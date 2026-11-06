import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatRequest, ChatResponse, StreamChunk } from '@/services/ai/types'
import { DEFAULT_AI_CONFIG } from '@/services/ai/types'
import { useSettingsStore } from '@/stores/settingsStore'
import { useChatStore } from '@/stores/chatStore'
import { useAiChat } from '@/hooks/useAiChat'
import { getAgentScopeContext } from '@/services/aiScope'
import { getDirectChatMetrics } from '@/services/agent/directChat'
import type { Memory } from '@/services/database/persistence'
import type { AgentResult, AgentRunRequest } from '@/services/agent/types'
import { prepareConversationContext } from '@/services/agent/conversationRequest'

const mocks = vi.hoisted(() => ({
  foreground: vi.fn(),
  hydrate: vi.fn(async () => {}),
  aiReady: vi.fn(() => true),
  classify: vi.fn<(request: ChatRequest) => Promise<ChatResponse>>(),
  answer: vi.fn(),
  memory: vi.fn<() => Promise<Memory[]>>(async () => []),
  knowledge: vi.fn<typeof import('@/services/rag/pipeline').searchRelevant>(async () => []),
  agent: vi.fn<(request: AgentRunRequest) => Promise<AgentResult>>(async () => ({ answer: 'anonymous agent answer', steps: [], toolCalls: 0, reason: 'completed' })),
  chunks: [] as StreamChunk[][],
}))
const client = {
  chat: mocks.classify,
  streamChat: async function* (_request: ChatRequest) {
    mocks.answer(_request)
    for (const chunk of mocks.chunks.shift() || [{ content: 'anonymous direct answer', done: true }]) yield chunk
  },
}
vi.mock('@/services/ai/aiClient', () => ({
  getAiClient: () => client, getAiConfig: () => useSettingsStore.getState().ai,
  initAiClient: () => client, isAiReady: mocks.aiReady, isEmbeddingReady: () => false,
  getEmbeddingConfig: () => null, isLocalApi: () => true, resetAiClient: () => {},
  createChatProvider: () => client,
}))
vi.mock('@/services/settingsSecrets', () => ({ ensureSettingsSecretsHydrated: mocks.hydrate }))
vi.mock('@/services/memory/memoryIntake', () => ({ persistGlobalMemoryMessage: async () => true }))
vi.mock('@/services/memory/memoryWindowScheduler', () => ({
  setWindowSchedulerForegroundBusy: mocks.foreground, scheduleGlobalWindowExtraction: async () => {},
}))
vi.mock('@/services/agent/conversationRequest', async importOriginal => {
  const real = await importOriginal<typeof import('@/services/agent/conversationRequest')>()
  return { ...real, prepareConversationContext: vi.fn(real.prepareConversationContext) }
})
vi.mock('@/services/rag/pipeline', async importOriginal => ({
  ...await importOriginal<typeof import('@/services/rag/pipeline')>(), searchRelevant: mocks.knowledge, getKnowledgeDocumentStates: async () => [],
}))
vi.mock('@/services/database/db', async importOriginal => ({ ...await importOriginal<typeof import('@/services/database/db')>(), isDatabaseReady: () => true }))
vi.mock('@/hooks/useTauri', async importOriginal => ({ ...await importOriginal<typeof import('@/hooks/useTauri')>(), isTauri: () => true }))
vi.mock('@/services/agent', async importOriginal => ({ ...await importOriginal<typeof import('@/services/agent')>(), runAgent: mocks.agent }))
vi.mock('@/services/memory/memoryService', async importOriginal => ({
  ...await importOriginal<typeof import('@/services/memory/memoryService')>(), searchMemories: mocks.memory,
  processMemoryCandidateExtraction: async () => {},
}))

