import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatRequest, ChatResponse } from '@/services/ai/types'
import { makeRoutingDecision } from '@/services/agent/routingService'
import { resolveRouterConfig } from '@/services/agent/routerConfig'
import { semanticRoutingTriggers } from '@/services/agent/semanticRouter'
import { setAgentScopeContext } from '@/services/aiScope'
import * as executor from '@/services/agent/executor'
import { registerTool } from '@/services/agent/toolRegistry'

const mocks = vi.hoisted(() => ({
  chat: vi.fn<(request: ChatRequest) => Promise<ChatResponse>>(), database: true,
  agentToolResultMode: undefined as 'text' | undefined,
}))
vi.mock('@/services/ai/aiClient', () => ({ getAiClient: () => ({ chat: mocks.chat, agentToolResultMode: mocks.agentToolResultMode }), isAiReady: () => true }))
vi.mock('@/hooks/useTauri', async original => ({ ...await original<typeof import('@/hooks/useTauri')>(), isTauri: () => true }))
vi.mock('@/services/database/db', async original => ({ ...await original<typeof import('@/services/database/db')>(), isDatabaseReady: () => mocks.database }))

const query = '看看库里面有没有回溯内容'
const response = (content: string): ChatResponse => ({ id: 'anonymous', role: 'assistant', content })

