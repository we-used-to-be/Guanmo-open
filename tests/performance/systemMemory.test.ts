import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  desktop: true,
  invoke: vi.fn(),
  tasks: [] as Array<() => Promise<void>>,
}))
vi.mock('@/hooks/useTauri', () => ({ isTauri: () => mocks.desktop }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))
vi.mock('@/services/idleScheduler', () => ({ idleScheduler: {
  enqueueOptional: (run: () => Promise<void>) => { mocks.tasks.push(run); return vi.fn() },
} }))

const healthy = { availablePhysicalMb: 4096, totalPhysicalMb: 8192, availableCommitMb: 4096, commitLimitMb: 12288 }
let memory: typeof import('@/services/systemMemory')
const cleanup: Array<() => void> = []

beforeEach(async () => {
  vi.useFakeTimers()
  vi.resetModules()
  mocks.desktop = true
  mocks.tasks.length = 0
  mocks.invoke.mockReset().mockResolvedValue(healthy)
  memory = await import('@/services/systemMemory')
})
afterEach(() => { cleanup.splice(0).forEach((stop) => stop()); vi.useRealTimers() })

describe('system memory admission', () => {
  it('blocks on exhausted commit even when physical RAM and JS heap remain available', async () => {
    mocks.invoke.mockResolvedValue({ ...healthy, availableCommitMb: 400 })
    const run = vi.fn()
    const estimate = vi.fn().mockResolvedValue(128)
    memory.scheduleMemoryAwareTask(run, estimate, () => true, 1, 'anonymous')
    await mocks.tasks[0]()
    expect(run).not.toHaveBeenCalled()
    expect(estimate).not.toHaveBeenCalled()
    expect(mocks.invoke).toHaveBeenCalledWith('get_system_memory_snapshot')
  })

  it('keeps enough headroom for both the reserve and the estimated index', async () => {
    mocks.invoke.mockResolvedValue({ ...healthy, availableCommitMb: 800 })
    const run = vi.fn()
    memory.scheduleMemoryAwareTask(run, async () => 400, () => true, 1, 'anonymous')
    await mocks.tasks[0]()
    expect(run).not.toHaveBeenCalled()
  })

  it('rechecks memory after the budget query', async () => {
    mocks.invoke.mockResolvedValueOnce(healthy).mockResolvedValueOnce({ ...healthy, availablePhysicalMb: 300 })
    const run = vi.fn()
    memory.scheduleMemoryAwareTask(run, async () => 128, () => true, 1, 'anonymous')
    await mocks.tasks[0]()
    expect(run).not.toHaveBeenCalled()
  })

  it.each([null, {}, { ...healthy, availableCommitMb: -1 }, { ...healthy, availablePhysicalMb: Infinity }])(
    'skips optional work for an invalid sample %j', async (sample) => {
      mocks.invoke.mockResolvedValue(sample)
      const run = vi.fn()
      memory.scheduleMemoryAwareTask(run, 128, () => true, 1, 'anonymous')
      await mocks.tasks[0]()
      expect(run).not.toHaveBeenCalled()
    },
  )

  it('skips optional work when sampling fails', async () => {
    mocks.invoke.mockRejectedValue(new Error('anonymous failure'))
    const run = vi.fn()
    memory.scheduleMemoryAwareTask(run, 128, () => true, 1, 'anonymous')
    await mocks.tasks[0]()
    expect(run).not.toHaveBeenCalled()
  })

  it('ignores a late sample after cancellation or policy change', async () => {
    let finish!: (value: typeof healthy) => void
    mocks.invoke.mockImplementation(() => new Promise((resolve) => { finish = resolve }))
    const run = vi.fn()
    const stop = memory.scheduleMemoryAwareTask(run, 128, () => true, 1, 'anonymous')
    const pending = mocks.tasks[0]()
    await vi.dynamicImportSettled()
    stop()
    finish(healthy)
    await pending
    expect(run).not.toHaveBeenCalled()
    let eligible = true
    mocks.invoke.mockResolvedValue(healthy)
    memory.scheduleMemoryAwareTask(run, async () => { eligible = false; return 128 }, () => eligible, 1, 'anonymous')
    await mocks.tasks[1]()
    expect(run).not.toHaveBeenCalled()
  })

  it('uses hysteresis and never regards failed sampling as healthy', () => {
    expect(memory.classifyMemoryPressure({ ...healthy, availableCommitMb: 650 }, 'pressure')).toBe('pressure')
    expect(memory.classifyMemoryPressure({ ...healthy, availableCommitMb: 800 }, 'pressure')).toBe('normal')
    expect(memory.classifyMemoryPressure(null, 'pressure')).toBe('unknown')
  })

  it('coalesces concurrent sampling and cleans up the shared polling timer', async () => {
    let finish!: (value: typeof healthy) => void
    mocks.invoke.mockImplementation(() => new Promise((resolve) => { finish = resolve }))
    const first = memory.readSystemMemory()
    const second = memory.readSystemMemory()
    const listener = vi.fn()
    const stop = memory.subscribeMemoryPressure(listener)
    cleanup.push(stop)
    await vi.dynamicImportSettled()
    expect(mocks.invoke).toHaveBeenCalledTimes(1)
    finish(healthy)
    expect(await first).toEqual(await second)
    expect(listener).toHaveBeenLastCalledWith('normal')
    stop()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not invoke native memory APIs on Web', async () => {
    mocks.desktop = false
    expect(await memory.readSystemMemory()).toBeNull()
    const run = vi.fn().mockResolvedValue(undefined)
    memory.scheduleMemoryAwareTask(run, 128, () => true, 1, 'anonymous')
    await mocks.tasks[0]()
    expect(run).toHaveBeenCalledTimes(1)
    expect(mocks.invoke).not.toHaveBeenCalled()
  })
})
