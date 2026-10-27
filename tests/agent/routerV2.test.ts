import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { makeRoutingDecision } from '@/services/agent/routingService'
import { DEFAULT_ROUTER_CONFIG, resolveRouterConfig } from '@/services/agent/routerConfig'
import { applySemanticRoute, parseSemanticRoute, resolveSemanticRouting, semanticRoutingTriggers } from '@/services/agent/semanticRouter'
import { CAPABILITY_TOOLS, isWriteTool } from '@/services/agent/toolSelector'
import { registerTool } from '@/services/agent/toolRegistry'
import { qualifyCandidates, qualifyExternalTool, qualifyTool, type ToolEligibilityContext } from '@/services/agent/toolEligibility'
import { getRoutingMetrics, recordRoutingMetric, summarizeRoutingEvaluation } from '@/services/agent/routingDiagnostics'

const config = resolveRouterConfig()
const qualifyContext: ToolEligibilityContext = {
  desktop: true, readAllowed: true, writeAllowed: true, hasSelection: true,
  hasReadableContext: true, hasEditTarget: true, memoryWriteRequested: false,
  webEnabled: true, reminderEnabled: true,
}
const original = () => makeRoutingDecision('这个说法靠谱吗？', {})
const response = (value: unknown) => ({ id: 'anonymous', role: 'assistant' as const, content: JSON.stringify(value) })
const selected = { intent: 'tools', toolCategories: ['knowledge'], needsMemory: false, confidence: 0.9 }

beforeAll(() => {
  for (const name of [...new Set(Object.values(CAPABILITY_TOOLS).flat()), 'save_memory']) {
    registerTool({ name, description: 'anonymous', parameters: [],
      effect: isWriteTool(name) ? 'write_local' : 'read', execute: async () => 'unused' })
  }
})
afterEach(() => vi.useRealTimers())

describe('Router V2 uncertainty gate', () => {
  it.each(['你好', '什么是闭包？', '什么是记忆？', '解释一下证据的出处', '写一首春天的诗'])('does not send ordinary QA to a classifier: %s', query => {
    expect(semanticRoutingTriggers(query, makeRoutingDecision(query, {}), {}, config)).toEqual([])
  })
  it.each(['搜索知识库里的算法资料', '联网搜索今日新闻', '现在几点了', '你记得我的地址吗', '创建阅读提醒', '搜索知识库并联网搜索资料', '查找那份文档'])('keeps explicit requests on rules: %s', query => {
    expect(semanticRoutingTriggers(query, makeRoutingDecision(query, {}), {}, config)).toEqual([])
  })
  it('does not classify a low score alone', () => {
    expect(semanticRoutingTriggers('知识', makeRoutingDecision('知识', {}), {}, config)).toEqual([])
  })
  it('detects an implicit lookup even when all original scores are zero', () => {
    expect(semanticRoutingTriggers('这个说法靠谱吗？', original(), {}, config)).toContain('implicit_lookup')
  })
  it('reuses score evidence and configurable conflict margin', () => {
    const decision = { ...original(), ruleScores: [
      { capability: 'knowledge' as const, score: 3, isRequired: false, signals: ['weak:资料'] },
      { capability: 'web' as const, score: 2, isRequired: false, signals: ['weak:搜索'] },
    ] }
    expect(semanticRoutingTriggers('有出处吗？', decision, {}, config)).toContain('conflicting_categories')
    expect(semanticRoutingTriggers('有出处吗？', decision, {}, { ...config, conflictMargin: 0 })).not.toContain('conflicting_categories')
    expect(semanticRoutingTriggers('用资料还是网络？', decision, {}, config)).toEqual(['conflicting_categories'])
  })
  it('classifies missing referents and history dependency only without sufficient context', () => {
    const decision = original()
    expect(semanticRoutingTriggers('之前那套仍然合适吗？', decision, {}, config)).toEqual(expect.arrayContaining(['missing_referent', 'implicit_memory']))
    expect(semanticRoutingTriggers('之前那套仍然合适吗？', decision, { hasContextTags: true }, config)).toEqual([])
    expect(semanticRoutingTriggers('之前那套仍然合适吗？', decision, {}, config, true)).toEqual([])
    expect(semanticRoutingTriggers('之前那套仍然合适吗？', decision, {}, { ...config, enabled: false })).toEqual([])
  })
  it('protects translation-only selection and manual requests', () => {
    const query = '翻译这段文本'
    expect(semanticRoutingTriggers(query, makeRoutingDecision(query, { hasSelection: true }), { hasSelection: true }, config)).toEqual([])
    expect(semanticRoutingTriggers('这个说法靠谱吗？', makeRoutingDecision('这个说法靠谱吗？', {}, { forceAgent: true }), {}, config)).toEqual([])
  })
})

