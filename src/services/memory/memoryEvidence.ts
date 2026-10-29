import type { ChatMessage } from '@/services/ai/types'
import { contentHash } from './memoryPolicy'

export interface MemoryEvidence {
  version: 1
  kind: 'semantic' | 'episodic'
  sourceId: string
  sessionId?: string
  recordedAt?: number
  /** Early v1 records used this name for the message timestamp, not an inferred event date. */
  occurredAt?: number
  excerpt: string
  replacement?: { id: string; contentHash: string; updatedAt: number }
}

export function encodeMemoryEvidence(message: ChatMessage, kind: MemoryEvidence['kind'] = 'semantic'): string {
  const excerpt = (message.displayContent || message.content).slice(0, 1200)
  if (!message.id) return excerpt
  return JSON.stringify({ version: 1, kind, sourceId: message.id,
    sessionId: message.sessionId, recordedAt: message.timestamp, excerpt } satisfies MemoryEvidence)
}

export function decodeMemoryEvidence(value?: string | null): MemoryEvidence | null {
  if (!value?.startsWith('{') || value.length > 6000) return null
  try {
    const evidence = JSON.parse(value) as Partial<MemoryEvidence>
    if (evidence.version !== 1 || !['semantic', 'episodic'].includes(evidence.kind || '')
      || typeof evidence.sourceId !== 'string' || !evidence.sourceId || evidence.sourceId.length > 300
      || typeof evidence.excerpt !== 'string' || evidence.excerpt.length > 1200
      || (evidence.sessionId !== undefined && typeof evidence.sessionId !== 'string')
      || [evidence.recordedAt, evidence.occurredAt].some(time => time !== undefined && (!Number.isFinite(time) || time <= 0 || time > 8.64e15))) return null
    if (evidence.replacement && (typeof evidence.replacement.id !== 'string'
      || typeof evidence.replacement.contentHash !== 'string' || !/^[a-f0-9]{1,8}$/.test(evidence.replacement.contentHash)
      || !Number.isFinite(evidence.replacement.updatedAt))) return null
    return evidence as MemoryEvidence
  } catch { return null }
}

export function memoryEvidenceText(value?: string | null): string {
  return decodeMemoryEvidence(value)?.excerpt || value || ''
}

/** A version snapshot for confirmation, not an authorization token or cryptographic proof. */
export function withMemoryReplacement(value: string, previous: { id: string; content: string; updatedAt: number }): string {
  const evidence = decodeMemoryEvidence(value)
  return evidence ? JSON.stringify({ ...evidence, replacement: {
    id: previous.id, contentHash: contentHash(previous.content), updatedAt: previous.updatedAt,
  } }) : value
}
