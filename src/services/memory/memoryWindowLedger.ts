import { getDatabase, isDatabaseReady } from '@/services/database/db'

const LEASE_MS = 60_000
const MAX_ATTEMPTS = 3
const MAX_AGE_MS = 7 * 86_400_000

export interface MemoryWindowGroup { sessionId: string; scopeKey: string | null; epoch: number; policyVersion?: 3 }
export interface PendingMemoryWindowGroup {
  group: MemoryWindowGroup
  pendingCount: number
  lastActivityAt: number
}
export interface MemoryWindowGroupPage { groups: PendingMemoryWindowGroup[]; nextCursor: string | null }
interface IntakeReceipt extends MemoryWindowGroup {
  version: 2 | 3
  sourceId: string
  sequence: number
  sourceFingerprint: string
  status: 'pending' | 'completed' | 'noop' | 'invalidated' | 'failed'
  createdAt: number
}
interface SettingsRow { key: string; value: string }
interface WindowRecord extends MemoryWindowGroup {
  version: 2 | 3
  windowId: string
  status: 'running' | 'retry' | 'blocked' | 'finished'
  owner: string
  leaseUntil: number
  nextAttemptAt: number
  attempts: number
  createdAt: number
  sourceIds: string[]
  receiptValues: string[]
  prefixIds: string[]
  prefixReceiptValues?: string[]
}
export interface MemoryWindowClaim { key: string; value: string; record: WindowRecord }
export type MemoryWindowResult = 'completed' | 'noop' | 'invalidated' | 'failed'
export type MemoryWindowAcquire = { kind: 'claimed'; claim: MemoryWindowClaim }
  | { kind: 'blocked' | 'busy' | 'not_due' | 'lost_race' | 'settled' | 'failed' }

const versionOf = (group: MemoryWindowGroup) => group.policyVersion ?? 2
const intakePrefix = (group: MemoryWindowGroup) => `memory-extraction:v${versionOf(group)}:intake:`
const windowPrefix = (group: MemoryWindowGroup) => `memory-extraction:v${versionOf(group)}:window:`
const batchSize = (group: MemoryWindowGroup) => versionOf(group) === 3 ? 8 : 4
const idleMs = (group: MemoryWindowGroup) => versionOf(group) === 3 ? 300_000 : 60_000

function decodeReceipt(row: SettingsRow, group: MemoryWindowGroup): IntakeReceipt {
  const value: unknown = JSON.parse(row.value)
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_memory_intake_receipt')
  const item = value as IntakeReceipt
  if (item.version !== versionOf(group) || typeof item.sourceId !== 'string' || !item.sourceId || item.sourceId.length > 300
    || row.key !== intakePrefix(group) + item.sourceId || item.sessionId !== group.sessionId || item.scopeKey !== group.scopeKey
    || item.epoch !== group.epoch || !Number.isSafeInteger(item.sequence) || item.sequence <= 0
    || !Number.isSafeInteger(item.createdAt) || item.createdAt <= 0 || !/^[a-f0-9]{64}$/.test(item.sourceFingerprint)
    || !['pending', 'completed', 'noop', 'invalidated', 'failed'].includes(item.status)) throw new Error('invalid_memory_intake_receipt')
  return item
}

