import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AiProvider, ChatMessage, ChatRequest, ChatResponse, ModelMessage, StreamChunk } from '@/services/ai/types'
import { setAgentScopeContext } from '@/services/aiScope'
import { useEditorStore } from '@/stores/editorStore'
import { streamFinalAnswer } from '@/services/aiChatFlow'
import { buildAgentFinalAnswerMessages, buildMessagesForModel } from '@/services/aiChatMessages'
import { AiError, AiNetworkError } from '@/services/ai/errors'

const requests: ModelMessage[][] = []
const responses: Array<ChatResponse | Error | StreamChunk[]> = []
const chat = vi.fn(async (request: ChatRequest) => {
  requests.push(request.messages.slice())
  const response = responses.shift()
  if (response instanceof Error) throw response
  return response as ChatResponse
})
const streamChat = vi.fn(async function* (request: ChatRequest) {
  requests.push(request.messages.slice())
  const response = responses.shift()
  if (response instanceof Error) throw response
  for (const chunk of response as StreamChunk[]) yield chunk
})
const client = { chat, streamChat } as unknown as AiProvider
vi.mock('@/services/ai/aiClient', () => ({ getAiClient: () => client, isAiReady: () => true }))
vi.mock('@/hooks/useTauri', async importOriginal => ({ ...await importOriginal<typeof import('@/hooks/useTauri')>(), isTauri: () => true }))
vi.mock('@/services/database/db', async importOriginal => ({ ...await importOriginal<typeof import('@/services/database/db')>(), isDatabaseReady: () => true }))

const history: ChatMessage[] = [
  { role: 'user', content: 'old question 1' }, { role: 'assistant', content: 'old answer 1' },
  { role: 'user', content: 'old question 2' }, { role: 'assistant', content: 'old answer 2' },
]
const overflow = () => new AiError('context length exceeded', 'API_ERROR', 400)
const answer: ChatResponse = { id: 'anonymous', role: 'assistant', content: 'answer' }

