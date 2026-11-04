import { getDatabase, isDatabaseReady } from '@/services/database/db'
import type { MemoryWindowClaim } from './memoryWindowLedger'

export interface ExtractionHistory {
  id: string
  completedAt: number
  sources: Array<{ sourceId: string; sessionId: string; sourceFingerprint: string }>
  modelCalled: boolean
  formatRepaired?: boolean
  proposed: number
  rejected: number
  rejectionReasons?: string[]
  inserted: number
  skipped: number
  decisions?: Array<{ sourceId: string; outcome: 'inserted' | 'skipped'; state?: 'active' | 'candidate'; reason?: 'conflict' | 'policy' | 'duplicate' }>
}

const KEY = 'memory-extraction:v3:history'

/** One atomic SQLite statement keeps two summaries, without copying chat or model text. */
export async function saveExtractionHistory(claim: MemoryWindowClaim, summary: Omit<ExtractionHistory, 'id' | 'completedAt' | 'sources'>): Promise<void> {
  if (!isDatabaseReady()) return
  const sources = claim.record.receiptValues.map(value => {
    const receipt = JSON.parse(value)
    return { sourceId: receipt.sourceId, sessionId: receipt.sessionId, sourceFingerprint: receipt.sourceFingerprint }
  })
  const history: ExtractionHistory = { id: claim.record.windowId, completedAt: Date.now(), sources, ...summary }
  await getDatabase().execute(`INSERT INTO settings (key, value, updated_at) VALUES ($1, json_array(json($2)), unixepoch())
    ON CONFLICT(key) DO UPDATE SET value = CASE WHEN json_valid(settings.value) AND json_type(settings.value) = 'array'
      AND json_array_length(settings.value) > 0 THEN json_insert(json_array(json($2)), '$[#]', json_extract(settings.value, '$[0]'))
      ELSE json_array(json($2)) END, updated_at = unixepoch()`, [KEY, JSON.stringify(history)])
}

export async function loadExtractionHistory(): Promise<ExtractionHistory[]> {
  if (!isDatabaseReady()) return []
  const [row] = await getDatabase().select<{ value: string }>('SELECT value FROM settings WHERE key = $1', [KEY])
  if (!row) return []
  try {
    const value: unknown = JSON.parse(row.value)
    if (!Array.isArray(value)) return []
    return value.slice(0, 2).filter((item): item is ExtractionHistory => item && typeof item.id === 'string'
      && Number.isSafeInteger(item.completedAt) && Array.isArray(item.sources) && item.sources.length <= 8
      && item.sources.every((source: Record<string, unknown>) => typeof source.sourceId === 'string'
        && typeof source.sessionId === 'string' && typeof source.sourceFingerprint === 'string')
      && (item.decisions === undefined || Array.isArray(item.decisions) && item.decisions.length <= 6
        && item.decisions.every((decision: Record<string, unknown>) => decision && typeof decision.sourceId === 'string'
          && ['inserted', 'skipped'].includes(String(decision.outcome))
          && (decision.state === undefined || ['active', 'candidate'].includes(String(decision.state)))
          && (decision.reason === undefined || ['conflict', 'policy', 'duplicate'].includes(String(decision.reason)))))
      && (item.rejectionReasons === undefined || Array.isArray(item.rejectionReasons) && item.rejectionReasons.length <= 6
        && item.rejectionReasons.every((reason: unknown) => typeof reason === 'string' && ['shape', 'source', 'sensitive', 'scope', 'unsupported_value', 'content_mismatch', 'undecided', 'negation', 'policy'].includes(reason)))
      && (item.formatRepaired === undefined || typeof item.formatRepaired === 'boolean')
      && typeof item.modelCalled === 'boolean' && ['proposed', 'rejected', 'inserted', 'skipped']
        .every(key => Number.isSafeInteger(item[key]) && item[key] >= 0))
  } catch { return [] }
}