describe('One semantic result, no rule competition', () => {
  it('adopts selected categories directly, ignores self-reported confidence as authority', async () => {
    const rules = { ...original(), candidates: ['web' as const], required: ['web' as const], candidateTools: ['web_search' as const] }
    const chat = vi.fn().mockResolvedValue(response({ ...selected, confidence: 0.01 }))
    const result = await resolveSemanticRouting({ query: '有出处吗？', original: rules, context: {}, config, chat })
    expect(result.status).toBe('selected')
    expect(result.decision.candidates).toEqual(['knowledge'])
    expect(result.decision.required).toEqual([])
    expect(result.decision.candidateTools).toEqual(['search_knowledge', 'list_database_contents'])
    expect(chat).toHaveBeenCalledTimes(1)
    expect(chat.mock.calls[0][0]).toMatchObject({ temperature: 0, maxTokens: 160, tools: [], toolChoice: 'none' })
    expect(semanticRoutingTriggers('有出处吗？', result.decision, {}, config)).toEqual([])
  })
  it('allows no_tool, including overriding original candidates', async () => {
    const rules = makeRoutingDecision('搜索资料', {})
    const result = await resolveSemanticRouting({ query: '有出处吗？', original: rules, context: {}, config,
      chat: vi.fn().mockResolvedValue(response({ intent: 'no_tool', toolCategories: [], needsMemory: false, confidence: 0.8 })) })
    expect(result).toMatchObject({ status: 'no_tool', decision: { mode: 'direct', candidateTools: [], shouldLookupMemory: false } })
  })
  it('outputs memory and tools in one call, without forcing execution', () => {
    const result = applySemanticRoute(original(), { intent: 'tools', toolCategories: ['knowledge'], needsMemory: true, confidence: 0.5 })
    expect(result).toMatchObject({ shouldLookupMemory: true, memoryIntent: 'weak', required: [] })
    expect(result.candidateTools).toContain('search_memory')
    expect(result.candidateTools).not.toContain('save_memory')
    expect(applySemanticRoute(original(), { intent: 'tools', toolCategories: ['file_write'], needsMemory: false, confidence: 1 }).requiresEditConfirmation).toBe(false)
  })
  it.each([
    { ...selected, toolCategories: ['invented'] }, { ...selected, toolCategories: ['knowledge', 'knowledge'] },
    { ...selected, confidence: 2 }, { ...selected, needsMemory: 'yes' },
    { ...selected, intent: 'no_tool' },
  ])('rejects invalid output and preserves original route', async value => {
    const rules = original()
    const result = await resolveSemanticRouting({ query: '有出处吗？', original: rules, context: {}, config, chat: vi.fn().mockResolvedValue(response(value)) })
    expect(result.status).toBe('invalid')
    expect(result.decision).toBe(rules)
  })
  it('rejects invalid JSON or model prose', () => {
    expect(parseSemanticRoute('```json\n{}\n```', config)).toBeNull()
    expect(parseSemanticRoute('x'.repeat(5000), config)).toBeNull()
  })
  it('only sends a bounded query and context booleans, never document paths or full text', async () => {
    const chat = vi.fn().mockResolvedValue(response(selected))
    await resolveSemanticRouting({ query: 'x'.repeat(2000), original: original(), context: { currentFilePath: 'PRIVATE_PATH', hasSelection: true }, config, chat })
    const messages = chat.mock.calls[0][0].messages
    const payload = JSON.parse(messages[1].content)
    expect(payload.query).toHaveLength(config.maxQueryChars)
    expect(JSON.stringify(messages)).not.toContain('PRIVATE_PATH')
    expect(payload.categories.every((entry: { tools: object[] }) => entry.tools.every(tool => Object.keys(tool).sort().join(',') === 'effect,name'))).toBe(true)
  })
  it('falls back on unavailable model or sync failure exactly once', async () => {
    const rules = original()
    const chat = vi.fn(() => { throw new Error('unavailable private details') })
    const result = await resolveSemanticRouting({ query: '有出处吗？', original: rules, context: {}, config, chat })
    expect(result).toEqual({ decision: rules, status: 'failed' })
    expect(chat).toHaveBeenCalledTimes(1)
  })
  it('bounds a hung model, aborts it and ignores late output', async () => {
    vi.useFakeTimers()
    const rules = original()
    let resolve!: (value: ReturnType<typeof response>) => void
    const chat = vi.fn(() => new Promise<ReturnType<typeof response>>(r => { resolve = r }))
    const promise = resolveSemanticRouting({ query: '有出处吗？', original: rules, context: {}, config, chat })
    await vi.advanceTimersByTimeAsync(config.timeoutMs)
    const result = await promise
    expect(result).toEqual({ decision: rules, status: 'timeout' })
    expect(chat.mock.calls[0][0].signal?.aborted).toBe(true)
    resolve(response(selected))
    await Promise.resolve()
    expect(result.decision).toBe(rules)
    expect(vi.getTimerCount()).toBe(0)
  })
  it('honors user cancellation without another classification', async () => {
    const controller = new AbortController()
    const rules = original()
    const chat = vi.fn(() => new Promise<never>(() => {}))
    const promise = resolveSemanticRouting({ query: '有出处吗？', original: rules, context: {}, config, chat, signal: controller.signal })
    await Promise.resolve()
    controller.abort()
    expect(await promise).toEqual({ decision: rules, status: 'cancelled' })
    expect(chat).toHaveBeenCalledTimes(1)
  })
})

