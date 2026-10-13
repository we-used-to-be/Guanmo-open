import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ ready: true, select: vi.fn(), invoke: vi.fn() }))
vi.mock('@/services/database/db', () => ({ isDatabaseReady: () => mocks.ready, getDatabase: () => ({ select: mocks.select }) }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))
import { estimateRagWarmupMb } from '@/services/database/persistence'

beforeEach(() => { mocks.ready = true; mocks.select.mockReset(); mocks.invoke.mockReset() })
describe('RAG warmup budget', () => {
  it('reuses the exact native estimate instead of returning user content or vectors', async () => {
    mocks.invoke.mockResolvedValue(512)
    expect(await estimateRagWarmupMb()).toBe(512)
    expect(mocks.invoke).toHaveBeenCalledWith('estimate_rag_index_memory')
    expect(mocks.select).not.toHaveBeenCalled()
  })
  it('fails closed when the database is unavailable or metadata is invalid', async () => {
    mocks.ready = false
    expect(await estimateRagWarmupMb()).toBe(Infinity)
    expect(mocks.invoke).not.toHaveBeenCalled()
    mocks.ready = true
    mocks.invoke.mockResolvedValue(-1)
    expect(await estimateRagWarmupMb()).toBe(Infinity)
  })
  it('keeps allocator headroom even for an empty index', async () => {
    mocks.invoke.mockResolvedValue(128)
    expect(await estimateRagWarmupMb()).toBe(128)
  })
  it.each([null, {}, 127, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects an invalid native budget %j', async (value) => {
    mocks.invoke.mockResolvedValue(value)
    expect(await estimateRagWarmupMb()).toBe(Infinity)
  })
})
