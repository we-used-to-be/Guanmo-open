/**
 * B/C window extraction scheduler.
 *
 * V2: four user turns and a 60-second tail; v3: eight user messages and a five-minute tail.
 *
 * Design constraints (from docs/plans/memory-extraction-optimization.md §4.1 §4.2 §7):
 * - Global model concurrency = 1; reuses idleScheduler priority-60 slot.
 * - Does not touch the existing A (v1 queue) path; runs alongside it.
 * - Does not read from Store at dispatch time; scope/sessionId captured at message persist.
 * - Foreground model connection takes priority; scheduler yields when foregroundBusy.
 * - C idle timer fires only after DB ready and after foreground generation ends.
 * - No infinite retry: acquireMemoryWindow handles MAX_ATTEMPTS and lease expiry.
 * - Not called on Web runtime; callers must guard with isWebRuntime().
 */

import { getDatabase, isDatabaseReady } from '@/services/database/db'
import { loadMemories } from '@/services/database/persistence'
import { idleScheduler } from '@/services/idleScheduler'
import { isWebRuntime } from '@/services/runtimeCapabilities'
import type { ChatRequest } from '@/services/ai/types'
import { persistMemoryIntake } from './memoryIntake'
import { acquireMemoryWindow, countPendingMemoryWindowSources, deferMemoryWindow, finishMemoryWindow,
  getMemoryWindowGroupForSource, getMemoryWindowRetryAt, listPendingMemoryWindowGroupsPage } from './memoryWindowLedger'
import type { MemoryWindowGroup } from './memoryWindowLedger'
import { buildMemoryWindowInput } from './memoryWindowInput'
import { requestMemoryWindowProposals, verifyMemoryWindowProposals } from './memoryWindowModel'
import { prepareMemoryWindowWrite, persistMemoryWindowCandidate } from './memoryWindowPersistence'
import type { MemoryWindowCandidate } from './memoryWindowCandidates'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ModelClient {
  chat(request: ChatRequest): Promise<{ content: string; usage?: unknown }>
}

export interface WindowSchedulerGroup {
  /** Captured at message persist time; never read from current Store state. */
  sessionId: string
  /** Normalized workspace scope key (null = global). */
  scopeKey: string | null
}

// ---------------------------------------------------------------------------
// Internal state (module-singleton, no shared closure leaks across tests)
// ---------------------------------------------------------------------------

const scheduledB = new Set<string>()
interface CIdleEntry { group: MemoryWindowGroup; client: ModelClient; timer: ReturnType<typeof setTimeout> | null;
  lastActivityAt: number; retryAt?: number; retryReady: boolean }
const cIdleEntries = new Map<string, CIdleEntry>()
const cRecoveryScheduled = new Set<2 | 3>()
let lastActivityAt = 0
let foregroundBusy = false
let activeWindowController: AbortController | null = null

/** Reset module-local scheduling state for deterministic scheduler tests. */
export function __resetMemoryWindowSchedulerForTests(): void {
  for (const entry of cIdleEntries.values()) if (entry.timer !== null) clearTimeout(entry.timer)
  activeWindowController?.abort('test_reset')
  activeWindowController = null
  cIdleEntries.clear()
  scheduledB.clear()
  cRecoveryScheduled.clear()
  lastActivityAt = 0
  foregroundBusy = false
}

function groupKey(group: MemoryWindowGroup): string {
  return JSON.stringify([group.policyVersion ?? 2, group.sessionId, group.scopeKey, group.epoch])
}

function versionOf(group: MemoryWindowGroup): 2 | 3 { return group.policyVersion ?? 2 }
function batchSize(group: MemoryWindowGroup): number { return versionOf(group) === 3 ? 8 : 4 }
function idleMs(group: MemoryWindowGroup): number { return versionOf(group) === 3 ? 300_000 : 60_000 }

// ---------------------------------------------------------------------------
// Foreground busy signal
// ---------------------------------------------------------------------------

/** Called by useAiChat before and after each generation to signal foreground state. */
export function setWindowSchedulerForegroundBusy(busy: boolean): void {
  if (foregroundBusy === busy) return
  foregroundBusy = busy
  lastActivityAt = Date.now()
  if (busy) activeWindowController?.abort('foreground_priority')
  for (const [key, entry] of cIdleEntries) {
    if (entry.timer !== null) clearTimeout(entry.timer)
    entry.timer = null
    if (versionOf(entry.group) === 2) entry.lastActivityAt = lastActivityAt
    if (!busy) {
      if (versionOf(entry.group) === 3) {
        void countPendingMemoryWindowSources(entry.group).then(pending => {
          if (pending >= batchSize(entry.group)) scheduleB(entry.group, entry.client)
          else armCIdleTail(key, entry)
        })
      } else armCIdleTail(key, entry)
    }
  }
}

