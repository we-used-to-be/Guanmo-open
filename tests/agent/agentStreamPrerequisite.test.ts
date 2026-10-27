import { afterEach, expect, it, vi } from 'vitest'
import type { AiProvider, ChatRequest, ChatResponse, StreamChunk } from '@/services/ai/types'
import { makeRoutingDecision } from '@/services/agent/routingService'
import { setAgentScopeContext } from '@/services/aiScope'

vi.mock('@/hooks/useTauri', async importOriginal => ({
  ...await importOriginal<typeof import('@/hooks/useTauri')>(), isTauri: () => true,
}))
vi.mock('@/services/database/db', async importOriginal => ({
  ...await importOriginal<typeof import('@/services/database/db')>(), isDatabaseReady: () => true,
}))

const responses: StreamChunk[][] = []
const streamChat = vi.fn(async function* (_request: ChatRequest) {
  const response = responses.shift()
  if (!response) throw new Error('缺少匿名模型响应')
  for (const chunk of response) yield chunk
})
const client: AiProvider = {
  chat: vi.fn(async (): Promise<ChatResponse> => ({ id: 'anonymous', content: '', role: 'assistant' })),
  streamChat,
  embedding: vi.fn(async () => ({ embedding: [] })),
  batchEmbedding: vi.fn(async () => []),
  validateConfig: vi.fn(async () => ({ valid: true })),
  listModels: vi.fn(async () => []),
}
vi.mock('@/services/ai/aiClient', () => ({ getAiClient: () => client, isAiReady: () => true }))

afterEach(() => setAgentScopeContext(null))

it('补读必需选区上下文前不流出模型的临时答复', async () => {
  const { initAgent, runAgent } = await import('@/services/agent/executor')
  const { registerTool } = await import('@/services/agent/toolRegistry')
  initAgent()
  const query = '结合前后文检索知识库相关内容'
  const decision = makeRoutingDecision(query, { hasSelection: true, hasContextTags: true })
  expect(decision.required).toEqual(expect.arrayContaining(['knowledge', 'selection_context']))

  registerTool({
    name: 'search_knowledge', description: '匿名知识库检索',
    parameters: [{ name: 'query', type: 'string', required: false, description: '检索词' }],
    execute: async () => JSON.stringify({ status: 'ok', resultCount: 1, results: [{ filePath: 'C:\\Temp\\anonymous.md', title: '匿名文档', snippet: '匿名证据', startLine: 1, endLine: 1 }] }),
  })
  registerTool({
    name: 'read_selection_context', description: '匿名选区读取',
    parameters: [{ name: 'targetId', type: 'string', required: false, description: '选区 ID' }],
    execute: async () => JSON.stringify({ chunks: [
      { role: 'before', content: '上文' },
      { role: 'current', content: '选区' },
      { role: 'after', content: '下文' },
    ] }),
  })
  setAgentScopeContext({
    contextTags: [{ id: 'selection-1', type: 'selection', title: '匿名选区', filePath: 'C:\\Temp\\anonymous.md', content: '选区', preview: '选区', selectionFrom: 0, selectionTo: 2 }],
    editTargets: [{ id: 'edit-target-1', type: 'selection', title: '匿名选区', filePath: 'C:\\Temp\\anonymous.md', selectionFrom: 0, selectionTo: 2 }],
  })
  responses.push(
    [{ content: '', done: true, toolCallDeltas: [{ index: 0, name: 'search_knowledge', arguments: '{"query":"匿名"}' }] }],
    [{ content: '临时答复', done: false }, { content: '，尚未读取选区', done: true }],
    [{ content: '最终答复', done: true }],
  )
  const visible: string[] = []
  const result = await runAgent({
    query, routingDecision: decision, streamEnabled: true,
    onStreamContent: content => visible.push(content),
  })

  expect(result.reason).toBe('completed')
  expect(result.answer).toBe('最终答复')
  expect(result.steps.some(step => step.type === 'action' && step.content === '补调工具: read_selection_context')).toBe(true)
  expect(visible).toEqual(['最终答复'])
  expect(streamChat).toHaveBeenCalledTimes(3)
})