describe('read routing and bounded Agent fallback', () => {
  const search = vi.fn(async () => JSON.stringify({ status: 'empty', results: [] }))
  beforeAll(() => executor.initAgent())
  beforeEach(() => {
    mocks.database = true
    mocks.agentToolResultMode = undefined
    mocks.chat.mockReset()
    search.mockReset().mockResolvedValue(JSON.stringify({ status: 'empty', results: [] }))
    setAgentScopeContext({ contextTags: [] })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    for (const name of ['search_memory', 'search_knowledge']) registerTool({ name, description: 'anonymous',
      parameters: [{ name: 'query', type: 'string', required: true, description: 'query' },
        { name: 'topK', type: 'number', required: false, description: 'limit' }], execute: search })
  })

  it('routes the reported library lookup to mandatory knowledge search without a file tag or classifier', () => {
    const decision = makeRoutingDecision(query, {})
    expect(decision.mode).toBe('agent')
    expect(decision.required).toContain('knowledge')
    expect(decision.candidateTools).toContain('search_knowledge')
    expect(decision.candidateTools).not.toContain('read_context_file')
    expect(semanticRoutingTriggers(query, decision, {}, resolveRouterConfig())).toEqual([])
  })

  it('does not mistake library lookup plus translation for selection-only translation', () => {
    const decision = makeRoutingDecision(`${query}并翻译成中文`, { hasSelection: true, hasContextTags: true })
    expect(decision.mode).toBe('agent')
    expect(decision.selectionRequestKind).toBe('explicit_lookup')
    expect(decision.required).toContain('knowledge')
  })

  it.each(['看看内容', '库是什么', '数据库里面有没有用户表'])('does not turn a vague phrase into a mandatory local library search: %s', text => {
    const decision = makeRoutingDecision(text, {})
    expect(decision.required).not.toContain('knowledge')
    if (text === '看看内容') expect(decision.mode).toBe('direct')
  })

  it('gives an Agent with a missing weak file candidate a qualified core read fallback', async () => {
    const decision = { ...makeRoutingDecision('看看内容', {}), mode: 'agent' as const,
      candidateTools: ['read_context_file' as const], required: [] }
    mocks.chat.mockImplementationOnce(async request => {
      expect(request.tools?.map(tool => tool.function.name)).toEqual(['search_memory', 'search_knowledge'])
      return { ...response('我先检索'), toolCalls: [{ name: 'search_knowledge', args: { query: '回溯' } }] }
    }).mockResolvedValueOnce(response('未找到相关片段'))
    const result = await executor.runAgent({ query: '看看内容', routingDecision: decision, streamEnabled: false })
    expect(search).toHaveBeenCalledTimes(1)
    expect(result.answer).toBe('未找到相关片段')
  })

  it('keeps the system prompt stable across preferences while placing them in the current turn', async () => {
    const decision = { ...makeRoutingDecision('看看内容', {}), mode: 'agent' as const,
      candidateTools: ['read_context_file' as const], required: [] }
    mocks.chat.mockResolvedValue(response('回答'))
    await executor.runAgent({ query: '看看内容', routingDecision: decision, streamEnabled: false, customPreferencePrompt: '简短回答' })
    await executor.runAgent({ query: '看看内容', routingDecision: decision, streamEnabled: false, customPreferencePrompt: '详细回答' })
    const first = mocks.chat.mock.calls[0][0].messages
    const second = mocks.chat.mock.calls[1][0].messages
    expect(first[0]).toEqual(second[0])
    expect(second.slice(1).some(message => message.content.includes('详细回答'))).toBe(true)
  })

  it.each([undefined, 'text'] as const)('uses the provider tool result mode (%s)', async mode => {
    mocks.agentToolResultMode = mode
    const decision = { ...makeRoutingDecision('看看内容', {}), mode: 'agent' as const,
      candidateTools: ['read_context_file' as const], required: [] }
    mocks.chat.mockResolvedValueOnce({ ...response('检索中'), toolCalls: [{ id: 'call-1', name: 'search_knowledge', args: { query: '回溯' } }] })
      .mockResolvedValueOnce(response('没有相关片段'))
    await executor.runAgent({ query: '看看内容', routingDecision: decision, streamEnabled: false })
    const messages = mocks.chat.mock.calls[1][0].messages
    if (mode === 'text') {
      expect(messages.some(message => message.role === 'tool' || 'tool_calls' in message)).toBe(false)
      expect(messages.at(-1)).toMatchObject({ role: 'user', content: expect.stringContaining('工具返回结果') })
    } else {
      expect(messages.at(-2)).toMatchObject({ role: 'assistant', tool_calls: [{ id: 'call-1', function: { name: 'search_knowledge' } }] })
      expect(messages.at(-1)).toMatchObject({ role: 'tool', tool_call_id: 'call-1' })
    }
    expect(search).toHaveBeenCalledTimes(1)
  })

  it('falls back to text results when native tool IDs are duplicated', async () => {
    const decision = { ...makeRoutingDecision('看看内容', {}), mode: 'agent' as const,
      candidateTools: ['read_context_file' as const], required: [] }
    mocks.chat.mockResolvedValueOnce({ ...response('检索中'), toolCalls: [
      { id: 'duplicate', name: 'search_memory', args: { query: '偏好' } },
      { id: 'duplicate', name: 'search_knowledge', args: { query: '回溯' } },
    ] }).mockResolvedValueOnce(response('没有相关片段'))
    await executor.runAgent({ query: '看看内容', routingDecision: decision, streamEnabled: false })
    expect(mocks.chat.mock.calls[1][0].messages.some(message => message.role === 'tool')).toBe(false)
    expect(search).toHaveBeenCalledTimes(2)
  })

  it('repairs a missing mandatory search once instead of accepting an action-only answer', async () => {
    mocks.chat.mockResolvedValueOnce(response('我先在知识库里检索与回溯相关的内容。'))
      .mockResolvedValueOnce(response('未找到相关片段'))
    const result = await executor.runAgent({ query, routingDecision: makeRoutingDecision(query, {}), streamEnabled: false })
    expect(search).toHaveBeenCalledTimes(1)
    expect(result.answer).toBe('未找到相关片段')
    expect(result.toolCalls).toBe(1)
  })

  it('reports an unavailable mandatory read without asking a tool-less model to promise a search', async () => {
    mocks.database = false
    mocks.chat.mockResolvedValue(response('我先在知识库里检索。'))
    const result = await executor.runAgent({ query, routingDecision: makeRoutingDecision(query, {}), streamEnabled: false })
    expect(mocks.chat).not.toHaveBeenCalled()
    expect(search).not.toHaveBeenCalled()
    expect(result.reason).toBe('error')
    expect(result.answer).toContain('检索')
    expect(result.answer).not.toContain('我先')
  })

  it('does not substitute library inventory when the requested content-search tool is disabled', async () => {
    registerTool({ name: 'search_knowledge', description: 'anonymous', parameters: [], enabled: false, execute: search })
    mocks.chat.mockResolvedValue(response('我先检索'))
    const result = await executor.runAgent({ query, routingDecision: makeRoutingDecision(query, {}), streamEnabled: false })
    expect(mocks.chat).not.toHaveBeenCalled()
    expect(search).not.toHaveBeenCalled()
    expect(result.reason).toBe('error')
    expect(result.answer).toContain('检索')
  })

  it('does not count a failed read as completed or keep retrying automatic repair', async () => {
    search.mockRejectedValue(new Error('anonymous retrieval failure'))
    mocks.chat.mockResolvedValue(response('我先在知识库里检索。'))
    const result = await executor.runAgent({ query, routingDecision: makeRoutingDecision(query, {}), streamEnabled: false })
    expect(search).toHaveBeenCalledTimes(1)
    expect(mocks.chat).toHaveBeenCalledTimes(2)
    expect(result.reason).toBe('error')
    expect(result.answer).not.toContain('我先')
  })

  it('repairs all missing required reads in the one allowed batch, including selection and knowledge', async () => {
    const readSelection = vi.fn(async () => JSON.stringify({ chunks: [
      { role: 'before', content: '匿名上文' }, { role: 'current', content: '匿名选区' }, { role: 'after', content: '匿名下文' },
    ] }))
    registerTool({ name: 'read_selection_context', description: 'anonymous',
      parameters: [{ name: 'targetId', type: 'string', required: false, description: 'target' }], execute: readSelection })
    setAgentScopeContext({ contextTags: [{ id: 'selection', type: 'selection', title: 'anonymous', filePath: 'C:/Temp/anonymous.md',
      content: '匿名选区', preview: '匿名', selectionFrom: 0, selectionTo: 4 }],
    editTargets: [{ id: 'target', type: 'selection', title: 'anonymous', filePath: 'C:/Temp/anonymous.md', selectionFrom: 0, selectionTo: 4 }] })
    const decision = { ...makeRoutingDecision(query, {}), candidateTools: ['read_selection_context', 'search_knowledge'] as const,
      required: ['selection_context', 'knowledge'] as const }
    mocks.chat.mockResolvedValueOnce(response('我先读取并检索。')).mockResolvedValueOnce(response('根据上下文和检索结果回答。'))
    const result = await executor.runAgent({ query, routingDecision: { ...decision, candidateTools: [...decision.candidateTools], required: [...decision.required] }, streamEnabled: false })
    expect(readSelection).toHaveBeenCalledTimes(1)
    expect(search).toHaveBeenCalledTimes(1)
    expect(result.toolCalls).toBe(2)
    expect(result.answer).toBe('根据上下文和检索结果回答。')
  })

  it('keeps semantic suggestions discretionary rather than forcing an unrequested search', async () => {
    const decision = { ...makeRoutingDecision('这个说法靠谱吗', {}), mode: 'agent' as const,
      selectionSource: 'semantic' as const, candidateTools: ['search_knowledge' as const], required: [] }
    mocks.chat.mockResolvedValue(response('根据本轮已提供的信息可以判断。'))
    const result = await executor.runAgent({ query: '这个说法靠谱吗', routingDecision: decision, streamEnabled: false })
    expect(search).not.toHaveBeenCalled()
    expect(result.answer).toBe('根据本轮已提供的信息可以判断。')
  })

  it('does not add library-wide fallback tools to section-scoped reading', async () => {
    setAgentScopeContext({ contextTags: [{ id: 'selection', type: 'selection', title: 'anonymous',
      filePath: 'C:/Temp/anonymous.md', content: '标题', preview: '标题' }] })
    const decision = { ...makeRoutingDecision('解释本节内容', { hasSelection: true, hasContextTags: true }),
      candidateTools: ['read_selection_context' as const], required: [] }
    mocks.chat.mockResolvedValue(response('本节说明'))
    await executor.runAgent({ query: '解释本节内容', routingDecision: decision, streamEnabled: false })
    expect(mocks.chat.mock.calls[0][0].tools?.map(tool => tool.function.name)).toEqual(['read_selection_context'])
  })

  it('keeps user opt-outs and sensitive memory access checks in Agent fallback', async () => {
    const decision = { ...makeRoutingDecision('看看内容', {}), mode: 'agent' as const, candidateTools: [], required: [] }
    mocks.chat.mockImplementationOnce(async request => {
      expect(request.tools?.map(tool => tool.function.name)).toEqual(['search_knowledge'])
      return response('直接回答')
    })
    await executor.runAgent({ query: '不要使用记忆，看看内容', routingDecision: decision, streamEnabled: false })
    const result = await executor.executeTool('search_memory', { query: '我的住址' }, 1000, '给个建议')
    expect(result.status).toBe('tool_error')
    expect(search).not.toHaveBeenCalled()
  })

  it('does not treat a read tool returning an explicit failure string as successful evidence', async () => {
    registerTool({ name: 'read_context_file', description: 'anonymous', parameters: [], execute: async () => '读取文件失败: anonymous' })
    setAgentScopeContext({ contextTags: [{ id: 'file', type: 'file', title: 'anonymous', filePath: 'C:/Temp/anonymous.md', content: null, preview: '' }] })
    const result = await executor.executeTool('read_context_file', {}, 1000, '读取文件')
    expect(result.status).toBe('tool_error')
  })
})
