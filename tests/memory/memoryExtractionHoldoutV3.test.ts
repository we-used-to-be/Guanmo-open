import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'

type Msg = { id: string; role: string; session: string; scope: string; parentId: string | null }
type Case = { id: string; schedule: string; messages: Msg[] }
type Fact = { primary: string; support: string[]; scope: string; alternatePrimary?: string[] }
type Gold = { id: string; facts: Fact[]; reviewStatus: string; faultAssertion: unknown }
const read = <T,>(path: string): T[] => readFileSync(path, 'utf8').trim().split('\n').map(line => JSON.parse(line) as T)
const cases = read<Case>('docs/memory/evaluation/extraction-v3-holdout/cases.jsonl')
const gold = read<Gold>('docs/memory/evaluation/extraction-v3-holdout/gold.jsonl')

describe('unreviewed replacement holdout', () => {
  it('matches the published draft hashes', () => {
    const hash = (path: string) => createHash('sha256').update(readFileSync(path, 'utf8').replace(/\r\n/g, '\n')).digest('hex')
    expect(hash('docs/memory/evaluation/extraction-v3-holdout/cases.jsonl')).toBe('10bc36ef5409928cab03bc5d6df210e4eb4096708e73461371a339cf9082d364')
    expect(hash('docs/memory/evaluation/extraction-v3-holdout/gold.jsonl')).toBe('b1401ef158f8d8c5ba887a3d55e39ce9bce9f7e315ada8e0a8cae639fba52ff5')
  })
  it('contains twenty scripts with all five schedules and paired labels', () => {
    expect(cases).toHaveLength(100)
    expect(new Set(cases.map(item => item.id)).size).toBe(100)
    expect(gold.map(item => item.id)).toEqual(cases.map(item => item.id))
    expect(gold.every(item => item.reviewStatus === 'pending_independent_review')).toBe(true)
    for (let script = 1; script <= 20; script++) for (let schedule = 1; schedule <= 5; schedule++) {
      expect(cases.some(item => item.id === `H3-${String(script).padStart(2, '0')}-S${schedule}`)).toBe(true)
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
