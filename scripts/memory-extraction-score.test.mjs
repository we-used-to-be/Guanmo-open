import { test } from 'node:test'
import assert from 'node:assert/strict'
import { allowedBeforeConfirmation, allowedState, correctRecordsWithinLimit, protectedUnchanged, scoreActive, scoreActiveSummary, scoreCase, scoreDiscovery, scoreDiscoverySummary } from './memory-extraction-score.mjs'

const gold = [{ identity: '数据库', value: 'SQLite', scope: 'P', primary: 'u3', support: ['u1', 'a2'] }]
const valid = { identity: '数据库', value: 'sqlite', scope: 'P', primary: 'u3', support: ['a2', 'u1'] }

test('matches a fact and all required sources exactly once', () => {
  assert.deepEqual(scoreCase(gold, [valid, valid]), { tp: 1, fp: 1, fn: 0, precision: .5, recall: 1,
    contentMatched: 2, sourceCorrect: 2, sourceAccuracy: 1, attributionAccuracy: 1 })
})
test('counts incorrect scope, missing context and unsupported sources as errors', () => {
  assert.deepEqual(scoreCase(gold, [{ ...valid, support: ['u1'] }, { ...valid, scope: 'Q' }]),
    { tp: 0, fp: 2, fn: 1, precision: 0, recall: 0, contentMatched: 1, sourceCorrect: 0, sourceAccuracy: 0, attributionAccuracy: 0 })
})
test('reports undefined denominators as null', () => {
  assert.deepEqual(scoreCase([], []), { tp: 0, fp: 0, fn: 0, precision: null, recall: null,
    contentMatched: 0, sourceCorrect: 0, sourceAccuracy: null, attributionAccuracy: null })
})
test('accepts optional context while requiring all necessary support', () => {
  const context = [{ ...gold[0], support: ['u1'], optionalSupport: ['a2'] }]
  assert.equal(scoreCase(context, [{ ...valid, support: ['u1'] }]).tp, 1)
  assert.equal(scoreCase(context, [valid]).tp, 1)
  assert.equal(scoreCase(context, [{ ...valid, support: ['u1', 'other'] }]).fp, 1)
  assert.equal(scoreCase(context, [{ ...valid, support: ['a2'] }]).fn, 1)
})
test('distinguishes discovery from final active recall and confirmation', () => {
  const fact = { ...gold[0], activeRecallDenominator: true, expectedStates: { beforeConfirmation: ['candidate'], afterScriptedConfirmation: ['candidate'] } }
  assert.equal(scoreCase([fact], [{ ...valid, status: 'candidate' }]).recall, 1)
  assert.equal(scoreActive([fact], [{ ...valid, status: 'candidate' }]).recall, 0)
  assert.equal(allowedState(fact, 'candidate', 'beforeConfirmation'), true)
  assert.equal(allowedState(fact, 'active', 'beforeConfirmation'), false)
  const explicit = { expectedStates: { proposal: ['proposal'], discovery: ['active', 'candidate'], beforeConfirmation: ['none'], afterScriptedConfirmation: ['active'] } }
  assert.equal(allowedState(explicit, 'proposal', 'proposal'), true)
  assert.equal(allowedState(explicit, 'proposal', 'discovery'), false)
  assert.equal(scoreDiscovery(gold, [{ ...valid, status: 'proposal' }]).recall, 0)
  assert.equal(scoreDiscovery(gold, [{ ...valid, status: 'active' }]).recall, 1)
  assert.equal(allowedState(explicit, 'active', 'afterScriptedConfirmation'), true)
})
test('allows either repeated assertion as primary and the other as optional support', () => {
  const repeated = [{ ...gold[0], primary: 'u1', alternatePrimary: ['u3'], support: [], optionalSupport: ['u1', 'u3'] }]
  for (const [primary, other] of [['u1', 'u3'], ['u3', 'u1']]) {
    assert.equal(scoreCase(repeated, [{ ...valid, primary, support: [] }]).tp, 1)
    assert.equal(scoreCase(repeated, [{ ...valid, primary, support: [other] }]).tp, 1)
    assert.equal(scoreCase(repeated, [{ ...valid, primary, support: [primary] }]).tp, 0)
  }
})
test('detects missing, modified, or unlocked protected records', () => {
  const original = { id: 'old', content: '中文', status: 'active', source: 'manual', locked: true }
  assert.equal(protectedUnchanged(original, { ...original }), true)
  assert.equal(protectedUnchanged(original, undefined), false)
  assert.equal(protectedUnchanged(original, { ...original, locked: false }), false)
  assert.equal(protectedUnchanged(original, { ...original, content: '英文' }), false)
})
test('uses source-specific states for direct assertions and later references', () => {
  const fact = { ...gold[0], primary: 'u1', support: [], sourceVariants: [
    { primary: 'u1', support: [], optionalSupport: ['u3'], states: ['active', 'candidate'] },
    { primary: 'u3', support: ['u1'], optionalSupport: [], states: ['candidate'] },
  ] }
  assert.equal(scoreDiscovery([fact], [{ ...valid, primary: 'u1', support: [], status: 'active' }]).tp, 1)
  assert.equal(scoreDiscovery([fact], [{ ...valid, primary: 'u3', support: ['u1'], status: 'candidate' }]).tp, 1)
  const wrongState = scoreDiscovery([fact], [{ ...valid, primary: 'u3', support: ['u1'], status: 'active' }])
  assert.equal(wrongState.tp, 0)
  assert.equal(wrongState.sourceAccuracy, 1)
})
test('allows only an earlier supported record before explicit confirmation and rejects duplicates', () => {
  const fact = { ...gold[0], primary: 'u3', support: ['u1'], preexistingFrom: 'u1', allowCorrectPreexisting: true,
    maxCorrectRecords: 1, expectedStates: { beforeConfirmation: ['none', 'candidate', 'active'] }, sourceVariants: [
      { primary: 'u1', support: [], optionalSupport: ['u3'], states: ['active', 'candidate'] },
      { primary: 'u3', support: ['u1'], optionalSupport: [], states: ['active', 'candidate'] },
    ] }
  const earlier = { ...valid, primary: 'u1', support: [], status: 'active' }
  const late = { ...valid, primary: 'u3', support: ['u1'], status: 'active' }
  assert.equal(allowedBeforeConfirmation(fact, undefined), true)
  assert.equal(allowedBeforeConfirmation(fact, earlier), true)
  assert.equal(allowedBeforeConfirmation(fact, late), false)
  assert.equal(correctRecordsWithinLimit(fact, [earlier]), true)
  assert.equal(correctRecordsWithinLimit(fact, [earlier, late]), false)
})
test('aggregates by script, excludes undefined denominators, and keeps proposals out', () => {
  const summary = scoreDiscoverySummary([
    { script: 'one', gold, outputs: [{ ...valid, status: 'active' }] },
    { script: 'one', gold, outputs: [{ ...valid, status: 'proposal' }] },
    { script: 'two', gold: [], outputs: [{ ...valid, status: 'candidate' }] },
  ])
  assert.deepEqual(summary, { tp: 1, fp: 1, fn: 1, microPrecision: .5, microRecall: .5,
    scriptMacroPrecision: .5, scriptMacroRecall: .5, scripts: 2 })
})
test('keeps unconfirmed candidates in the final active recall denominator', () => {
  const summary = scoreActiveSummary([
    { script: 'one', gold, outputs: [{ ...valid, status: 'active' }] },
    { script: 'one', gold, outputs: [{ ...valid, status: 'candidate' }] },
  ])
  assert.equal(summary.microRecall, .5)
  assert.equal(summary.scriptMacroRecall, .5)
})
