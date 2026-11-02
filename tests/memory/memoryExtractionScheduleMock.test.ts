// @vitest-environment node
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { expect, it, vi } from 'vitest'
import { DB_SCHEMA, splitDatabaseSchemaStatements } from '@/services/database/schema'
import { MemoryExtractionQueue } from '@/services/memory/memoryExtractionQueue'
import { loadMemories, persistMemory, type Memory } from '@/services/database/persistence'

const adapter = vi.hoisted(() => ({ execute: vi.fn(), select: vi.fn() }))
vi.mock('@/services/database/db', () => ({ isDatabaseReady: () => true, getDatabase: () => adapter }))
vi.mock('@/services/idleScheduler', () => ({ idleScheduler: { enqueueOptional: vi.fn() } }))
type Message = { id: string; role: 'user' | 'assistant'; text: string; session: string; scope: string; at: string }
type Case = { id: string; split: string; schedule: string; messages: Message[] }
type Event = { at: number; kind: 'user' | 'answer' | 'drain' | 'stop'; message?: Message }
type Initial = { id: string; memories: { identity: string; value: string; scope: string; status: string; source?: string; locked?: boolean }[] }
const items = readFileSync('docs/memory/evaluation/extraction-v1/cases.jsonl', 'utf8').trim().split('\n')
  .map(line => JSON.parse(line) as Case).filter(item => item.split === 'development')
const initial = new Map(readFileSync('docs/memory/evaluation/extraction-v1/initial-states.jsonl', 'utf8').trim().split('\n')
  .map(line => JSON.parse(line) as Initial).map(item => [item.id, item.memories]))
const bind = (params: unknown[]) => Object.fromEntries(params.map((value, index) => [`$${index + 1}`, value]))

it('simulates development schedules with the real A queue and a bounded NOOP mock', async () => {
  vi.useFakeTimers()
  let requests = 0, failedRequests = 0, noRequests = 0, unfinished = 0
  try {
    for (const item of items) {
      const db = new DatabaseSync(':memory:')
      try {
        for (const sql of splitDatabaseSchemaStatements(DB_SCHEMA)) {
          if (/^CREATE TABLE IF NOT EXISTS (?:memories|settings|chat_sessions|chat_messages)\b/.test(sql)) db.exec(sql)
        }
        adapter.execute.mockImplementation(async (sql: string, params: unknown[] = []) => ({ rowsAffected: Number(db.prepare(sql).run(bind(params)).changes) }))
        adapter.select.mockImplementation(async (sql: string, params: unknown[] = []) => db.prepare(sql).all(bind(params)))
        for (const [index, seed] of (initial.get(item.id) || []).entries()) {
          const project = seed.scope === 'P'
          const memory: Memory = { id: `${item.id}-initial-${index}`, content: `${seed.identity}：${seed.value}`,
            category: project ? 'project' : 'preference', source: seed.source === 'manual' ? 'manual_created' : 'auto_extracted',
            status: seed.status as Memory['status'], locked: Boolean(seed.locked), scopeType: project ? 'project' : 'global',
            scopeKey: project ? 'd:/memory-eval/p' : null, subject: project ? 'project' : 'user', factKey: seed.identity,
            factValue: seed.value, createdAt: 1_700_000_000_000, updatedAt: 1_700_000_000_000 }
          expect(await persistMemory(memory)).toBe(true)
        }
        const before = await loadMemories()
        const queue = new MemoryExtractionQueue()
        let calls = 0
        const client = { chat: vi.fn(async () => {
          calls++
          if (item.schedule === 'S5' && calls === 1) { failedRequests++; throw new Error('simulated 503') }
          return { content: '[]' }
        }) }
        const users = item.messages.filter(message => message.role === 'user')
        const events: Event[] = users.flatMap((message, index) => {
          const at = Date.parse(message.at)
          return item.schedule === 'S4' && index === users.length - 1
            ? [{ at, kind: 'user' as const, message }, { at, kind: 'stop' as const }]
            : [{ at, kind: 'user' as const, message }, { at: at + 1000, kind: 'answer' as const, message }]
        })
        const observationEnd = Date.parse(users.at(-1)!.at) + (item.schedule === 'S4' ? 180_000 : 120_000)
        let steps = 0
        while (events.length) {
          if (++steps > 500) throw new Error(`Unbounded simulated events: ${item.id}`)
          events.sort((left, right) => left.at - right.at)
          const event = events.shift()!
          if (event.at > observationEnd) break
          vi.setSystemTime(event.at)
          if (event.kind === 'stop') { events.length = 0; break }
          if (event.kind === 'user') {
            const source = event.message!
            db.prepare('INSERT OR IGNORE INTO chat_sessions (id, title) VALUES (?, ?)').run(source.session, '匿名')
            db.prepare('INSERT INTO chat_messages (id, session_id, role, content) VALUES (?, ?, ?, ?)').run(source.id, source.session, source.role, source.text)
          } else if (event.kind === 'answer') {
            const source = event.message!
            const workspace = source.scope === 'global' ? null : `D:/memory-eval/${source.scope}`
            await queue.enqueue({ id: source.id, role: 'user', content: source.text }, source.session, workspace)
            events.push({ at: event.at + 500, kind: 'drain' })
          } else {
            const delay = await queue.drain(client)
            if (delay !== undefined) events.push({ at: event.at + delay, kind: 'drain' })
          }
        }
        requests += calls
        if (!calls) noRequests++
        const row = db.prepare("SELECT COUNT(*) AS n FROM settings WHERE json_extract(value, '$.status') IN ('pending','running')").get() as { n: number }
        unfinished += row.n
        expect(await loadMemories()).toEqual(before)
      } finally { db.close() }
    }
    expect(items).toHaveLength(100)
    expect(failedRequests).toBeGreaterThan(0)
    process.stdout.write(`A virtual NOOP: ${items.length} development cases; requests=${requests}, simulated503=${failedRequests}, noRequests=${noRequests}, pending=${unfinished}\n`)
  } finally { vi.useRealTimers() }
})