async function runScheduledWindow(group: MemoryWindowGroup, strategy: 'B' | 'C', client: ModelClient,
  groupLastActivityAt = lastActivityAt): Promise<void> {
  if (!isDatabaseReady()) return
  const controller = new AbortController()
  activeWindowController = controller
  try { await runOneWindow(group, strategy, client, controller.signal, groupLastActivityAt) }
  finally { if (activeWindowController === controller) activeWindowController = null }
}

function armCIdleTail(key: string, entry: CIdleEntry): void {
  if (foregroundBusy || isWebRuntime() || !entry.retryReady) return
  const remaining = Math.max(idleMs(entry.group) - (Date.now() - entry.lastActivityAt), (entry.retryAt ?? 0) - Date.now(), 0)
  entry.timer = setTimeout(() => {
    entry.timer = null
    if (foregroundBusy) return
    if (!isDatabaseReady()) {
      entry.timer = setTimeout(() => { entry.timer = null; armCIdleTail(key, entry) }, 5_000)
      return
    }
    idleScheduler.enqueueOptional(async () => {
      await runScheduledWindow(entry.group, 'C', entry.client, entry.lastActivityAt)
      const pending = await countPendingMemoryWindowSources(entry.group)
      if (pending >= batchSize(entry.group)) scheduleB(entry.group, entry.client)
      else if (pending > 0) scheduleCIdleTail(entry.group, entry.client, entry.lastActivityAt)
      else if (cIdleEntries.get(key) === entry) cIdleEntries.delete(key)
    }, 60, '长期记忆尾批补偿 C')
  }, remaining)
}

// ---------------------------------------------------------------------------
// Core single-window execution
// ---------------------------------------------------------------------------

async function runOneWindow(group: MemoryWindowGroup, strategy: 'B' | 'C', client: ModelClient, signal: AbortSignal,
  groupLastActivityAt: number): Promise<void> {
  if (signal.aborted || !isDatabaseReady()) return
  const now = Date.now()
  const acquire = await acquireMemoryWindow(group, strategy, 'window-scheduler', {
    now, lastActivityAt: groupLastActivityAt, foregroundBusy,
  })
  if (acquire.kind !== 'claimed') return

  const { claim } = acquire
  try {
    if (signal.aborted) { await deferMemoryWindow(claim, 'foreground', Date.now()); return }
    const built = await buildMemoryWindowInput(claim)
    if (built.kind === 'blocked') { await deferMemoryWindow(claim, 'retry', Date.now()); return }
    if (built.kind === 'lost_lease') return
    if (built.kind !== 'ready') {
      await deferMemoryWindow(claim, 'retry', Date.now())
      return
    }

    if (versionOf(group) === 3 && built.packets.length !== 1) throw new Error('invalid_memory_v3_packet_count')
    const invalidated = new Set(built.invalidatedSourceIds)
    const results: Record<string, 'completed' | 'noop' | 'invalidated' | 'failed'> = {}
    for (const id of claim.record.sourceIds) {
      if (invalidated.has(id)) results[id] = 'invalidated'
    }
    for (const id of built.failedSourceIds ?? []) results[id] = 'failed'

    const scopeKey = (JSON.parse(claim.value) as { scopeKey: string | null }).scopeKey
    const existingMemories = isDatabaseReady()
      ? await loadMemories({ scopeType: scopeKey ? 'project' : 'global', scopeKey: scopeKey ?? undefined })
      : []

    for (const packet of built.packets) {
      if (signal.aborted || !isDatabaseReady()) { await deferMemoryWindow(claim, signal.aborted ? 'foreground' : 'retry', Date.now()); return }
      if (!packet.needsModel) {
        for (const id of packet.newSourceIds) { if (!results[id]) results[id] = 'noop' }
        continue
      }

      const proposals = await requestMemoryWindowProposals(claim, packet, existingMemories, client,
        { signal, foregroundBusy: () => foregroundBusy })
      if (proposals.kind === 'deferred' || proposals.kind === 'lost_lease' || proposals.kind === 'retry') {
        await deferMemoryWindow(claim, proposals.kind === 'deferred' ? 'foreground' : 'retry', Date.now()); return
      }
      if (proposals.kind === 'noop' || proposals.kind === 'oversize') {
        for (const id of packet.newSourceIds) { if (!results[id]) results[id] = proposals.kind === 'oversize' ? 'failed' : 'noop' }
        continue
      }
      if (proposals.kind !== 'proposals') continue

      if (!proposals.candidates.length) {
        for (const id of packet.newSourceIds) { if (!results[id]) results[id] = 'noop' }
        continue
      }

      let supportedCandidates: Array<{ candidate: MemoryWindowCandidate; supported: true }>
      if (versionOf(group) === 3) {
        supportedCandidates = proposals.candidates.map(candidate => ({ candidate, supported: true }))
      } else {
        const verified = await verifyMemoryWindowProposals(claim, packet, proposals.candidates, client,
          { signal, foregroundBusy: () => foregroundBusy })
        if (verified.kind === 'deferred' || verified.kind === 'lost_lease' || verified.kind === 'retry') {
          await deferMemoryWindow(claim, verified.kind === 'deferred' ? 'foreground' : 'retry', Date.now()); return
        }
        if (signal.aborted || !isDatabaseReady()) { await deferMemoryWindow(claim, signal.aborted ? 'foreground' : 'retry', Date.now()); return }
        supportedCandidates = verified.kind === 'verified'
          ? verified.verdicts.filter((v): v is { candidate: MemoryWindowCandidate; supported: true } => v.supported)
          : []
      }

      for (const verdict of supportedCandidates) {
        if (signal.aborted || !isDatabaseReady()) { await deferMemoryWindow(claim, signal.aborted ? 'foreground' : 'retry', Date.now()); return }
        try {
          const writeRequest = await prepareMemoryWindowWrite(claim, packet, verdict, existingMemories)
          if (!writeRequest) continue
          const outcome = await persistMemoryWindowCandidate(writeRequest)
          if (outcome === 'invalidated' || outcome === 'lost_lease' || (outcome === 'conflict' && versionOf(group) === 2)) {
            await deferMemoryWindow(claim, 'retry', Date.now())
            return
          }
        } catch (err) {
          console.warn('[Memory] window candidate write error', err instanceof Error ? err.message : err)
          await deferMemoryWindow(claim, 'retry', Date.now())
          return
        }
      }
      if (signal.aborted || !isDatabaseReady()) { await deferMemoryWindow(claim, signal.aborted ? 'foreground' : 'retry', Date.now()); return }
      for (const id of packet.newSourceIds) { if (!results[id]) results[id] = 'completed' }
    }

    // Fill any remaining unresolved sources as noop.
    for (const id of claim.record.sourceIds) { if (!results[id]) results[id] = 'noop' }
    await finishMemoryWindow(claim, results, Date.now())
    const pending = await countPendingMemoryWindowSources(group)
    if (pending >= batchSize(group)) scheduleB(group, client)
    else if (pending > 0) scheduleCIdleTail(group, client, cIdleEntries.get(groupKey(group))?.lastActivityAt ?? Date.now())
  } catch (err) {
    console.warn('[Memory] window extraction error', err instanceof Error ? err.message : err)
    try { await deferMemoryWindow(claim, 'retry', Date.now()) } catch { /* lease may already be lost */ }
  }
}

