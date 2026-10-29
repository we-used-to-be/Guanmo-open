import { build } from 'esbuild'
import { mkdir, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import path from 'node:path'

const mode = process.argv.includes('--baseline') ? 'baseline' : 'current'
const baselineRef = '1c84c405f474292195197ba07b6fa443e38eb28d'
const ruleFiles = new Set(['src/services/memory/memoryPolicy.ts', 'src/services/agent/routingService.ts', 'src/services/agent/intentDetector.ts', 'src/services/agent/semanticRouter.ts'])
const built = await build({
  stdin: {
    contents: `
      import { memoryEvaluationCases } from './scripts/memory-evaluation-cases';
      import { classifyMemoryRetrievalIntent } from './src/services/memory/memoryPolicy';
      import { makeRoutingDecision } from './src/services/agent/routingService';
      import { semanticRoutingTriggers } from './src/services/agent/semanticRouter';
      import { resolveRouterConfig } from './src/services/agent/routerConfig';
      export { memoryEvaluationCases, classifyMemoryRetrievalIntent, makeRoutingDecision, semanticRoutingTriggers, resolveRouterConfig };
    `,
    resolveDir: process.cwd(), loader: 'ts',
  },
  bundle: true, platform: 'node', format: 'esm', write: false, logLevel: 'silent',
  plugins: [{ name: 'pure-rule-snapshot', setup(builder) {
    // Routing imports only the policy re-exports of memoryService; resolve those directly to avoid any database runtime.
    builder.onResolve({ filter: /memory\/memoryService$/ }, () => ({ path: path.resolve('src/services/memory/memoryPolicy.ts') }))
    if (mode === 'baseline') builder.onLoad({ filter: /\.ts$/ }, args => {
      const relative = path.relative(process.cwd(), args.path).split(path.sep).join('/')
      if (!ruleFiles.has(relative)) return
      return { contents: execFileSync('git', ['show', `${baselineRef}:${relative}`], { encoding: 'utf8' }), loader: 'ts' }
    })
  } }],
})
const { memoryEvaluationCases: cases, classifyMemoryRetrievalIntent: classify, makeRoutingDecision, semanticRoutingTriggers, resolveRouterConfig } = await import(
  `data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`,
)
if (cases.length < 200 || new Set(cases.map(c => c.id)).size !== cases.length) throw new Error('invalid evaluation corpus')
// Labels never enter the classifier. Context-aware integration is measured separately in Vitest.
const results = cases.map(c => ({ ...c, predicted: classify(c.query) !== 'none' }))
const routed = cases.map(c => {
  const decision = makeRoutingDecision(c.query, {}, { messages: c.currentContext ? [{ role: 'user', content: c.currentContext }] : [] })
  const triggers = semanticRoutingTriggers(c.query, decision, {}, resolveRouterConfig(), Boolean(c.currentContext))
  return { ...c, predicted: decision.shouldLookupMemory, mode: decision.mode, classifierRequested: triggers.length > 0, triggers }
})
const metrics = (rows) => {
  const tp = rows.filter(r => r.needsMemory && r.predicted).length
  const fp = rows.filter(r => !r.needsMemory && r.predicted).length
  const fn = rows.filter(r => r.needsMemory && !r.predicted).length
  const tn = rows.length - tp - fp - fn
  const precision = tp / (tp + fp || 1), recall = tp / (tp + fn || 1)
  return { count: rows.length, tp, fp, fn, tn, precision, recall, f1: 2 * precision * recall / (precision + recall || 1) }
}
for (let i = 0; i < 10; i++) for (const c of cases) classify(c.query)
const durations = []
for (let i = 0; i < 100; i++) for (const c of cases) {
  const start = performance.now(); classify(c.query); durations.push(performance.now() - start)
}
durations.sort((a, b) => a - b)
const report = {
  mode, baselineRef, layer: 'pure-rules', samples: cases.length,
  note: 'Synthetic labels; lexical intent classification only. CPU time is not first-token latency. No model, network or user database accessed.',
  all: metrics(results), tune: metrics(results.filter(r => r.split === 'tune')),
  test: metrics(results.filter(r => r.split === 'test')),
  groups: Object.fromEntries([...new Set(cases.map(c => c.group))].map(group => [group, metrics(results.filter(r => r.group === group))])),
  routing: { all: metrics(routed), tune: metrics(routed.filter(r => r.split === 'tune')), test: metrics(routed.filter(r => r.split === 'test')),
    classifierTriggerRate: routed.filter(r => r.classifierRequested).length / routed.length,
    disallowedClassifierRequests: routed.filter(r => r.classifierRequested && !r.modelAllowed).map(r => r.id),
    ruleDecisionRate: routed.filter(r => !r.classifierRequested).length / routed.length,
    note: 'Actual production route + trigger functions, with no model execution. Does not measure classifier accuracy or final routing after fallback.' },
  cpuMs: { p50: durations[Math.floor(durations.length * .5)], p95: durations[Math.floor(durations.length * .95)], measurements: durations.length },
  failures: results.filter(r => r.predicted !== r.needsMemory).map(({ id, query, split, needsMemory, predicted, reason }) => ({ id, query, split, needsMemory, predicted, reason })),
  realModel: 'NOT TESTED', retrieval: 'NOT TESTED', finalAnswer: 'NOT TESTED', firstToken: 'NOT TESTED',
}
await mkdir('docs/memory/evaluation', { recursive: true })
await writeFile(`docs/memory/evaluation/${mode}.json`, JSON.stringify(report, null, 2) + '\n', 'utf8')
await writeFile(`docs/memory/evaluation/${mode}.md`, `# Memory intent ${mode}\n\nAnonymous pure-rule evaluation. No model/network or real user data. CPU time is not first-token latency.\n\n\`\`\`json\n${JSON.stringify(report, null, 2)}\n\`\`\`\n`, 'utf8')
console.log(JSON.stringify({ mode, samples: cases.length, tune: report.tune, test: report.test, cpuMs: report.cpuMs }, null, 2))
