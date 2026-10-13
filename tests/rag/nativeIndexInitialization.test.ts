import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))
vi.mock('@/hooks/useTauri', () => ({ isTauri: () => true }))

import { initializeNativeRagIndex, prepareNativeRagIndex } from '@/services/rag/nativeIndex'

const ready = {
  status: 'ready',
  documentCount: 1,
  chunkCount: 1,
  validVectorCount: 1,
  skippedVectorCount: 0,
}

describe('shared native RAG initialization', () => {
  beforeEach(() => { mocks.invoke.mockReset() })

  it('lets a foreground waiter cancel without cancelling the shared warmup', async () => {
    let finish!: (value: typeof ready) => void
    mocks.invoke.mockImplementation((command: string) => command === 'get_rag_index_state'
      ? Promise.resolve({ ...ready, status: 'initializing' })
      : new Promise<typeof ready>((resolve) => { finish = resolve }))

    const warmup = initializeNativeRagIndex()
    const controller = new AbortController()
    const foreground = prepareNativeRagIndex(undefined, controller.signal)
    await Promise.resolve()
    await Promise.resolve()
    controller.abort()
    await expect(foreground).rejects.toMatchObject({ name: 'AbortError' })
    finish(ready)
    await expect(warmup).resolves.toMatchObject({ status: 'ready' })
    expect(mocks.invoke.mock.calls.filter(([command]) => command === 'initialize_rag_index')).toHaveLength(1)
    expect(mocks.invoke.mock.calls.filter(([command]) => command === 'cancel_rag_index_initialization')).toHaveLength(0)
  })

  it('retries after failure so search can use its existing keyword fallback', async () => {
    mocks.invoke.mockImplementation((command: string) => command === 'get_rag_index_state'
      ? Promise.resolve({ ...ready, status: 'failed' })
      : Promise.reject(new Error('index unavailable')))
    await expect(prepareNativeRagIndex()).resolves.toBe('fallback')
    await expect(prepareNativeRagIndex()).resolves.toBe('fallback')
    expect(mocks.invoke.mock.calls.filter(([command]) => command === 'initialize_rag_index')).toHaveLength(2)
  })

  it('uses fallback for memory admission failure and non-ready initialization replies', async () => {
    mocks.invoke.mockImplementation((command: string) => command === 'get_rag_index_state'
      ? Promise.resolve({ ...ready, status: 'idle' })
      : Promise.reject(new Error('RAG index memory budget unavailable')))
    const progress = vi.fn()
    await expect(prepareNativeRagIndex(progress)).resolves.toBe('fallback')
    expect(progress).toHaveBeenLastCalledWith('fallback')
    mocks.invoke.mockResolvedValue({ ...ready, status: 'idle' })
    await expect(prepareNativeRagIndex()).resolves.toBe('fallback')
  })

  it('keeps an already ready index without starting another initialization', async () => {
    mocks.invoke.mockResolvedValue(ready)
    await expect(prepareNativeRagIndex()).resolves.toBe('already_ready')
    expect(mocks.invoke).toHaveBeenCalledTimes(1)
    expect(mocks.invoke).toHaveBeenCalledWith('get_rag_index_state')
  })
})
