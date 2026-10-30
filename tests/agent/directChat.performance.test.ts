import { beforeAll, describe, expect, it, vi } from 'vitest'
import type { AiProvider } from '@/services/ai/types'
import { streamDirectChat, type DirectChatMetric } from '@/services/agent/directChat'
import { registerTool } from '@/services/agent/toolRegistry'

vi.mock('@/services/agent/toolEligibilityContext', () => ({ currentToolEligibilityContext: () => ({
  desktop: true, databaseAvailable: true, readAllowed: true, writeAllowed: false,
}) }))
vi.mock('@/services/agent/executor', () => ({ initAgent: () => {}, executeTool: () => { throw new Error('No retrieval allowed in ordinary QA benchmark') },
  prepareAgentToolResultForModel: () => { throw new Error('No result expected') } }))

beforeAll(() => {
  for (const name of ['search_memory', 'search_knowledge']) registerTool({ name, description: 'anonymous',
    parameters: [{ name: 'query', type: 'string', description: '搜索查询', required: true },
      { name: 'topK', type: 'number', description: '返回结果数量，默认5', required: false }], execute: async () => '' })
})

describe('anonymous local orchestration A/B (not model/network latency)', () => {
  it('compares 300 interleaved ordinary QA samples with the feature off/on', async () => {
    const samples: Record<string, DirectChatMetric[]> = { off: [], on: [] }
    let requests = 0
    const client = { chat: async () => { requests++; return { id: '', role: 'assistant', content: '匿名回答' } } } as unknown as AiProvider
    for (let i = 0; i < 320; i++) {
      for (const enabled of i % 2 ? [true, false] : [false, true]) {
        await streamDirectChat({ client, messages: [{ role: 'user', content: '什么是闭包？' }], query: '什么是闭包？',
          enabled, workspacePath: null, streamEnabled: false, onUpdate: () => {}, isCancelled: () => false,
          onMetric: metric => { if (i >= 20) samples[enabled ? 'on' : 'off'].push(metric) } })
      }
    }
    const summary = Object.fromEntries(Object.entries(samples).map(([name, values]) => {
      const first = values.map(value => value.firstTextMs!).sort((a, b) => a - b)
      return [name, { samples: values.length, p50Ms: first[149], p95Ms: first[284],
        schemaEstimatedTokens: values[0].schemaEstimatedTokens,
        extraRequests: values.reduce((n, value) => n + value.modelRequests - 1, 0),
        executedTools: values.reduce((n, value) => n + value.executedTools, 0) }]
    }))
    console.info('Local orchestration only; excludes provider/network and real intent accuracy', summary)
    expect(requests).toBe(640)
    expect(summary.on.schemaEstimatedTokens).toBeLessThanOrEqual(600)
    expect(summary.on.extraRequests).toBe(0)
    expect(summary.on.executedTools).toBe(0)
    // A loose host-only budget catches accidental blocking work, not provider performance.
    expect(summary.on.p95Ms).toBeLessThan(20)
  })
})