function decodeWindow(row: SettingsRow, group: MemoryWindowGroup): WindowRecord {
  const value: unknown = JSON.parse(row.value)
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_memory_window')
  const item = value as WindowRecord
  if (item.version !== versionOf(group) || item.sessionId !== group.sessionId || item.scopeKey !== group.scopeKey || item.epoch !== group.epoch
    || typeof item.windowId !== 'string' || !item.windowId || !['running', 'retry', 'blocked', 'finished'].includes(item.status)
    || typeof item.owner !== 'string' || !Number.isSafeInteger(item.attempts) || item.attempts < 0 || item.attempts > MAX_ATTEMPTS
    || [item.createdAt, item.leaseUntil, item.nextAttemptAt].some(n => !Number.isSafeInteger(n) || n < 0)
    || !Array.isArray(item.sourceIds) || item.sourceIds.length < 1 || item.sourceIds.length > batchSize(group)
    || !Array.isArray(item.receiptValues) || item.receiptValues.length !== item.sourceIds.length
    || !Array.isArray(item.prefixIds) || item.prefixIds.length > 2
    || (item.prefixIds.length > 0 && (!Array.isArray(item.prefixReceiptValues) || item.prefixReceiptValues.length !== item.prefixIds.length))
    || (item.prefixReceiptValues !== undefined && (!Array.isArray(item.prefixReceiptValues) || item.prefixReceiptValues.length !== item.prefixIds.length))
    || [...item.sourceIds, ...item.prefixIds].some(id => typeof id !== 'string' || !id || id.length > 300)
    || new Set([...item.sourceIds, ...item.prefixIds]).size !== item.sourceIds.length + item.prefixIds.length) {
    throw new Error('invalid_memory_window')
  }
  item.receiptValues.forEach((value, index) => {
    if (typeof value !== 'string' || decodeReceipt({ key: intakePrefix(group) + item.sourceIds[index], value }, group).status !== 'pending') {
      throw new Error('invalid_memory_window_receipt')
    }
  })
  item.prefixReceiptValues?.forEach((value, index) => {
    const receipt = typeof value === 'string' ? decodeReceipt({ key: intakePrefix(group) + item.prefixIds[index], value }, group) : null
    if (!receipt || !['completed', 'noop'].includes(receipt.status)) throw new Error('invalid_memory_window_prefix')
  })
  return item
}

async function windowKey(group: MemoryWindowGroup): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify([group.sessionId, group.epoch]))
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return windowPrefix(group) + Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}

function groupCondition(group: MemoryWindowGroup): string { return `CASE WHEN json_valid(value) THEN
  json_extract(value, '$.version') = ${versionOf(group)} AND json_extract(value, '$.sessionId') = $1
  AND json_extract(value, '$.scopeKey') IS $2 AND json_extract(value, '$.epoch') = $3 ELSE 0 END`
}

function groupFromReceipt(row: SettingsRow): { group: MemoryWindowGroup; sequence: number; createdAt: number } | null {
  try {
    const item = JSON.parse(row.value) as Partial<IntakeReceipt>
    if (![2, 3].includes(item.version || 0) || row.key !== `memory-extraction:v${item.version}:intake:${item.sourceId}` || item.status !== 'pending'
      || typeof item.sourceId !== 'string' || !item.sourceId || item.sourceId.length > 300
      || typeof item.sessionId !== 'string' || !item.sessionId || item.sessionId.length > 300
      || (item.scopeKey !== null && (typeof item.scopeKey !== 'string' || !item.scopeKey || item.scopeKey.length > 4096))
      || !Number.isSafeInteger(item.epoch) || item.epoch! < 0
      || !Number.isSafeInteger(item.sequence) || item.sequence! <= 0
      || !Number.isSafeInteger(item.createdAt) || item.createdAt! <= 0
      || typeof item.sourceFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(item.sourceFingerprint)) return null
    return { group: { sessionId: item.sessionId, scopeKey: item.scopeKey!, epoch: item.epoch!,
      ...(item.version === 3 ? { policyVersion: 3 as const } : {}) },
      sequence: item.sequence!, createdAt: item.createdAt! }
  } catch { return null }
}

/** Recover durable pending receipts without relying on the Store's current session or scope. */
export async function listPendingMemoryWindowGroups(policyVersion: 2 | 3 = 2): Promise<PendingMemoryWindowGroup[]> {
  return (await listPendingMemoryWindowGroupsPage(policyVersion)).groups
}

