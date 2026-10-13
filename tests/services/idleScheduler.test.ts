import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let scheduler: typeof import('@/services/idleScheduler')['idleScheduler']
beforeEach(async () => {
  vi.resetModules()
  vi.useFakeTimers()
  vi.stubGlobal('MessageChannel', undefined)
  vi.stubGlobal('requestIdleCallback', undefined)
  scheduler = (await import('@/services/idleScheduler')).idleScheduler
})
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

describe('shared idle queue', () => {
  it('does not overlap an index build and a hidden mode preload', async () => {
    let finish!: () => void
    const first = vi.fn(() => new Promise<void>((resolve) => { finish = resolve }))
    const second = vi.fn().mockResolvedValue(undefined)
    scheduler.enqueueOptional(first, 1, 'anonymous index')
    scheduler.enqueueOptional(second, 2, 'anonymous mode')
    await vi.advanceTimersByTimeAsync(1)
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).not.toHaveBeenCalled()
    finish()
    await vi.runAllTimersAsync()
    expect(second).toHaveBeenCalledTimes(1)
  })

  it('suppresses cancellation during the idle wait and continues with the next task', async () => {
    const cancelled = vi.fn().mockResolvedValue(undefined)
    const next = vi.fn().mockResolvedValue(undefined)
    const stop = scheduler.enqueueOptional(cancelled, 1, 'anonymous cancelled')
    scheduler.enqueueOptional(next, 2, 'anonymous next')
    stop()
    await vi.runAllTimersAsync()
    expect(cancelled).not.toHaveBeenCalled()
    expect(next).toHaveBeenCalledTimes(1)
  })

  it('does not log skipped admission as successful initialization', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    try {
      scheduler.enqueueOptional(async () => 'skipped', 1, 'anonymous index')
      await vi.runAllTimersAsync()
      expect(log.mock.calls.flat().some((value) => String(value).includes('跳过 anonymous index'))).toBe(true)
      expect(log.mock.calls.flat().some((value) => String(value).includes('✓ anonymous index'))).toBe(false)
    } finally {
      log.mockRestore()
    }
  })
})
