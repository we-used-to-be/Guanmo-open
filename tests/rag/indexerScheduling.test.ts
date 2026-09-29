import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ingestDocument, runSerializedDocumentOperation } from '@/services/rag/pipeline'

type MockSettingsSnapshot = {
  knowledge: { autoIndexEnabled: boolean }
}

const mockSettings = vi.hoisted(() => {
  const state: MockSettingsSnapshot = {
    knowledge: { autoIndexEnabled: true },
  }
  let listener: ((next: MockSettingsSnapshot, previous: MockSettingsSnapshot) => void) | undefined

  return {
    state,
    subscribe: vi.fn((next: (state: MockSettingsSnapshot, previous: MockSettingsSnapshot) => void) => {
      listener = next
      return vi.fn()
    }),
    disableAutoIndex: () => {
      const previous = { knowledge: { ...state.knowledge } }
      state.knowledge.autoIndexEnabled = false
      listener?.(state, previous)
    },
    reset: () => {
      state.knowledge.autoIndexEnabled = true
    },
  }
})

vi.mock('@/stores/settingsStore', () => ({
  useSettingsStore: { getState: () => mockSettings.state, subscribe: mockSettings.subscribe },
}))
vi.mock('@/services/ai/aiClient', () => ({ isEmbeddingReady: () => false }))
vi.mock('@/hooks/useTauri', () => ({ readFile: vi.fn(), joinPath: vi.fn() }))
vi.mock('@/services/fileSystem', () => ({ listDirectory: vi.fn() }))
vi.mock('@/services/fileTree', () => ({ shouldSkipWorkspaceDirectory: vi.fn() }))
vi.mock('@/services/rag/pipeline', () => ({
  ingestDocument: vi.fn(),
  processEmbeddingQueue: vi.fn(),
  runSerializedDocumentOperation: vi.fn(),
}))
vi.mock('@/services/rag/vectorStore', () => ({
  vectorStore: { replaceDocument: vi.fn(), flushPersistence: vi.fn() },
}))
vi.mock('@/services/rag/nativeIndex', () => ({ refreshNativeRagIndexDocument: vi.fn() }))

import {
  cancelPendingIndexTimers,
  getPendingIndexTimerPaths,
  indexMarkdownDocumentAsync,
  scheduleMarkdownDocumentIndex,
} from '@/services/rag/indexer'

