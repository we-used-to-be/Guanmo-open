import type { ChatMessage, ChatRequest } from '@/services/ai/types'
import { getDatabase, isDatabaseReady } from '@/services/database/db'
import { idleScheduler } from '@/services/idleScheduler'
import { normalizeMemoryScopeKey, shouldExtractMemoryCandidate, isExplicitMemoryWriteIntent } from './memoryPolicy'
import { MemoryCandidateCapacityError, processMemoryCandidateExtraction } from './memoryService'

const PREFIX = 'memory-extraction:v1:'
const LEASE_MS = 60_000
const TIMEOUT_MS = 20_000
const MAX_ATTEMPTS = 3

interface ExtractionJob {
  version: 1
  sourceId: string
  sessionId: string
  scopeKey: string | null
  createdAt: number
  status: 'pending' | 'running' | 'completed' | 'failed'
  attempts: number
  leaseUntil: number
}
interface JobRow { key: string; value: string }
interface SourceRow { id: string; session_id: string; role: string; content: string; metadata: string | null; created_at: number }
type Client = { chat(request: ChatRequest): Promise<{ content: string }> }

function decodeJob(row: JobRow): ExtractionJob | null {
  try {
    const job = JSON.parse(row.value) as ExtractionJob
    return job.version === 1 && typeof job.sourceId === 'string' && job.sourceId.length <= 300
      && typeof job.sessionId === 'string' && job.sessionId.length <= 300
      && row.key === PREFIX + job.sourceId && (job.scopeKey === null || typeof job.scopeKey === 'string')
      && ['pending', 'running', 'completed', 'failed'].includes(job.status)
      && Number.isInteger(job.attempts) && job.attempts >= 0 && job.attempts <= MAX_ATTEMPTS
      && Number.isFinite(job.createdAt) && Number.isFinite(job.leaseUntil) ? job : null
  } catch { return null }
}

async function readSource(job: ExtractionJob): Promise<{ message: ChatMessage; raw: SourceRow } | null> {
  const [row] = await getDatabase().select<SourceRow>(
    "SELECT id, session_id, role, content, metadata, created_at FROM chat_messages WHERE id = $1 AND session_id = $2 AND role = 'user'",
    [job.sourceId, job.sessionId],
  )
  if (!row) return null
  let text = row.content
  try {
    const metadata: unknown = row.metadata ? JSON.parse(row.metadata) : null
    if (metadata && typeof metadata === 'object' && 'displayContent' in metadata && typeof metadata.displayContent === 'string') text = metadata.displayContent
  } catch { return null }
  // Only user-visible input is sent. Old tagged messages without a display snapshot are skipped.
  if (text.length > 6000 || text.includes('【上下文') || !shouldExtractMemoryCandidate(text) || isExplicitMemoryWriteIntent(text)) return null
  return { raw: row, message: { id: row.id, sessionId: row.session_id, role: 'user', content: text,
    timestamp: row.created_at < 1e12 ? row.created_at * 1000 : row.created_at } }
}

/** Durable receipts live in existing SQLite settings, never in user-facing/localStorage configuration. */
export class MemoryExtractionQueue {
  private running = false

  async enqueue(message: ChatMessage, sessionId: string, workspacePath?: string | null): Promise<boolean> {
    const text = message.displayContent || message.content
    if (!isDatabaseReady() || !message.id || message.role !== 'user' || message.hidden
      || text.length > 6000 || !shouldExtractMemoryCandidate(text) || isExplicitMemoryWriteIntent(text)) return false
    const job: ExtractionJob = { version: 1, sourceId: message.id, sessionId,
      scopeKey: normalizeMemoryScopeKey('project', workspacePath), createdAt: Date.now(),
      status: 'pending', attempts: 0, leaseUntil: 0 }
    const result = await getDatabase().execute(
      `INSERT OR IGNORE INTO settings (key, value, updated_at)
       SELECT $1, $2, unixepoch() WHERE EXISTS (SELECT 1 FROM chat_messages WHERE id = $3 AND session_id = $4 AND role = 'user')`,
      [PREFIX + message.id, JSON.stringify(job), message.id, sessionId],
    )
    return result.rowsAffected === 1
  }

