import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatRequest, StreamChunk } from '@/services/ai/types'
import { setAgentScopeContext } from '@/services/aiScope'
import { useSettingsStore } from '@/stores/settingsStore'

const stream = vi.fn<(request: ChatRequest) => AsyncIterable<StreamChunk>>()
const chat = vi.fn(async (_request: ChatRequest) => ({ id: 'anonymous', content: '请补充目标', role: 'assistant' as const }))
vi.mock('@/services/ai/aiClient', () => ({ getAiClient: () => ({ streamChat: stream, chat }), isAiReady: () => true }))
vi.mock('@/hooks/useTauri', async importOriginal => ({ ...await importOriginal<typeof import('@/hooks/useTauri')>(), isTauri: () => true }))

describe('Router V2 execution boundary', () => {
  let executor: typeof import('@/services/agent/executor')
  let registerTool: typeof import('@/services/agent/toolRegistry').registerTool
  beforeAll(async () => {
    executor = await import('@/services/agent/executor')
    executor.initAgent()
    registerTool = (await import('@/services/agent/toolRegistry')).registerTool
  })
  beforeEach(() => {
    chat.mockClear()
    useSettingsStore.setState(state => ({ ai: { ...state.ai, webSearchEnabled: true } }))
  })
  afterEach(() => setAgentScopeContext(null))

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
})
