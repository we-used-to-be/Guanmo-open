import { getDatabase, isDatabaseReady } from '@/services/database/db'
import type { MemorySourceSnapshot } from '@/services/database/persistence'
import { containsForbiddenMemorySecret } from './memoryPolicy'
import { readMemoryIntakeSource } from './memoryIntakeSource'
import { isMemoryWindowLeaseCurrent } from './memoryWindowLedger'
import type { MemoryWindowClaim } from './memoryWindowLedger'

export interface MemoryWindowTurn {
  id: string
  role: 'user' | 'assistant'
  contextOnly: boolean
  parentId?: string
  text?: string
  gap?: string
  segment?: { index: number; total: number; continuationBefore: boolean; continuationAfter: boolean }
}

export interface MemoryWindowPacket {
  /** Storage/extraction contract; v3 is global-only and has a distinct ledger namespace. */
  policyVersion?: 2 | 3
  /** Only this field may be serialized into a model request. */
  turns: MemoryWindowTurn[]
  newSourceIds: string[]
  segmentedSourceIds: string[]
  /** Local SQL guards only; may contain hidden raw attachment text. */
  snapshots: MemorySourceSnapshot[]
  needsModel: boolean
  estimatedInputTokens: number
}

type BuildResult = { kind: 'ready'; packets: MemoryWindowPacket[]; invalidatedSourceIds: string[]; failedSourceIds: string[] }
  | { kind: 'blocked' | 'lost_lease' }

interface AssistantRow { id: string; session_id: string; role: string; parent_id: string | null; content: string; metadata: string | null; created_at: number }
interface Unit { sourceId: string; turns: Array<Omit<MemoryWindowTurn, 'contextOnly'>>; snapshots: MemorySourceSnapshot[]; segmented: boolean; fresh: boolean }
interface Receipt { version: number; sourceId: string; sessionId: string; scopeKey: string | null; epoch: number; sequence: number; sourceFingerprint: string; status: string }

function parseReceipt(value: string, sourceId: string, claim: MemoryWindowClaim, fresh: boolean): Receipt {
  const item: unknown = JSON.parse(value)
  if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('invalid_memory_window_input_receipt')
  const receipt = item as Receipt
  if (receipt.version !== claim.record.version || receipt.sourceId !== sourceId || receipt.sessionId !== claim.record.sessionId
    || receipt.scopeKey !== claim.record.scopeKey || receipt.epoch !== claim.record.epoch
    || !Number.isSafeInteger(receipt.sequence) || receipt.sequence <= 0 || !/^[a-f0-9]{64}$/.test(receipt.sourceFingerprint)
    || (fresh ? receipt.status !== 'pending' : !['completed', 'noop'].includes(receipt.status))) {
    throw new Error('invalid_memory_window_input_receipt')
  }
  return receipt
}

export async function assistantUnit(sessionId: string, parentId: string, policyVersion: 2 | 3 = 3): Promise<{ turn: Omit<MemoryWindowTurn, 'contextOnly'>; snapshot?: MemorySourceSnapshot } | null> {
  const rows = await getDatabase().select<AssistantRow>(
    "SELECT id, session_id, role, parent_id, content, metadata, created_at FROM chat_messages WHERE session_id = $1 AND parent_id = $2 AND role = 'assistant' ORDER BY created_at DESC, id DESC LIMIT 2",
    [sessionId, parentId],
  )
  if (!rows.length) return null
  if (rows.length > 1) return { turn: { id: parentId + ':ambiguous-assistant', role: 'assistant', parentId, gap: 'ambiguous' } }
  const row = rows[0]
  if (!row.id || row.id.length > 300 || row.session_id !== sessionId || row.role !== 'assistant' || row.parent_id !== parentId
    || typeof row.content !== 'string' || (row.metadata !== null && typeof row.metadata !== 'string')
    || !Number.isSafeInteger(row.created_at) || row.created_at <= 0) return null
  let metadata: Record<string, unknown> = {}
  if (row.metadata !== null) {
    try {
      const parsed: unknown = JSON.parse(row.metadata)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error()
      metadata = parsed as Record<string, unknown>
    } catch { return { turn: { id: row.id, role: 'assistant', parentId, gap: 'metadata' } } }
  }
  if (metadata.contextMeta !== undefined && (!metadata.contextMeta || typeof metadata.contextMeta !== 'object' || Array.isArray(metadata.contextMeta))) {
    return { turn: { id: row.id, role: 'assistant', parentId, gap: 'metadata' } }
  }
  if (policyVersion === 3 && metadata.displayContent !== undefined && typeof metadata.displayContent !== 'string') {
    return { turn: { id: row.id, role: 'assistant', parentId, gap: 'metadata' } }
  }
  const context = metadata.contextMeta ? metadata.contextMeta as Record<string, unknown> : {}
  const visibleText = policyVersion === 3 && typeof metadata.displayContent === 'string' ? metadata.displayContent : row.content
  const restrictedLegacyContext = policyVersion === 2 && (metadata.sources !== undefined && (!Array.isArray(metadata.sources) || metadata.sources.length > 0)
    || metadata.tags !== undefined || context.webSearchUsed !== undefined && context.webSearchUsed !== false
    || context.ragSourceCount !== undefined && (typeof context.ragSourceCount !== 'number' || context.ragSourceCount !== 0)
    || context.tagCount !== undefined && (typeof context.tagCount !== 'number' || context.tagCount !== 0))
  if (metadata.hidden !== undefined && metadata.hidden !== false || restrictedLegacyContext
    || row.content.includes('【上下文') || visibleText.includes('【上下文') || containsForbiddenMemorySecret(visibleText)) {
    return { turn: { id: row.id, role: 'assistant', parentId, gap: 'restricted' } }
  }
  if (new TextEncoder().encode(JSON.stringify(visibleText)).length > (policyVersion === 3 ? 32_000 : 800)) {
    return { turn: { id: row.id, role: 'assistant', parentId, gap: 'oversize' } }
  }
  return { turn: { id: row.id, role: 'assistant', parentId, text: visibleText }, snapshot: {
    id: row.id, sessionId, role: 'assistant', parentId, content: row.content, metadata: row.metadata, createdAt: row.created_at,
  } }
}

