import { invoke } from '@tauri-apps/api/core'
import { isDatabaseReady } from '@/services/database/db'
import type { Memory, MemorySourceSnapshot } from '@/services/database/persistence'
import { UnsupportedCapabilityError } from '@/services/externalHttp'
import { isWebRuntime } from '@/services/runtimeCapabilities'
import { areMemoryFactsEquivalent, findActiveFactConflict, shouldActivateAutomaticMemory } from './memoryPolicy'
import { decodeMemoryEvidence, encodeWindowMemoryEvidence, withMemoryReplacement } from './memoryEvidence'
import { parseMemoryWindowCandidates } from './memoryWindowCandidates'
import type { MemoryWindowCandidate } from './memoryWindowCandidates'
import type { MemoryWindowPacket } from './memoryWindowInput'
import type { MemoryWindowClaim } from './memoryWindowLedger'

interface WindowWriteRequest {
  operationId: string
  memory: { id: string; content: string; category: string; status: 'active' | 'candidate'; scopeType: 'global' | 'project';
    scopeKey: string | null; subject: string; factKey: string; factValue: string; confidence: number; evidence: string;
    supersedesId: string | null; createdAt: number; updatedAt: number }
  source: { id: string; snapshots: MemorySourceSnapshot[]; lease: { key: string; value: string } }
}

export type WindowWriteOutcome = 'inserted' | 'already_applied' | 'duplicate' | 'conflict' | 'invalidated' | 'lost_lease'

function normalizedIdentity(value: string): string {
  return value.trim().replace(/\s+/gu, ' ').toLowerCase()
}

function operationIdentity(parts: string[]): string {
  const encoder = new TextEncoder()
  return parts.map(part => `${encoder.encode(part).length}:${part}`).join('')
}

/** Experimental only: a model verdict is not a substitute for the frozen safety and quality gates. */
export async function prepareMemoryWindowWrite(claim: MemoryWindowClaim, packet: MemoryWindowPacket,
  verdict: { candidate: MemoryWindowCandidate; supported: true }, existing: readonly Memory[], now = Date.now()): Promise<WindowWriteRequest | null> {
  if (!Number.isSafeInteger(now) || now <= 0 || verdict.supported !== true) throw new Error('invalid_memory_window_write')
  const locked = JSON.parse(claim.value) as MemoryWindowClaim['record']
  const parsed = parseMemoryWindowCandidates(JSON.stringify([verdict.candidate]), packet, locked.scopeKey)
  if (parsed.candidates.length !== 1 || parsed.rejections.length) throw new Error('invalid_memory_window_candidate')
  const candidate = parsed.candidates[0]
  const evidenceValue = await encodeWindowMemoryEvidence(claim, packet, candidate)
  const decoded = decodeMemoryEvidence(evidenceValue)
  if (!decoded || decoded.version !== (locked.version === 3 ? 3 : 2)) throw new Error('invalid_memory_window_evidence')
  const scopeType = candidate.scope, scopeKey = scopeType === 'project' ? locked.scopeKey : null
  if (scopeType === 'project' && !scopeKey) throw new Error('invalid_memory_window_scope')
  const evidenceIds = new Set(decoded.sources.map(source => source.id))
  const snapshots = packet.snapshots.filter(snapshot => evidenceIds.has(snapshot.id)).map(snapshot => ({ ...snapshot }))
  if (snapshots.length !== evidenceIds.size) throw new Error('invalid_memory_window_sources')
  const version = locked.version === 3 ? 3 : 2
  const identityParts = [String(version), scopeType, scopeKey ?? '', candidate.category, decoded.sessionId]
  for (const source of decoded.sources) identityParts.push(source.id, source.role)
  identityParts.push(candidate.primarySourceId, normalizedIdentity(candidate.subject), normalizedIdentity(candidate.factKey),
    normalizedIdentity(candidate.factValue), 'add')
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(operationIdentity(identityParts)))
  const operationId = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
  const fact = { category: candidate.category, subject: candidate.subject, factKey: candidate.factKey, factValue: candidate.factValue,
    content: candidate.content, scopeType, scopeKey }
  const conflict = findActiveFactConflict([...existing], fact)
  if (version === 3 && conflict) return null
  const replacement = conflict && !areMemoryFactsEquivalent(conflict, fact) ? conflict : undefined
  const primary = packet.turns.find(turn => turn.id === candidate.primarySourceId && turn.role === 'user' && !turn.contextOnly)
  if (!primary?.text) throw new Error('invalid_memory_window_primary')
  const directActive = !candidate.segmented && shouldActivateAutomaticMemory(candidate, primary.text)
  const acceptedContext = version === 3 && !candidate.segmented && candidate.confidence >= 0.85
    && candidate.supportingSourceIds.length > 0
    && /(?:同意|接受|就用|就按|选这个|选第|按你说的|按这个|以后就|没错|确实|是的|i agree|use that|choose that)/i.test(primary.text)
    && candidate.supportingSourceIds.some(id => packet.turns.some(turn => turn.id === id
      && turn.text?.toLowerCase().includes(candidate.factValue.toLowerCase())))
  const active = !replacement && (directActive || acceptedContext)
  const sensitive = candidate.sensitivity === 'sensitive'
  if (version === 3 && !sensitive && !active) return null
  return { operationId, memory: { id: `mem-v${version}-` + operationId, content: candidate.content, category: candidate.category,
    status: version === 3 ? (sensitive ? 'candidate' : 'active') : (active ? 'active' : 'candidate'), scopeType, scopeKey, subject: candidate.subject, factKey: candidate.factKey,
    factValue: candidate.factValue, confidence: candidate.confidence,
    evidence: replacement ? withMemoryReplacement(evidenceValue, replacement) : evidenceValue,
    supersedesId: replacement?.id ?? null, createdAt: now, updatedAt: now },
  source: { id: candidate.primarySourceId, snapshots, lease: { key: claim.key, value: claim.value } } }
}

/** Never called by the existing chat path; callers must enforce evaluation and semantic gates. */
export async function persistMemoryWindowCandidate(request: WindowWriteRequest): Promise<WindowWriteOutcome> {
  if (isWebRuntime()) throw new UnsupportedCapabilityError('长期记忆后台写入')
  if (!isDatabaseReady()) throw new Error('memory_window_database_not_ready')
  const evidence = JSON.parse(request.memory.evidence) as { version?: number }
  const command = evidence.version === 3 ? 'persist_memory_v3_transaction' : 'persist_memory_v2_transaction'
  const result = await invoke<unknown>(command, { request })
  if (!['inserted', 'already_applied', 'duplicate', 'conflict', 'invalidated', 'lost_lease'].includes(String(result))) {
    throw new Error('invalid_memory_window_write_result')
  }
  return result as WindowWriteOutcome
}
