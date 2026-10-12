import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ ready: true, select: vi.fn() }))
vi.mock('@/services/database/db', () => ({ isDatabaseReady: () => mocks.ready, getDatabase: () => ({ select: mocks.select }) }))
import { estimateRagWarmupMb } from '@/services/database/persistence'

beforeEach(() => { mocks.ready = true; mocks.select.mockReset() })
describe('RAG warmup budget', () => {
  it('uses scalar sizes and counts instead of returning user content or vectors', async () => {
    mocks.select.mockResolvedValue([{ bytes: 100 * 1024 * 1024, chunks: 1000, documents: 100 }])
    expect(await estimateRagWarmupMb()).toBeGreaterThan(600)
    expect(mocks.select.mock.calls[0][0]).toContain('SUM(length(CAST(embedding AS BLOB)))')
  })
  it('fails closed when the database is unavailable or metadata is invalid', async () => {
    mocks.ready = false
    expect(await estimateRagWarmupMb()).toBe(Infinity)
    expect(mocks.select).not.toHaveBeenCalled()
    mocks.ready = true
    mocks.select.mockResolvedValue([{ bytes: -1, chunks: 0, documents: 0 }])
    expect(await estimateRagWarmupMb()).toBe(Infinity)
  })
})