/** A bounded keyset scan lets startup recovery continue past a 512-receipt page. */
export async function listPendingMemoryWindowGroupsPage(policyVersion: 2 | 3 = 2,
  afterKey: string | null = null): Promise<MemoryWindowGroupPage> {
  if (!isDatabaseReady()) return { groups: [], nextCursor: null }
  const condition = afterKey === null ? '' : 'AND key > $1'
  const rows = await getDatabase().select<SettingsRow>(
    `SELECT key, value FROM settings WHERE key LIKE 'memory-extraction:v${policyVersion}:intake:%' ${condition}
     AND CASE WHEN json_valid(value) THEN json_extract(value, '$.version') = ${policyVersion}
       AND json_extract(value, '$.status') = 'pending' ELSE 0 END
     ORDER BY key ASC LIMIT 512`,
    afterKey === null ? [] : [afterKey],
  )
  const groups = new Map<string, PendingMemoryWindowGroup>()
  for (const row of rows) {
    const parsed = groupFromReceipt(row)
    if (!parsed) continue
    const key = JSON.stringify([parsed.group.sessionId, parsed.group.scopeKey, parsed.group.epoch])
    const previous = groups.get(key)
    if (previous) {
      previous.pendingCount++
      previous.lastActivityAt = Math.max(previous.lastActivityAt, parsed.createdAt)
    } else {
      groups.set(key, { group: parsed.group, pendingCount: 1, lastActivityAt: parsed.createdAt })
    }
  }
  return { groups: [...groups.values()], nextCursor: rows.length === 512 ? rows[rows.length - 1].key : null }
}

/** Read the epoch allocated atomically with this source's durable intake receipt. */
export async function getMemoryWindowGroupForSource(sourceId: string, sessionId: string,
  scopeKey: string | null, policyVersion: 2 | 3 = 2): Promise<MemoryWindowGroup | null> {
  if (!sourceId || !sessionId || !isDatabaseReady()) return null
  const group: MemoryWindowGroup = { sessionId, scopeKey, epoch: 0, ...(policyVersion === 3 ? { policyVersion: 3 as const } : {}) }
  const [row] = await getDatabase().select<SettingsRow>('SELECT key, value FROM settings WHERE key = $1', [intakePrefix(group) + sourceId])
  if (!row) return null
  const parsed = groupFromReceipt(row)
  if (!parsed || versionOf(parsed.group) !== policyVersion || parsed.group.sessionId !== sessionId || parsed.group.scopeKey !== scopeKey) return null
  return parsed.group
}

export async function countPendingMemoryWindowSources(group: MemoryWindowGroup): Promise<number> {
  if (!isDatabaseReady()) return 0
  const [row] = await getDatabase().select<{ count: number }>(
    `SELECT COUNT(*) AS count FROM settings WHERE key LIKE '${intakePrefix(group)}%' AND ${groupCondition(group)}
     AND CASE WHEN json_valid(value) THEN json_extract(value, '$.status') = 'pending' ELSE 0 END`,
    [group.sessionId, group.scopeKey, group.epoch],
  )
  return Number.isSafeInteger(row?.count) && row.count >= 0 ? row.count : 0
}

/** Earliest persisted retry/lease deadline for this group, used to avoid tight retry loops. */
export async function getMemoryWindowRetryAt(group: MemoryWindowGroup): Promise<number | null> {
  if (!isDatabaseReady()) return null
  const key = await windowKey(group)
  const [row] = await getDatabase().select<SettingsRow>('SELECT key, value FROM settings WHERE key = $1', [key])
  if (!row) return null
  try {
    const record = decodeWindow(row, group)
    if (record.status === 'running' && record.leaseUntil > Date.now()) return record.leaseUntil
    if (record.status === 'retry' || record.status === 'blocked') return record.nextAttemptAt > Date.now() ? record.nextAttemptAt : null
  } catch { /* finished receipts no longer match a pending lease */ }
  return null
}

async function receipts(group: MemoryWindowGroup, statuses: string[], before?: number): Promise<SettingsRow[]> {
  const db = getDatabase()
  const filteredStatuses = statuses.map((_, index) => `$${index + 4}`).join(', ')
  const beforeParameter = `$${statuses.length + 4}`
  return db.select<SettingsRow>(
    `SELECT key, value FROM settings WHERE key LIKE '${intakePrefix(group)}%' AND ${groupCondition(group)}
     AND CASE WHEN json_valid(value) THEN json_extract(value, '$.status') IN (${filteredStatuses})
       AND (${beforeParameter} IS NULL OR json_extract(value, '$.sequence') < ${beforeParameter}) ELSE 0 END
     ORDER BY json_extract(value, '$.sequence') ${before === undefined ? 'ASC' : 'DESC'} LIMIT ${before === undefined ? batchSize(group) : 2}`,
    [group.sessionId, group.scopeKey, group.epoch, ...statuses, before ?? null],
  )
}

