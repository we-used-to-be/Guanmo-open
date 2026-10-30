import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatRequest, StreamChunk } from '@/services/ai/types'
import { getAgentScopeContext, setAgentScopeContext } from '@/services/aiScope'
import { useSettingsStore } from '@/stores/settingsStore'

const stream = vi.fn<(request: ChatRequest) => AsyncIterable<StreamChunk>>()
const chat = vi.fn(async (_request: ChatRequest) => ({ id: 'anonymous', content: '请补充目标', role: 'assistant' as const }))
vi.mock('@/services/ai/aiClient', () => ({ getAiClient: () => ({ streamChat: stream, chat }), isAiReady: () => true }))
vi.mock('@/hooks/useTauri', async importOriginal => ({ ...await importOriginal<typeof import('@/hooks/useTauri')>(), isTauri: () => true }))
vi.mock('@/services/database/db', async importOriginal => ({ ...await importOriginal<typeof import('@/services/database/db')>(), isDatabaseReady: () => true }))

describe('Router V2 execution boundary', () => {
  let executor: typeof import('@/services/agent/executor')
  let registerTool: typeof import('@/services/agent/toolRegistry').registerTool
  beforeAll(async () => {
    executor = await import('@/services/agent/executor')
    executor.initAgent()
    registerTool = (await import('@/services/agent/toolRegistry')).registerTool
  })

  it('retains prefetched memory sources even when Agent does not search again', async () => {
    const memory = { kind: 'memory' as const, memoryId: 'anonymous-memory', content: '偏好简洁回答' }
    const result = await executor.runAgent({ query: 'anonymous', candidateToolNames: [], streamEnabled: false,
      prefetchedMemory: { query: 'anonymous', result: memory.content, sources: [memory], topK: 10 } })
    expect(result.sources).toEqual([memory])
    expect(result.sourceRegistry?.entries).toEqual([{ id: 'S1', source: memory }])
  })

  it('returns memory sources retrieved within the Agent tool loop', async () => {
    const memory = { kind: 'memory' as const, memoryId: 'anonymous-memory', content: '偏好简洁回答' }
    registerTool({ name: 'search_memory', description: 'anonymous', parameters: [], execute: async () => JSON.stringify({ memories: [memory] }) })
    let calls = 0
    stream.mockImplementation(async function* () {
      if (++calls === 1) yield { content: '', done: true, toolCallDeltas: [{ index: 0, name: 'search_memory', arguments: '{}' }] }
      else yield { content: '按偏好回答 [S1]', done: true }
    })
    const result = await executor.runAgent({ query: '我的偏好', candidateToolNames: ['search_memory'], config: { maxSteps: 2 } })
    expect(result.sources).toEqual([memory])
    expect(result.referencedSourceIds).toEqual(['S1'])
  })
  beforeEach(() => {
    chat.mockClear()
    useSettingsStore.setState(state => ({ ai: { ...state.ai, webSearchEnabled: true } }))
  })
  afterEach(() => setAgentScopeContext(null))

  it('passes a captured Direct memory scope without borrowing or changing the active Agent scope', async () => {
    const execute = vi.fn(async () => 'anonymous memory')
    registerTool({ name: 'search_memory', description: 'anonymous', parameters: [{ name: 'query', type: 'string', required: true, description: 'query' }], execute })
    setAgentScopeContext({ contextTags: [], workspacePath: 'C:/Temp/agent-workspace' })
    const scope = getAgentScopeContext()
    const result = await executor.executeTool('search_memory', { query: 'anonymous' }, 1000, 'anonymous', undefined, undefined, undefined,
      { workspacePath: 'C:/Temp/direct-workspace' })
    expect(result.status).toBe('success')
    expect(execute.mock.calls[0][1].workspacePath).toBe('C:/Temp/direct-workspace')
    expect(getAgentScopeContext()).toBe(scope)
  })

  it('keeps long structured memory results parseable and snapshots only retained content', async () => {
    const source = { kind: 'memory', memoryId: 'anonymous-memory', content: '"匿名事实"'.repeat(1000) }
    registerTool({ name: 'search_memory', description: 'anonymous', parameters: [], execute: async () => JSON.stringify({ memories: [source] }) })
    const result = await executor.executeTool('search_memory', {}, 1000, 'anonymous')
    const parsed = JSON.parse(result.result)
    expect(result.result.length).toBeLessThanOrEqual(3000)
    expect(parsed.memories[0].content.length).toBeLessThan(source.content.length)
    const registry = executor.prepareAgentToolResultForModel({ entries: [] }, 'search_memory', result.result).registry
    expect(registry.entries[0].source).toMatchObject({ content: parsed.memories[0].content })
  })

  it('enforces the Direct read whitelist inside the shared executor', async () => {
    const execute = vi.fn(async () => 'must not execute')
    registerTool({ name: 'get_current_time', description: 'anonymous', parameters: [], execute })
    const result = await executor.executeTool('get_current_time', {}, 1000, 'anonymous', undefined, undefined, undefined, { workspacePath: null })
    expect(result.status).toBe('tool_error')
    expect(execute).not.toHaveBeenCalled()
  })

  it('rechecks tool availability after schema exposure and before execution', async () => {
    let available = true
    const execute = vi.fn(async () => 'anonymous')
    registerTool({ name: 'get_current_time', description: 'anonymous', parameters: [], isAvailable: () => available, execute })
    let calls = 0
    stream.mockImplementation(async function* (request) {
      if (++calls === 1) {
        expect(request.tools?.map(tool => tool.function.name)).toEqual(['get_current_time'])
        available = false
        yield { content: '', done: true, toolCallDeltas: [{ index: 0, name: 'get_current_time', arguments: '{}' }] }
      } else yield { content: '工具不可用', done: true }
    })
    const result = await executor.runAgent({ query: 'anonymous', candidateToolNames: ['get_current_time'], config: { maxSteps: 2 } })
    expect(execute).not.toHaveBeenCalled()
    expect(result.steps.some(step => step.content.includes('工具调用被拒绝'))).toBe(true)
  })

  it('rechecks current-turn selection authorization after model latency', async () => {
    const execute = vi.fn(async () => 'never read')
    registerTool({ name: 'read_selection_context', description: 'anonymous', parameters: [], execute })
    setAgentScopeContext({ contextTags: [{ id: 's', type: 'selection', title: 'anonymous', filePath: 'C:/Temp/anonymous.md', content: 'text', preview: 'text' }] })
    let calls = 0
    stream.mockImplementation(async function* (request) {
      if (++calls === 1) {
        expect(request.tools?.map(tool => tool.function.name)).toEqual(['read_selection_context'])
        setAgentScopeContext(null)
        yield { content: '', done: true, toolCallDeltas: [{ index: 0, name: 'read_selection_context', arguments: '{}' }] }
      } else yield { content: '请添加选区', done: true }
    })
    await executor.runAgent({ query: 'anonymous', candidateToolNames: ['read_selection_context'], config: { maxSteps: 2 } })
    expect(execute).not.toHaveBeenCalled()
  })

  it('rechecks the Web search switch before dispatch', async () => {
    const execute = vi.fn(async () => 'never search')
    registerTool({ name: 'web_search', description: 'anonymous', parameters: [], execute })
    let calls = 0
    stream.mockImplementation(async function* () {
      if (++calls === 1) {
        useSettingsStore.setState(state => ({ ai: { ...state.ai, webSearchEnabled: false } }))
        yield { content: '', done: true, toolCallDeltas: [{ index: 0, name: 'web_search', arguments: '{}' }] }
      } else yield { content: '搜索已关闭', done: true }
    })
    await executor.runAgent({ query: 'anonymous', candidateToolNames: ['web_search'], config: { maxSteps: 2 } })
    expect(execute).not.toHaveBeenCalled()
  })

  it('never exposes unavailable tools or full-registry descriptions when candidates become empty', async () => {
    registerTool({ name: 'replace_current_tab_text', description: 'UNRELATED_SCHEMA_SENTINEL', parameters: [], execute: async () => '' })
    await executor.runAgent({ query: 'anonymous', candidateToolNames: ['replace_current_tab_text'] })
    expect(chat).toHaveBeenCalledTimes(1)
    const request = chat.mock.calls[0][0] as ChatRequest
    expect(request.tools).toEqual([])
    expect(request.messages[0].content).not.toContain('UNRELATED_SCHEMA_SENTINEL')
    expect(request.messages[0].content).toContain('缺少本轮授权')
  })

  it('reuses successful or empty prefetch inside one run without reexecuting the same memory query', async () => {
    const execute = vi.fn(async () => 'should not execute')
    registerTool({ name: 'search_memory', description: 'anonymous memory', parameters: [{ name: 'query', type: 'string', required: true, description: 'query' }], execute })
    let calls = 0
    stream.mockImplementation(async function* () {
      if (++calls === 1) yield { content: '', done: true, toolCallDeltas: [{ index: 0, name: 'search_memory', arguments: '{"query":"我的偏好"}' }] }
      else yield { content: '没有找到已保存偏好', done: true }
    })
    const result = await executor.runAgent({ query: '我的偏好', candidateToolNames: ['search_memory'], hasPrefetchedMemoryLookup: true,
      prefetchedMemory: { query: '我的偏好', result: '未找到相关记忆。', topK: 10 }, config: { maxSteps: 2 } })
    expect(execute).not.toHaveBeenCalled()
    expect(result.steps.some(step => step.content.includes('未找到相关记忆'))).toBe(true)
  })
})