// ---------------------------------------------------------------------------
// B scheduler: fires after each intake registration
// ---------------------------------------------------------------------------

function scheduleB(group: MemoryWindowGroup, client: ModelClient): void {
  if (isWebRuntime()) return
  const key = groupKey(group)
  if (scheduledB.has(key)) return
  scheduledB.add(key)
  idleScheduler.enqueueOptional(async () => {
    scheduledB.delete(key)
    if (foregroundBusy) {
      scheduleCIdleTail(group, client, cIdleEntries.get(key)?.lastActivityAt ?? Date.now())
      return
    }
    const retryAt = await getMemoryWindowRetryAt(group)
    if (retryAt && retryAt > Date.now()) {
      scheduleCIdleTail(group, client, cIdleEntries.get(key)?.lastActivityAt ?? Date.now())
      return
    }
    await runScheduledWindow(group, 'B', client)
    if (!scheduledB.has(key)) {
      const pending = await countPendingMemoryWindowSources(group)
      const nextAttemptAt = await getMemoryWindowRetryAt(group)
      if (pending >= batchSize(group) && (!nextAttemptAt || nextAttemptAt <= Date.now())) scheduleB(group, client)
      else if (pending > 0) scheduleCIdleTail(group, client, cIdleEntries.get(key)?.lastActivityAt ?? Date.now())
      void scheduleWindowRecovery(client, versionOf(group))
    }
  }, 60, '长期记忆窗口提取 B')
}

// ---------------------------------------------------------------------------
// C idle tail-flush: starts 60 s after last activity
// ---------------------------------------------------------------------------

function scheduleCIdleTail(group: MemoryWindowGroup, client: ModelClient, lastActivityAt = Date.now()): void {
  if (isWebRuntime()) return
  const key = groupKey(group)
  const previous = cIdleEntries.get(key)
  if (previous?.timer !== null && previous?.timer !== undefined) clearTimeout(previous.timer)
  const entry: CIdleEntry = { group, client, timer: null,
    lastActivityAt: previous ? Math.max(previous.lastActivityAt, lastActivityAt) : lastActivityAt,
    retryAt: previous?.retryAt, retryReady: false }
  cIdleEntries.set(key, entry)
  void getMemoryWindowRetryAt(group).then(retryAt => {
    if (cIdleEntries.get(key) !== entry) return
    entry.retryAt = retryAt ?? undefined
    entry.retryReady = true
    armCIdleTail(key, entry)
  })
}

