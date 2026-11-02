// @vitest-environment node
/**
 * memoryWindowScheduler unit tests.
 *
 * Tests verify:
 * - intake registration happens before scheduling
 * - B strategy fires after 4 pending sources
 * - C strategy arms a 60-s idle timer
 * - foreground-busy signal defers the window claim
 * - scheduler does not bleed state between scopes (scope isolation)
 * - non-Tauri / non-DB paths are silently skipped
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  isWeb: vi.fn(() => false),
  dbReady: vi.fn(() => true),
  dbSelect: vi.fn(async () => []),
  persistIntake: vi.fn(async () => true),
  acquire: vi.fn(),
  getRetryAt: vi.fn(async () => null),
  buildInput: vi.fn(),
  requestProposals: vi.fn(),
  verifyProposals: vi.fn(),
  prepareWrite: vi.fn(),
  persistWrite: vi.fn(),
  finish: vi.fn(async () => true),
  defer: vi.fn(async () => true),
  loadMemories: vi.fn(async () => []),
  getGroup: vi.fn(async (_sourceId: string, sessionId: string, scopeKey: string | null) => ({ sessionId, scopeKey, epoch: 0 })),
  listPending: vi.fn(async () => []),
  listPendingPage: vi.fn(async () => ({ groups: [], nextCursor: null })),
  countPending: vi.fn(async () => 0),
  idleQueue: [] as Array<() => Promise<void>>,
  idle: { enqueueOptional: vi.fn((fn: () => Promise<void>, _priority: number, _label: string) => {
    mocks.idleQueue.push(fn); return () => {}
  }) },
}))

vi.mock('@/services/runtimeCapabilities', () => ({ isWebRuntime: mocks.isWeb }))
vi.mock('@/services/database/db', () => ({ isDatabaseReady: mocks.dbReady, getDatabase: () => ({ select: mocks.dbSelect }) }))
vi.mock('@/services/database/persistence', () => ({ loadMemories: mocks.loadMemories }))
vi.mock('@/services/idleScheduler', () => ({ idleScheduler: mocks.idle }))
vi.mock('@/services/memory/memoryIntake', () => ({ persistMemoryIntake: mocks.persistIntake }))
vi.mock('@/services/memory/memoryWindowLedger', () => ({
  acquireMemoryWindow: mocks.acquire,
  countPendingMemoryWindowSources: mocks.countPending,
  finishMemoryWindow: mocks.finish,
  deferMemoryWindow: mocks.defer,
  getMemoryWindowRetryAt: mocks.getRetryAt,
  getMemoryWindowGroupForSource: mocks.getGroup,
  listPendingMemoryWindowGroupsPage: mocks.listPendingPage,
}))
vi.mock('@/services/memory/memoryWindowInput', () => ({ buildMemoryWindowInput: mocks.buildInput }))
vi.mock('@/services/memory/memoryWindowModel', () => ({
  requestMemoryWindowProposals: mocks.requestProposals,
  verifyMemoryWindowProposals: mocks.verifyProposals,
}))
vi.mock('@/services/memory/memoryWindowPersistence', () => ({
  prepareMemoryWindowWrite: mocks.prepareWrite,
  persistMemoryWindowCandidate: mocks.persistWrite,
}))
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))

import { scheduleGlobalWindowExtraction, schedulePersistedWindowExtraction, scheduleWindowExtraction,
  setWindowSchedulerForegroundBusy, __resetMemoryWindowSchedulerForTests } from '@/services/memory/memoryWindowScheduler'

const client = { chat: vi.fn() }

const group = (overrides: Partial<{ sessionId: string; scopeKey: string | null }> = {}) => ({
  sessionId: 'session-a', scopeKey: 'scope-p', ...overrides,
})

const message = (id = 'u1') => ({
  id, sessionId: 'session-a', content: '我喜欢技术回答先给结论。',
  metadata: null as string | null, createdAt: Date.now(),
})

async function runIdleQueue(): Promise<void> {
  const jobs = mocks.idleQueue.splice(0)
  for (const job of jobs) await job()
}

const claimedAcquire = (version: 2 | 3 = 2) => {
  const record = { version, sessionId: 'session-a', scopeKey: version === 3 ? null : 'scope-p', epoch: 0,
    windowId: 'w:1', status: 'running', owner: 'worker', leaseUntil: Date.now() + 60_000,
    nextAttemptAt: 0, attempts: 1, createdAt: Date.now(),
    sourceIds: ['u1'], receiptValues: ['{}'], prefixIds: [], prefixReceiptValues: [] }
  const value = JSON.stringify(record)
  return { kind: 'claimed' as const, claim: { key: 'w', value, record } }
}

beforeEach(() => {
  __resetMemoryWindowSchedulerForTests()
  vi.clearAllMocks()
  mocks.idleQueue.length = 0
  mocks.getGroup.mockImplementation(async (_sourceId, sessionId, scopeKey) => ({ sessionId, scopeKey, epoch: 0 }))
  mocks.listPending.mockResolvedValue([])
  mocks.listPendingPage.mockResolvedValue({ groups: [], nextCursor: null })
  mocks.getRetryAt.mockResolvedValue(null)
  mocks.countPending.mockResolvedValue(0)
  setWindowSchedulerForegroundBusy(false)
})

describe('scheduleWindowExtraction – intake and B scheduling', () => {
  it('registers the message via persistMemoryIntake before scheduling', async () => {
    mocks.acquire.mockResolvedValue({ kind: 'not_due' })
    await scheduleWindowExtraction(message(), group(), 'B', client)
    await runIdleQueue()
    expect(mocks.persistIntake).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'u1', sessionId: 'session-a' }), 'scope-p',
    )
    expect(mocks.idle.enqueueOptional).toHaveBeenCalledTimes(2)
  })

  it('reads the exact user source from SQLite before registering it', async () => {
    mocks.acquire.mockResolvedValue({ kind: 'not_due' })
    mocks.dbSelect.mockResolvedValueOnce([{ id: 'u1', session_id: 'session-a', role: 'user', parent_id: null,
      content: '已持久化的用户内容。', metadata: '{"displayContent":"可见内容。"}', created_at: 1234 }])
    await schedulePersistedWindowExtraction('u1', 'session-a', 'scope-p', 'B', client)
    await runIdleQueue()
    expect(mocks.persistIntake).toHaveBeenCalledWith({ id: 'u1', sessionId: 'session-a',
      content: '已持久化的用户内容。', metadata: '{"displayContent":"可见内容。"}', createdAt: 1234 }, 'scope-p')
  })

  it('skips intake and scheduling on Web runtime', async () => {
    mocks.isWeb.mockReturnValueOnce(true)
    await scheduleWindowExtraction(message(), group(), 'B', client)
    expect(mocks.persistIntake).not.toHaveBeenCalled()
    expect(mocks.idle.enqueueOptional).not.toHaveBeenCalled()
  })

  it('skips scheduling when DB is not ready', async () => {
    mocks.dbReady.mockReturnValueOnce(false)
    await scheduleWindowExtraction(message(), group(), 'B', client)
    expect(mocks.persistIntake).not.toHaveBeenCalled()
  })

  it('does not crash if persistMemoryIntake throws; A path is unaffected', async () => {
    mocks.persistIntake.mockRejectedValueOnce(new Error('intake_failed'))
    // Should resolve without throwing
    await expect(scheduleWindowExtraction(message(), group(), 'B', client)).resolves.toBeUndefined()
    expect(mocks.idle.enqueueOptional).not.toHaveBeenCalled()
  })

  it('keeps separate session/scope groups scheduled independently', async () => {
    mocks.acquire.mockResolvedValue({ kind: 'not_due' })
    await scheduleWindowExtraction(message('u1'), group(), 'B', client)
    await scheduleWindowExtraction({ ...message('u2'), sessionId: 'session-b' }, group({ sessionId: 'session-b' }), 'B', client)
    expect(mocks.idle.enqueueOptional).toHaveBeenCalledTimes(3)
    await runIdleQueue()
    expect(mocks.acquire).toHaveBeenCalledTimes(2)
  })
})

describe('runOneWindow – acquire and pipeline', () => {
  it('releases with noop when acquireMemoryWindow returns not_due', async () => {
    mocks.acquire.mockResolvedValue({ kind: 'not_due' })
    await scheduleWindowExtraction(message(), group(), 'B', client)
    await runIdleQueue()
    expect(mocks.buildInput).not.toHaveBeenCalled()
    expect(mocks.finish).not.toHaveBeenCalled()
  })

  it('defers the window when buildMemoryWindowInput returns blocked', async () => {
    mocks.acquire.mockResolvedValue(claimedAcquire())
    mocks.buildInput.mockResolvedValue({ kind: 'blocked' })
    await scheduleWindowExtraction(message(), group(), 'B', client)
    await runIdleQueue()
    expect(mocks.defer).toHaveBeenCalledWith(expect.anything(), 'retry', expect.any(Number))
    expect(mocks.requestProposals).not.toHaveBeenCalled()
  })

  it('finishes a noop packet without a model call', async () => {
    const acquired = claimedAcquire()
    mocks.acquire.mockResolvedValue(acquired)
    mocks.buildInput.mockResolvedValue({ kind: 'ready', packets: [
      { turns: [{ id: 'u1', role: 'user', contextOnly: false, text: '谢谢。' }],
        newSourceIds: ['u1'], segmentedSourceIds: [], needsModel: false,
        estimatedInputTokens: 50, snapshots: [] },
    ], invalidatedSourceIds: [] })
    await scheduleWindowExtraction(message(), group(), 'B', client)
    await runIdleQueue()
    expect(mocks.requestProposals).not.toHaveBeenCalled()
    expect(mocks.finish).toHaveBeenCalledWith(
      expect.anything(), expect.objectContaining({ u1: 'noop' }), expect.any(Number),
    )
  })

  it('calls proposal and verification for a model-needed packet, then writes supported candidates', async () => {
    const acquired = claimedAcquire()
    const packet = { turns: [{ id: 'u1', role: 'user', contextOnly: false, text: '我的专业是计算机科学。' }],
      newSourceIds: ['u1'], segmentedSourceIds: [], needsModel: true, estimatedInputTokens: 200,
      snapshots: [{ id: 'u1', sessionId: 'session-a', role: 'user', parentId: null, content: '我的专业是计算机科学。', metadata: null, createdAt: 1 }] }
    const candidate = { content: '专业：计算机科学', category: 'profile', kind: 'semantic', scope: 'global',
      primarySourceId: 'u1', supportingSourceIds: [], subject: 'user', factKey: 'major',
      factValue: '计算机科学', confidence: 0.95, segmented: false, requiresSemanticReview: true }
    mocks.acquire.mockResolvedValue(acquired)
    mocks.buildInput.mockResolvedValue({ kind: 'ready', packets: [packet], invalidatedSourceIds: [] })
    mocks.requestProposals.mockResolvedValue({ kind: 'proposals', candidates: [candidate], rejected: 0, usage: null, elapsedMs: 100 })
    mocks.verifyProposals.mockResolvedValue({ kind: 'verified', verdicts: [{ candidate, supported: true }], usage: null, elapsedMs: 50 })
    mocks.prepareWrite.mockResolvedValue({ operationId: 'op1', memory: {}, source: {} })
    mocks.persistWrite.mockResolvedValue('inserted')
    await scheduleWindowExtraction(message(), group(), 'B', client)
    await runIdleQueue()
    expect(mocks.requestProposals).toHaveBeenCalledTimes(1)
    expect(mocks.verifyProposals).toHaveBeenCalledTimes(1)
    expect(mocks.prepareWrite).toHaveBeenCalledTimes(1)
    expect(mocks.persistWrite).toHaveBeenCalledTimes(1)
    expect(mocks.finish).toHaveBeenCalledWith(
      expect.anything(), expect.objectContaining({ u1: 'completed' }), expect.any(Number),
    )
  })

  it('does not settle a source when the atomic write invalidates its lease', async () => {
    const acquired = claimedAcquire()
    const packet = { turns: [{ id: 'u1', role: 'user', contextOnly: false, text: '我的专业是计算机科学。' }],
      newSourceIds: ['u1'], segmentedSourceIds: [], needsModel: true, estimatedInputTokens: 200,
      snapshots: [{ id: 'u1', sessionId: 'session-a', role: 'user', parentId: null, content: '我的专业是计算机科学。', metadata: null, createdAt: 1 }] }
    const candidate = { content: '专业：计算机科学', category: 'profile', kind: 'semantic', scope: 'global',
      primarySourceId: 'u1', supportingSourceIds: [], subject: 'user', factKey: 'major',
      factValue: '计算机科学', confidence: 0.95, segmented: false, requiresSemanticReview: true }
    mocks.acquire.mockResolvedValue(acquired)
    mocks.buildInput.mockResolvedValue({ kind: 'ready', packets: [packet], invalidatedSourceIds: [] })
    mocks.requestProposals.mockResolvedValue({ kind: 'proposals', candidates: [candidate], rejected: 0, usage: null, elapsedMs: 100 })
    mocks.verifyProposals.mockResolvedValue({ kind: 'verified', verdicts: [{ candidate, supported: true }], usage: null, elapsedMs: 50 })
    mocks.prepareWrite.mockResolvedValue({ operationId: 'op1', memory: {}, source: {} })
    mocks.persistWrite.mockResolvedValue('lost_lease')
    await scheduleWindowExtraction(message(), group(), 'B', client)
    await runIdleQueue()
    expect(mocks.defer).toHaveBeenCalledWith(acquired.claim, 'retry', expect.any(Number))
    expect(mocks.finish).not.toHaveBeenCalled()
  })

  it('marks a source invalidated and still finishes the window', async () => {
    const acquired = claimedAcquire()
    mocks.acquire.mockResolvedValue(acquired)
    mocks.buildInput.mockResolvedValue({ kind: 'ready', packets: [], invalidatedSourceIds: ['u1'] })
    await scheduleWindowExtraction(message(), group(), 'B', client)
    await runIdleQueue()
    expect(mocks.finish).toHaveBeenCalledWith(
      expect.anything(), expect.objectContaining({ u1: 'invalidated' }), expect.any(Number),
    )
  })

  it('yields when foreground is busy during proposals', async () => {
    setWindowSchedulerForegroundBusy(true)
    mocks.acquire.mockResolvedValue({ kind: 'not_due' }) // foreground busy → acquire sees not_due
    await scheduleWindowExtraction(message(), group(), 'B', client)
    await runIdleQueue()
    expect(mocks.buildInput).not.toHaveBeenCalled()
  })

  it('does not charge a foreground deferral as a model failure', async () => {
    const acquired = claimedAcquire()
    mocks.acquire.mockResolvedValue(acquired)
    mocks.buildInput.mockResolvedValue({ kind: 'ready', packets: [{ newSourceIds: ['u1'], needsModel: true }], invalidatedSourceIds: [] })
    mocks.requestProposals.mockResolvedValue({ kind: 'deferred' })
    await scheduleWindowExtraction(message(), group(), 'B', client)
    await runIdleQueue()
    expect(mocks.defer).toHaveBeenCalledWith(acquired.claim, 'foreground', expect.any(Number))
    expect(mocks.finish).not.toHaveBeenCalled()
  })

  it('marks only oversized new sources failed and processes the remaining packet', async () => {
    const acquired = claimedAcquire()
    acquired.claim.record.sourceIds = ['u1', 'u2']
    acquired.claim.value = JSON.stringify(acquired.claim.record)
    mocks.acquire.mockResolvedValue(acquired)
    mocks.buildInput.mockResolvedValue({ kind: 'ready', packets: [{ newSourceIds: ['u1', 'u2'], needsModel: true }],
      invalidatedSourceIds: [], failedSourceIds: ['u1'] })
    mocks.requestProposals.mockResolvedValue({ kind: 'proposals', candidates: [], rejected: 0 })
    await scheduleWindowExtraction(message(), group(), 'B', client)
    await runIdleQueue()
    expect(mocks.requestProposals).toHaveBeenCalledTimes(1)
    expect(mocks.finish).toHaveBeenCalledWith(acquired.claim, { u1: 'failed', u2: 'noop' }, expect.any(Number))
  })
})

describe('scope isolation', () => {
  it('registers intake with the captured scopeKey, not a global default', async () => {
    mocks.acquire.mockResolvedValue({ kind: 'not_due' })
    await scheduleWindowExtraction(message(), group({ scopeKey: 'workspace-q' }), 'B', client)
    await runIdleQueue()
    expect(mocks.persistIntake).toHaveBeenCalledWith(
      expect.anything(), 'workspace-q',
    )
  })

  it('passes null scopeKey for global messages', async () => {
    mocks.acquire.mockResolvedValue({ kind: 'not_due' })
    await scheduleWindowExtraction(message(), group({ scopeKey: null }), 'B', client)
    await runIdleQueue()
    expect(mocks.persistIntake).toHaveBeenCalledWith(
      expect.anything(), null,
    )
  })

  it('uses the epoch allocated by the persisted receipt', async () => {
    mocks.acquire.mockResolvedValue({ kind: 'not_due' })
    mocks.getGroup.mockResolvedValueOnce({ sessionId: 'session-a', scopeKey: 'scope-p', epoch: 7 })
    await scheduleWindowExtraction(message(), group(), 'B', client)
    await runIdleQueue()
    expect(mocks.acquire).toHaveBeenCalledWith(
      { sessionId: 'session-a', scopeKey: 'scope-p', epoch: 7 }, 'B', 'window-scheduler', expect.anything(),
    )
  })

  it('schedules startup recovery for a complete pending group without current-session state', async () => {
    const recovered = { sessionId: 'session-old', scopeKey: 'scope-old', epoch: 3 }
    mocks.listPendingPage.mockResolvedValueOnce({ groups: [{ group: recovered, pendingCount: 4, lastActivityAt: Date.now() - 120_000 }], nextCursor: null })
    mocks.countPending.mockResolvedValueOnce(4)
    mocks.acquire.mockResolvedValue({ kind: 'not_due' })
    const { scheduleWindowRecovery } = await import('@/services/memory/memoryWindowScheduler')
    scheduleWindowRecovery(client)
    await runIdleQueue()
    await runIdleQueue()
    expect(mocks.acquire).toHaveBeenCalledWith(recovered, 'B', 'window-scheduler', expect.anything())
  })

  it('flushes an underfilled C window after 60 seconds of idle time', async () => {
    vi.useFakeTimers()
    try {
      mocks.acquire.mockResolvedValue({ kind: 'not_due' })
      await scheduleWindowExtraction(message(), group(), 'C', client)
      await runIdleQueue()
      await vi.advanceTimersByTimeAsync(60_000)
      await runIdleQueue()
      expect(mocks.acquire).toHaveBeenCalledWith(
        { sessionId: 'session-a', scopeKey: 'scope-p', epoch: 0 }, 'C', 'window-scheduler', expect.anything(),
      )
    } finally {
      vi.clearAllTimers()
      vi.useRealTimers()
    }
  })
})

describe('v3 global scheduling', () => {
  it('rejects a split v3 batch before any model call', async () => {
    vi.useFakeTimers()
    try {
      const group3 = { sessionId: 'session-a', scopeKey: null, epoch: 0, policyVersion: 3 as const }
      mocks.getGroup.mockResolvedValueOnce(group3)
      mocks.countPending.mockResolvedValueOnce(8)
      const acquired = claimedAcquire(3)
      mocks.acquire.mockResolvedValue(acquired)
      mocks.buildInput.mockResolvedValue({ kind: 'ready', packets: [{ needsModel: true }, { needsModel: true }], invalidatedSourceIds: [] })
      await scheduleGlobalWindowExtraction('u1', 'session-a', client)
      await runIdleQueue()
      expect(mocks.requestProposals).not.toHaveBeenCalled()
      expect(mocks.defer).toHaveBeenCalledWith(acquired.claim, 'retry', expect.any(Number))
    } finally {
      vi.clearAllTimers()
      vi.useRealTimers()
    }
  })
  it('uses one proposal call and never runs the v2 verifier for a full eight-message batch', async () => {
    vi.useFakeTimers()
    try {
    const group3 = { sessionId: 'session-a', scopeKey: null, epoch: 0, policyVersion: 3 as const }
    mocks.getGroup.mockResolvedValueOnce(group3)
    mocks.countPending.mockResolvedValueOnce(8)
    mocks.acquire.mockResolvedValue(claimedAcquire(3))
    mocks.buildInput.mockResolvedValue({ kind: 'ready', packets: [{ policyVersion: 3,
      turns: [{ id: 'u1', role: 'user', contextOnly: false, text: '我的专业是计算机科学。' }],
      newSourceIds: ['u1'], segmentedSourceIds: [], needsModel: true, estimatedInputTokens: 200, snapshots: [] }],
      invalidatedSourceIds: [] })
    mocks.requestProposals.mockResolvedValue({ kind: 'proposals', candidates: [{ content: '专业：计算机科学', category: 'profile',
      kind: 'semantic', scope: 'global', primarySourceId: 'u1', supportingSourceIds: [], subject: 'user', factKey: 'major',
      factValue: '计算机科学', confidence: 0.95, sensitivity: 'normal', segmented: false, requiresSemanticReview: true }], rejected: 0 })
    mocks.prepareWrite.mockResolvedValue({ operationId: 'op3', memory: {}, source: {} })
    mocks.persistWrite.mockResolvedValue('inserted')

    await scheduleGlobalWindowExtraction('u1', 'session-a', client)
    await runIdleQueue()

    expect(mocks.acquire).toHaveBeenCalledWith(group3, 'B', 'window-scheduler', expect.anything())
    expect(mocks.requestProposals).toHaveBeenCalledTimes(1)
    expect(mocks.verifyProposals).not.toHaveBeenCalled()
    expect(mocks.persistWrite).toHaveBeenCalledTimes(1)
    } finally {
      vi.clearAllTimers()
      vi.useRealTimers()
    }
  })

  it('flushes a one-message v3 tail after five minutes of session-local idle', async () => {
    vi.useFakeTimers()
    try {
      const group3 = { sessionId: 'session-a', scopeKey: null, epoch: 0, policyVersion: 3 as const }
      mocks.getGroup.mockResolvedValueOnce(group3)
      mocks.countPending.mockResolvedValueOnce(1)
      mocks.acquire.mockResolvedValue({ kind: 'not_due' })
      await scheduleGlobalWindowExtraction('u1', 'session-a', client)
      await runIdleQueue()
      await vi.advanceTimersByTimeAsync(300_000)
      await runIdleQueue()
      expect(mocks.acquire).toHaveBeenCalledWith(group3, 'C', 'window-scheduler', expect.anything())
    } finally {
      vi.clearAllTimers()
      vi.useRealTimers()
    }
  })
})
