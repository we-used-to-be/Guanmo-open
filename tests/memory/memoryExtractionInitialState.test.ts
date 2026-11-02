// @vitest-environment node
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { expect, it, vi } from 'vitest'
import { DB_SCHEMA, splitDatabaseSchemaStatements } from '@/services/database/schema'
import { loadMemories, persistMemory, type Memory } from '@/services/database/persistence'

const adapter = vi.hoisted(() => ({ execute: vi.fn(), select: vi.fn() }))
vi.mock('@/services/database/db', () => ({ isDatabaseReady: () => true, getDatabase: () => adapter }))
type Initial = { id: string; memories: { identity: string; value: string; scope: string; status: string; source?: string; locked?: boolean }[] }
const items = readFileSync('docs/memory/evaluation/extraction-v1/initial-states.jsonl', 'utf8').trim().split('\n')
  .map(line => JSON.parse(line) as Initial).filter(item => Number(item.id.slice(3, 5)) % 2 === 1)
const bind = (params: unknown[]) => Object.fromEntries(params.map((value, index) => [`$${index + 1}`, value]))

it('maps development initial states into isolated SQLite and preserves their protections', async () => {
  for (const item of items) {
    const db = new DatabaseSync(':memory:')
    try {
      for (const sql of splitDatabaseSchemaStatements(DB_SCHEMA)) {
        if (/^CREATE TABLE IF NOT EXISTS (?:memories|settings|chat_sessions|chat_messages)\b/.test(sql)) db.exec(sql)
      }
      adapter.execute.mockImplementation(async (sql: string, params: unknown[] = []) => ({ rowsAffected: Number(db.prepare(sql).run(bind(params)).changes) }))
      adapter.select.mockImplementation(async (sql: string, params: unknown[] = []) => db.prepare(sql).all(bind(params)))
      for (const [index, initial] of item.memories.entries()) {
        const isProject = initial.scope === 'P'
        const memory: Memory = { id: `${item.id}-initial-${index}`, content: `${initial.identity}：${initial.value}`,
          category: isProject ? 'project' : 'preference', source: initial.source === 'manual' ? 'manual_created' : 'auto_extracted',
          status: initial.status as Memory['status'], locked: Boolean(initial.locked), scopeType: isProject ? 'project' : 'global',
          scopeKey: isProject ? 'd:/memory-eval/p' : null, subject: isProject ? 'project' : 'user', factKey: initial.identity,
          factValue: initial.value, createdAt: 1_700_000_000_000, updatedAt: 1_700_000_000_000 }
        expect(await persistMemory(memory)).toBe(true)
      }
      const saved = await loadMemories()
      expect(saved).toHaveLength(item.memories.length)
      for (const [index, initial] of item.memories.entries()) {
        expect(saved[index]).toMatchObject({ factKey: initial.identity, factValue: initial.value, status: initial.status, locked: Boolean(initial.locked) })
      }
    } finally { db.close() }
  }
  expect(items).toHaveLength(100)
  expect(items.filter(item => item.memories.length)).toHaveLength(15)
})
