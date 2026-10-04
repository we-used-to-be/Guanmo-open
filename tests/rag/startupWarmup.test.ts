import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  tauri: true,
  activeTabId: 'tab-1' as string | null,
  waitForPoint: vi.fn(),
  scheduleNative: vi.fn(() => vi.fn()),
}))

vi.mock('@/hooks/useTauri', () => ({ isTauri: () => mocks.tauri }))
vi.mock('@/stores/editorStore', () => ({ useEditorStore: { getState: () => ({ activeTabId: mocks.activeTabId }) } }))
vi.mock('@/services/startupPerformance', () => ({ waitForStartupPoint: mocks.waitForPoint }))
vi.mock('@/services/rag/warmupScheduler', () => ({ scheduleNativeRagWarmup: mocks.scheduleNative }))

import { scheduleRagWarmupAfterFirstSurface } from '@/services/rag/startupWarmup'

describe('RAG startup warmup boundary', () => {
  let resolvePoint: (point: string) => void

  beforeEach(() => {
    mocks.tauri = true
    mocks.activeTabId = 'tab-1'
    mocks.scheduleNative.mockClear()
    mocks.waitForPoint.mockClear()
    const waiters = new Map<string, () => void>()
    mocks.waitForPoint.mockImplementation((point: string) => new Promise<void>((resolve) => waiters.set(point, resolve)))
    resolvePoint = (point) => waiters.get(point)?.()
  })

  it('waits for a real editor or preview surface before loading the warmup', async () => {
    const stop = scheduleRagWarmupAfterFirstSurface()
    expect(mocks.scheduleNative).not.toHaveBeenCalled()
    resolvePoint('preview-first-visible')
    await vi.waitFor(() => expect(mocks.scheduleNative).toHaveBeenCalledTimes(1))
    stop()
    expect(mocks.scheduleNative.mock.results[0].value).toHaveBeenCalledTimes(1)
  })

  it('uses the visible shell when no document is open and ignores a disposed startup', async () => {
    mocks.activeTabId = null
    const stop = scheduleRagWarmupAfterFirstSurface()
    expect(mocks.waitForPoint).toHaveBeenCalledWith('app-shell-first-visible')
    stop()
    resolvePoint('app-shell-first-visible')
    await Promise.resolve()
    expect(mocks.scheduleNative).not.toHaveBeenCalled()
  })

  it('does not schedule desktop RAG in Web mode', () => {
    mocks.tauri = false
    scheduleRagWarmupAfterFirstSurface()()
    expect(mocks.waitForPoint).not.toHaveBeenCalled()
  })
})
