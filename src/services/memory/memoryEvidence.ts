import type { ChatMessage } from '@/services/ai/types'
import { containsForbiddenMemorySecret, contentHash } from './memoryPolicy'
import { classifyGlobalMemoryInputGap } from './memoryInputPolicy'
import type { MemoryWindowPacket } from './memoryWindowInput'
import type { MemoryWindowCandidate } from './memoryWindowCandidates'
import type { MemoryWindowClaim } from './memoryWindowLedger'

interface MemoryEvidenceBase {
  kind: 'semantic' | 'episodic'
  sourceId: string
  sessionId?: string
  recordedAt?: number
  occurredAt?: number
  excerpt: string
  replacement?: { id: string; contentHash: string; updatedAt: number }
}

export interface MemoryEvidenceV1 extends MemoryEvidenceBase {
  version: 1
  /** Early v1 records used this name for the message timestamp, not an inferred event date. */
  occurredAt?: number
}

export interface MemoryEvidenceV2 extends MemoryEvidenceBase {
  version: 2
  sessionId: string
  windowId: string
  policyVersion: 2
  sources: Array<{ id: string; sessionId: string; role: 'user' | 'assistant'; parentId: string | null;
    sequence: number; createdAt: number; textHash: string; segment?: { index: number; total: number } }>
}

export interface MemoryEvidenceV3 extends MemoryEvidenceBase {
  version: 3
  sessionId: string
  windowId: string
  policyVersion: 3
  sensitivity: 'normal' | 'sensitive'
  sources: MemoryEvidenceV2['sources']
}

export type MemoryEvidence = MemoryEvidenceV1 | MemoryEvidenceV2 | MemoryEvidenceV3

interface DecodedMemoryEvidence {
  version?: number
  policyVersion?: number
  kind?: string
  sourceId?: string
  sessionId?: string
  recordedAt?: number
  occurredAt?: number
  excerpt?: string
  windowId?: string
  sensitivity?: string
  replacement?: { id?: string; contentHash?: string; updatedAt?: number }
  sources?: MemoryEvidenceV2['sources']
}

export function encodeMemoryEvidence(message: ChatMessage, kind: MemoryEvidence['kind'] = 'semantic'): string {
  const excerpt = (message.displayContent || message.content).slice(0, 1200)
  if (!message.id) return excerpt
  return JSON.stringify({ version: 1, kind, sourceId: message.id,
    sessionId: message.sessionId, recordedAt: message.timestamp, excerpt } satisfies MemoryEvidenceV1)
}

/** Store only visible excerpts and hashes; raw source snapshots remain local to atomic write guards. */
export async function encodeWindowMemoryEvidence(claim: MemoryWindowClaim, packet: MemoryWindowPacket,
  candidate: MemoryWindowCandidate): Promise<string> {
  const locked = JSON.parse(claim.value) as MemoryWindowClaim['record']
  if (!locked.sourceIds.includes(candidate.primarySourceId) || !packet.newSourceIds.includes(candidate.primarySourceId)
    || !locked.sessionId || !locked.windowId || locked.windowId.length > 300 || !locked.windowId.startsWith(claim.key + ':')) {
    throw new Error('invalid_memory_evidence_window')
  }
  const ids = [candidate.primarySourceId, ...candidate.supportingSourceIds]
  if (ids.length > 12 || new Set(ids).size !== ids.length) throw new Error('invalid_memory_evidence_sources')
  const selected = ids.map(id => {
    const matches = packet.turns.map((turn, index) => ({ turn, index })).filter(item => item.turn.id === id && item.turn.text !== undefined)
    const snapshots = packet.snapshots.filter(snapshot => snapshot.id === id)
    if (matches.length !== 1 || snapshots.length !== 1) throw new Error('invalid_memory_evidence_source')
    const { turn, index } = matches[0], snapshot = snapshots[0]
    if (snapshot.sessionId !== locked.sessionId || snapshot.role !== turn.role || snapshot.parentId !== (turn.parentId ?? null)
      || !Number.isSafeInteger(snapshot.createdAt) || snapshot.createdAt <= 0 || snapshot.createdAt > 8.64e15
      || containsForbiddenMemorySecret(turn.text!) || turn.text!.includes('【上下文')
      || (turn.role === 'user' && ![...locked.sourceIds, ...(locked.prefixIds || [])].includes(turn.id))
      || (turn.role === 'user' && classifyGlobalMemoryInputGap(turn.text!))) throw new Error('invalid_memory_evidence_source')
    return { turn, index, snapshot }
  }).sort((a, b) => a.index - b.index)
  const primary = selected.find(item => item.turn.id === candidate.primarySourceId)
  if (!primary || primary.turn.role !== 'user' || primary.turn.contextOnly
    || selected.some(item => item.index > primary.index)
    || selected.some(item => item.turn.role === 'assistant' && !selected.some(parent => parent.turn.id === item.turn.parentId && parent.turn.role === 'user'))) {
    throw new Error('invalid_memory_evidence_attribution')
  }
  const sources: MemoryEvidenceV2['sources'] = []
  for (const { turn, index, snapshot } of selected) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(turn.text!))
    const textHash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
    sources.push({ id: snapshot.id, sessionId: snapshot.sessionId, role: snapshot.role, parentId: snapshot.parentId,
      sequence: index + 1, createdAt: snapshot.createdAt, textHash,
      ...(turn.segment ? { segment: { index: turn.segment.index, total: turn.segment.total } } : {}) })
  }
  let excerpt = ''
  for (const point of primary.turn.text!) { if (excerpt.length + point.length > 1200) break; excerpt += point }
  const recordedAt = primary.snapshot.createdAt < 1e12 ? primary.snapshot.createdAt * 1000 : primary.snapshot.createdAt
  const evidence: MemoryEvidenceV2 | MemoryEvidenceV3 = locked.version === 3
    ? { version: 3, policyVersion: 3, sensitivity: candidate.sensitivity || 'normal', kind: candidate.kind,
      sourceId: candidate.primarySourceId, sessionId: locked.sessionId, windowId: locked.windowId, recordedAt, excerpt, sources }
    : { version: 2, policyVersion: 2, kind: candidate.kind, sourceId: candidate.primarySourceId,
      sessionId: locked.sessionId, windowId: locked.windowId, recordedAt, excerpt, sources }
  const result = JSON.stringify(evidence)
  if (result.length > 6000 || !decodeMemoryEvidence(result)) throw new Error('invalid_memory_evidence_size')
  return result
}

