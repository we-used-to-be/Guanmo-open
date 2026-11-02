import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'

type Msg = { id: string; role: string; session: string; scope: string; parentId: string | null }
type Case = { id: string; schedule: string; messages: Msg[] }
type Fact = { primary: string; support: string[]; scope: string; alternatePrimary?: string[]; sourceVariants?: { primary: string; support: string[]; optionalSupport: string[] }[] }
type Gold = { id: string; facts: Fact[]; reviewStatus: string; faultAssertion: { source: string; mutation: string; requiredRequestSource: string; requiredWritableSource: string } | null }
const read = <T,>(path: string): T[] => readFileSync(path, 'utf8').trim().split('\n').map(line => JSON.parse(line) as T)
const cases = read<Case>('docs/memory/evaluation/extraction-v6-holdout/cases.jsonl')
const gold = read<Gold>('docs/memory/evaluation/extraction-v6-holdout/gold.jsonl')

describe('unreviewed replacement holdout', () => {
  it('matches the published draft hashes', () => {
    const hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex')
    expect(hash('docs/memory/evaluation/extraction-v6-holdout/cases.jsonl')).toBe('bd1e8a958c86df4bdfc05c655f2ab47f54e04b92693e7da90a736985568de22b')
    expect(hash('docs/memory/evaluation/extraction-v6-holdout/gold.jsonl')).toBe('195f5dac9ebcf7e145b43f9eb3b99e5bd03476f0838dd12e156bf716f2d94d4d')
  })
  it('contains twenty scripts with all five schedules and paired labels', () => {
    expect(cases).toHaveLength(100)
    expect(new Set(cases.map(item => item.id)).size).toBe(100)
    expect(gold.map(item => item.id)).toEqual(cases.map(item => item.id))
    expect(gold.every(item => item.reviewStatus === 'self_reviewed_not_independent')).toBe(true)
    for (let script = 1; script <= 20; script++) for (let schedule = 1; schedule <= 5; schedule++) {
      expect(cases.some(item => item.id === `H6-${String(script).padStart(2, '0')}-S${schedule}`)).toBe(true)
    }
    expect(gold.filter(item => item.faultAssertion)).toHaveLength(10)
  })
  it('uses real user primary sources and same-session assistant parents', () => {
    for (const item of gold) {
      const entry = cases.find(candidate => candidate.id === item.id)!
      for (const fact of item.facts) {
        expect(entry.messages.find(message => message.id === fact.primary)).toMatchObject({ role: 'user', scope: fact.scope })
        for (const source of [...fact.support, ...(fact.alternatePrimary || [])]) expect(entry.messages.some(message => message.id === source)).toBe(true)
        for (const variant of fact.sourceVariants || []) {
          expect(entry.messages.find(message => message.id === variant.primary)).toMatchObject({ role: 'user', scope: fact.scope })
          for (const source of [...variant.support, ...variant.optionalSupport]) expect(entry.messages.some(message => message.id === source)).toBe(true)
        }
      }
      for (const reply of entry.messages.filter(message => message.role === 'assistant')) {
        expect(entry.messages.find(message => message.id === reply.parentId)).toMatchObject({ role: 'user', session: reply.session })
      }
      if (entry.schedule === 'S4') expect(entry.messages.at(-1)?.role).toBe('user')
    }
  })
  it('targets the second user and an assistant support message for the two fault scenarios', () => {
    const deletion = gold.find(item => item.id === 'H6-19-S1')!
    expect(deletion.faultAssertion).toMatchObject({ source: 'H6-19-S1-M3', requiredRequestSource: 'H6-19-S1-M3', requiredWritableSource: 'H6-19-S1-M3', mutation: 'delete' })
    expect(deletion.facts[0].primary).toBe('H6-19-S1-M1')
    const supportChange = gold.find(item => item.id === 'H6-20-S1')!
    expect(supportChange.faultAssertion).toMatchObject({ source: 'H6-20-S1-M2', requiredRequestSource: 'H6-20-S1-M2', requiredWritableSource: 'H6-20-S1-M2', mutation: 'metadata_only' })
    expect(cases.find(item => item.id === supportChange.id)!.messages.find(message => message.id === supportChange.faultAssertion!.source)?.role).toBe('assistant')
  })
  it('records alternate sources and the prior explicit-save record boundary', () => {
    type Variant = { primary: string; support: string[]; states: string[] }
    type RevisedFact = Fact & { sourceVariants: Variant[]; preexistingFrom?: string; maxCorrectRecords?: number; expectedStates: { beforeConfirmation: string[] } }
    const direct = gold.find(item => item.id === 'H6-02-S1')!.facts[0] as RevisedFact
    expect(direct.sourceVariants).toEqual([
      expect.objectContaining({ primary: 'H6-02-S1-M1', support: [], states: ['active', 'candidate'] }),
      expect.objectContaining({ primary: 'H6-02-S1-M3', support: ['H6-02-S1-M1'], states: ['candidate'] }),
    ])
    const explicit = gold.find(item => item.id === 'H6-10-S1')!.facts[0] as RevisedFact
    expect(explicit.preexistingFrom).toBe('H6-10-S1-M1')
    expect(explicit.maxCorrectRecords).toBe(1)
    expect(explicit.expectedStates.beforeConfirmation).toEqual(['none', 'candidate', 'active'])
  })
  it('does not require context already restated in a complete user decision', () => {
    const get = (id: string) => gold.find(item => item.id === id)!.facts[0] as Fact & { optionalSupport: string[] }
    expect(get('H6-03-S1').support).toEqual([])
    expect(get('H6-03-S1').optionalSupport).toEqual(['H6-03-S1-M1', 'H6-03-S1-M2'])
    expect(get('H6-17-S1').support).toEqual([])
  })
})
