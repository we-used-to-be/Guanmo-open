import { describe, expect, it } from 'vitest'
import { isExplicitMemoryWriteIntent, shouldExtractMemoryCandidate } from '../../src/services/memory/memoryPolicy'

describe('memory extraction rule baseline', () => {
  it('filters both the options and the user decision in the frozen script 07', () => {
    const messages = ['项目数据库在SQLite和PostgreSQL里选。', '定第二个，后续项目都这样。']
    expect(messages.map(shouldExtractMemoryCandidate)).toEqual([false, false])
    expect(messages.map(isExplicitMemoryWriteIntent)).toEqual([false, false])
  })

  it('filters the user acceptance in the frozen scripts 09 and 10', () => {
    expect(shouldExtractMemoryCandidate('我长期更习惯前一种。')).toBe(false)
    expect(shouldExtractMemoryCandidate('第二种，以后一直这样。')).toBe(false)
  })

  it('admits a literal fact and keeps sensitive text out', () => {
    expect(shouldExtractMemoryCandidate('我的专业是计算机科学。')).toBe(true)
    expect(shouldExtractMemoryCandidate('我的密码是匿名测试口令，不要保存。')).toBe(false)
  })
})