function assertGroup(group: MemoryWindowGroup, owner: string, now: number): void {
  if (!group.sessionId || group.sessionId.length > 300 || (group.scopeKey !== null && (!group.scopeKey || group.scopeKey.length > 4096))
    || !Number.isSafeInteger(group.epoch) || group.epoch < 0 || !owner || owner.length > 300
    || !Number.isSafeInteger(now) || now <= 0) throw new Error('invalid_memory_window_request')
}

const liveLeaseCondition = `CASE WHEN json_valid(value) THEN json_extract(value, '$.status') = 'running'
  AND json_extract(value, '$.leaseUntil') > CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) ELSE 0 END`

/** Recheck before an external request; the final write still needs its own atomic lease guard. */
export async function isMemoryWindowLeaseCurrent(claim: MemoryWindowClaim): Promise<boolean> {
  if (!isDatabaseReady()) return false
  const record = decodeWindow({ key: claim.key, value: claim.value }, claim.record)
  if (record.status !== 'running') return false
  const params: unknown[] = [claim.key, claim.value]
  const bind = (item: unknown) => { params.push(item); return `$${params.length}` }
  const guards = [...record.sourceIds.map((id, index) => ({ id, value: record.receiptValues[index] })),
    ...record.prefixIds.map((id, index) => ({ id, value: record.prefixReceiptValues![index] }))]
    .map(item => `EXISTS (SELECT 1 FROM settings WHERE key = ${bind(intakePrefix(record) + item.id)} AND value = ${bind(item.value)})`)
  const rows = await getDatabase().select<{ key: string }>(
    `SELECT key FROM settings WHERE key = $1 AND value = $2 AND ${liveLeaseCondition} AND ${guards.join(' AND ')}`, params,
  )
  return isDatabaseReady() && rows.length === 1
}

