// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ db: null as DatabaseSync | null }))
vi.mock('@/services/database/db', () => ({
  isDatabaseReady: () => Boolean(state.db),
  getDatabase: () => ({
    execute: async (sql: string, values: string[]) => state.db!.prepare(sql).run(Object.fromEntries(values.map((value, index) => [`$${index + 1}`, value]))),
    select: async (sql: string, values: string[]) => state.db!.prepare(sql).all(Object.fromEntries(values.map((value, index) => [`$${index + 1}`, value]))),
  }),
}))

import { loadExtractionHistory, saveExtractionHistory } from '@/services/memory/memoryExtractionHistory'
import type { MemoryWindowClaim } from '@/services/memory/memoryWindowLedger'

afterEach(() => { state.db?.close(); state.db = null })

it('retains only two summaries without copying message content', async () => {
  state.db = new DatabaseSync(':memory:')
  state.db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER)')
  for (const id of ['one', 'two', 'three']) {
    const claim = { record: { windowId: id, receiptValues: [JSON.stringify({ sourceId: id, sessionId: 'session', sourceFingerprint: 'hash', content: 'private' })] } } as MemoryWindowClaim
    await saveExtractionHistory(claim, { modelCalled: true, proposed: 1, rejected: 0, inserted: 0, skipped: 1,
      decisions: [{ sourceId: id, outcome: 'skipped', reason: 'conflict' }] })
  }
  expect((await loadExtractionHistory()).map(item => item.id)).toEqual(['three', 'two'])
  expect((await loadExtractionHistory())[0].decisions).toEqual([{ sourceId: 'three', outcome: 'skipped', reason: 'conflict' }])
  const stored = state.db.prepare('SELECT value FROM settings').get() as { value: string }
  expect(stored.value).not.toContain('private')
})
