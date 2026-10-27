import type { SemanticRouteStatus, SemanticTrigger } from './semanticRouter'

interface RoutingMetric {
  source: 'rules' | 'semantic'
  mode: 'direct' | 'agent'
  durationMs: number
  trigger?: readonly SemanticTrigger[]
  status?: SemanticRouteStatus
  candidateCount: number
}

/** In-memory, opt-in and bounded. No text, paths, model responses or credentials. */
const records: RoutingMetric[] = []
export function recordRoutingMetric(metric: RoutingMetric) {
  records.push({ ...metric, trigger: metric.trigger ? [...metric.trigger] : undefined })
  if (records.length > 200) records.shift()
}
export function getRoutingMetrics() {
  return records.map(record => ({ ...record, trigger: record.trigger ? [...record.trigger] : undefined }))
}
export function getRoutingSummary() {
  const triggered = records.filter(record => record.trigger?.length).length
  return { samples: records.length, triggered, triggerRate: records.length ? triggered / records.length : 0,
    fallbackCount: records.filter(record => record.status && !['selected', 'no_tool'].includes(record.status)).length }
}
export function summarizeRoutingEvaluation(expected: readonly string[], selected: readonly string[]) {
  return { falsePositives: selected.filter(name => !expected.includes(name)).length,
    falseNegatives: expected.filter(name => !selected.includes(name)).length }
}
