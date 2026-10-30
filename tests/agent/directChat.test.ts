import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AiProvider, ChatRequest, ChatResponse, StreamChunk } from '@/services/ai/types'
import { streamDirectChat, type DirectChatMetric } from '@/services/agent/directChat'
import { registerTool } from '@/services/agent/toolRegistry'
import { AiError } from '@/services/ai/errors'
import { resolveRouterConfig } from '@/services/agent/routerConfig'
import { createSourceReferenceRegistry } from '@/services/ai/sourceReferences'

const mocks = vi.hoisted(() => ({
  execute: vi.fn<typeof import('@/services/agent/executor').executeTool>(async () => ({ result: '已确认事实', rawResult: '已确认事实', status: 'success' })),
  eligibility: { desktop: true, databaseAvailable: true, readAllowed: true, writeAllowed: false,
    hasSelection: false, hasReadableContext: false, hasEditTarget: false, memoryWriteRequested: false,
    webEnabled: false, reminderEnabled: false },
  available: true,
}))
vi.mock('@/services/agent/toolEligibilityContext', () => ({ currentToolEligibilityContext: () => mocks.eligibility }))
vi.mock('@/services/agent/executor', async importOriginal => ({
  ...await importOriginal<typeof import('@/services/agent/executor')>(), initAgent: () => {}, executeTool: mocks.execute,
}))

beforeEach(() => {
  mocks.execute.mockClear()
  mocks.available = true
  mocks.eligibility.desktop = true
  mocks.eligibility.databaseAvailable = true
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  for (const name of ['search_memory', 'search_knowledge']) registerTool({ name, description: 'anonymous',
    parameters: [{ name: 'query', type: 'string', description: '查询', required: true },
      { name: 'topK', type: 'number', description: '数量', required: false }],
    isAvailable: () => mocks.available, execute: async () => '' })
})

function setup(responses: Array<Partial<ChatResponse> | Error>) {
  const requests: ChatRequest[] = []
  const chat = vi.fn(async (request: ChatRequest): Promise<ChatResponse> => {
    requests.push(request)
    const next = responses.shift()
    if (next instanceof Error) throw next
    return { id: 'anonymous', role: 'assistant', content: '', ...next }
  })
  const client = { chat, streamChat: vi.fn() } as unknown as AiProvider
  const updates: string[] = []
  const metrics: DirectChatMetric[] = []
  const options = { client, messages: [{ role: 'user' as const, content: '给个安排' }], query: '给个安排',
    enabled: true, workspacePath: 'C:/Temp/anonymous', streamEnabled: false,
    isCancelled: () => false, onUpdate: (text: string) => updates.push(text), onMetric: (metric: DirectChatMetric) => metrics.push(metric) }
  return { requests, chat, client, options, updates, metrics }
}

const memoryCall = (args: Record<string, unknown> = { query: '安排' }) => ({ id: 'call-1', name: 'search_memory', args })

