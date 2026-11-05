import { getDatabase, isDatabaseReady } from '@/services/database/db'
import type { MemorySourceSnapshot } from '@/services/database/persistence'
import { fingerprintGlobalMemorySource, fingerprintMemorySource } from './memoryIntake'
import { classifyGlobalMemoryInputGap, isVisibleSelectionQuestion } from './memoryInputPolicy'

export interface MemoryIntakeIdentity {
  sourceId: string
  sessionId: string
  sourceFingerprint: string
  policyVersion?: 2 | 3
}

type IntakeSource =
  | { kind: 'ready'; visibleText: string; snapshot: MemorySourceSnapshot }
  | { kind: 'segmented'; segments: string[]; snapshot: MemorySourceSnapshot }
  | { kind: 'gap'; reason: 'hidden' | 'sensitive' | 'refusal' | 'explicit' | 'transformation' | 'missing_visible_text' }
  | { kind: 'invalidated' }
  | { kind: 'blocked' }
  | { kind: 'oversize' }

interface SourceRow {
  id: string
  session_id: string
  role: string
  parent_id: string | null
  content: string
  metadata: string | null
  created_at: number
}

/** Preserve every code point while accounting for JSON escapes; segments are never complete turns. */
export function splitMemoryInput(text: string, maxBytes = 3000, maxSegments = 128): string[] | null {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 4 || !Number.isSafeInteger(maxSegments) || maxSegments < 1) {
    throw new Error('invalid_memory_segment_budget')
  }
  if (text.length > maxBytes * maxSegments) return null
  const points = Array.from(text), parts: string[] = []
  let start = 0
  while (start < points.length) {
    let end = start, bytes = 0, boundary = start
    while (end < points.length) {
      const point = points[end].codePointAt(0)!
      const size = point === 0x22 || point === 0x5c || [8, 9, 10, 12, 13].includes(point) ? 2
        : point < 0x20 || point >= 0xd800 && point <= 0xdfff ? 6
          : point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4
      if (bytes + size > maxBytes) break
      bytes += size
      if (/[\s。！？!?；;，,]/u.test(points[end])) boundary = end + 1
      end++
    }
    if (end < points.length && boundary > start) end = boundary
    if (end === start || parts.length >= maxSegments) return null
    parts.push(points.slice(start, end).join(''))
    start = end
  }
  return parts.length ? parts : ['']
}

/** Read only the exact registered source; raw snapshot is for local SQL guards, never for a model request. */
export async function readMemoryIntakeSource(identity: MemoryIntakeIdentity): Promise<IntakeSource> {
  if (!identity.sourceId || identity.sourceId.length > 300 || !identity.sessionId || identity.sessionId.length > 300
    || !/^[a-f0-9]{64}$/.test(identity.sourceFingerprint)) return { kind: 'invalidated' }
  if (!isDatabaseReady()) return { kind: 'blocked' }
  const [row] = await getDatabase().select<SourceRow>(
    "SELECT id, session_id, role, parent_id, content, metadata, created_at FROM chat_messages WHERE id = $1 AND session_id = $2 AND role = 'user'",
    [identity.sourceId, identity.sessionId],
  )
  if (!isDatabaseReady()) return { kind: 'blocked' }
  if (!row || row.id !== identity.sourceId || row.session_id !== identity.sessionId || row.role !== 'user'
    || row.parent_id !== null || typeof row.content !== 'string' || (row.metadata !== null && typeof row.metadata !== 'string')
    || !Number.isSafeInteger(row.created_at) || row.created_at <= 0) return { kind: 'invalidated' }
  let metadata: Record<string, unknown> = {}
  if (row.metadata !== null) {
    try {
      const parsed: unknown = JSON.parse(row.metadata)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { kind: 'gap', reason: 'missing_visible_text' }
      metadata = parsed as Record<string, unknown>
    } catch { return { kind: 'gap', reason: 'missing_visible_text' } }
  }
  if (metadata.hidden === true) return { kind: 'gap', reason: 'hidden' }
  if (('hidden' in metadata && typeof metadata.hidden !== 'boolean')
    || ('tags' in metadata && !Array.isArray(metadata.tags))
    || ('displayContent' in metadata && typeof metadata.displayContent !== 'string')) return { kind: 'gap', reason: 'missing_visible_text' }
  const hasTags = Array.isArray(metadata.tags) && metadata.tags.length > 0
  const visibleText = typeof metadata.displayContent === 'string' ? metadata.displayContent : null
  if (visibleText === null && (hasTags || row.content.includes('【上下文'))) return { kind: 'gap', reason: 'missing_visible_text' }
  const text = visibleText ?? row.content
  const fingerprint = identity.policyVersion === 3
    ? await fingerprintGlobalMemorySource(text, row.created_at)
    : await fingerprintMemorySource(row.content, row.metadata, row.created_at)
  if (!isDatabaseReady()) return { kind: 'blocked' }
  if (fingerprint !== identity.sourceFingerprint) return { kind: 'invalidated' }
  const gap = classifyGlobalMemoryInputGap(text, identity.policyVersion === 3 && isVisibleSelectionQuestion(text, row.metadata))
  if (gap) return { kind: 'gap', reason: gap }
  const segments = splitMemoryInput(text)
  if (!segments) return { kind: 'oversize' }
  const snapshot: MemorySourceSnapshot = { id: row.id, sessionId: row.session_id, role: 'user',
    parentId: row.parent_id, content: row.content, metadata: row.metadata, createdAt: row.created_at }
  return segments.length === 1 ? { kind: 'ready', visibleText: text, snapshot } : { kind: 'segmented', segments, snapshot }
}