const unchanged = {
  unchanged: true as const,
  stats: { total: 0, reused: 0, added: 0, deleted: 0, reembedded: 0 },
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

describe('automatic Markdown indexing schedule', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    mockSettings.reset()
    cancelPendingIndexTimers(getPendingIndexTimerPaths())
    const operations = new Map<string, Promise<void>>()
    vi.mocked(runSerializedDocumentOperation).mockImplementation(async (filePath, operation) => {
      const previous = operations.get(filePath.toLowerCase()) || Promise.resolve()
      let release!: () => void
      const gate = new Promise<void>((resolve) => { release = resolve })
      const queued = previous.then(() => gate)
      operations.set(filePath.toLowerCase(), queued)
      await previous
      try {
        return await operation()
      } finally {
        release()
        if (operations.get(filePath.toLowerCase()) === queued) operations.delete(filePath.toLowerCase())
      }
    })
    vi.mocked(ingestDocument).mockResolvedValue(unchanged)
  })

  afterEach(() => {
    cancelPendingIndexTimers(getPendingIndexTimerPaths())
    vi.useRealTimers()
  })

  it('does not schedule synchronous automatic indexing for huge documents', () => {
    expect(scheduleMarkdownDocumentIndex('D:/anonymous/huge.md', 'huge', 'x'.repeat(100_000))).toBe(false)
    expect(getPendingIndexTimerPaths()).toEqual([])
  })

  it('cancels a pending small-document index when the document becomes huge', () => {
    const path = 'D:/anonymous/growing.md'
    expect(scheduleMarkdownDocumentIndex(path, 'growing', 'small')).toBe(true)
    expect(getPendingIndexTimerPaths()).toEqual([path])

    expect(scheduleMarkdownDocumentIndex(path, 'growing', 'x'.repeat(100_000))).toBe(false)
    expect(getPendingIndexTimerPaths()).toEqual([])
  })

  it('关闭自动索引时由设置反应取消待处理 timer', () => {
    const path = 'D:/anonymous/disabled.md'
    expect(scheduleMarkdownDocumentIndex(path, 'disabled', 'small')).toBe(true)
    expect(getPendingIndexTimerPaths()).toEqual([path])

    mockSettings.disableAutoIndex()

    expect(getPendingIndexTimerPaths()).toEqual([])
  })

  it('运行中的版本完成后只索引最新的待处理自动版本', async () => {
    let finishFirst!: (value: typeof unchanged) => void
    const first = new Promise<typeof unchanged>((resolve) => { finishFirst = resolve })
    vi.mocked(ingestDocument).mockImplementation(async (_path, _title, content) =>
      content === 'A' ? first : unchanged
    )
    const path = 'D:/anonymous/rapid.md'

    scheduleMarkdownDocumentIndex(path, 'rapid', 'A', 0)
    await vi.advanceTimersByTimeAsync(0)
    scheduleMarkdownDocumentIndex(path, 'rapid', 'B', 0)
    await vi.advanceTimersByTimeAsync(0)
    scheduleMarkdownDocumentIndex(path, 'rapid', 'C', 0)
    await vi.advanceTimersByTimeAsync(0)
    expect(vi.mocked(ingestDocument).mock.calls.map((call) => call[2])).toEqual(['A'])

    finishFirst(unchanged)
    await flushMicrotasks()
    expect(vi.mocked(ingestDocument).mock.calls.map((call) => call[2])).toEqual(['A', 'C'])
  })

  it('显式入库丢弃排队的自动版本并保持操作顺序', async () => {
    let releaseBlocker!: () => void
    const blocker = new Promise<void>((resolve) => { releaseBlocker = resolve })
    const path = 'D:/anonymous/manual.md'
    const blocking = runSerializedDocumentOperation(path, async () => { await blocker })

    scheduleMarkdownDocumentIndex(path, 'manual', 'old auto', 0)
    await vi.advanceTimersByTimeAsync(0)
    const manual = indexMarkdownDocumentAsync(path, 'manual', 'manual version')
    releaseBlocker()
    await blocking
    await manual
    expect(vi.mocked(ingestDocument).mock.calls.map((call) => call[2])).toEqual(['manual version'])
  })

  it('关闭自动索引后不运行排队版本', async () => {
    let releaseBlocker!: () => void
    const blocker = new Promise<void>((resolve) => { releaseBlocker = resolve })
    const path = 'D:/anonymous/disabled-queued.md'
    const blocking = runSerializedDocumentOperation(path, async () => { await blocker })

    scheduleMarkdownDocumentIndex(path, 'disabled', 'old auto', 0)
    await vi.advanceTimersByTimeAsync(0)
    mockSettings.disableAutoIndex()
    releaseBlocker()
    await blocking
    await flushMicrotasks()
    expect(ingestDocument).not.toHaveBeenCalled()
  })

  it('取消后新自动任务排在删除操作之后', async () => {
    let releaseBlocker!: () => void
    const blocker = new Promise<void>((resolve) => { releaseBlocker = resolve })
    const path = 'D:/anonymous/removed.md'
    const events: string[] = []
    const blocking = runSerializedDocumentOperation(path, async () => { await blocker })

    scheduleMarkdownDocumentIndex(path, 'removed', 'obsolete', 0)
    await vi.advanceTimersByTimeAsync(0)
    cancelPendingIndexTimers('D:\\ANONYMOUS\\REMOVED.MD')
    const removing = runSerializedDocumentOperation(path, async () => { events.push('remove') })
    vi.mocked(ingestDocument).mockImplementation(async () => {
      events.push('index')
      return unchanged
    })
    scheduleMarkdownDocumentIndex(path, 'removed', 'new version', 0)
    await vi.advanceTimersByTimeAsync(0)

    releaseBlocker()
    await blocking
    await removing
    await flushMicrotasks()
    expect(events).toEqual(['remove', 'index'])
    expect(vi.mocked(ingestDocument).mock.calls.map((call) => call[2])).toEqual(['new version'])
  })
})
