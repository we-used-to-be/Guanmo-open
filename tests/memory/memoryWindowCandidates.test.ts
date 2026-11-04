// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { parseMemoryWindowCandidates } from '@/services/memory/memoryWindowCandidates'
import { shouldActivateAutomaticMemory } from '@/services/memory/memoryPolicy'
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
  it('accepts model-extracted statements without requiring literal wording', () => {
    const candidate = { content: '用户现在每周都会修复机械钟表，已经坚持了五年', category: 'profile', kind: 'semantic', scope: 'global',
      primarySourceId: 'g1', supportingSourceIds: [], subject: '用户', factKey: '机械钟表修复习惯', factValue: '每周都会修复机械钟表',
      confidence: 0.95, sensitivity: 'normal' }
    expect(parse(candidate, globalPacket('我现在每周都会修复机械钟表，已经坚持了五年。'), null).candidates[0])
      .toMatchObject({ content: candidate.content })
  })
  it('accepts a model paraphrase without requiring an exact quote', () => {
    const input = globalPacket('我的职业是独立开发者，我长期从事软件开发。')
    const candidate = { content: '用户是独立开发者，长期从事软件开发', category: 'profile', kind: 'semantic', scope: 'global',
      primarySourceId: 'g1', supportingSourceIds: [], subject: '用户', factKey: '职业', factValue: '独立开发者，长期从事软件开发',
      confidence: 0.95, sensitivity: 'normal', evidenceQuote: '我的职业是独立开发者，我长期从事软件开发' }
    expect(parse(candidate, input, null).candidates[0]).toMatchObject({ content: candidate.content })
    expect(parse({ ...candidate, evidenceQuote: undefined }, input, null).candidates[0]).toMatchObject({ content: candidate.content })
  })

  it('leaves semantic support decisions to the model', () => {
    const candidate = { content: '用户喜欢苹果并且是医生', category: 'preference', kind: 'semantic', scope: 'global',
      primarySourceId: 'g1', supportingSourceIds: [], subject: '用户', factKey: '喜好', factValue: '苹果',
      confidence: 0.95, sensitivity: 'normal' }
    expect(parse(candidate, globalPacket('我喜欢苹果。'), null).candidates[0]).toMatchObject({ content: candidate.content })
  })

  it('does not apply a second local attribution classifier to the model result', () => {
    const candidate = { content: '用户是自由摄影师', category: 'profile', kind: 'semantic', scope: 'global',
      primarySourceId: 'g1', supportingSourceIds: [], subject: '用户', factKey: '职业', factValue: '自由摄影师',
      confidence: 0.95, sensitivity: 'normal' }
    expect(parse(candidate, globalPacket('我姐姐是自由摄影师。'), null).candidates[0]).toMatchObject({ content: candidate.content })
  })

  it('leaves negation interpretation to the extraction model', () => {
    const candidate = { content: '用户每天都喝咖啡', category: 'preference', kind: 'semantic', scope: 'global',
      primarySourceId: 'g1', supportingSourceIds: [], subject: '用户', factKey: '饮品', factValue: '咖啡',
      confidence: 0.95, sensitivity: 'normal' }
    expect(parse(candidate, globalPacket('我不喝咖啡。'), null).candidates[0]).toMatchObject({ content: candidate.content })
  })
  it('admits explicit habits and rejects candidates Rust would reject for missing literal value', () => {
    const candidate = { content: '用户习惯技术回答先给结论，再说明依据', category: 'preference', kind: 'semantic' as const,
      scope: 'global', primarySourceId: 'g1', supportingSourceIds: [], subject: '用户', factKey: '回答方式',
      factValue: '技术回答先给结论，再说明依据', confidence: 0.95, sensitivity: 'normal' }
    const text = '我习惯技术回答先给结论，再说明依据。'
    expect(shouldActivateAutomaticMemory(candidate, text)).toBe(true)
    expect(shouldActivateAutomaticMemory(candidate, '我习惯技术回答先给结论吗？')).toBe(false)
    expect(shouldActivateAutomaticMemory({ ...candidate, content: '用户不喜欢技术回答过度冗长', factValue: '不喜欢技术回答过度冗长' }, '我不喜欢技术回答过度冗长。')).toBe(true)
    expect(shouldActivateAutomaticMemory({ ...candidate, content: '用户不喜欢技术回答过度冗长', factValue: '不喜欢技术回答过度冗长' }, '这次我不喜欢技术回答过度冗长。')).toBe(false)
    const changed = { ...candidate, content: '用户习惯技术回答先给结论', factValue: '技术回答先给结论，再说明依据' }
    expect(parse(changed, globalPacket(text), null).candidates[0]).toMatchObject({ content: changed.content })
  })
  it('removes only a redundant primary source from v3 support IDs and still rejects unknown sources', () => {
    const candidate = { content: '用户的职业是独立开发者', category: 'profile', kind: 'semantic', scope: 'global',
      primarySourceId: 'g1', supportingSourceIds: ['g1'], subject: '用户', factKey: '职业', factValue: '独立开发者',
      confidence: 0.95, sensitivity: 'normal' }
    const input = globalPacket('我的职业是独立开发者，我长期从事软件开发。')
    expect(parse(candidate, input, null).candidates[0].supportingSourceIds).toEqual([])
    expect(parse({ ...candidate, supportingSourceIds: ['g1', 'unknown'] }, input, null).rejections).toEqual(['source'])
    expect(parse({ ...candidate, confidence: 'high' }, input, null).rejections).toEqual(['shape'])
  })
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

  it('rejects secrets and invalid global scope in v3', () => {
    const normal = { content: '我喜欢回答先给结论', category: 'preference', kind: 'semantic', scope: 'global',
      primarySourceId: 'g1', supportingSourceIds: [], subject: 'user', factKey: 'answer_order', factValue: '先给结论',
      confidence: 0.95, sensitivity: 'normal' }
    expect(parse(normal, globalPacket('我的密码是ExampleSecret123'), null).rejections).toEqual(['sensitive'])
    expect(parse({ ...normal, scope: 'project' }, globalPacket('本项目使用SQLite'), null).rejections).toEqual(['scope'])

    const acceptedContext = packet()
    acceptedContext.policyVersion = 3
    acceptedContext.turns[2].text = '我会考虑一下。'
    expect(parse(item({ category: 'learning', scope: 'global', content: '用户选择 PostgreSQL', primarySourceId: 'u2',
      supportingSourceIds: ['u1', 'a1'], factKey: 'database', sensitivity: 'normal' }), acceptedContext, null).candidates).toHaveLength(1)
  })
})