/** Durable claim only. Callers must guard every model call and every write with the active lease. */
export async function acquireMemoryWindow(group: MemoryWindowGroup, strategy: 'B' | 'C', owner: string,
  options: { now: number; lastActivityAt?: number; foregroundBusy: boolean }): Promise<MemoryWindowAcquire> {
  assertGroup(group, owner, options.now)
  if (strategy !== 'B' && strategy !== 'C') throw new Error('invalid_memory_window_strategy')
  if (!isDatabaseReady()) return { kind: 'blocked' }
  if (options.foregroundBusy !== false) return { kind: 'not_due' }
  const key = await windowKey(group)
  if (!isDatabaseReady()) return { kind: 'blocked' }
  const db = getDatabase()
  const [old] = await db.select<SettingsRow>('SELECT key, value FROM settings WHERE key = $1', [key])
  let previous: WindowRecord | undefined
  if (old) previous = decodeWindow(old, group)
  if (previous && previous.status !== 'finished') {
    if (previous.status === 'running' && previous.leaseUntil > options.now
      || previous.status !== 'running' && previous.nextAttemptAt > options.now) return { kind: 'busy' }
    const rows = await Promise.all(previous.sourceIds.map(async id => {
      const [row] = await db.select<SettingsRow>('SELECT key, value FROM settings WHERE key = $1', [intakePrefix(group) + id])
      return row ? { row, receipt: decodeReceipt(row, group) } : null
    }))
    if (rows.some(row => !row)) throw new Error('missing_memory_intake_receipt')
    if (rows.every(row => row!.receipt.status !== 'pending')) {
      rows.forEach((row, index) => {
        const expected = decodeReceipt({ key: row!.row.key, value: previous!.receiptValues[index] }, group)
        if (row!.receipt.sequence !== expected.sequence || row!.receipt.sourceFingerprint !== expected.sourceFingerprint
          || row!.receipt.createdAt !== expected.createdAt) throw new Error('changed_memory_intake_receipt')
      })
      const done = JSON.stringify({ ...previous, status: 'finished', owner: '', leaseUntil: 0 })
      const result = await db.execute('UPDATE settings SET value = $1, updated_at = unixepoch() WHERE key = $2 AND value = $3', [done, key, old!.value])
      return { kind: result.rowsAffected === 1 ? 'settled' : 'lost_race' }
    }
    if (rows.some((row, index) => row!.receipt.status !== 'pending' || row!.row.value !== previous!.receiptValues[index])) {
      throw new Error('inconsistent_memory_window_receipts')
    }
    const expired = options.now - previous.createdAt > MAX_AGE_MS || previous.attempts >= MAX_ATTEMPTS
    const next: WindowRecord = { ...previous, status: 'running', owner, leaseUntil: options.now + LEASE_MS,
      nextAttemptAt: 0, attempts: expired ? previous.attempts : previous.attempts + 1 }
    const value = JSON.stringify(next)
    const result = await db.execute('UPDATE settings SET value = $1, updated_at = unixepoch() WHERE key = $2 AND value = $3', [value, key, old!.value])
    if (result.rowsAffected !== 1) return { kind: 'lost_race' }
    const claim = { key, value, record: next }
    if (expired) {
      const finished = await finishMemoryWindow(claim, Object.fromEntries(next.sourceIds.map(id => [id, 'failed'])), options.now)
      return { kind: finished ? 'failed' : 'lost_race' }
    }
    return { kind: 'claimed', claim }
  }

  const pendingRows = await receipts(group, ['pending'])
  const pending = pendingRows.map(row => decodeReceipt(row, group))
  if (!pending.length) return { kind: 'not_due' }
  if (new Set(pending.map(item => item.sequence)).size !== pending.length) throw new Error('duplicate_memory_intake_sequence')
  if (pending.length < batchSize(group) && (strategy === 'B' || !Number.isSafeInteger(options.lastActivityAt)
    || options.lastActivityAt! <= 0 || options.now - Math.max(options.lastActivityAt!, ...pending.map(item => item.createdAt)) < idleMs(group))) return { kind: 'not_due' }
  const prefixRows = await receipts(group, ['completed', 'noop'], pending[0].sequence)
  const orderedPrefix = prefixRows.reverse()
  const prefixIds = orderedPrefix.map(row => decodeReceipt(row, group).sourceId)
  const record: WindowRecord = { version: versionOf(group), ...group, windowId: `${key}:${pending[0].sequence}`, status: 'running', owner,
    leaseUntil: options.now + LEASE_MS, nextAttemptAt: 0, attempts: 1, createdAt: pending[0].createdAt,
    sourceIds: pending.map(item => item.sourceId), receiptValues: pendingRows.map(row => row.value), prefixIds,
    prefixReceiptValues: orderedPrefix.map(row => row.value) }
  const value = JSON.stringify(record)
  const params: unknown[] = old ? [value, key, old.value] : [key, value]
  const bind = (item: unknown) => { params.push(item); return `$${params.length}` }
  const guards = [...pendingRows, ...orderedPrefix].map(row => `EXISTS (SELECT 1 FROM settings WHERE key = ${bind(row.key)} AND value = ${bind(row.value)})`)
  if (pending.length < batchSize(group)) {
    const session = bind(group.sessionId), scope = bind(group.scopeKey), epoch = bind(group.epoch), last = bind(pending[pending.length - 1].sequence)
    guards.push(`NOT EXISTS (SELECT 1 FROM settings WHERE key LIKE '${intakePrefix(group)}%' AND CASE WHEN json_valid(value) THEN
      json_extract(value, '$.version') = ${versionOf(group)} AND json_extract(value, '$.sessionId') = ${session} AND json_extract(value, '$.scopeKey') IS ${scope}
      AND json_extract(value, '$.epoch') = ${epoch} AND json_extract(value, '$.status') = 'pending'
      AND json_extract(value, '$.sequence') > ${last} ELSE 0 END)`)
  }
  const where = guards.join(' AND ')
  const sql = old
    ? `UPDATE settings SET value = $1, updated_at = unixepoch() WHERE key = $2 AND value = $3 AND ${where}`
    : `INSERT OR IGNORE INTO settings (key, value, updated_at) SELECT $1, $2, unixepoch() WHERE ${where}`
  const inserted = await db.execute(sql, params)
  if (inserted.rowsAffected !== 1) return { kind: 'lost_race' }
  const claim = { key, value, record }
  if (options.now - record.createdAt > MAX_AGE_MS) {
    const finished = await finishMemoryWindow(claim, Object.fromEntries(record.sourceIds.map(id => [id, 'failed'])), options.now)
    return { kind: finished ? 'failed' : 'lost_race' }
  }
  return { kind: 'claimed', claim }
}