function latestDistinct(units: Unit[]): Unit[] {
  const found: Unit[] = [], ids = new Set<string>()
  for (let index = units.length - 1; index >= 0 && found.length < 2; index--) {
    if (!ids.has(units[index].sourceId)) { ids.add(units[index].sourceId); found.push(units[index]) }
  }
  return found.reverse()
}

/** Builds only anonymous-window inputs; never serialize a packet's snapshots into a model request. */
export async function buildMemoryWindowInput(claim: MemoryWindowClaim, maxBytes?: number): Promise<BuildResult> {
  if (!isDatabaseReady()) return { kind: 'blocked' }
  if (!await isMemoryWindowLeaseCurrent(claim)) return { kind: 'lost_lease' }
  // The record carried by the caller is mutable; the serialized CAS value is authoritative.
  const record = JSON.parse(claim.value) as MemoryWindowClaim['record']
  maxBytes ??= record.version === 3 ? 32_000 : 4000
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 512 || maxBytes > (record.version === 3 ? 32_000 : 4000)) {
    throw new Error('invalid_memory_window_budget')
  }
  const lockedClaim = { ...claim, record }
  const sourceItems = [
    ...record.prefixIds.map((id, index) => ({ id, value: record.prefixReceiptValues![index], fresh: false })),
    ...record.sourceIds.map((id, index) => ({ id, value: record.receiptValues[index], fresh: true })),
  ]
  const units: Unit[] = [], invalidatedSourceIds: string[] = [], failedSourceIds: string[] = []
  let previousSequence = 0
  for (const item of sourceItems) {
    const receipt = parseReceipt(item.value, item.id, lockedClaim, item.fresh)
    if (receipt.sequence <= previousSequence) throw new Error('invalid_memory_window_sequence')
    previousSequence = receipt.sequence
    const source = await readMemoryIntakeSource({ ...receipt, policyVersion: receipt.version === 3 ? 3 : 2 })
    if (source.kind === 'blocked') return { kind: 'blocked' }
    if (source.kind === 'invalidated' || source.kind === 'gap' || source.kind === 'oversize'
      || record.version === 3 && source.kind === 'segmented') {
      if (source.kind === 'invalidated' && item.fresh) invalidatedSourceIds.push(item.id)
      if ((source.kind === 'oversize' || source.kind === 'segmented') && item.fresh) failedSourceIds.push(item.id)
      units.push({ sourceId: item.id, turns: [{ id: item.id, role: 'user', gap: source.kind === 'gap' ? source.reason : source.kind === 'segmented' ? 'oversize' : source.kind }],
        snapshots: [], segmented: false, fresh: item.fresh })
      continue
    }
    const segments = source.kind === 'segmented' ? source.segments : [source.visibleText]
    // A prefix is context only: retaining its last segment is enough to mark it as incomplete.
    const indexes = item.fresh ? segments.map((_, index) => index) : [segments.length - 1]
    for (const index of indexes) {
      const user: Omit<MemoryWindowTurn, 'contextOnly'> = { id: item.id, role: 'user', text: segments[index],
        ...(segments.length > 1 ? { segment: { index, total: segments.length, continuationBefore: index > 0, continuationAfter: index + 1 < segments.length } } : {}) }
      const unit: Unit = { sourceId: item.id, turns: [user], snapshots: [source.snapshot], segmented: segments.length > 1, fresh: item.fresh }
      if (segments.length === 1) {
        const assistant = await assistantUnit(record.sessionId, item.id, record.version)
        if (assistant) { unit.turns.push(assistant.turn); if (assistant.snapshot) unit.snapshots.push(assistant.snapshot) }
      }
      units.push(unit)
    }
  }
  if (!isDatabaseReady()) return { kind: 'blocked' }
  if (!await isMemoryWindowLeaseCurrent(claim)) return { kind: 'lost_lease' }

  const packets: MemoryWindowPacket[] = []
  let history = latestDistinct(units.filter(unit => !unit.fresh)), current: Unit[] = [], context: Unit[] = []
  const turnsFor = (prior: Unit[], active: Unit[]) => [
    ...prior.flatMap(unit => unit.turns.map(turn => ({ ...turn, contextOnly: true }))),
    ...active.flatMap(unit => unit.turns.map(turn => ({ ...turn, contextOnly: false }))),
  ]
  const byteCount = (prior: Unit[], active: Unit[]) => new TextEncoder().encode(JSON.stringify({ turns: turnsFor(prior, active) })).length
  if (record.version === 3) {
    // One v3 claim is one model request. Preserve complete fresh user text;
    // optional prefix and assistant context give way before any source does.
    const active = units.filter(unit => unit.fresh)
    const prior = [...history]
    while (prior.length && byteCount(prior, active) > maxBytes) prior.shift()
    for (let i = active.length - 1; i >= 0 && byteCount(prior, active) > maxBytes; i--) {
      active[i] = { ...active[i], turns: active[i].turns.slice(0, 1),
        snapshots: active[i].snapshots.filter(snapshot => snapshot.role === 'user') }
    }
    for (let i = active.length - 1; i >= 0 && byteCount(prior, active) > maxBytes; i--) {
      if (active[i].turns[0].text === undefined) continue
      failedSourceIds.push(active[i].sourceId)
      active[i] = { ...active[i], turns: [{ id: active[i].sourceId, role: 'user', gap: 'oversize' }], snapshots: [] }
    }
    const turns = turnsFor(prior, active)
    const snapshots = [...prior, ...active].flatMap(unit => unit.snapshots)
    return { kind: 'ready', packets: [{ policyVersion: 3, turns, snapshots,
      newSourceIds: active.map(unit => unit.sourceId), segmentedSourceIds: [],
      needsModel: active.some(unit => unit.turns[0].text !== undefined), estimatedInputTokens: byteCount(prior, active) }],
    invalidatedSourceIds, failedSourceIds }
  }
  const flush = () => {
    if (!current.length) return
    const turns = turnsFor(context, current), snapshots = new Map<string, MemorySourceSnapshot>()
    for (const unit of [...context, ...current]) for (const snapshot of unit.snapshots) snapshots.set(snapshot.id, snapshot)
    packets.push({ policyVersion: record.version, turns, snapshots: [...snapshots.values()], newSourceIds: [...new Set(current.map(unit => unit.sourceId))],
      segmentedSourceIds: [...new Set(current.filter(unit => unit.segmented).map(unit => unit.sourceId))],
      needsModel: current.some(unit => unit.turns[0].text !== undefined), estimatedInputTokens: byteCount(context, current) })
    history = latestDistinct([...context, ...current]); current = []; context = []
  }
  for (let unit of units.filter(item => item.fresh)) {
    if (!current.length) context = history.filter(previous => previous.sourceId !== unit.sourceId)
    if (byteCount(context, [...current, unit]) > maxBytes && current.length) {
      flush(); context = history.filter(previous => previous.sourceId !== unit.sourceId)
    }
    while (context.length && byteCount(context, [...current, unit]) > maxBytes) context.shift()
    if (byteCount(context, [...current, unit]) > maxBytes && unit.turns.length > 1) {
      unit = { ...unit, turns: unit.turns.slice(0, 1), snapshots: unit.snapshots.filter(snapshot => snapshot.role === 'user') }
    }
    if (byteCount(context, [...current, unit]) > maxBytes) {
      if (!failedSourceIds.includes(unit.sourceId)) failedSourceIds.push(unit.sourceId)
      unit = { ...unit, turns: [{ id: unit.sourceId, role: 'user', gap: 'oversize' }], snapshots: [], segmented: false }
    }
    current.push(unit)
    if (unit.segmented) flush()
  }
  flush()
  return { kind: 'ready', packets, invalidatedSourceIds, failedSourceIds }
}
