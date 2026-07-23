import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  decideResource,
  BALANCED_LARGE_DOC_THRESHOLD,
  BALANCED_SMALL_DOC_TTL_MS,
  BALANCED_LARGE_DOC_TTL_MS,
  type ResourceDecisionInput,
} from '@/services/editorSession'

function baseInput(overrides: Partial<ResourceDecisionInput> = {}): ResourceDecisionInput {
  return {
    policy: 'balanced',
    docId: 'doc-1',
    candidateDocId: 'doc-1',
    docCharCount: 1000,
    instanceType: 'preview',
    isCurrentlyVisible: false,
    lastUsedAt: 1000,
    now: 2000,
    hasUncommittedDraft: false,
    ...overrides,
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(2000)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('decideResource', () => {
  it('未提交草稿时强制保留', () => {
    const result = decideResource(baseInput({ hasUncommittedDraft: true }))
    expect(result).toEqual({ action: 'keep' })
  })

  it('当前可见实例强制保留', () => {
    const result = decideResource(baseInput({ isCurrentlyVisible: true }))
    expect(result).toEqual({ action: 'keep' })
  })

  it('Diff 离开后释放', () => {
    const result = decideResource(baseInput({ instanceType: 'diff' }))
    expect(result).toEqual({ action: 'release' })
  })

  it('不同文档时释放', () => {
    const result = decideResource(baseInput({
      docId: 'doc-2',
      candidateDocId: 'doc-1',
    }))
    expect(result).toEqual({ action: 'release' })
  })

  describe('memory 策略', () => {
    it('非当前可见实例释放', () => {
      const result = decideResource(baseInput({ policy: 'memory' }))
      expect(result).toEqual({ action: 'release' })
    })
  })

  describe('balanced 策略', () => {
    it('小文档保留 45 秒（基于 lastUsedAt 固定截止）', () => {
      const result = decideResource(baseInput({
        policy: 'balanced',
        docCharCount: 5000,
        lastUsedAt: 1000,
        now: 2000,
      }))
      expect(result).toEqual({ action: 'keepUntil', deadline: 1000 + BALANCED_SMALL_DOC_TTL_MS })
    })

    it('99999 字符视为小文档', () => {
      const result = decideResource(baseInput({
        policy: 'balanced',
        docCharCount: 99999,
        lastUsedAt: 1000,
        now: 2000,
      }))
      expect(result).toEqual({ action: 'keepUntil', deadline: 1000 + BALANCED_SMALL_DOC_TTL_MS })
    })

    it('100000 字符视为长文档，保留 5 秒', () => {
      const result = decideResource(baseInput({
        policy: 'balanced',
        docCharCount: BALANCED_LARGE_DOC_THRESHOLD,
        lastUsedAt: 1000,
        now: 2000,
      }))
      expect(result).toEqual({ action: 'keepUntil', deadline: 1000 + BALANCED_LARGE_DOC_TTL_MS })
    })

    it('截止时间已过期时立即释放', () => {
      const result = decideResource(baseInput({
        policy: 'balanced',
        docCharCount: 5000,
        lastUsedAt: 1000,
        now: 1000 + BALANCED_SMALL_DOC_TTL_MS + 1,
      }))
      expect(result).toEqual({ action: 'release' })
    })

    it('重新决策不延后截止时间（固定基于 lastUsedAt）', () => {
      const result1 = decideResource(baseInput({
        policy: 'balanced',
        docCharCount: 5000,
        lastUsedAt: 1000,
        now: 2000,
      }))
      const result2 = decideResource(baseInput({
        policy: 'balanced',
        docCharCount: 5000,
        lastUsedAt: 1000,
        now: 40000,
      }))
      // 两次决策的 deadline 相同，不随 now 变化
      expect(result1).toEqual({ action: 'keepUntil', deadline: 1000 + BALANCED_SMALL_DOC_TTL_MS })
      expect(result2).toEqual({ action: 'keepUntil', deadline: 1000 + BALANCED_SMALL_DOC_TTL_MS })
    })
  })

  describe('speed 策略', () => {
    it('始终保留', () => {
      const result = decideResource(baseInput({ policy: 'speed' }))
      expect(result).toEqual({ action: 'keep' })
    })
  })
})