/** Marks every source in one SQLite statement, then closes the durable lease. */
export async function finishMemoryWindow(claim: MemoryWindowClaim, results: Record<string, MemoryWindowResult>, now: number): Promise<boolean> {
  const record = decodeWindow({ key: claim.key, value: claim.value }, claim.record)
  if (record.status !== 'running' || !Number.isSafeInteger(now) || now <= 0 || record.leaseUntil <= now || !isDatabaseReady()
    || Object.keys(results).length !== record.sourceIds.length
    || record.sourceIds.some(id => !Object.prototype.hasOwnProperty.call(results, id) || !['completed', 'noop', 'invalidated', 'failed'].includes(results[id]))) return false
  const params: unknown[] = []
  const bind = (item: unknown) => { params.push(item); return `$${params.length}` }
  const clauses = record.sourceIds.map(id => `WHEN ${bind(intakePrefix(record) + id)} THEN ${bind(results[id])}`).join(' ')
  const keys = record.sourceIds.map(id => bind(intakePrefix(record) + id)).join(', ')
  const lockKey = bind(claim.key), lockValue = bind(claim.value)
  const guards = [...record.sourceIds.map((id, index) => ({ id, value: record.receiptValues[index] })),
    ...record.prefixIds.map((id, index) => ({ id, value: record.prefixReceiptValues![index] }))]
    .map(item => `EXISTS (SELECT 1 FROM settings WHERE key = ${bind(intakePrefix(record) + item.id)} AND value = ${bind(item.value)})`)
  const result = await getDatabase().execute(
    `UPDATE settings SET value = json_set(value, '$.status', CASE key ${clauses} END), updated_at = unixepoch()
     WHERE key IN (${keys}) AND EXISTS (SELECT 1 FROM settings WHERE key = ${lockKey} AND value = ${lockValue} AND ${liveLeaseCondition})
     AND ${guards.join(' AND ')}`,
    params,
  )
  if (result.rowsAffected !== record.sourceIds.length) return false
  const finished = JSON.stringify({ ...record, status: 'finished', owner: '', leaseUntil: 0 })
  const closed = await getDatabase().execute(`UPDATE settings SET value = $1, updated_at = unixepoch() WHERE key = $2 AND value = $3 AND ${liveLeaseCondition}`,
    [finished, claim.key, claim.value])
  // If interrupted here, the next owner recognizes that all receipts are already terminal.
  return closed.rowsAffected === 1
}

export async function deferMemoryWindow(claim: MemoryWindowClaim, reason: 'retry' | 'capacity' | 'foreground', now: number): Promise<boolean> {
  const record = decodeWindow({ key: claim.key, value: claim.value }, claim.record)
  if (record.status !== 'running' || !Number.isSafeInteger(now) || now <= 0 || record.leaseUntil <= now || !isDatabaseReady()) return false
  if (reason === 'retry' && record.attempts >= MAX_ATTEMPTS) {
    return finishMemoryWindow(claim, Object.fromEntries(record.sourceIds.map(id => [id, 'failed'])), now)
  }
  const next: WindowRecord = { ...record, status: reason === 'capacity' ? 'blocked' : 'retry', owner: '', leaseUntil: 0,
    attempts: reason !== 'retry' ? Math.max(0, record.attempts - 1) : record.attempts,
    nextAttemptAt: now + (reason !== 'retry'
      ? (reason === 'foreground' && versionOf(record) === 3 ? 0 : LEASE_MS)
      : versionOf(record) === 3 ? (record.attempts <= 1 ? 60_000 : 120_000) : 1000 * 2 ** record.attempts) }
  const result = await getDatabase().execute(`UPDATE settings SET value = $1, updated_at = unixepoch() WHERE key = $2 AND value = $3 AND ${liveLeaseCondition}`,
    [JSON.stringify(next), claim.key, claim.value])
  return result.rowsAffected === 1
}