beforeEach(() => {
  mocks.foreground.mockClear()
  mocks.hydrate.mockReset().mockResolvedValue(undefined)
  mocks.aiReady.mockReset().mockReturnValue(true)
  vi.mocked(prepareConversationContext).mockClear()
  mocks.classify.mockReset()
  mocks.answer.mockClear()
  mocks.agent.mockClear()
  mocks.memory.mockReset().mockResolvedValue([])
  mocks.knowledge.mockReset().mockResolvedValue([])
  mocks.chunks.length = 0
  useSettingsStore.setState({ ai: { ...DEFAULT_AI_CONFIG, baseUrl: 'http://127.0.0.1:1234', chatModel: 'anonymous', routing: { enabled: true } } })
  useChatStore.setState({ messages: [], streaming: false, error: null, agentTaskContext: null, agentMode: false,
    saveCurrentSession: vi.fn(async () => {}) })
})

describe('Router V2 real chat orchestration', () => {
  it('shows the current route in the timeline and clears the previous route on a new request', async () => {
    const { result } = renderHook(() => useAiChat())
    await act(async () => { await result.current.sendMessage('你好') })
    expect(useChatStore.getState().timeline.map(item => item.label)).toContain('普通请求 · 快速回答问题')
    await act(async () => { await result.current.sendMessage('再看看', true) })
    const labels = useChatStore.getState().timeline.map(item => item.label)
    expect(labels).toContain('Agent 流程 · 处理复杂任务')
    expect(labels).not.toContain('普通请求 · 快速回答问题')
  })
  it.each(['context', 'client-ready', 'client-unconfigured'] as const)('keeps the new foreground request busy when the cancelled request returns late from %s', async stage => {
    const prepared = await prepareConversationContext({ content: '匿名上下文', readFile: async () => '' })
    vi.mocked(prepareConversationContext).mockClear()
    let releaseA!: () => void
    let releaseB!: () => void
    if (stage === 'context') {
      vi.mocked(prepareConversationContext).mockImplementationOnce(() => new Promise(resolve => { releaseA = () => resolve(prepared) }))
    } else {
      mocks.hydrate.mockImplementationOnce(() => new Promise(resolve => { releaseA = () => resolve() }))
    }
    const { result } = renderHook(() => useAiChat())
    let taskA!: Promise<void>, taskB!: Promise<void>
    act(() => { taskA = result.current.sendMessage('匿名请求 A') })
    await waitFor(() => expect(releaseA).toBeTypeOf('function'))
    act(() => result.current.cancelStream())
    vi.mocked(prepareConversationContext).mockImplementationOnce(() => new Promise(resolve => { releaseB = () => resolve(prepared) }))
    act(() => { taskB = result.current.sendMessage('匿名请求 B') })
    await waitFor(() => expect(releaseB).toBeTypeOf('function'))
    if (stage === 'client-unconfigured') {
      mocks.aiReady.mockReturnValue(false)
      act(() => useSettingsStore.setState({ ai: { ...DEFAULT_AI_CONFIG } }))
    }
    await act(async () => { releaseA(); await taskA })
    expect(useChatStore.getState().streaming).toBe(true)
    expect(mocks.foreground).toHaveBeenLastCalledWith(true)
    expect(useChatStore.getState().error).toBeNull()
    act(() => result.current.cancelStream())
    await act(async () => { releaseB(); await taskB })
    expect(mocks.foreground).toHaveBeenLastCalledWith(false)
    expect(mocks.answer).not.toHaveBeenCalled()
  })
  it('retains qualified fallback reads in the route and subsequent task continuation', async () => {
    mocks.agent.mockResolvedValueOnce({ answer: 'anonymous lookup result', toolCalls: 1, reason: 'completed', steps: [
      { type: 'action', toolName: 'search_knowledge', content: 'search', timestamp: 1 },
      { type: 'observation', toolName: 'search_knowledge', content: 'anonymous result', timestamp: 2 },
    ] })
    const { result } = renderHook(() => useAiChat())
    await act(async () => { await result.current.sendMessage('看看内容', true) })
    expect(mocks.agent.mock.calls[0][0].routingDecision?.candidateTools).toEqual(['search_memory', 'search_knowledge'])
    expect(useChatStore.getState().agentTaskContext).toMatchObject({
      originalRequest: '看看内容', usedToolNames: ['search_knowledge'],
    })
    await act(async () => { await result.current.sendMessage('继续') })
    expect(mocks.agent).toHaveBeenCalledTimes(2)
    expect(mocks.agent.mock.calls[1][0].routingDecision?.candidateTools).toContain('search_knowledge')
    expect(mocks.agent.mock.calls[1][0].routingDecision?.inheritedOriginalRequest).toBe('看看内容')
  })

  it('keeps pending knowledge status after memory completes and shows index progress before final generation', async () => {
    let finishMemory!: (value: Memory[]) => void
    let finishKnowledge!: (value: []) => void
    let reportProgress!: (stage: 'initializing' | 'fallback') => void
    mocks.memory.mockImplementationOnce(() => new Promise(resolve => { finishMemory = resolve }))
    mocks.knowledge.mockImplementationOnce((_query, options) => {
      reportProgress = options!.onProgress!
      return new Promise(resolve => { finishKnowledge = resolve })
    })
    mocks.chunks.push([{ content: '', done: true, toolCallDeltas: [
      { index: 0, id: 'memory-status', name: 'search_memory', arguments: '{"query":"偏好"}' },
      { index: 1, id: 'knowledge-status', name: 'search_knowledge', arguments: '{"query":"资料"}' },
    ] }])
    const assistantText = () => useChatStore.getState().messages.find(message => message.role === 'assistant')?.content
    mocks.answer.mockImplementationOnce(() => {}).mockImplementationOnce(() => expect(assistantText()).toBe('正在生成回答...'))
    const { result } = renderHook(() => useAiChat())
    let pending!: Promise<void>
    act(() => { pending = result.current.sendMessage('给个建议') })
    await waitFor(() => expect(mocks.knowledge).toHaveBeenCalledTimes(1))
    expect(assistantText()).toContain('正在读取长期记忆库...')
    expect(assistantText()).toContain('正在检索本地知识库索引...')
    await act(async () => { finishMemory([]) })
    await waitFor(() => expect(assistantText()).toBe('正在检索本地知识库索引...'))
    act(() => reportProgress('initializing'))
    expect(assistantText()).toBe('正在初始化索引库…')
    act(() => reportProgress('fallback'))
    expect(assistantText()).toBe('索引库初始化失败，正在使用关键词检索…')
    await act(async () => { finishKnowledge([]); await pending })
    expect(assistantText()).toBe('anonymous direct answer')
  })

  it('shows memory retrieval status while a Direct core read is pending, then replaces it with the answer', async () => {
    let finishMemory!: (value: Memory[]) => void
    mocks.memory.mockImplementationOnce(() => new Promise(resolve => { finishMemory = resolve }))
    mocks.chunks.push([{ content: '', done: true, toolCallDeltas: [{ index: 0, id: 'memory-status', name: 'search_memory', arguments: '{"query":"偏好"}' }] }])
    const { result } = renderHook(() => useAiChat())
    let pending!: Promise<void>
    act(() => { pending = result.current.sendMessage('给个建议') })
    await waitFor(() => expect(mocks.memory).toHaveBeenCalledTimes(1))
    expect(useChatStore.getState().messages.find(message => message.role === 'assistant')?.content).toBe('正在读取长期记忆库...')
    await act(async () => { finishMemory([]); await pending })
    expect(useChatStore.getState().messages.find(message => message.role === 'assistant')?.content).toBe('anonymous direct answer')
  })

  const memory: Memory = { id: 'anonymous-memory', content: '默认用中文简洁回答', category: 'preference', source: 'manual_created',
    status: 'active', locked: false, scopeType: 'global', scopeKey: null, createdAt: 1, updatedAt: 1 }

  it('publishes memories returned by ordinary chat core retrieval as message sources', async () => {
    mocks.memory.mockResolvedValue([memory])
    mocks.chunks.push([{ content: '', done: true, toolCallDeltas: [{ index: 0, id: 'memory-source', name: 'search_memory', arguments: '{"query":"偏好"}' }] }])
    const { result } = renderHook(() => useAiChat())
    await act(async () => { await result.current.sendMessage('给个建议') })
    expect(result.current.error).toBeNull()
    expect(useChatStore.getState().messages.find(message => message.role === 'assistant')?.sources).toEqual([
      { kind: 'memory', memoryId: memory.id, content: memory.content },
    ])
  })

  it('publishes Direct prefetch sources without needing another tool call', async () => {
    mocks.memory.mockResolvedValue([memory])
    mocks.classify.mockResolvedValue({ id: 'route', role: 'assistant', content: '{"intent":"no_tool","toolCategories":[],"needsMemory":true,"confidence":0.9}' })
    const { result } = renderHook(() => useAiChat())
    await act(async () => { await result.current.sendMessage('这个说法靠谱吗？') })
    expect(mocks.agent).not.toHaveBeenCalled()
    expect(useChatStore.getState().messages.find(message => message.role === 'assistant')?.sources).toEqual([
      { kind: 'memory', memoryId: memory.id, content: memory.content },
    ])
  })
  it('lets the main model recover an implicit memory need without entering Agent', async () => {
    useSettingsStore.setState(state => ({ ai: { ...state.ai, routing: { diagnostics: true } } }))
    mocks.chunks.push([{ content: '', done: true, toolCallDeltas: [{ index: 0, id: 'direct-memory', name: 'search_memory', arguments: '{"query":"偏好"}' }] }])
    const { result } = renderHook(() => useAiChat())
    await act(async () => { await result.current.sendMessage('给个建议') })
    expect(mocks.classify).not.toHaveBeenCalled()
    expect(mocks.agent).not.toHaveBeenCalled()
    expect(mocks.memory).toHaveBeenCalledTimes(1)
    expect(mocks.answer).toHaveBeenCalledTimes(2)
    expect(mocks.answer.mock.calls[0][0].tools.map((tool: { function: { name: string } }) => tool.function.name)).toEqual(['search_memory', 'search_knowledge'])
    expect(mocks.answer.mock.calls[1][0].tools).toBeUndefined()
    expect(mocks.answer.mock.calls[1][0].messages.some((message: { role: string }) => message.role === 'tool')).toBe(true)
    expect(result.current.error).toBeNull()
    expect(getDirectChatMetrics().at(-1)?.schemaEstimatedTokens).toBeLessThanOrEqual(600)
  })

  it('keeps selection-only translation free of core schemas', async () => {
    const { result } = renderHook(() => useAiChat())
    await act(async () => { await result.current.sendMessage('翻译成中文', undefined, [{ id: 'selection', type: 'selection',
      title: 'anonymous', content: 'hello', preview: 'hello', filePath: 'C:/Temp/anonymous.md', selectionFrom: 0, selectionTo: 5 }]) })
    expect(mocks.classify).not.toHaveBeenCalled()
    expect(mocks.memory).not.toHaveBeenCalled()
    expect(mocks.agent).not.toHaveBeenCalled()
    expect(mocks.answer.mock.calls[0][0].tools).toBeUndefined()
    expect(mocks.answer.mock.calls[0][0].messages.some((message: { content: string }) => message.content.includes('hello'))).toBe(true)
  })

  it('restores the original Direct payload when core tools are switched off', async () => {
    useSettingsStore.setState(state => ({ ai: { ...state.ai, routing: { coreToolsEnabled: false } } }))
    const { result } = renderHook(() => useAiChat())
    await act(async () => { await result.current.sendMessage('给个建议') })
    expect(mocks.answer).toHaveBeenCalledTimes(1)
    expect(mocks.answer.mock.calls[0][0].tools).toBeUndefined()
    expect(mocks.memory).not.toHaveBeenCalled()
  })

  it('does not execute model calls returned after the chat session changes', async () => {
    mocks.chunks.push([{ content: '', done: true, toolCallDeltas: [{ index: 0, id: 'stale', name: 'search_memory', arguments: '{"query":"偏好"}' }] }])
    mocks.answer.mockImplementationOnce(() => useChatStore.setState({ currentSessionId: 'another-anonymous-session' }))
    const { result } = renderHook(() => useAiChat())
    await act(async () => { await result.current.sendMessage('给个建议') })
    expect(mocks.answer).toHaveBeenCalledTimes(1)
    expect(mocks.memory).not.toHaveBeenCalled()
    expect(mocks.agent).not.toHaveBeenCalled()
  })

  it('ordinary Direct reaches the main stream with no classifier or recall', async () => {
    const { result } = renderHook(() => useAiChat())
    await act(async () => { await result.current.sendMessage('什么是闭包？') })
    expect(mocks.classify).not.toHaveBeenCalled()
    expect(mocks.memory).not.toHaveBeenCalled()
    expect(mocks.agent).not.toHaveBeenCalled()
    expect(mocks.answer).toHaveBeenCalledTimes(1)
    expect(result.current.error).toBeNull()
  })

  it('uses an explicit matching current user fact without recalling historical memory', async () => {
    useChatStore.setState({ messages: [{ id: 'current-user', role: 'user', content: '称呼我小林', timestamp: Date.now() }] })
    const { result } = renderHook(() => useAiChat())
    await act(async () => { await result.current.sendMessage('我的称呼是什么？') })
    expect(mocks.memory).not.toHaveBeenCalled()
    expect(mocks.classify).not.toHaveBeenCalled()
    expect(mocks.agent).not.toHaveBeenCalled()
    expect(mocks.answer).toHaveBeenCalledTimes(1)
  })
  it('explicit tool routing does not call a classifier', async () => {
    const { result } = renderHook(() => useAiChat())
    await act(async () => { await result.current.sendMessage('搜索知识库里的算法资料') })
    expect(mocks.classify).not.toHaveBeenCalled()
    expect(mocks.agent).toHaveBeenCalledTimes(1)
    expect(mocks.agent.mock.calls[0][0].routingDecision.candidateTools).toContain('search_knowledge')
  })
  it('semantic no_tool reaches Direct and does not recall or reselect tools', async () => {
    mocks.classify.mockResolvedValue({ id: 'route', role: 'assistant', content: '{"intent":"no_tool","toolCategories":[],"needsMemory":false,"confidence":0.9}' })
    const { result } = renderHook(() => useAiChat())
    await act(async () => { await result.current.sendMessage('这个说法靠谱吗？') })
    expect(mocks.classify).toHaveBeenCalledTimes(1)
    expect(mocks.agent).not.toHaveBeenCalled()
    expect(mocks.memory).not.toHaveBeenCalled()
    expect(mocks.answer).toHaveBeenCalledTimes(1)
  })

  it('semantic no_tool can prefetch memory and still stream Direct exactly once', async () => {
    mocks.classify.mockResolvedValue({ id: 'route', role: 'assistant', content: '{"intent":"no_tool","toolCategories":[],"needsMemory":true,"confidence":0.9}' })
    const { result } = renderHook(() => useAiChat())
    await act(async () => { await result.current.sendMessage('这个说法靠谱吗？') })
    expect(mocks.classify).toHaveBeenCalledTimes(1)
    expect(mocks.memory).toHaveBeenCalledTimes(1)
    expect(mocks.agent).not.toHaveBeenCalled()
    expect(mocks.answer).toHaveBeenCalledTimes(1)
  })
  it('one semantic call chooses both knowledge and memory', async () => {
    mocks.classify.mockResolvedValue({ id: 'route', role: 'assistant', content: '{"intent":"tools","toolCategories":["knowledge"],"needsMemory":true,"confidence":0.7}' })
    const { result } = renderHook(() => useAiChat())
    await act(async () => { await result.current.sendMessage('之前那套仍然合适吗？') })
    expect(mocks.classify).toHaveBeenCalledTimes(1)
    expect(mocks.memory).toHaveBeenCalledTimes(1)
    expect(mocks.agent.mock.calls[0][0].routingDecision).toMatchObject({ selectionSource: 'semantic', candidates: ['knowledge', 'memory'], required: [] })
  })
  it('explicit memory recall stays on rules', async () => {
    const { result } = renderHook(() => useAiChat())
    await act(async () => { await result.current.sendMessage('你记得我的地址吗？') })
    expect(mocks.classify).not.toHaveBeenCalled()
    expect(mocks.memory).toHaveBeenCalledTimes(1)
  })
  it('falls back to the original Direct route on a model error', async () => {
    mocks.classify.mockRejectedValue(new Error('anonymous model unavailable'))
    const { result } = renderHook(() => useAiChat())
    await act(async () => { await result.current.sendMessage('这个说法靠谱吗？') })
    expect(mocks.classify).toHaveBeenCalledTimes(1)
    expect(mocks.answer).toHaveBeenCalledTimes(1)
    expect(mocks.agent).not.toHaveBeenCalled()
    expect(result.current.error).toBeNull()
  })
  it('a late classifier after cancellation cannot send or overwrite a new request', async () => {
    let resolve!: (response: ChatResponse) => void
    mocks.classify.mockImplementation(() => new Promise(r => { resolve = r }))
    const { result } = renderHook(() => useAiChat())
    let pending!: Promise<void>
    act(() => { pending = result.current.sendMessage('这个说法靠谱吗？') })
    await waitFor(() => expect(mocks.classify).toHaveBeenCalledTimes(1))
    act(() => result.current.cancelStream())
    await act(async () => { await result.current.sendMessage('你好') })
    await act(async () => {
      resolve({ id: 'late', role: 'assistant', content: '{"intent":"tools","toolCategories":["knowledge"],"needsMemory":true,"confidence":1}' })
      await pending
    })
    expect(mocks.answer).toHaveBeenCalledTimes(1)
    expect(mocks.agent).not.toHaveBeenCalled()
    expect(mocks.memory).not.toHaveBeenCalled()
    expect(useChatStore.getState().messages.filter(message => message.role === 'assistant')).toHaveLength(1)
  })
  it('old Agent cleanup cannot clear a newer request scope', async () => {
    type Result = Awaited<ReturnType<typeof mocks.agent>>
    let finishOld!: (value: Result) => void
    let finishNew!: (value: Result) => void
    mocks.agent.mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve }))
      .mockImplementationOnce(() => new Promise(resolve => { finishNew = resolve }))
    const { result } = renderHook(() => useAiChat())
    let oldRequest!: Promise<void>
    let newRequest!: Promise<void>
    act(() => { oldRequest = result.current.sendMessage('搜索知识库里的算法资料') })
    await waitFor(() => expect(mocks.agent).toHaveBeenCalledTimes(1))
    act(() => result.current.cancelStream())
    act(() => { newRequest = result.current.sendMessage('搜索知识库里的另一份资料') })
    await waitFor(() => expect(mocks.agent).toHaveBeenCalledTimes(2))
    const newerScope = getAgentScopeContext()
    expect(newerScope).not.toBeNull()
    await act(async () => { finishOld({ answer: 'old', steps: [], toolCalls: 0, reason: 'completed' }); await oldRequest })
    expect(getAgentScopeContext()).toBe(newerScope)
    await act(async () => { finishNew({ answer: 'new', steps: [], toolCalls: 0, reason: 'completed' }); await newRequest })
    expect(getAgentScopeContext()).toBeNull()
  })
})
