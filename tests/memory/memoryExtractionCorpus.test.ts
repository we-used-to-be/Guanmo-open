import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

type Message = { id: string; role: 'user' | 'assistant'; parentId: string | null; text: string; session: string; scope: string }
type Case = { id: string; split: string; schedule: string; messages: Message[] }
type Gold = { id: string; reviewStatus: string; facts: { primary: string; support: string[]; missingSupport: boolean; scope: string }[] }
const readLines = <T,>(path: string): T[] => readFileSync(path, 'utf8').trim().split('\n').map(line => JSON.parse(line) as T)
const cases = readLines<Case>('docs/memory/evaluation/extraction-v1/cases.jsonl')
const gold = readLines<{ id: string; reviewStatus: string }>('docs/memory/evaluation/extraction-v1/gold.jsonl')
const structured = readLines<Gold>('docs/memory/evaluation/extraction-v1/gold-structured.jsonl')
const revised = readLines<Gold & { protectedExisting: unknown; faultAssertion: unknown }>('docs/memory/evaluation/extraction-v1/gold-structured-v2.jsonl')
const revisedV3 = readLines<Gold>('docs/memory/evaluation/extraction-v1/gold-structured-v3.jsonl')
const initialStates = readLines<{ id: string; memories: unknown[] }>('docs/memory/evaluation/extraction-v1/initial-states.jsonl')

describe('draft extraction corpus', () => {
  it('contains the 40 scripts and five schedules with disjoint splits', () => {
    expect(cases).toHaveLength(200)
    expect(new Set(cases.map(item => item.id)).size).toBe(200)
    expect(cases.filter(item => item.split === 'development')).toHaveLength(100)
    expect(cases.filter(item => item.split === 'holdout')).toHaveLength(100)
    expect(gold.map(item => item.id)).toEqual(cases.map(item => item.id))
    expect(gold.every(item => item.reviewStatus === 'pending_independent_review')).toBe(true)
    for (let script = 1; script <= 40; script++) {
      for (let schedule = 1; schedule <= 5; schedule++) {
        const id = `EX-${String(script).padStart(2, '0')}-S${schedule}`
        expect(cases.find(item => item.id === id)?.split).toBe(script % 2 ? 'development' : 'holdout')
      }
    }
  })

  it('links assistant replies to the preceding user in the same session', () => {
    for (const item of cases) {
      for (const message of item.messages.filter(m => m.role === 'assistant')) {
        const parent = item.messages.find(m => m.id === message.parentId)
        expect(parent?.role).toBe('user')
        expect(parent?.session).toBe(message.session)
      }
      if (item.schedule === 'S4') expect(item.messages.at(-1)?.role).toBe('user')
    }
  })

  it('preserves scope transitions and long user text', () => {
    const get = (id: string) => cases.find(item => item.id === id)!.messages
    expect(get('EX-29-S1')[2].scope).toBe('Q')
    expect(get('EX-30-S1')[1]).toMatchObject({ session: 'T', scope: 'Q' })
    expect(get('EX-37-S1')[2].text).toBe('谢谢。'.repeat(3500) + '我的长期目标是研究数论。')
    expect(get('EX-38-S1')[2].text).toBe('普通填充。'.repeat(2500))
  })

  it('keeps structured source IDs within the case and marks them for review', () => {
    expect(structured).toHaveLength(200)
    for (const item of structured) {
      const entry = cases.find(candidate => candidate.id === item.id)!
      expect(item.reviewStatus).toBe('pending_independent_review')
      for (const fact of item.facts) {
        const primary = entry.messages.find(message => message.id === fact.primary)
        expect(primary?.role).toBe('user')
        expect(primary?.scope).toBe(fact.scope)
        expect(fact.missingSupport).toBe(false)
        for (const source of fact.support) expect(entry.messages.some(message => message.id === source)).toBe(true)
      }
    }
  })

  it('contains initial state descriptions only for the five specified scripts', () => {
    expect(initialStates).toHaveLength(200)
    expect(initialStates.filter(item => item.memories.length).map(item => item.id.slice(3, 5)))
      .toEqual(['17', '18', '19', '21', '22'].flatMap(script => Array(5).fill(script)))
  })

  it('retains reviewed protection and fault requirements in the revised draft', () => {
    expect(revised).toHaveLength(200)
    expect(revised.filter(item => item.protectedExisting)).toHaveLength(20)
    expect(revised.filter(item => item.faultAssertion)).toHaveLength(10)
    const fact = revised.find(item => item.id === 'EX-07-S1')!.facts[0] as Gold['facts'][number] & { optionalSupport: string[] }
    expect(fact.support).toEqual(['EX-07-S1-M1'])
    expect(fact.optionalSupport).toEqual(['EX-07-S1-M2'])
  })

  it('separates explicit proposals from persisted discovery and permits combined duplicate evidence', () => {
    const explicit = revisedV3.find(item => item.id === 'EX-25-S1')!.facts[0] as Gold['facts'][number] & { expectedStates: { proposal: string[]; discovery: string[]; beforeConfirmation: string[] } }
    expect(explicit.expectedStates.proposal).toEqual(['proposal'])
    expect(explicit.expectedStates.discovery).toEqual(['active', 'candidate'])
    expect(explicit.expectedStates.beforeConfirmation).toEqual(['none'])
    const duplicate = revisedV3.find(item => item.id === 'EX-20-S1')!.facts[0] as Gold['facts'][number] & { alternatePrimary: string[]; optionalSupport: string[] }
    expect(duplicate.alternatePrimary).toEqual(['EX-20-S1-M3'])
    expect(duplicate.optionalSupport).toEqual(['EX-20-S1-M1', 'EX-20-S1-M3'])
  })
})
