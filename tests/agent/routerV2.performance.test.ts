import { describe, expect, it } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { makeRoutingDecision } from '@/services/agent/routingService'
import { resolveRouterConfig } from '@/services/agent/routerConfig'
import { semanticRoutingTriggers } from '@/services/agent/semanticRouter'

describe('Router Direct performance baseline', () => {
  it('measures the synchronous rule path with anonymous general questions', () => {
    const queries = ['你好', '什么是闭包？', '解释一下牛顿第二定律', '1+1等于几？', '写一首关于春天的诗']
    for (let i = 0; i < 1000; i++) makeRoutingDecision(queries[i % queries.length], {})
    const durations: number[] = []
    const phase = process.env.ROUTER_BENCH_PHASE
    for (let i = 0; i < 5000; i++) {
      const start = performance.now()
      const result = makeRoutingDecision(queries[i % queries.length], {})
      const triggers = phase === 'after'
        ? semanticRoutingTriggers(queries[i % queries.length], result, {}, resolveRouterConfig()) : []
      durations.push(performance.now() - start)
      expect(result.mode).toBe('direct')
      expect(triggers).toEqual([])
    }
    durations.sort((a, b) => a - b)
    const result = { samples: durations.length, medianMs: durations[2500], p90Ms: durations[4500], maxMs: durations.at(-1) }
    if (phase === 'before' || phase === 'after') {
      mkdirSync('output/router-v2', { recursive: true })
      writeFileSync(`output/router-v2/${phase}.json`, JSON.stringify(result, null, 2))
    }
    console.info('Anonymous Direct rule timings', result)
  })
})
