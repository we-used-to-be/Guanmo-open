import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  policy: 'speed' as 'memory' | 'balanced' | 'speed',
  activeTabId: 'tab-1',
  loadStats: vi.fn(),
  getIndexState: vi.fn(),
  initializeIndex: vi.fn(),
  settingsListeners: new Set<(next: unknown, previous: unknown) => void>(),
  editorListeners: new Set<(next: unknown) => void>(),
}))

vi.mock('@/stores/settingsStore', () => ({
  useSettingsStore: {
    getState: () => ({ editor: { modePerformancePolicy: mocks.policy } }),
    subscribe: (listener: (next: unknown, previous: unknown) => void) => {
      mocks.settingsListeners.add(listener)
      return () => mocks.settingsListeners.delete(listener)
    },
  },
}))
vi.mock('@/stores/editorStore', () => ({
  useEditorStore: {
    getState: () => ({ activeTabId: mocks.activeTabId }),
    subscribe: (listener: (next: unknown) => void) => {
      mocks.editorListeners.add(listener)
      return () => mocks.editorListeners.delete(listener)
    },
  },
}))
vi.mock('@/services/database/persistence', () => ({ loadRagStatsAggregate: mocks.loadStats }))
vi.mock('@/services/rag/nativeIndex', () => ({
  getNativeRagIndexState: mocks.getIndexState,
  initializeNativeRagIndex: mocks.initializeIndex,
}))

import { scheduleNativeRagWarmup } from '@/services/rag/warmupScheduler'

async function flushPromises() {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

describe('RAG warmup scheduling', () => {
  let stop: (() => void) | undefined
  let idleCallback: (() => void) | undefined

  beforeEach(() => {
    vi.useFakeTimers()
    mocks.policy = 'speed'
    mocks.activeTabId = 'tab-1'
    mocks.settingsListeners.clear()
    mocks.editorListeners.clear()
    mocks.loadStats.mockReset().mockResolvedValue({ documents: 20 })
    mocks.getIndexState.mockReset().mockResolvedValue({ status: 'idle' })
    mocks.initializeIndex.mockReset().mockResolvedValue({ status: 'ready' })
    vi.stubGlobal('requestIdleCallback', vi.fn((callback: () => void) => { idleCallback = callback; return 1 }))
    vi.stubGlobal('cancelIdleCallback', vi.fn())
  })

  afterEach(() => {
    stop?.()
    stop = undefined
    idleCallback = undefined
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('starts speed immediately and ordinary interaction cannot cancel it', async () => {
    stop = scheduleNativeRagWarmup()
    await flushPromises()
    expect(mocks.initializeIndex).toHaveBeenCalledTimes(1)
    window.dispatchEvent(new KeyboardEvent('keydown'))
    window.dispatchEvent(new PointerEvent('pointerdown'))
    expect(mocks.initializeIndex).toHaveBeenCalledTimes(1)
  })

  it('starts balanced only after a quiet period and an idle callback', async () => {
    mocks.policy = 'balanced'
    stop = scheduleNativeRagWarmup()
    await flushPromises()
    await vi.advanceTimersByTimeAsync(1500)
    window.dispatchEvent(new KeyboardEvent('keydown'))
    await vi.advanceTimersByTimeAsync(1999)
    expect(mocks.initializeIndex).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(idleCallback).toBeTypeOf('function')
    idleCallback?.()
    await flushPromises()
    expect(mocks.initializeIndex).toHaveBeenCalledTimes(1)
    window.dispatchEvent(new KeyboardEvent('keydown'))
    expect(mocks.initializeIndex).toHaveBeenCalledTimes(1)
  })

  it('keeps memory mode and empty knowledge bases on demand', async () => {
    mocks.policy = 'memory'
    stop = scheduleNativeRagWarmup()
    await flushPromises()
    await vi.advanceTimersByTimeAsync(3000)
    expect(mocks.initializeIndex).not.toHaveBeenCalled()
    stop()
    mocks.policy = 'speed'
    mocks.loadStats.mockResolvedValue({ documents: 0 })
    stop = scheduleNativeRagWarmup()
    await flushPromises()
    expect(mocks.initializeIndex).not.toHaveBeenCalled()
  })

  it('reuses an index completed by foreground search while balanced was waiting', async () => {
    mocks.policy = 'balanced'
    stop = scheduleNativeRagWarmup()
    await flushPromises()
    mocks.getIndexState.mockResolvedValue({ status: 'ready' })
    await vi.advanceTimersByTimeAsync(2000)
    idleCallback?.()
    await flushPromises()
    expect(mocks.initializeIndex).not.toHaveBeenCalled()
  })

  it('resets balanced quiet time on a tab switch, then starts immediately if switched to speed', async () => {
    mocks.policy = 'balanced'
    stop = scheduleNativeRagWarmup()
    await flushPromises()
    await vi.advanceTimersByTimeAsync(1500)
    mocks.activeTabId = 'tab-2'
    mocks.editorListeners.forEach((listener) => listener({ activeTabId: 'tab-2' }))
    await vi.advanceTimersByTimeAsync(500)
    expect(idleCallback).toBeUndefined()
    const previous = { editor: { modePerformancePolicy: 'balanced' } }
    mocks.policy = 'speed'
    mocks.settingsListeners.forEach((listener) => listener({ editor: { modePerformancePolicy: 'speed' } }, previous))
    await flushPromises()
    expect(mocks.initializeIndex).toHaveBeenCalledTimes(1)
  })
})