describe('Independent qualification', () => {
  it('distinguishes available, missing context and blocked permission', () => {
    expect(qualifyTool('replace_current_tab_text', { ...qualifyContext, hasEditTarget: false })).toBe('needs_input')
    expect(qualifyTool('replace_current_tab_text', { ...qualifyContext, writeAllowed: false })).toBe('blocked')
    expect(qualifyTool('read_selection_context', { ...qualifyContext, hasSelection: false })).toBe('needs_input')
    expect(qualifyTool('read_context_file', { ...qualifyContext, hasReadableContext: false })).toBe('needs_input')
    expect(qualifyTool('search_memory', qualifyContext)).toBe('available')
    expect(qualifyTool('save_memory', qualifyContext)).toBe('blocked')
    expect(qualifyTool('save_memory', { ...qualifyContext, memoryWriteRequested: true })).toBe('available')
    expect(qualifyTool('unknown', qualifyContext)).toBe('blocked')
    expect(qualifyTool('search_memory', { ...qualifyContext, desktop: false })).toBe('blocked')
    expect(qualifyTool('search_memory', { ...qualifyContext, readAllowed: false })).toBe('blocked')
    expect(qualifyTool('search_memory', { ...qualifyContext, databaseAvailable: false })).toBe('blocked')
    expect(qualifyTool('web_search', { ...qualifyContext, webEnabled: false })).toBe('blocked')
  })
  it('filters semantic choices through the same qualification', () => {
    const route = applySemanticRoute(original(), { intent: 'tools', toolCategories: ['file_write', 'web'], needsMemory: false, confidence: 1 })
    const result = qualifyCandidates(route.candidateTools, { ...qualifyContext, hasEditTarget: false, webEnabled: false })
    expect(result.available).toEqual(['list_current_edit_targets'])
    expect(result.needsInput).toEqual(['replace_current_tab_text'])
  })
  it('rechecks live registration availability', () => {
    let available = true
    registerTool({ name: 'anonymous_live', parameters: [], description: 'anonymous', isAvailable: () => available, execute: async () => '' })
    expect(qualifyTool('anonymous_live', qualifyContext)).toBe('available')
    available = false
    expect(qualifyTool('anonymous_live', qualifyContext)).toBe('blocked')
    registerTool({ name: 'anonymous_disabled', parameters: [], description: '', enabled: false, execute: async () => '' })
    expect(qualifyTool('anonymous_disabled', qualifyContext)).toBe('blocked')
  })
  it('reserves a fail-closed MCP snapshot boundary without injecting schemas', () => {
    const external = { name: 'mcp_anonymous_0' as const, enabled: true, connectionState: 'connected' as const, catalogCurrent: true, userSelected: true }
    expect(qualifyExternalTool(external)).toBe('available')
    expect(qualifyExternalTool({ ...external, connectionState: 'disconnected' })).toBe('blocked')
    expect(qualifyExternalTool({ ...external, catalogCurrent: false })).toBe('blocked')
    expect(qualifyExternalTool({ ...external, userSelected: false })).toBe('blocked')
  })
})

describe('Compatibility and anonymous diagnostics', () => {
  it('normalizes old or malformed settings without clearing them', () => {
    expect(resolveRouterConfig()).toEqual(DEFAULT_ROUTER_CONFIG)
    expect(resolveRouterConfig({ timeoutMs: NaN, conflictMargin: 50, enabled: false })).toMatchObject({ timeoutMs: 1200, conflictMargin: 3, enabled: false })
  })
  it('keeps bounded numeric diagnostics and supports labelled offline evaluation', () => {
    for (let i = 0; i < 205; i++) recordRoutingMetric({ source: 'rules', mode: 'direct', durationMs: i, candidateCount: 0 })
    expect(getRoutingMetrics()).toHaveLength(200)
    expect(Object.keys(getRoutingMetrics()[0])).not.toContain('query')
    expect(summarizeRoutingEvaluation(['knowledge'], ['web'])).toEqual({ falsePositives: 1, falseNegatives: 1 })
  })
})
