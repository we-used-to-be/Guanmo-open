import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'

type Msg = { id: string; role: string; session: string; scope: string; parentId: string | null }
type Case = { id: string; schedule: string; messages: Msg[] }
type Fact = { primary: string; support: string[]; scope: string; alternatePrimary?: string[] }
type Gold = { id: string; facts: Fact[]; reviewStatus: string; faultAssertion: { source: string; mutation: string } | null }
const read = <T,>(path: string): T[] => readFileSync(path, 'utf8').trim().split('\n').map(line => JSON.parse(line) as T)
const cases = read<Case>('docs/memory/evaluation/extraction-v4-holdout/cases.jsonl')
const gold = read<Gold>('docs/memory/evaluation/extraction-v4-holdout/gold.jsonl')

describe('unreviewed replacement holdout', () => {
  it('matches the published draft hashes', () => {
    const hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex')
    expect(hash('docs/memory/evaluation/extraction-v4-holdout/cases.jsonl')).toBe('898d4008b9850a0423ff46621bd5dcf7f6a45fcc42b4b323936ae209e7d3afbe')
    expect(hash('docs/memory/evaluation/extraction-v4-holdout/gold.jsonl')).toBe('e7876ea931bc89c091478bda6d72e4bb3bb591ddd4296e4993ba6a856fb550a6')
  })
  it('contains twenty scripts with all five schedules and paired labels', () => {
    expect(cases).toHaveLength(100)
    expect(new Set(cases.map(item => item.id)).size).toBe(100)
    expect(gold.map(item => item.id)).toEqual(cases.map(item => item.id))
    expect(gold.every(item => item.reviewStatus === 'pending_independent_review')).toBe(true)
    for (let script = 1; script <= 20; script++) for (let schedule = 1; schedule <= 5; schedule++) {
      expect(cases.some(item => item.id === `H4-${String(script).padStart(2, '0')}-S${schedule}`)).toBe(true)
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
  it('targets the second user and an assistant support message for the two fault scenarios', () => {
    const deletion = gold.find(item => item.id === 'H4-19-S1')!
    expect(deletion.faultAssertion).toMatchObject({ source: 'H4-19-S1-M3', mutation: 'delete' })
    expect(deletion.facts[0].primary).toBe('H4-19-S1-M1')
    const supportChange = gold.find(item => item.id === 'H4-20-S1')!
    expect(supportChange.faultAssertion).toMatchObject({ source: 'H4-20-S1-M2', mutation: 'metadata_only' })
    expect(cases.find(item => item.id === supportChange.id)!.messages.find(message => message.id === supportChange.faultAssertion!.source)?.role).toBe('assistant')
  })
})