export function decodeMemoryEvidence(value?: string | null): MemoryEvidence | null {
  if (!value?.startsWith('{') || value.length > 6000) return null
  try {
    const evidence = JSON.parse(value) as DecodedMemoryEvidence
    if (![1, 2, 3].includes(evidence.version || 0) || !['semantic', 'episodic'].includes(evidence.kind || '')
      || typeof evidence.sourceId !== 'string' || !evidence.sourceId || evidence.sourceId.length > 300
      || typeof evidence.excerpt !== 'string' || evidence.excerpt.length > 1200
      || (evidence.sessionId !== undefined && typeof evidence.sessionId !== 'string')
      || [evidence.recordedAt, evidence.occurredAt].some(time => time !== undefined && (!Number.isFinite(time) || time <= 0 || time > 8.64e15))) return null
    if (evidence.replacement && (typeof evidence.replacement.id !== 'string'
      || typeof evidence.replacement.contentHash !== 'string' || !/^[a-f0-9]{1,8}$/.test(evidence.replacement.contentHash)
      || !Number.isFinite(evidence.replacement.updatedAt))) return null
    if (evidence.version === 2 || evidence.version === 3) {
      if (evidence.policyVersion !== evidence.version || typeof evidence.windowId !== 'string' || !evidence.windowId || evidence.windowId.length > 300
        || typeof evidence.sessionId !== 'string' || !evidence.sessionId || evidence.sessionId.length > 300
        || evidence.version === 3 && !['normal', 'sensitive'].includes(String(evidence.sensitivity))
        || !Array.isArray(evidence.sources) || evidence.sources.length < 1 || evidence.sources.length > 12) return null
      let previousSequence = 0
      const ids = new Set<string>()
      for (const source of evidence.sources) {
        if (!source || typeof source.id !== 'string' || !source.id || source.id.length > 300 || ids.has(source.id)
          || source.sessionId !== evidence.sessionId || !['user', 'assistant'].includes(source.role)
          || (source.parentId !== null && typeof source.parentId !== 'string')
          || (source.role === 'user' && source.parentId !== null)
          || !Number.isSafeInteger(source.sequence) || source.sequence <= previousSequence
          || !Number.isSafeInteger(source.createdAt) || source.createdAt <= 0 || source.createdAt > 8.64e15
          || typeof source.textHash !== 'string' || !/^[a-f0-9]{64}$/.test(source.textHash)
          || (source.segment !== undefined && (!Number.isSafeInteger(source.segment.index) || !Number.isSafeInteger(source.segment.total)
            || source.segment.index < 0 || source.segment.total < 2 || source.segment.total > 128 || source.segment.index >= source.segment.total))) return null
        ids.add(source.id); previousSequence = source.sequence
      }
      const primary = evidence.sources.find(source => source.id === evidence.sourceId)
      if (!primary || primary.role !== 'user' || evidence.sources.some(source => source.sequence > primary.sequence)
        || evidence.sources.some(source => source.role === 'assistant' && !evidence.sources!.some(parent => parent.id === source.parentId && parent.role === 'user' && parent.sequence < source.sequence))) return null
    }
    return evidence as MemoryEvidence
  } catch { return null }
}

export function memoryEvidenceText(value?: string | null): string {
  return decodeMemoryEvidence(value)?.excerpt || value || ''
}

/** At most two user turns, including the deciding source; assistant text is never labeled as a user quote. */
export function memoryEvidenceUserReferences(evidence: MemoryEvidence): Array<{ id: string; sessionId: string; textHash?: string }> {
  if (!evidence.sessionId) return []
  if (evidence.version === 1) return [{ id: evidence.sourceId, sessionId: evidence.sessionId }]
  const users = evidence.sources.filter(source => source.role === 'user')
  if (users.some(source => source.id === evidence.sourceId && source.segment)) return []
  return users.filter(source => !source.segment).slice(-2)
    .map(source => ({ id: source.id, sessionId: source.sessionId, textHash: source.textHash }))
}

/** A version snapshot for confirmation, not an authorization token or cryptographic proof. */
export function withMemoryReplacement(value: string, previous: { id: string; content: string; updatedAt: number }): string {
  const evidence = decodeMemoryEvidence(value)
  if (!evidence) return value
  const result = JSON.stringify({ ...evidence, replacement: {
    id: previous.id, contentHash: contentHash(previous.content), updatedAt: previous.updatedAt,
  } })
  if (evidence.version === 2 && !decodeMemoryEvidence(result)) throw new Error('invalid_memory_evidence_replacement')
  return result
}
