import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))
vi.mock('@/hooks/useTauri', () => ({ isTauri: () => true }))

import { initializeNativeRagIndex, prepareNativeRagIndex } from '@/services/rag/nativeIndex'
import { useToastStore } from '@/stores/toastStore'

const ready = {
  status: 'ready',
  documentCount: 1,
  chunkCount: 1,
  validVectorCount: 1,
  skippedVectorCount: 0,
}

describe('shared native RAG initialization', () => {
  beforeEach(() => { mocks.invoke.mockReset() })
  afterEach(() => {
    useToastStore.getState().toasts.forEach(({ id }) => useToastStore.getState().removeToast(id))
  })

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
    expect(useToastStore.getState().toasts).toHaveLength(0)
  })

  it('retries after failure so search can use its existing keyword fallback', async () => {
    mocks.invoke.mockImplementation((command: string) => command === 'get_rag_index_state'
      ? Promise.resolve({ ...ready, status: 'failed' })
      : Promise.reject(new Error('index unavailable')))
    await expect(prepareNativeRagIndex()).resolves.toBe('fallback')
    await expect(prepareNativeRagIndex()).resolves.toBe('fallback')
    expect(mocks.invoke.mock.calls.filter(([command]) => command === 'initialize_rag_index')).toHaveLength(2)
    expect(useToastStore.getState().toasts).toHaveLength(0)
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
    expect(useToastStore.getState().toasts).toHaveLength(0)
  })

  it.each(['RAG index memory budget unavailable', new Error('RAG index memory pressure')])(
    'warns once for foreground memory rejection %s and preserves keyword fallback', async (error) => {
      mocks.invoke.mockImplementation((command: string) => command === 'get_rag_index_state'
        ? Promise.resolve({ ...ready, status: 'idle' }) : Promise.reject(error))
      const progress = vi.fn()
      await expect(prepareNativeRagIndex(progress)).resolves.toBe('fallback')
      await expect(prepareNativeRagIndex(progress)).resolves.toBe('fallback')
      expect(progress).toHaveBeenLastCalledWith('fallback')
      expect(useToastStore.getState().toasts).toHaveLength(1)
      expect(useToastStore.getState().toasts[0]).toMatchObject({
        type: 'warning', title: '知识库初始化暂缓', message: expect.stringContaining('关键词检索'),
      })
    },
  )

  it('keeps background initialization silent when memory admission fails', async () => {
    mocks.invoke.mockRejectedValue('RAG index memory budget unavailable')
    await expect(initializeNativeRagIndex()).rejects.toBe('RAG index memory budget unavailable')
    expect(useToastStore.getState().toasts).toHaveLength(0)
  })

  it('warns for a non-ready memory rejection response', async () => {
    mocks.invoke.mockResolvedValue({ ...ready, status: 'failed', error: 'RAG index memory pressure' })
    await expect(prepareNativeRagIndex()).resolves.toBe('fallback')
    expect(useToastStore.getState().toasts).toHaveLength(1)
  })

  it('does not warn after a foreground request is cancelled', async () => {
    const controller = new AbortController()
    let fail!: (error: string) => void
    mocks.invoke.mockImplementation((command: string) => {
      if (command === 'get_rag_index_state') return Promise.resolve({ ...ready, status: 'idle' })
      return new Promise((_, reject) => { fail = reject })
    })
    const foreground = prepareNativeRagIndex(undefined, controller.signal)
    await Promise.resolve()
    await Promise.resolve()
    controller.abort()
    fail('RAG index memory budget unavailable')
    await expect(foreground).rejects.toMatchObject({ name: 'AbortError' })
    expect(useToastStore.getState().toasts).toHaveLength(0)
  })
})
