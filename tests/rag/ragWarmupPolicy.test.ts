import { describe, expect, it } from 'vitest'
import { decideRagWarmup } from '@/services/rag/warmupPolicy'

describe('RAG warmup performance policy', () => {
  it('keeps memory mode and low-memory devices on demand', () => {
    expect(decideRagWarmup({ policy: 'memory', documentCount: 10, recentlyUsed: true, userActive: false, memoryPressure: false })).toBe('on-demand')
    expect(decideRagWarmup({ policy: 'speed', documentCount: 10, availableMemoryMb: 256, recentlyUsed: true, userActive: false, memoryPressure: false })).toBe('on-demand')
  })

  it('warms small, recent, or speed-mode indexes while idle', () => {
    expect(decideRagWarmup({ policy: 'balanced', documentCount: 40, recentlyUsed: false, userActive: false, memoryPressure: false })).toBe('idle-warmup')
    expect(decideRagWarmup({ policy: 'balanced', documentCount: 500, recentlyUsed: true, userActive: false, memoryPressure: false })).toBe('idle-warmup')
    expect(decideRagWarmup({ policy: 'speed', documentCount: 500, recentlyUsed: false, userActive: false, memoryPressure: false })).toBe('idle-warmup')
  })

  it('keeps speed eligible during activity, but defers balanced and respects memory pressure', () => {
    expect(decideRagWarmup({ policy: 'speed', documentCount: 10, recentlyUsed: true, userActive: true, memoryPressure: false })).toBe('idle-warmup')
    expect(decideRagWarmup({ policy: 'balanced', documentCount: 10, recentlyUsed: true, userActive: true, memoryPressure: false })).toBe('cancel')
    expect(decideRagWarmup({ policy: 'speed', documentCount: 10, recentlyUsed: true, userActive: false, memoryPressure: true })).toBe('cancel')
  })
})
