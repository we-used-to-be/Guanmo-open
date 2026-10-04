import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AiProvider, ChatRequest, ChatResponse, StreamChunk } from '@/services/ai/types'
import { decodeAgentStepEvent, decodeKnowledgeSearchOutcome } from '@/services/agent/session'
import { clearAgentDiagnostics, finishAgentTrace, startAgentTrace, useAgentDiagnosticsStore } from '@/services/devAgentDiagnostics'

const responseQueue: StreamChunk[][] = []
const streamChat = vi.fn(async function* (_request: ChatRequest) {
  const chunks = responseQueue.shift()
  if (!chunks) throw new Error('缺少匿名模型响应')
  for (const chunk of chunks) yield chunk
})

const client: AiProvider = {
  chat: vi.fn(async (): Promise<ChatResponse> => ({
    id: 'anonymous',
    content: '',
    role: 'assistant',
  })),
  streamChat,
  embedding: vi.fn(async () => ({ embedding: [] })),
  batchEmbedding: vi.fn(async () => []),
  validateConfig: vi.fn(async () => ({ valid: true })),
  listModels: vi.fn(async () => []),
}

vi.mock('@/services/ai/aiClient', () => ({
  getAiClient: () => client,
  isAiReady: () => true,
}))

describe('Agent execution budget', () => {
  let runAgent: typeof import('@/services/agent/executor').runAgent
  let registerTool: typeof import('@/services/agent/toolRegistry').registerTool
  let originalKnowledgeTool: ReturnType<typeof import('@/services/agent/toolRegistry').getTool>
  let originalWebSearchTool: ReturnType<typeof import('@/services/agent/toolRegistry').getTool>
  const executeAnonymousRead = vi.fn(async () => '匿名工具结果')
  const executeAnonymousList = vi.fn(async () => '匿名列表结果')

  beforeAll(async () => {
    const executor = await import('@/services/agent/executor')
    const registry = await import('@/services/agent/toolRegistry')
    executor.initAgent()
    registry.registerTool({
      name: 'get_current_time',
      description: '匿名只读工具',
      parameters: [],
      execute: executeAnonymousRead,
    })
    registry.registerTool({
      name: 'list_memories',
      description: '匿名列表工具',
      parameters: [],
      execute: executeAnonymousList,
    })
    runAgent = executor.runAgent
    registerTool = registry.registerTool
    originalKnowledgeTool = registry.getTool('search_knowledge')
    originalWebSearchTool = registry.getTool('web_search')
  })

  beforeEach(() => {
    useAgentDiagnosticsStore.getState().setEnabled(false)
    clearAgentDiagnostics()
    responseQueue.length = 0
    streamChat.mockClear()
    executeAnonymousRead.mockClear()
    executeAnonymousList.mockClear()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    registerTool({
      name: 'get_current_time',
      description: '匿名只读工具',
      parameters: [],
      execute: executeAnonymousRead,
    })
    if (originalKnowledgeTool) registerTool(originalKnowledgeTool)
    if (originalWebSearchTool) registerTool(originalWebSearchTool)
  })

  it('直接复用工具后的模型答案，不再请求第三次最终综合', async () => {
    responseQueue.push(
      [{
        content: '',
        done: true,
        toolCallDeltas: [{ index: 0, name: 'get_current_time', arguments: '{}' }],
      }],
      [
        { content: '匿名', done: false },
        { content: '最终答案', done: true },
      ],
    )
    const onStreamContent = vi.fn()

    const result = await runAgent({
      query: '匿名时间请求',
      candidateToolNames: ['get_current_time'],
      requiredCapabilities: ['time'],
      streamEnabled: true,
      onStreamContent,
    })

    expect(streamChat).toHaveBeenCalledTimes(2)
    expect(executeAnonymousRead).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({
      answer: '匿名最终答案',
      toolCalls: 1,
      reason: 'completed',
    })
    expect(result.finalMessages).toBeUndefined()
    expect(onStreamContent).toHaveBeenNthCalledWith(1, '匿名')
    expect(onStreamContent).toHaveBeenNthCalledWith(2, '匿名最终答案')
  })

  it('外部请求持有诊断 Trace 时，执行器记录模型阶段但不提前结束请求', async () => {
    responseQueue.push(
      [{ content: '', done: true, toolCallDeltas: [{ index: 0, name: 'get_current_time', arguments: '{}' }] }],
      [{ content: '匿名回答', done: true }],
    )
    useAgentDiagnosticsStore.getState().setEnabled(true)
    const diagnosticRunId = startAgentTrace({ mode: 'agent' })

    const result = await runAgent({
      query: '匿名请求',
      candidateToolNames: ['get_current_time'],
      requiredCapabilities: ['time'],
      diagnosticRunId,
    })

    expect(result.reason).toBe('completed')
    expect(useAgentDiagnosticsStore.getState().runs).toHaveLength(0)
    finishAgentTrace(diagnosticRunId, 'completed')
    expect(useAgentDiagnosticsStore.getState().runs).toHaveLength(1)
    expect(useAgentDiagnosticsStore.getState().runs[0].runId).toBe(diagnosticRunId)
    expect(useAgentDiagnosticsStore.getState().runs[0].spans[0].phase).toBe('model_request')
  })

  it('外部诊断 ID 为空时，执行器不会在开关重入后另建请求', async () => {
    responseQueue.push(
      [{ content: '', done: true, toolCallDeltas: [{ index: 0, name: 'get_current_time', arguments: '{}' }] }],
      [{ content: '匿名回答', done: true }],
    )
    useAgentDiagnosticsStore.getState().setEnabled(true)

    await runAgent({
      query: '匿名请求',
      candidateToolNames: ['get_current_time'],
      requiredCapabilities: ['time'],
      diagnosticRunId: undefined,
    })

    expect(useAgentDiagnosticsStore.getState().runs).toHaveLength(0)
  })

  it('工具返回后二次请求重新装箱且工具只执行一次', async () => {
    const executeLongResult = vi.fn(async () => `完整来源内容：${'匿名证据'.repeat(2000)}`)
    registerTool({
      name: 'get_current_time',
      description: '匿名长结果工具',
      parameters: [],
      execute: executeLongResult,
    })
    responseQueue.push(
      [{
        content: '',
        done: true,
        toolCallDeltas: [{ index: 0, name: 'get_current_time', arguments: '{}' }],
      }],
      [{ content: '基于证据的匿名答案', done: true }],
    )

    const result = await runAgent({
      query: '匿名长工具请求',
      candidateToolNames: ['get_current_time'],
      contextWindowTokens: 8192,
      streamEnabled: true,
    })

    expect(streamChat).toHaveBeenCalledTimes(2)
    expect(executeLongResult).toHaveBeenCalledTimes(1)
    const secondRequest = streamChat.mock.calls[1][0]
    expect(secondRequest.tools?.some((tool) => tool.function.name === 'get_current_time')).toBe(true)
    expect(secondRequest.messages.some((message) => message.content.includes('工具返回结果'))).toBe(true)
    expect(secondRequest.messages[0].content).toContain('get_current_time')
    expect(result.answer).toBe('基于证据的匿名答案')
  })

  it('知识库来源只包含实际装入模型的完整结果项', async () => {
    const results = Array.from({ length: 8 }, (_, index) => ({
      filePath: `D:\\anonymous\\source-${index + 1}.md`,
      title: `匿名来源 ${index + 1}`,
      chunkId: `chunk-${index + 1}`,
      snippet: `匿名证据 ${index + 1}：${'内容'.repeat(100)}`,
      titlePath: [],
      startLine: index * 10 + 1,
      endLine: index * 10 + 9,
    }))
    registerTool({
      name: 'search_knowledge',
      description: '匿名知识库检索',
      parameters: [],
      execute: vi.fn(async () => JSON.stringify({ status: 'ok', resultCount: results.length, results }, null, 2)),
    })
    responseQueue.push(
      [{
        content: '',
        done: true,
        toolCallDeltas: [{ index: 0, name: 'search_knowledge', arguments: '{}' }],
      }],
      [{ content: '匿名知识库答案', done: true }],
    )

    const result = await runAgent({
      query: '匿名知识库问题',
      candidateToolNames: ['search_knowledge'],
      contextWindowTokens: 8192,
      streamEnabled: true,
    })

    const toolMessage = streamChat.mock.calls[1][0].messages.find(
      (message) => message.role === 'user' && message.content.startsWith('工具返回结果'),
    )
    const includedSources = results.filter((source) => toolMessage?.content.includes(source.filePath.replaceAll('\\', '\\\\')))
    expect(includedSources.length).toBeGreaterThan(0)
    expect(result.sources).toHaveLength(includedSources.length)
    expect(result.sources.map((source) => source.kind === 'web' ? source.url : source.filePath))
      .toEqual(includedSources.map((source) => source.filePath))
  })

  it('超长知识库结果的 observation 保持合法 JSON，时间线不误报检索失败', async () => {
    const results = Array.from({ length: 8 }, (_, index) => ({
      filePath: `D:\\anonymous\\long-${index + 1}.md`,
      title: `匿名长来源 ${index + 1}`,
      chunkId: `chunk-${index + 1}`,
      snippet: `匿名证据 ${index + 1}：${'内容'.repeat(400)}`,
      titlePath: [],
      startLine: index * 10 + 1,
      endLine: index * 10 + 9,
    }))
    registerTool({
      name: 'search_knowledge',
      description: '匿名知识库检索',
      parameters: [],
      execute: vi.fn(async () => JSON.stringify({ status: 'ok', resultCount: results.length, results }, null, 2)),
    })
    responseQueue.push(
      [{
        content: '',
        done: true,
        toolCallDeltas: [{ index: 0, name: 'search_knowledge', arguments: '{}' }],
      }],
      [{ content: '匿名长知识库答案', done: true }],
    )

    const result = await runAgent({
      query: '匿名长知识库问题',
      candidateToolNames: ['search_knowledge'],
      contextWindowTokens: 8192,
      streamEnabled: true,
    })

    const observation = result.steps.find(
      (step) => step.type === 'observation' && step.toolName === 'search_knowledge',
    )
    expect(observation).toBeDefined()
    const parsed = JSON.parse(observation!.content) as { status: string; results: unknown[] }
    expect(parsed.status).toBe('ok')
    expect(parsed.results.length).toBeGreaterThan(0)
    expect(parsed.results.length).toBeLessThan(results.length)
    expect(decodeKnowledgeSearchOutcome(decodeAgentStepEvent(observation!))).toBe('found')
  })

  it('超长联网搜索结果保持结构完整并只登记模型可见来源', async () => {
    const results = Array.from({ length: 8 }, (_, index) => ({
      title: `匿名网页 ${index + 1}`,
      url: `https://example.com/anonymous-${index + 1}`,
      siteName: 'example.com',
      snippet: `匿名联网证据 ${index + 1}：${'内容'.repeat(500)}`,
    }))
    registerTool({
      name: 'web_search',
      description: '匿名联网搜索',
      parameters: [],
      execute: vi.fn(async () => JSON.stringify({
        status: 'ok',
        query: '匿名联网问题',
        totalResults: results.length,
        results,
      }, null, 2)),
    })
    responseQueue.push(
      [{
        content: '',
        done: true,
        toolCallDeltas: [{ index: 0, name: 'web_search', arguments: '{}' }],
      }],
      [{ content: '匿名联网答案', done: true }],
    )

    const result = await runAgent({
      query: '匿名联网问题',
      candidateToolNames: ['web_search'],
      requiredCapabilities: ['web'],
      contextWindowTokens: 8192,
      streamEnabled: true,
    })

    const toolMessage = streamChat.mock.calls[1][0].messages.find(
      (message) => message.role === 'user' && message.content.startsWith('工具返回结果'),
    )
    const serializedResult = toolMessage?.content
      .slice('工具返回结果：\n'.length)
      .split('\n\n请根据以上信息继续思考或给出最终答案。')[0]
    const parsed = JSON.parse(serializedResult || '') as {
      results: Array<{ url: string; referenceId: string }>
    }
    const visibleUrls = parsed.results.map((source) => source.url)

    expect(parsed.results.length).toBeGreaterThan(0)
    expect(parsed.results.length).toBeLessThan(results.length)
    expect(parsed.results.every((source) => /^\[S\d+\]$/.test(source.referenceId))).toBe(true)
    expect(result.sources?.map((source) => source.kind === 'web' ? source.url : source.filePath))
      .toEqual(visibleUrls)
    expect(result.answer).toBe('匿名联网答案')
  })

  it('为同批次的每个工具分别发送执行阶段事件', async () => {
    responseQueue.push(
      [{
        content: '',
        done: true,
        toolCallDeltas: [
          { index: 0, name: 'get_current_time', arguments: '{}' },
          { index: 1, name: 'list_memories', arguments: '{}' },
        ],
      }],
      [{ content: '匿名多工具答案', done: true }],
    )
    const onStep = vi.fn()

    const result = await runAgent({
      query: '匿名多工具请求',
      candidateToolNames: ['get_current_time', 'list_memories'],
      streamEnabled: true,
      onStep,
    })

    expect(executeAnonymousRead).toHaveBeenCalledTimes(1)
    expect(executeAnonymousList).toHaveBeenCalledTimes(1)
    expect(result.toolCalls).toBe(2)
    expect(onStep.mock.calls
      .map(([step]) => step)
      .filter((step) => step.type === 'action')
      .map((step) => step.toolName)).toEqual(['get_current_time', 'list_memories'])
  })

  it('原生工具调用把同轮文本作为行动说明传给每个 action 事件', async () => {
    responseQueue.push(
      [{
        content: '我会先查看当前时间',
        done: true,
        toolCallDeltas: [
          { index: 0, name: 'get_current_time', arguments: '{}' },
          { index: 1, name: 'list_memories', arguments: '{}' },
        ],
      }],
      [{ content: '匿名多工具答案', done: true }],
    )
    const onStep = vi.fn()

    await runAgent({
      query: '匿名多工具行动说明',
      candidateToolNames: ['get_current_time', 'list_memories'],
      streamEnabled: true,
      onStep,
    })

    expect(onStep.mock.calls
      .map(([step]) => step)
      .filter((step) => step.type === 'action')
      .map((step) => step.actionMessage)).toEqual(['我会先查看当前时间', '我会先查看当前时间'])
  })

  it('JSON 降级工具调用读取顶层行动说明且不把它放进工具参数', async () => {
    responseQueue.push(
      [{
        content: '{"tool":"get_current_time","args":{},"actionMessage":"我会先查看当前时间"}',
        done: true,
      }],
      [{ content: '匿名工具答案', done: true }],
    )
    const onStep = vi.fn()

    await runAgent({
      query: '匿名 JSON 行动说明',
      candidateToolNames: ['get_current_time'],
      streamEnabled: true,
      onStep,
    })

    const action = onStep.mock.calls
      .map(([step]) => step)
      .find((step) => step.type === 'action')
    expect(action).toMatchObject({
      actionMessage: '我会先查看当前时间',
      toolArgs: {},
    })
    expect(action.toolArgs).not.toHaveProperty('actionMessage')
  })

  it('同轮相同只读工具与参数只执行一次', async () => {
    responseQueue.push(
      [{
        content: '',
        done: true,
        toolCallDeltas: [
          { index: 0, name: 'get_current_time', arguments: '{}' },
          { index: 1, name: 'get_current_time', arguments: '{}' },
        ],
      }],
      [{ content: '匿名去重答案', done: true }],
    )

    const result = await runAgent({
      query: '匿名重复调用请求',
      candidateToolNames: ['get_current_time'],
      streamEnabled: true,
    })

    expect(executeAnonymousRead).toHaveBeenCalledTimes(1)
    expect(result.toolCalls).toBe(1)
    expect(result.steps.filter((step) => step.type === 'observation')).toHaveLength(2)
  })

  it('达到工具调用预算后返回可综合的稳定终态', async () => {
    responseQueue.push([{
      content: '',
      done: true,
      toolCallDeltas: [{ index: 0, name: 'get_current_time', arguments: '{}' }],
    }])

    const result = await runAgent({
      query: '匿名预算请求',
      candidateToolNames: ['get_current_time'],
      config: { maxToolCalls: 1 },
      streamEnabled: true,
    })

    expect(streamChat).toHaveBeenCalledTimes(1)
    expect(result.reason).toBe('max_tool_calls')
    expect(result.toolCalls).toBe(1)
    expect(result.finalMessages?.at(-1)?.content).toContain('工具调用上限')
  })

  it('工具预算不会拦截必须生成的修改确认卡片', async () => {
    const executePendingEdit = vi.fn(async () => JSON.stringify({
      __pendingEdit: true,
      oldText: '匿名原文',
      newText: '匿名新文',
    }))
    registerTool({
      name: 'replace_current_tab_text',
      description: '匿名修改确认工具',
      parameters: [],
      execute: executePendingEdit,
    })
    responseQueue.push([{
      content: '',
      done: true,
      toolCallDeltas: [{ index: 0, name: 'replace_current_tab_text', arguments: '{}' }],
    }])

    const result = await runAgent({
      query: '修改匿名选区',
      currentEditTargetCount: 1,
      hasCurrentEditTarget: true,
      config: { maxToolCalls: 0 },
      routingDecision: {
        mode: 'agent',
        reasonCodes: ['strong_signal'],
        candidates: ['file_write'],
        required: [],
        candidateTools: ['replace_current_tab_text'],
        selectionRequestKind: 'none',
        requiresEditConfirmation: true,
        shouldLookupMemory: false,
        memoryIntent: 'none',
        shouldLookupKnowledge: false,
        isDocumentRewrite: true,
        isWebComparison: false,
        isLocalResearch: false,
        isFileSummary: false,
        explicitMemoryWriteIntent: false,
      },
      streamEnabled: true,
    })

    expect(executePendingEdit).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({
      answer: '',
      reason: 'completed',
      toolCalls: 1,
    })
  })

  it('请求在开始前取消时不调用模型或工具', async () => {
    const controller = new AbortController()
    controller.abort('anonymous_cancel')

    const result = await runAgent({
      query: '匿名取消请求',
      candidateToolNames: ['get_current_time'],
      signal: controller.signal,
      streamEnabled: true,
    })

    expect(streamChat).not.toHaveBeenCalled()
    expect(executeAnonymousRead).not.toHaveBeenCalled()
    expect(result).toMatchObject({
      answer: '已取消本次 Agent 请求。',
      reason: 'error',
    })
  })

  it('工具提前成功时只创建一个超时计时器并立即清理', async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout')
    const controller = new AbortController()
    const removeEventListenerSpy = vi.spyOn(controller.signal, 'removeEventListener')
    responseQueue.push(
      [{
        content: '',
        done: true,
        toolCallDeltas: [{ index: 0, name: 'get_current_time', arguments: '{}' }],
      }],
      [{ content: '匿名成功答案', done: true }],
    )

    const result = await runAgent({
      query: '匿名成功请求',
      candidateToolNames: ['get_current_time'],
      config: { stepTimeout: 3210 },
      signal: controller.signal,
      streamEnabled: true,
    })

    const timeoutCallIndexes = setTimeoutSpy.mock.calls
      .map(([, delay], index) => delay === 3210 ? index : -1)
      .filter(index => index >= 0)
    expect(timeoutCallIndexes).toHaveLength(1)
    expect(clearTimeoutSpy).toHaveBeenCalledWith(setTimeoutSpy.mock.results[timeoutCallIndexes[0]]?.value)
    expect(removeEventListenerSpy).toHaveBeenCalledWith('abort', expect.any(Function))
    expect(result.answer).toBe('匿名成功答案')
  })

  it('工具错误形成 tool_error 结果并清理超时计时器', async () => {
    registerTool({
      name: 'get_current_time',
      description: '匿名错误工具',
      parameters: [],
      execute: async () => { throw new Error('匿名工具失败') },
    })
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout')
    const controller = new AbortController()
    const removeEventListenerSpy = vi.spyOn(controller.signal, 'removeEventListener')
    responseQueue.push(
      [{
        content: '',
        done: true,
        toolCallDeltas: [{ index: 0, name: 'get_current_time', arguments: '{}' }],
      }],
      [{ content: '匿名错误降级答案', done: true }],
    )

    const result = await runAgent({
      query: '匿名错误请求',
      candidateToolNames: ['get_current_time'],
      signal: controller.signal,
      streamEnabled: true,
    })

    expect(result.steps.some((step) => step.content === '工具执行出错: 匿名工具失败')).toBe(true)
    expect(clearTimeoutSpy).toHaveBeenCalled()
    expect(removeEventListenerSpy).toHaveBeenCalledWith('abort', expect.any(Function))
  })

  it('父会话取消会结束不响应 abort 的工具并移除转发监听器', async () => {
    const executeIgnoringAbort = vi.fn(async () => await new Promise<string>(() => undefined))
    registerTool({
      name: 'get_current_time',
      description: '匿名取消工具',
      parameters: [],
      execute: executeIgnoringAbort,
    })
    responseQueue.push([{
      content: '',
      done: true,
      toolCallDeltas: [{ index: 0, name: 'get_current_time', arguments: '{}' }],
    }])
    const controller = new AbortController()
    const removeEventListenerSpy = vi.spyOn(controller.signal, 'removeEventListener')

    const pending = runAgent({
      query: '匿名执行中取消请求',
      candidateToolNames: ['get_current_time'],
      signal: controller.signal,
      streamEnabled: true,
    })
    while (executeIgnoringAbort.mock.calls.length === 0) await Promise.resolve()
    controller.abort('anonymous_cancel')
    const result = await pending

    expect(result.reason).toBe('error')
    expect(result.steps.some((step) => step.content === '工具执行已取消。')).toBe(true)
    expect(removeEventListenerSpy).toHaveBeenCalledWith('abort', expect.any(Function))
  })

  it('工具超时后仍形成明确工具结果并稳定结束', async () => {
    vi.useFakeTimers()
    let resolveLate: ((value: string) => void) | undefined
    let toolSignal: AbortSignal | undefined
    const controller = new AbortController()
    const removeEventListenerSpy = vi.spyOn(controller.signal, 'removeEventListener')
    const executeLate = vi.fn(async (_args, context) => await new Promise<string>((resolve) => {
      toolSignal = context.signal
      resolveLate = resolve
    }))
    registerTool({
      name: 'get_current_time',
      description: '匿名超时工具',
      parameters: [],
      execute: executeLate,
    })
    responseQueue.push(
      [{
        content: '',
        done: true,
        toolCallDeltas: [{ index: 0, name: 'get_current_time', arguments: '{}' }],
      }],
      [{ content: '匿名超时降级答案', done: true }],
    )

    const pending = runAgent({
      query: '匿名超时请求',
      candidateToolNames: ['get_current_time'],
      config: { stepTimeout: 5 },
      signal: controller.signal,
      streamEnabled: true,
    })
    while (executeLate.mock.calls.length === 0) await Promise.resolve()
    expect(vi.getTimerCount()).toBe(2)
    await vi.advanceTimersByTimeAsync(5)
    const result = await pending

    expect(result.reason).toBe('completed')
    expect(result.answer).toBe('匿名超时降级答案')
    expect(result.steps.some((step) => step.content === '工具执行超时。')).toBe(true)
    expect(toolSignal).toMatchObject({ aborted: true, reason: 'timeout' })
    expect(vi.getTimerCount()).toBe(0)
    expect(removeEventListenerSpy).toHaveBeenCalledWith('abort', expect.any(Function))

    const completedSteps = [...result.steps]
    resolveLate?.('匿名迟到工具结果')
    await Promise.resolve()
    expect(result.steps).toEqual(completedSteps)
    expect(result.steps.some((step) => step.content.includes('匿名迟到工具结果'))).toBe(false)
  })

  it('整次 deadline 收敛工具超时并基于已有证据降级', async () => {
    vi.useFakeTimers()
    let toolSignal: AbortSignal | undefined
    const executePastDeadline = vi.fn(async (_args, context) => await new Promise<string>(() => {
      toolSignal = context.signal
    }))
    registerTool({
      name: 'get_current_time',
      description: '匿名 deadline 工具',
      parameters: [],
      execute: executePastDeadline,
    })
    responseQueue.push([{
      content: '',
      done: true,
      toolCallDeltas: [{ index: 0, name: 'get_current_time', arguments: '{}' }],
    }])

    const pending = runAgent({
      query: '匿名 deadline 请求',
      candidateToolNames: ['get_current_time'],
      config: { stepTimeout: 30_000, deadlineMs: 20 },
      streamEnabled: true,
    })
    while (executePastDeadline.mock.calls.length === 0) await Promise.resolve()
    await vi.advanceTimersByTimeAsync(20)
    const result = await pending

    expect(result.reason).toBe('deadline')
    expect(result.toolCalls).toBe(1)
    expect(result.finalMessages?.at(-1)?.content).toContain('已有证据')
    expect(result.finalMessages?.at(-1)?.content).toContain('尚未取得或验证')
    expect(toolSignal).toMatchObject({ aborted: true, reason: 'deadline' })
    expect(vi.getTimerCount()).toBe(0)
  })
})
