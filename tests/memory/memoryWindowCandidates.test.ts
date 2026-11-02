// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { parseMemoryWindowCandidates } from '@/services/memory/memoryWindowCandidates'
import type { MemoryWindowPacket } from '@/services/memory/memoryWindowInput'

const packet = (): MemoryWindowPacket => ({
  turns: [
    { id: 'u1', role: 'user', contextOnly: false, text: '项目数据库在 SQLite 和 PostgreSQL 里选。' },
    { id: 'a1', role: 'assistant', contextOnly: false, parentId: 'u1', text: '第二个是 PostgreSQL。' },
    { id: 'u2', role: 'user', contextOnly: false, text: '定第二个，后续项目都这样。' },
    { id: 'u3', role: 'user', contextOnly: false, text: '谢谢。' },
  ],
  newSourceIds: ['u1', 'u2', 'u3'], segmentedSourceIds: [], snapshots: [], needsModel: true, estimatedInputTokens: 500,
})
const item = (changes: Record<string, unknown> = {}) => ({
  content: '项目数据库选择 PostgreSQL', category: 'project', kind: 'episodic', scope: 'project',
  primarySourceId: 'u2', supportingSourceIds: ['u1', 'a1'], subject: 'project', factKey: 'database',
  factValue: 'PostgreSQL', confidence: 0.9, ...changes,
})
const parse = (candidate: unknown, current = packet(), scope: string | null = 'p') =>
  parseMemoryWindowCandidates(JSON.stringify([candidate]), current, scope)
const globalPacket = (text: string): MemoryWindowPacket => ({ policyVersion: 3,
  turns: [{ id: 'g1', role: 'user', contextOnly: false, text }], newSourceIds: ['g1'], segmentedSourceIds: [],
  snapshots: [], needsModel: true, estimatedInputTokens: 100 })

describe('window model proposal validation', () => {
  it('accepts a user decision with prior user and assistant sources but requires semantic review', () => {
    const result = parse(item())
    expect(result.rejections).toEqual([])
    expect(result.candidates).toHaveLength(1)
    expect(result.candidates[0]).toMatchObject({ primarySourceId: 'u2', supportingSourceIds: ['u1', 'a1'], requiresSemanticReview: true })
  })

  it('rejects project decisions widened into future projects, even when the scope field says project', () => {
    expect(parse(item({ content: '项目数据库选择 PostgreSQL，后续项目都这样' })).rejections).toEqual(['scope'])
    expect(parse(item({ scope: 'global' })).rejections).toEqual(['scope'])
    expect(parse(item(), packet(), null).rejections).toEqual(['scope'])
    expect(parse(item({ content: 'PostgreSQL for all projects' })).rejections).toEqual(['scope'])
  })

  it('rejects assistant primary, unsupported parent, unknown and future sources', () => {
    expect(parse(item({ primarySourceId: 'a1', supportingSourceIds: ['u1'] })).rejections).toEqual(['source'])
    expect(parse(item({ supportingSourceIds: ['a1'] })).rejections).toEqual(['source'])
    expect(parse(item({ supportingSourceIds: ['u1', 'unknown'] })).rejections).toEqual(['source'])
    expect(parse(item({ primarySourceId: 'u1', supportingSourceIds: ['u2'] })).rejections).toEqual(['source'])
  })

  it('rejects undecided, unsupported, negative reversal and sensitive proposals', () => {
    const undecided = packet(); undecided.turns[2].text = '我还没决定。'
    expect(parse(item(), undecided).rejections).toEqual(['undecided'])
    undecided.turns[2].text = '我没选定。'
    expect(parse(item(), undecided).rejections).toEqual(['undecided'])
    expect(parse(item({ factValue: 'MySQL' })).rejections).toEqual(['unsupported_value'])
    const negative = packet(); negative.turns[2].text = '我不使用 PostgreSQL。'
    expect(parse(item(), negative).rejections).toEqual(['negation'])
    expect(parse(item({ content: '用户密码是匿名口令' })).rejections).toEqual(['sensitive'])
  })

  it('preserves NOOP and marks partial-source proposals for later conservative handling', () => {
    expect(parseMemoryWindowCandidates('[]', packet(), 'p')).toEqual({ candidates: [], rejections: [] })
    expect(() => parseMemoryWindowCandidates('not json', packet(), 'p')).toThrow()
    const partial = packet(); partial.segmentedSourceIds = ['u2']
    expect(parse(item(), partial).candidates[0].segmented).toBe(true)
  })

  it('accepts a normal global fact but keeps a health fact explicitly sensitive', () => {
    const normal = { content: '我喜欢回答先给结论', category: 'preference', kind: 'semantic', scope: 'global',
      primarySourceId: 'g1', supportingSourceIds: [], subject: 'user', factKey: 'answer_order', factValue: '先给结论',
      confidence: 0.95, sensitivity: 'normal' }
    expect(parse(normal, globalPacket('我喜欢回答先给结论'), null).candidates[0].sensitivity).toBe('normal')

    const sensitive = { ...normal, content: '用户长期有高血压', category: 'profile', factKey: 'health',
      factValue: '高血压', sensitivity: 'sensitive' }
    const result = parse(sensitive, globalPacket('我长期有高血压，希望饮食清淡'), null)
    expect(result.rejections).toEqual([])
    expect(result.candidates[0].sensitivity).toBe('sensitive')
  })

  it('rejects secrets, project/document scope, temporary facts, and unaccepted assistant suggestions in v3', () => {
    const normal = { content: '我喜欢回答先给结论', category: 'preference', kind: 'semantic', scope: 'global',
      primarySourceId: 'g1', supportingSourceIds: [], subject: 'user', factKey: 'answer_order', factValue: '先给结论',
      confidence: 0.95, sensitivity: 'normal' }
    expect(parse(normal, globalPacket('我的密码是ExampleSecret123'), null).rejections).toEqual(['sensitive'])
    expect(parse({ ...normal, content: '本项目使用SQLite', factValue: 'SQLite' }, globalPacket('本项目使用SQLite'), null).rejections).toEqual(['scope'])
    expect(parse({ ...normal, content: '这份文档结论使用SQLite', factValue: 'SQLite' }, globalPacket('这份文档结论使用SQLite'), null).rejections).toEqual(['scope'])
    expect(parse({ ...normal, content: '今天临时用SQLite', factValue: 'SQLite' }, globalPacket('今天临时用SQLite'), null).rejections).toEqual(['policy'])

    const acceptedContext = packet()
    acceptedContext.policyVersion = 3
    acceptedContext.turns[2].text = '我会考虑一下。'
    expect(parse(item({ category: 'learning', scope: 'global', content: '用户选择 PostgreSQL', primarySourceId: 'u2',
      supportingSourceIds: ['u1', 'a1'], factKey: 'database', sensitivity: 'normal' }), acceptedContext, null).rejections)
      .toEqual(['unsupported_value'])
  })
})
