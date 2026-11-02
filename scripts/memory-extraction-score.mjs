// Inputs must already be canonically adjudicated; this is not a semantic judge.
const equalText = (a, b) => String(a ?? '').trim().replace(/\s+/g, ' ').toLowerCase() === String(b ?? '').trim().replace(/\s+/g, ' ').toLowerCase()
const sameFact = (output, gold) => equalText(output.identity, gold.identity)
  && equalText(output.value, gold.value) && output.scope === gold.scope
const sameSource = (output, gold, checkState = true) => {
  const variants = gold.sourceVariants || [gold]
  return variants.some(variant => {
    const primaryValid = [variant.primary, ...(variant.alternatePrimary || [])].includes(output.primary)
    const actual = [...new Set(output.support || [])].sort()
    const required = [...new Set(variant.support || [])].sort()
    const allowed = new Set([...required, ...(variant.optionalSupport || [])])
    return primaryValid && (!checkState || !variant.states || variant.states.includes(output.status)) && !actual.includes(output.primary)
      && required.every(value => actual.includes(value)) && actual.every(value => allowed.has(value))
  })
}
const ratio = (a, b) => b ? a / b : null

export function scoreCase(gold, outputs) {
  const used = new Set()
  let tp = 0, fp = 0, sourceCorrect = 0, contentMatched = 0
  for (const output of outputs) {
    const contentMatches = gold.map((fact, index) => ({ fact, index })).filter(({ fact }) => sameFact(output, fact))
    if (contentMatches.length) contentMatched++
    if (contentMatches.some(({ fact }) => sameSource(output, fact, false))) sourceCorrect++
    const match = contentMatches.find(({ fact, index }) => !used.has(index) && sameSource(output, fact))
    if (!match) { fp++; continue }
    used.add(match.index)
    tp++
  }
  const fn = gold.length - tp
  return { tp, fp, fn, precision: ratio(tp, tp + fp), recall: ratio(tp, tp + fn),
    contentMatched, sourceCorrect, sourceAccuracy: ratio(sourceCorrect, contentMatched),
    attributionAccuracy: ratio(sourceCorrect, outputs.length) }
}

// Active recall uses every expected fact as denominator, including those that
// safely remain candidates; proposals never count as persisted discoveries.
export function scoreActive(gold, outputs) {
  return scoreCase(gold.filter(fact => fact.activeRecallDenominator !== false), outputs.filter(item => item.status === 'active'))
}

export function scoreDiscovery(gold, outputs) {
  return scoreCase(gold, outputs.filter(item => item.status === 'active' || item.status === 'candidate'))
}

function summarizeByScript(cases, score) {
  const groups = new Map()
  for (const item of cases) {
    const result = score(item.gold, item.outputs)
    const current = groups.get(item.script) || { tp: 0, fp: 0, fn: 0 }
    for (const key of ['tp', 'fp', 'fn']) current[key] += result[key]
    groups.set(item.script, current)
  }
  const totals = [...groups.values()].reduce((sum, group) => ({ tp: sum.tp + group.tp, fp: sum.fp + group.fp, fn: sum.fn + group.fn }), { tp: 0, fp: 0, fn: 0 })
  const mean = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null
  const precision = [...groups.values()].map(group => ratio(group.tp, group.tp + group.fp)).filter(value => value !== null)
  const recall = [...groups.values()].map(group => ratio(group.tp, group.tp + group.fn)).filter(value => value !== null)
  return { ...totals, microPrecision: ratio(totals.tp, totals.tp + totals.fp), microRecall: ratio(totals.tp, totals.tp + totals.fn),
    scriptMacroPrecision: mean(precision), scriptMacroRecall: mean(recall), scripts: groups.size }
}

export const scoreDiscoverySummary = cases => summarizeByScript(cases, scoreDiscovery)
export const scoreActiveSummary = cases => summarizeByScript(cases, scoreActive)

export function allowedState(fact, status, phase) {
  return Array.isArray(fact.expectedStates?.[phase]) && fact.expectedStates[phase].includes(status)
}

export function allowedBeforeConfirmation(fact, output) {
  if (!output) return allowedState(fact, 'none', 'beforeConfirmation')
  return Boolean(fact.allowCorrectPreexisting && output.primary === fact.preexistingFrom
    && sameFact(output, fact) && sameSource(output, fact) && allowedState(fact, output.status, 'beforeConfirmation'))
}

export function correctRecordsWithinLimit(fact, outputs) {
  return outputs.filter(output => sameFact(output, fact) && sameSource(output, fact)).length <= (fact.maxCorrectRecords ?? 1)
}

export function protectedUnchanged(before, after) {
  const canonical = value => Array.isArray(value) ? value.map(canonical)
    : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]))
      : value
  return Boolean(before && after && JSON.stringify(canonical(before)) === JSON.stringify(canonical(after)))
}