describe('bounded Direct core tools', () => {
  it('keeps ordinary answers to one request and a compact two-tool schema', async () => {
    const s = setup([{ content: '直接回答', usage: { promptTokens: 100, completionTokens: 5, totalTokens: 105 } }])
    await streamDirectChat(s.options)
    expect(s.requests).toHaveLength(1)
    expect(s.requests[0].tools?.map(tool => tool.function.name)).toEqual(['search_memory', 'search_knowledge'])
    expect(s.metrics[0].schemaEstimatedTokens).toBeLessThanOrEqual(600)
    expect(s.metrics[0]).toMatchObject({ modelRequests: 1, executedTools: 0, usage: { totalTokens: 105 } })
    expect(s.updates).toEqual(['直接回答'])
    expect(mocks.execute).not.toHaveBeenCalled()
  })

  it('executes an implicit read and continues once with native tool messages and no tools', async () => {
    const s = setup([{ toolCalls: [memoryCall()] }, { content: '基于事实回答' }])
    await streamDirectChat(s.options)
    expect(mocks.execute).toHaveBeenCalledTimes(1)
    expect(mocks.execute.mock.calls[0]).toEqual(['search_memory', { query: '安排', topK: 5 }, 10000, '给个安排', undefined, expect.any(Function), undefined, { workspacePath: 'C:/Temp/anonymous' }])
    expect(s.requests).toHaveLength(2)
    expect(s.requests[1].tools).toBeUndefined()
    expect(s.requests[1].messages).toContainEqual({ role: 'assistant', content: '', tool_calls: [
      { id: 'call-1', type: 'function', function: { name: 'search_memory', arguments: '{"query":"安排"}' } },
    ] })
    expect(s.requests[1].messages).toContainEqual({ role: 'tool', tool_call_id: 'call-1', content: '已确认事实' })
    expect(s.updates.at(-1)).toBe('基于事实回答')
  })

  it('does not execute a second batch even if the final model asks for more', async () => {
    const s = setup([{ toolCalls: [memoryCall()] }, { content: '还需资料', toolCalls: [memoryCall()] }])
    await streamDirectChat(s.options)
    expect(mocks.execute).toHaveBeenCalledTimes(1)
    expect(s.requests).toHaveLength(2)
  })

  it('forwards knowledge index progress, ignores late progress, and announces final generation', async () => {
    let reportProgress!: (stage: 'rag_initializing' | 'rag_fallback') => void
    mocks.execute.mockImplementationOnce(async (...args) => {
      reportProgress = args[5]!
      reportProgress('rag_initializing')
      reportProgress('rag_fallback')
      return { result: '资料片段', rawResult: '资料片段', status: 'success' }
    })
    const s = setup([{ toolCalls: [{ id: 'knowledge', name: 'search_knowledge', args: { query: '资料' } }] }, { content: '回答' }])
    const onStep = vi.fn()
    await streamDirectChat({ ...s.options, onStep })
    expect(onStep.mock.calls.map(([step]) => [step.type, step.progressStage || step.content])).toEqual([
      ['action', '正在检索本地资料'], ['progress', 'rag_initializing'], ['progress', 'rag_fallback'],
      ['observation', '资料片段'], ['thought', '正在生成回答...'],
    ])
    reportProgress('rag_initializing')
    expect(onStep).toHaveBeenCalledTimes(5)
  })

  it('coalesces identical default and explicit TopK calls without duplicating evidence', async () => {
    const s = setup([{ toolCalls: [memoryCall(), { ...memoryCall({ query: '安排', topK: 5 }), id: 'call-2' }] }, { content: '回答' }])
    await streamDirectChat(s.options)
    expect(mocks.execute).toHaveBeenCalledTimes(1)
    expect(s.metrics[0]).toMatchObject({ executedTools: 1, reusedTools: 1 })
    expect(s.requests[1].messages.filter(message => message.content === '已确认事实')).toHaveLength(1)
  })

  it.each(['已保存事实', '未找到相关记忆。'])('reuses injected strong prefetch including empty results: %s', async result => {
    const s = setup([{ toolCalls: [memoryCall()] }, { content: '回答' }])
    await streamDirectChat({ ...s.options, prefetchedMemory: { query: '安排', topK: 10, result } })
    expect(mocks.execute).not.toHaveBeenCalled()
    expect(s.metrics[0].reusedTools).toBe(1)
    expect(s.requests[1].messages.some(message => message.role === 'tool' && message.content.includes('已在前面'))).toBe(true)
  })

  it.each([{ topK: 3 }, { topK: 10, categories: ['preference'] }])('does not pretend restricted/light recall covers a strong search', async prefetch => {
    const s = setup([{ toolCalls: [memoryCall()] }, { content: '回答' }])
    await streamDirectChat({ ...s.options, prefetchedMemory: { query: '安排', result: '有限结果', ...prefetch } })
    expect(mocks.execute).toHaveBeenCalledTimes(1)
  })

  it('never exposes or dispatches writes, unknown tools, or calls beyond the batch budget', async () => {
    const s = setup([{ toolCalls: [
      { id: 'write', name: 'save_memory', args: { content: '不应写入' } },
      { id: 'unknown', name: 'read_context_file', args: { path: 'C:/Temp/anonymous.md' } },
      memoryCall(),
    ] }, { content: '未执行写入' }])
    await streamDirectChat(s.options)
    expect(mocks.execute).not.toHaveBeenCalled()
    expect(s.requests[1].messages.filter(message => message.role === 'tool')).toHaveLength(3)
  })

  it.each([{ query: '安排', extra: true }, { query: '安排', topK: NaN }, { query: ' ' }, { query: '我的住址' }])('rejects invalid or unrequested sensitive queries: %o', async args => {
    const s = setup([{ toolCalls: [memoryCall(args)] }, { content: '无法检索' }])
    await streamDirectChat(s.options)
    expect(mocks.execute).not.toHaveBeenCalled()
  })

  it('rechecks availability after model latency', async () => {
    const s = setup([{ toolCalls: [memoryCall()] }, { content: '已禁用' }])
    s.chat.mockImplementationOnce(async request => { s.requests.push(request); mocks.available = false
      return { id: '', role: 'assistant', content: '', toolCalls: [memoryCall()] } })
    await streamDirectChat(s.options)
    expect(mocks.execute).not.toHaveBeenCalled()
  })

  it('preserves the rollback and unavailable-host zero-tool paths', async () => {
    expect(resolveRouterConfig({ coreToolsEnabled: false }).coreToolsEnabled).toBe(false)
    expect(resolveRouterConfig().coreToolsEnabled).toBe(true)
    for (const enabled of [false, true]) {
      mocks.eligibility.desktop = false
      const s = setup([{ content: '回答' }])
      await streamDirectChat({ ...s.options, enabled })
      expect(s.requests[0].tools).toBeUndefined()
      expect(s.requests).toHaveLength(1)
    }
  })

  it('honors explicit opt-out before exposing schemas', async () => {
    const s = setup([{ content: '回答' }])
    await streamDirectChat({ ...s.options, query: '不要搜索记忆，也不要检索知识库' })
    expect(s.requests[0].tools).toBeUndefined()
  })

  it('does not let the model retrieve a sensitive fact the user explicitly said not to query', async () => {
    const s = setup([{ content: '直接回答' }])
    await streamDirectChat({ ...s.options, query: '不要查询我的地址，直接解释邮编的作用' })
    expect(s.requests[0].tools).toBeUndefined()
    expect(mocks.execute).not.toHaveBeenCalled()
  })

  it('retries explicit tools rejection once and remembers it on this client only', async () => {
    const s = setup([new AiError('tools are not supported', 'API_ERROR', 400), { content: '无工具回答' }, { content: '下一轮' }])
    await streamDirectChat(s.options)
    expect(s.requests[1].tools).toBeUndefined()
    await streamDirectChat(s.options)
    expect(s.requests[2].tools).toBeUndefined()
    expect(s.metrics[0].fallback).toBe(true)
    expect(mocks.execute).not.toHaveBeenCalled()
  })

  it('does not reinterpret ordinary API failures as lack of tool support', async () => {
    const s = setup([new AiError('invalid model parameter', 'API_ERROR', 400)])
    await expect(streamDirectChat(s.options)).rejects.toThrow('invalid model')
    expect(s.requests).toHaveLength(1)
  })

  it('keeps native tool results atomic when final generation overflows, without rerunning reads', async () => {
    const s = setup([{ toolCalls: [memoryCall()] }, new AiError('context length exceeded', 'API_ERROR', 400), { content: '恢复回答' }])
    await streamDirectChat({ ...s.options, messages: [{ role: 'user', content: '旧问题' }, { role: 'assistant', content: '旧答案' }, ...s.options.messages] })
    expect(mocks.execute).toHaveBeenCalledTimes(1)
    expect(s.requests).toHaveLength(3)
    expect(s.requests[2].messages.some(message => message.role === 'tool' && message.content === '已确认事实')).toBe(true)
    expect(s.requests[2].messages.some(message => message.content === '旧问题')).toBe(false)
    expect(s.metrics[0].modelRequests).toBe(3)
  })

  it('deduplicates already-injected knowledge chunks by ID and content version and keeps source IDs stable', async () => {
    const source = { kind: 'local' as const, filePath: 'C:/Temp/anonymous.md', fileName: 'anonymous.md', startLine: 1, endLine: 2 }
    const result = JSON.stringify({ results: [
      { chunkId: 'a', contentHash: 'hash-a', filePath: source.filePath, startLine: 1, endLine: 2, snippet: '已有片段' },
      { chunkId: 'b', contentHash: 'hash-b', filePath: source.filePath, startLine: 3, endLine: 4, snippet: '新片段' },
    ] })
    mocks.execute.mockResolvedValueOnce({ result, rawResult: result, status: 'success' })
    const s = setup([{ toolCalls: [{ id: 'knowledge', name: 'search_knowledge', args: { query: '安排' } }] }, { content: '回答 [S2]' }])
    const onSources = vi.fn()
    await streamDirectChat({ ...s.options, sourceRegistry: createSourceReferenceRegistry([source]),
      includedKnowledgeChunks: [{ id: 'a', contentHash: 'hash-a' }], onSources })
    const tool = s.requests[1].messages.find(message => message.role === 'tool')!
    expect(tool.content).not.toContain('已有片段')
    expect(tool.content).toContain('新片段')
    expect(onSources.mock.calls[0][0].entries.map((entry: { id: string }) => entry.id)).toEqual(['S1', 'S2'])
  })

  it('never publishes or continues a read that finishes after cancellation', async () => {
    const controller = new AbortController()
    mocks.execute.mockImplementationOnce(async () => { controller.abort(); return { result: '迟到事实', rawResult: '迟到事实', status: 'success' } })
    const s = setup([{ toolCalls: [memoryCall()] }])
    const onSources = vi.fn()
    await streamDirectChat({ ...s.options, signal: controller.signal, onSources })
    expect(s.requests).toHaveLength(1)
    expect(onSources).not.toHaveBeenCalled()
    expect(s.updates).not.toContain('迟到事实')
  })

  it('suppresses late tool calls after cancellation', async () => {
    const s = setup([])
    const controller = new AbortController()
    s.chat.mockImplementationOnce(async () => { controller.abort(); return { id: '', role: 'assistant', content: '', toolCalls: [memoryCall()] } })
    await streamDirectChat({ ...s.options, signal: controller.signal })
    expect(mocks.execute).not.toHaveBeenCalled()
    expect(s.requests).toHaveLength(0)
    expect(s.metrics[0].status).toBe('cancelled')
  })

  it('collects interleaved streaming tool arguments and replaces provisional text', async () => {
    const s = setup([])
    let n = 0
    s.client.streamChat = async function* (request): AsyncIterable<StreamChunk> {
      s.requests.push(request)
      if (++n === 1) {
        yield { content: '正在查找', done: false }
        yield { content: '', done: false, toolCallDeltas: [{ index: 0, id: 's1', name: 'search_', arguments: '{"que' }] }
        yield { content: '', done: true, toolCallDeltas: [{ index: 0, name: 'memory', arguments: 'ry":"安排"}' }] }
      } else yield { content: '流式最终回答', done: true }
    }
    await streamDirectChat({ ...s.options, streamEnabled: true })
    expect(mocks.execute).toHaveBeenCalledTimes(1)
    expect(s.requests[1].messages.some(message => message.role === 'tool' && message.tool_call_id === 's1')).toBe(true)
    expect(s.updates.at(-1)).toBe('流式最终回答')
  })
})
