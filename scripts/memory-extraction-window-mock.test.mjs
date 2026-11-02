import { test } from 'node:test'
import assert from 'node:assert/strict'
import { simulateWindows } from './memory-extraction-window-mock.mjs'

const turn = (id, at, scope = 'P', session = 'S', kind = 'visible') => ({ id, at, scope, session, kind })
test('B leaves a partial batch while C flushes after simulated idle', () => {
  const turns = [turn('a', 0), turn('b', 1000), turn('c', 2000)]
  assert.equal(simulateWindows(turns, 'B', 120_000).batches.length, 0)
  const result = simulateWindows(turns, 'C', 120_000)
  assert.deepEqual(result.batches[0].newIds, ['a', 'b', 'c'])
  assert.equal(result.batches[0].at, 62_000)
})
test('uses four new turns and at most two prior context IDs', () => {
  const turns = Array.from({ length: 8 }, (_, index) => turn(String(index), index * 1000))
  const result = simulateWindows(turns, 'B', 120_000)
  assert.deepEqual(result.batches.map(item => item.newIds), [['0', '1', '2', '3'], ['4', '5', '6', '7']])
  assert.deepEqual(result.batches[1].prefixIds, ['2', '3'])
})
test('separates session, scope and returning scope epochs', () => {
  const turns = [turn('p1', 0), turn('q', 1000, 'Q'), turn('p2', 2000), turn('other', 3000, 'P', 'T')]
  const result = simulateWindows(turns, 'C', 120_000)
  assert.deepEqual(result.batches.map(item => item.newIds), [['p1'], ['q'], ['p2'], ['other']])
  assert.deepEqual(result.batches.map(item => item.epoch), [0, 1, 2, 0])
})
test('does not expose gap or explicit IDs as automatic model inputs', () => {
  const turns = [turn('safe', 0), turn('private', 1, 'P', 'S', 'gap'), turn('explicit', 2, 'P', 'S', 'explicit'), turn('safe2', 3)]
  const result = simulateWindows(turns, 'B', 1000)
  assert.deepEqual(result.batches[0].newIds, ['safe', 'safe2'])
  assert.deepEqual(result.batches[0].gapIds, ['private', 'explicit'])
  assert.equal(simulateWindows(turns.slice(1, 3), 'C', 120_000).batches.length, 0)
})