  async drain(client: Client): Promise<number | undefined> {
    if (this.running || !isDatabaseReady()) return
    this.running = true
    try {
      const rows = await getDatabase().select<JobRow>(
        `SELECT key, value FROM settings WHERE key LIKE 'memory-extraction:v1:%'
         AND CASE WHEN json_valid(value) THEN json_extract(value, '$.status') END IN ('pending','running')
         ORDER BY updated_at ASC, key ASC LIMIT 24`,
      )
      const claimed: Array<{ row: JobRow; job: ExtractionJob; source: NonNullable<Awaited<ReturnType<typeof readSource>>> }> = []
      let scope: string | null | undefined
      let leaseDelay: number | undefined
      for (const row of rows) {
        const job = decodeJob(row)
        if (!job) continue
        if (job.leaseUntil > Date.now()) {
          leaseDelay = Math.min(leaseDelay ?? LEASE_MS, job.leaseUntil - Date.now() + 1)
          continue
        }
        if (job.attempts >= MAX_ATTEMPTS || Date.now() - job.createdAt > 7 * 86400_000) {
          await this.finish(row, { ...job, status: 'failed', leaseUntil: 0 })
          continue
        }
        if (scope !== undefined && scope !== job.scopeKey) continue
        const source = await readSource(job)
        if (!source) { await this.finish(row, { ...job, status: 'completed' }); continue }
        const next: ExtractionJob = { ...job, status: 'running', attempts: job.attempts + 1, leaseUntil: Date.now() + LEASE_MS }
        const value = JSON.stringify(next)
        const result = await getDatabase().execute('UPDATE settings SET value = $1, updated_at = unixepoch() WHERE key = $2 AND value = $3', [value, row.key, row.value])
        if (result.rowsAffected !== 1) continue
        claimed.push({ row: { ...row, value }, job: next, source })
        scope = job.scopeKey
        if (claimed.length === 3) break
      }
      if (!claimed.length) return leaseDelay
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort('memory_extraction_timeout'), TIMEOUT_MS)
      const isSourceValid = async () => {
        if (controller.signal.aborted || !isDatabaseReady()) return false
        for (const item of claimed) {
          const current = await readSource(item.job)
          if (!current || current.raw.content !== item.source.raw.content || current.raw.metadata !== item.source.raw.metadata) return false
        }
        return true
      }
      try {
        // Race a non-cooperative provider as well; late output remains unable to persist.
        await Promise.race([
          processMemoryCandidateExtraction(claimed.map(item => item.source.message), client, .1, {
            workspacePath: scope, signal: controller.signal, isSourceValid,
            triggerReason: 'idle_batch', throwOnFailure: true,
            sourceContents: Object.fromEntries(claimed.map(item => [item.source.raw.id, item.source.raw.content])),
          }),
          new Promise<never>((_, reject) => controller.signal.addEventListener('abort', () => reject(new Error('memory_timeout')), { once: true })),
        ])
        if (controller.signal.aborted) throw new Error('memory_timeout')
        for (const item of claimed) await this.finish(item.row, { ...item.job, status: 'completed', leaseUntil: 0 })
        return 500
      } catch (error) {
        if (error instanceof MemoryCandidateCapacityError) {
          for (const item of claimed) await this.finish(item.row, { ...item.job, status: 'pending', attempts: item.job.attempts - 1, leaseUntil: Date.now() + LEASE_MS })
          return LEASE_MS + 1
        }
        for (const item of claimed) await this.finish(item.row, { ...item.job,
          status: item.job.attempts >= MAX_ATTEMPTS ? 'failed' : 'pending', leaseUntil: 0 })
        console.info('[Memory] background batch deferred', { count: claimed.length })
        return 1000 * 2 ** Math.max(...claimed.map(item => item.job.attempts))
      } finally {
        controller.abort('memory_batch_finished')
        clearTimeout(timer)
      }
    } finally { this.running = false }
  }

  private async finish(row: JobRow, job: ExtractionJob) {
    await getDatabase().execute('UPDATE settings SET value = $1, updated_at = unixepoch() WHERE key = $2 AND value = $3', [JSON.stringify(job), row.key, row.value])
  }
}

const queue = new MemoryExtractionQueue()
let scheduled = false
function scheduleDrain(client: Client, delayMs = 500) {
  if (scheduled) return
  scheduled = true
  setTimeout(() => {
    idleScheduler.enqueueOptional(async () => {
      scheduled = false
      try {
        const retryDelay = await queue.drain(client)
        if (retryDelay !== undefined) scheduleDrain(client, retryDelay)
      } catch { console.info('[Memory] queue waiting for database availability') }
    }, 60, '长期记忆候选提取')
  }, delayMs)
}
export async function scheduleMemoryExtraction(message: ChatMessage, sessionId: string, workspacePath: string | null, client: Client) {
  if (!isDatabaseReady()) return
  await queue.enqueue(message, sessionId, workspacePath)
  // Recovery also runs for a general question; no extraction request is made without pending eligible jobs.
  scheduleDrain(client)
}
