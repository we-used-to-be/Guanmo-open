import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatRequest, ChatResponse } from '@/services/ai/types'
import { DEFAULT_AI_CONFIG } from '@/services/ai/types'
import { useSettingsStore } from '@/stores/settingsStore'
import { useChatStore } from '@/stores/chatStore'
import { useAiChat } from '@/hooks/useAiChat'
import { getAgentScopeContext } from '@/services/aiScope'

const mocks = vi.hoisted(() => ({
  classify: vi.fn<(request: ChatRequest) => Promise<ChatResponse>>(),
  answer: vi.fn(),
  memory: vi.fn(async () => []),
  agent: vi.fn(async () => ({ answer: 'anonymous agent answer', steps: [], toolCalls: 0, reason: 'completed' })),
}))
const client = {
  chat: mocks.classify,
  streamChat: async function* (_request: ChatRequest) {
    mocks.answer()
    yield { content: 'anonymous direct answer', done: true }
  },
}
vi.mock('@/services/ai/aiClient', () => ({
  getAiClient: () => client, getAiConfig: () => useSettingsStore.getState().ai,
  initAiClient: () => client, isAiReady: () => true, isEmbeddingReady: () => false,
  getEmbeddingConfig: () => null, isLocalApi: () => true, resetAiClient: () => {},
  createChatProvider: () => client,
}))
vi.mock('@/services/settingsSecrets', () => ({ ensureSettingsSecretsHydrated: async () => {} }))
vi.mock('@/services/database/db', async importOriginal => ({ ...await importOriginal<typeof import('@/services/database/db')>(), isDatabaseReady: () => true }))
vi.mock('@/hooks/useTauri', async importOriginal => ({ ...await importOriginal<typeof import('@/hooks/useTauri')>(), isTauri: () => true }))
vi.mock('@/services/agent', async importOriginal => ({ ...await importOriginal<typeof import('@/services/agent')>(), runAgent: mocks.agent }))
vi.mock('@/services/memory/memoryService', async importOriginal => ({
  ...await importOriginal<typeof import('@/services/memory/memoryService')>(), searchMemories: mocks.memory,
  processMemoryCandidateExtraction: async () => {},
}))

beforeEach(() => {
  mocks.classify.mockReset()
  mocks.answer.mockClear()
  mocks.agent.mockClear()
  mocks.memory.mockClear()
  useSettingsStore.setState({ ai: { ...DEFAULT_AI_CONFIG, baseUrl: 'http://127.0.0.1:1234', chatModel: 'anonymous', routing: { enabled: true } } })
  useChatStore.setState({ messages: [], streaming: false, error: null, agentTaskContext: null, agentMode: false,
    saveCurrentSession: vi.fn(async () => {}) })
})

describe('Router V2 real chat orchestration', () => {
  it('ordinary Direct reaches the main stream with no classifier or recall', async () => {
    const { result } = renderHook(() => useAiChat())
    await act(async () => { await result.current.sendMessage('什么是闭包？') })
    expect(mocks.classify).not.toHaveBeenCalled()
    expect(mocks.memory).not.toHaveBeenCalled()
    expect(mocks.agent).not.toHaveBeenCalled()
    expect(mocks.answer).toHaveBeenCalledTimes(1)
    expect(result.current.error).toBeNull()
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
