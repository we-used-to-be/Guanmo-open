import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'

type Msg = { id: string; role: string; session: string; scope: string; parentId: string | null }
type Case = { id: string; schedule: string; messages: Msg[] }
type Fact = { primary: string; support: string[]; scope: string; alternatePrimary?: string[] }
type Gold = { id: string; facts: Fact[]; reviewStatus: string; faultAssertion: unknown }
const read = <T,>(path: string): T[] => readFileSync(path, 'utf8').trim().split('\n').map(line => JSON.parse(line) as T)
const cases = read<Case>('docs/memory/evaluation/extraction-v2-holdout/cases.jsonl')
const gold = read<Gold>('docs/memory/evaluation/extraction-v2-holdout/gold.jsonl')

describe('unreviewed replacement holdout', () => {
  it('matches the published draft hashes', () => {
    const hash = (path: string) => createHash('sha256').update(readFileSync(path, 'utf8').replace(/\r\n/g, '\n')).digest('hex')
    expect(hash('docs/memory/evaluation/extraction-v2-holdout/cases.jsonl')).toBe('efa5ca87d7079bf253bc7c8037b75e46320ebad1c1ef9af275189a87a8fae81b')
    expect(hash('docs/memory/evaluation/extraction-v2-holdout/gold.jsonl')).toBe('4bbd449878877c98285fd7965e2748e235f55f940be5bc4ea1f28e081919bdc4')
  })
  it('contains twenty scripts with all five schedules and paired labels', () => {
    expect(cases).toHaveLength(100)
    expect(new Set(cases.map(item => item.id)).size).toBe(100)
    expect(gold.map(item => item.id)).toEqual(cases.map(item => item.id))
    expect(gold.every(item => item.reviewStatus === 'pending_independent_review')).toBe(true)
    for (let script = 1; script <= 20; script++) for (let schedule = 1; schedule <= 5; schedule++) {
      expect(cases.some(item => item.id === `H2-${String(script).padStart(2, '0')}-S${schedule}`)).toBe(true)
    }
    expect(gold.filter(item => item.faultAssertion)).toHaveLength(10)
  })
  it('uses real user primary sources and same-session assistant parents', () => {
    for (const item of gold) {
      const entry = cases.find(candidate => candidate.id === item.id)!
      for (const fact of item.facts) {
        expect(entry.messages.find(message => message.id === fact.primary)).toMatchObject({ role: 'user', scope: fact.scope })
        for (const source of [...fact.support, ...(fact.alternatePrimary || [])]) expect(entry.messages.some(message => message.id === source)).toBe(true)
      }
      for (const reply of entry.messages.filter(message => message.role === 'assistant')) {
        expect(entry.messages.find(message => message.id === reply.parentId)).toMatchObject({ role: 'user', session: reply.session })
      }
      if (entry.schedule === 'S4') expect(entry.messages.at(-1)?.role).toBe('user')
    }
  })
})
