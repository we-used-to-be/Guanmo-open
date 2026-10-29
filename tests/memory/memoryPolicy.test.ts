import { describe, expect, it } from 'vitest'
import {
  filterInjectableMemories,
  isMemoryVisibleInScope,
  lexicalMemorySimilarity,
  resolveMemoryCandidateDecision,
  type MemoryCandidateRecord,
} from '@/services/memory/memoryPolicy'

function memory(overrides: Partial<MemoryCandidateRecord>): MemoryCandidateRecord {
  return {
    id: 'memory-default',
    content: '默认使用中文回答',
    category: 'preference',
    source: 'auto_extracted',
    locked: false,
    status: 'active',
    scopeType: 'global',
    scopeKey: null,
    ...overrides,
  }
}

describe('记忆策略', () => {
  it('相同结构化事实不会重复创建', () => {
    const existing = memory({ id: 'memory-active', subject: '用户', factKey: '语言', factValue: '中文' })
    const candidate = memory({ id: 'memory-new', status: 'candidate', subject: '用户', factKey: '语言', factValue: '中文' })

    expect(resolveMemoryCandidateDecision([existing], candidate)).toMatchObject({
      action: 'skip',
      reason: 'active_duplicate',
      target: existing,
    })
  })

  it('项目记忆只在规范化后的同一工作区可见', () => {
    const scoped = memory({ scopeType: 'project', scopeKey: 'd:/workspace/notes' })

    expect(isMemoryVisibleInScope(scoped, 'D:\\Workspace\\Notes\\')).toBe(true)
    expect(isMemoryVisibleInScope(scoped, 'D:\\Workspace\\Other')).toBe(false)
  })

  it('冲突事实生成替代决策，并只注入未被替代的 active 记录', () => {
    const oldFact = memory({ id: 'old', subject: '用户', factKey: '主题', factValue: '浅色' })
    const candidate = memory({ id: 'new', status: 'candidate', subject: '用户', factKey: '主题', factValue: '深色', content: '默认使用深色主题' })
    expect(resolveMemoryCandidateDecision([oldFact], candidate)).toMatchObject({ action: 'replace', target: oldFact })

    const replacement = memory({ id: 'replacement', supersedesId: 'old', content: '默认使用深色主题' })
    expect(filterInjectableMemories([oldFact, replacement])).toEqual([replacement])
  })

  it('无向量时关键词相似度仍能召回相关记忆', () => {
    const relevant = lexicalMemorySimilarity('中文回答', '所有技术问题默认使用中文回答')
    const unrelated = lexicalMemorySimilarity('中文回答', '项目数据库使用 SQLite')

    expect(relevant).toBeGreaterThan(0.3)
    expect(relevant).toBeGreaterThan(unrelated)
  })

  it('different structured subjects are not silently collapsed by lexical similarity', () => {
    const first = memory({ status: 'candidate', subject: '项目甲', factKey: 'database', content: '项目甲默认使用 SQLite 数据库' })
    const second = memory({ status: 'candidate', subject: '项目乙', factKey: 'database', content: '项目乙默认使用 SQLite 数据库' })
    expect(resolveMemoryCandidateDecision([first], second)).toEqual({ action: 'create' })
  })
})