// ---------------------------------------------------------------------------
// C recovery: runs once after DB ready, picks up abandoned pending windows
// ---------------------------------------------------------------------------

export function scheduleWindowRecovery(client: ModelClient, policyVersion: 2 | 3 = 2): void {
  if (isWebRuntime() || cRecoveryScheduled.has(policyVersion)) return
  cRecoveryScheduled.add(policyVersion)
  if (!isDatabaseReady()) { cRecoveryScheduled.delete(policyVersion); return }
  idleScheduler.enqueueOptional(async () => {
    try {
      let cursor: string | null = null
      for (;;) {
        const page = await listPendingMemoryWindowGroupsPage(policyVersion, cursor)
        for (const pending of page.groups) {
          if (!isDatabaseReady()) return
          const actualPending = await countPendingMemoryWindowSources(pending.group)
          if (actualPending >= batchSize(pending.group)) {
            scheduleB(pending.group, client)
            continue
          }
          scheduleCIdleTail(pending.group, client, pending.lastActivityAt)
        }
        if (!page.nextCursor) break
        cursor = page.nextCursor
      }
    } finally {
      cRecoveryScheduled.delete(policyVersion)
    }
  }, 61, '长期记忆启动恢复 C')
}

/** Schedule only v3 global intake receipts created by the atomic chat-message command. */
export async function scheduleGlobalWindowExtraction(sourceId: string, sessionId: string, client: ModelClient): Promise<void> {
  if (isWebRuntime() || !isDatabaseReady()) return
  const group = await getMemoryWindowGroupForSource(sourceId, sessionId, null, 3)
  if (!group) return
  const pending = await countPendingMemoryWindowSources(group)
  if (pending >= batchSize(group)) scheduleB(group, client)
  scheduleCIdleTail(group, client, Date.now())
  void scheduleWindowRecovery(client, 3)
}

interface PersistedUserSource {
  id: string
  session_id: string
  role: string
  parent_id: string | null
  content: string
  metadata: string | null
  created_at: number
}

/** Read the already-persisted source and capture the scope before background work. */
export async function schedulePersistedWindowExtraction(sourceId: string, sessionId: string,
  scopeKey: string | null, strategy: 'B' | 'C', client: ModelClient): Promise<void> {
  if (isWebRuntime() || !isDatabaseReady()) return
  const [source] = await getDatabase().select<PersistedUserSource>(
    "SELECT id, session_id, role, parent_id, content, metadata, created_at FROM chat_messages WHERE id = $1 AND session_id = $2 AND role = 'user'",
    [sourceId, sessionId],
  )
  if (!source || source.parent_id !== null || !Number.isSafeInteger(source.created_at) || source.created_at <= 0) return
  await scheduleWindowExtraction({ id: source.id, sessionId: source.session_id, content: source.content,
    metadata: source.metadata, createdAt: source.created_at },
  { sessionId, scopeKey }, strategy, client)
}

// ---------------------------------------------------------------------------
// Public entry point: called from useAiChat (or conversationCommands) after
// a user message is successfully persisted.
// ---------------------------------------------------------------------------

/**
 * Register a persisted user message into the B/C window pipeline and schedule processing.
 *
 * Must be called AFTER the message is durably stored in SQLite.
 * The scopeKey and sessionId are captured here; they must not be read from Store later.
 */
export async function scheduleWindowExtraction(
  message: { id: string; sessionId: string; content: string; metadata?: string | null; createdAt: number },
  group: WindowSchedulerGroup,
  strategy: 'B' | 'C',
  client: ModelClient,
): Promise<void> {
  if (isWebRuntime() || !isDatabaseReady()) return
  lastActivityAt = Date.now()
  for (const [key, entry] of cIdleEntries) {
    if (entry.timer !== null) clearTimeout(entry.timer)
    entry.timer = null
    entry.lastActivityAt = lastActivityAt
    armCIdleTail(key, entry)
  }

  try {
    await persistMemoryIntake(
      { id: message.id, sessionId: message.sessionId, content: message.content, metadata: message.metadata, createdAt: message.createdAt },
      group.scopeKey,
    )
  } catch (err) {
    // Non-fatal: intake failure means this message won't enter B/C, but A path still runs.
    console.warn('[Memory] window intake registration failed', err instanceof Error ? err.message : err)
    return
  }

  const ledgerGroup = await getMemoryWindowGroupForSource(message.id, message.sessionId, group.scopeKey)
  if (!ledgerGroup) return
  scheduleB(ledgerGroup, client)
  if (strategy === 'C') scheduleCIdleTail(ledgerGroup, client)
  scheduleWindowRecovery(client)
}