describe('context overflow recovery at production entry points', () => {
  let runAgent: typeof import('@/services/agent/executor').runAgent
  const execute = vi.fn(async () => 'anonymous evidence')
  beforeAll(async () => {
    const executor = await import('@/services/agent/executor')
    executor.initAgent()
    const { registerTool } = await import('@/services/agent/toolRegistry')
    registerTool({ name: 'get_current_time', description: 'anonymous read', parameters: [], execute })
    runAgent = executor.runAgent
  })
  beforeEach(() => {
    requests.length = 0
    responses.length = 0
    vi.clearAllMocks()
  })
  afterEach(() => { setAgentScopeContext(null); vi.restoreAllMocks() })

  it('keeps normal requests intact with no extra call', async () => {
    responses.push(answer)
    const result = await runAgent({ query: 'current question', chatHistory: history, streamEnabled: false })
    expect(result.answer).toBe('answer')
    expect(requests).toHaveLength(1)
    expect(requests[0].slice(1)).toEqual([...history, { role: 'user', content: 'current question' }])
  })

  it.each([false, true])('removes multiple historical turns and reuses reduced context without reexecuting tools (stream=%s)', async (streamEnabled) => {
    const tool: ChatResponse = { ...answer, content: '', toolCalls: [{ name: 'get_current_time', args: {} }] }
    const toolStream: StreamChunk[] = [{ content: '', done: true, toolCallDeltas: [{ index: 0, name: 'get_current_time', arguments: '{}' }] }]
    responses.push(streamEnabled ? toolStream : tool, overflow(), streamEnabled ? toolStream : tool, streamEnabled ? [{ content: 'answer', done: true }] : answer)
    const result = await runAgent({ query: 'current question', chatHistory: history, untrustedContext: 'authorized selection [S1]', candidateToolNames: ['get_current_time'], streamEnabled })
    expect(result.answer).toBe('answer')
    expect(execute).toHaveBeenCalledTimes(1)
    expect(result.toolCalls).toBe(1)
    expect(requests).toHaveLength(4)
    for (const request of requests.slice(2)) {
      expect(request.some(m => m.content === 'current question')).toBe(true)
      expect(request.some(m => m.content.includes('authorized selection [S1]'))).toBe(true)
      expect(request.some(m => m.content.includes('anonymous evidence'))).toBe(true)
      expect(request.some(m => m.content.includes('old question'))).toBe(false)
    }
  })

  it('does not resend an unchanged request when only the current question exists', async () => {
    responses.push(overflow(), answer)
    const result = await runAgent({ query: 'current question', streamEnabled: false })
    expect(requests).toHaveLength(1)
    expect(result.reason).toBe('error')
    expect(result.answer).toContain('缩小')
  })

  it.each([
    new AiNetworkError('context length exceeded'),
    ...[401, 429, 500].map(status => new AiError('context length exceeded', 'API_ERROR', status)),
    new Error('token limit per minute exceeded'), new Error('too many tokens per minute'),
  ])('does not compress non-context failures (%s)', async (error) => {
    responses.push(error, answer)
    await runAgent({ query: 'current question', chatHistory: history, streamEnabled: false })
    expect(requests).toHaveLength(1)
  })

  it('terminates clearly after the single recovery also overflows', async () => {
    responses.push(overflow(), overflow(), answer)
    const result = await runAgent({ query: 'current question', chatHistory: history, streamEnabled: false })
    expect(requests).toHaveLength(2)
    expect(result.reason).toBe('error')
    expect(result.answer).toContain('缩小')
  })

  it('preserves the current context through the Agent final answer builder', async () => {
    responses.push({ ...answer, content: '', toolCalls: [{ name: 'get_current_time', args: {} }] })
    const result = await runAgent({ query: 'current question', chatHistory: history, untrustedContext: 'authorized selection [S1]', candidateToolNames: ['get_current_time'], config: { maxToolCalls: 1 }, streamEnabled: false })
    responses.push(overflow(), answer)
    await streamFinalAnswer({ client, messages: buildAgentFinalAnswerMessages(result.finalMessages!), streamEnabled: false, onUpdate: () => {}, isCancelled: () => false })
    const reduced = requests.at(-1)!
    expect(reduced.some(m => m.content === 'current question')).toBe(true)
    expect(reduced.some(m => m.content.includes('authorized selection [S1]'))).toBe(true)
    expect(reduced.some(m => m.content.includes('anonymous evidence'))).toBe(true)
    expect(reduced.some(m => m.content.includes('old question'))).toBe(false)
    expect(reduced.some(m => m.content.includes('现在请直接输出给用户的最终答案'))).toBe(true)
    expect(reduced.at(-1)?.content).toContain('仅当工具结果不足')
  })

  it('preserves direct-chat supplemental sources while removing historical turns', async () => {
    const messages = buildMessagesForModel({ history, userMessage: { role: 'user', content: 'current question' }, supplementalContext: 'evidence [S1] and [S2]' })
    responses.push(overflow(), answer)
    await streamFinalAnswer({ client, messages, streamEnabled: false, onUpdate: () => {}, isCancelled: () => false })
    expect(requests[1].some(m => m.content.includes('evidence [S1] and [S2]'))).toBe(true)
    expect(requests[1].some(m => m.content.includes('old question'))).toBe(false)
    expect(messages.some(m => m.content.includes('old question'))).toBe(true)
  })

  it.each(['agent', 'final'])('clears only the current partial stream before retry (%s)', async (entry) => {
    streamChat.mockImplementationOnce(async function* (request) {
      requests.push(request.messages.slice())
      yield { content: 'partial', done: false }
      throw overflow()
    })
    responses.push([{ content: 'fresh answer', done: true }])
    const updates: string[] = []
    if (entry === 'agent') {
      await runAgent({ query: 'current question', chatHistory: history, candidateToolNames: ['get_current_time'], onStreamContent: content => updates.push(content) })
    } else {
      await streamFinalAnswer({ client, messages: [...history, { role: 'user', content: 'current question' }], streamEnabled: true, onUpdate: content => updates.push(content), isCancelled: () => false })
    }
    expect(requests).toHaveLength(2)
    expect(updates).toEqual(['partial', '', 'fresh answer'])
  })

  it.each(['agent', 'final'])('does not retry after signal cancellation even with an overflow error (%s)', async (entry) => {
    const controller = new AbortController()
    chat.mockImplementationOnce(async request => {
      requests.push(request.messages.slice())
      controller.abort('anonymous_cancel')
      throw overflow()
    })
    if (entry === 'agent') {
      await runAgent({ query: 'current question', chatHistory: history, signal: controller.signal, streamEnabled: false })
    } else {
      await expect(streamFinalAnswer({ client, messages: [...history, { role: 'user', content: 'current question' }], signal: controller.signal, streamEnabled: false, onUpdate: () => {}, isCancelled: () => false })).rejects.toThrow('context length exceeded')
    }
    expect(requests).toHaveLength(1)
  })

  it('does not retry or extend an expired Agent deadline', async () => {
    const now = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now)
    chat.mockImplementationOnce(async request => {
      requests.push(request.messages.slice())
      clock.mockReturnValue(now + 100)
      throw overflow()
    })
    const result = await runAgent({ query: 'current question', chatHistory: history, config: { deadlineMs: 50 }, streamEnabled: false })
    expect(requests).toHaveLength(1)
    expect(result.reason).toBe('deadline')
  })

  it('reduces identical cached tool groups without deleting the only evidence or replaying the tool', async () => {
    const tool = { ...answer, content: '', toolCalls: [{ name: 'get_current_time', args: {} }] }
    responses.push(tool, tool, overflow(), answer)
    const result = await runAgent({ query: 'current question', candidateToolNames: ['get_current_time'], streamEnabled: false })
    expect(requests).toHaveLength(4)
    expect(requests[2].filter(m => m.content.includes('anonymous evidence'))).toHaveLength(2)
    expect(requests[3].filter(m => m.content.includes('anonymous evidence'))).toHaveLength(1)
    expect(execute).toHaveBeenCalledTimes(1)
    expect(result.toolCalls).toBe(1)
    expect(result.answer).toBe('answer')
  })

  it('keeps the current edit target and emits a pending confirmation once after recovery', async () => {
    const filePath = 'C:/Temp/anonymous.md'
    useEditorStore.setState({ tabs: [{ id: 'anonymous-tab', title: 'anonymous', filePath, content: 'anonymous original',
      savedContent: 'anonymous original', originalContent: 'anonymous original', modified: false }] })
    setAgentScopeContext({ contextTags: [{ id: 'tag', type: 'selection', title: 'anonymous', filePath,
      content: 'anonymous original', preview: 'anonymous', selectionFrom: 0, selectionTo: 18 }],
    editTargets: [{ id: 'authorized-target', type: 'selection', title: 'anonymous', filePath, selectionFrom: 0, selectionTo: 18 }] })
    const { registerTool, getTool } = await import('@/services/agent/toolRegistry')
    const original = getTool('replace_current_tab_text')!
    const pendingEdit = vi.fn(async () => JSON.stringify({ __pendingEdit: true, oldText: 'anonymous original', newText: 'anonymous edit' }))
    registerTool({ ...original, parameters: [
      { name: 'targetId', type: 'string', description: 'anonymous target', required: true },
      { name: 'newText', type: 'string', description: 'anonymous edit', required: true },
    ], execute: pendingEdit })
    responses.push(overflow(), { ...answer, content: '', toolCalls: [{ name: 'replace_current_tab_text', args: { targetId: 'authorized-target', newText: 'anonymous edit' } }] })
    try {
      const result = await runAgent({
        query: '修改匿名选区', chatHistory: history, untrustedContext: '本轮可编辑目标: authorized-target',
        currentEditTargetCount: 1, hasCurrentEditTarget: true, streamEnabled: false,
        routingDecision: {
          mode: 'agent', reasonCodes: ['strong_signal'], candidates: ['file_write'], required: [],
          candidateTools: ['replace_current_tab_text'], selectionRequestKind: 'none', requiresEditConfirmation: true,
          shouldLookupMemory: false, memoryIntent: 'none', shouldLookupKnowledge: false,
          isDocumentRewrite: true, isWebComparison: false, isLocalResearch: false, isFileSummary: false, explicitMemoryWriteIntent: false,
        },
      })
      expect(requests).toHaveLength(2)
      expect(requests[1].some(m => m.content.includes('authorized-target'))).toBe(true)
      expect(requests[1].some(m => m.content === '修改匿名选区')).toBe(true)
      expect(pendingEdit).toHaveBeenCalledTimes(1)
      expect(result.reason).toBe('completed')
      expect(result.steps.filter(step => step.type === 'observation' && step.content.includes('__pendingEdit'))).toHaveLength(1)
    } finally {
      registerTool(original)
    }
  })
})
