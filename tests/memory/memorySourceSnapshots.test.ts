// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DB_SCHEMA, splitDatabaseSchemaStatements } from '@/services/database/schema'
import { persistMemory, removeMemoryIfUnchanged, updateMemoryIfUnchanged } from '@/services/database/persistence'
import type { Memory, MemorySourceGuard } from '@/services/database/persistence'
import { MemoryExtractionQueue } from '@/services/memory/memoryExtractionQueue'

const adapter = vi.hoisted(() => ({ execute: vi.fn(), select: vi.fn() }))
vi.mock('@/services/database/db', () => ({ isDatabaseReady: () => true, getDatabase: () => adapter }))
vi.mock('@/services/idleScheduler', () => ({ idleScheduler: { enqueueOptional: vi.fn() } }))

let db: DatabaseSync
const guard = (): MemorySourceGuard => ({ id: 'u2', content: '选第二个', snapshots: [
  { id: 'u1', sessionId: 's', role: 'user', parentId: null, content: 'SQLite 或 PostgreSQL', metadata: null, createdAt: 1700000000 },
  { id: 'a1', sessionId: 's', role: 'assistant', parentId: 'u1', content: '第二个是 PostgreSQL', metadata: '{"visible":true}', createdAt: 1700000001 },
  { id: 'u2', sessionId: 's', role: 'user', parentId: null, content: '选第二个', metadata: null, createdAt: 1700000002 },
] })
const record = (): Memory => ({ id: 'm1', content: '项目选择 PostgreSQL', category: 'project', source: 'auto_extracted',
  locked: false, status: 'candidate', scopeType: 'project', scopeKey: 'P', createdAt: 1_700_000_000_000, updatedAt: 1_700_000_000_000 })

beforeEach(() => {
  db = new DatabaseSync(':memory:')
  for (const sql of splitDatabaseSchemaStatements(DB_SCHEMA)) {
    if (/^CREATE TABLE IF NOT EXISTS (?:memories|settings|chat_sessions|chat_messages)\b/.test(sql)) db.exec(sql)
  }
  db.prepare('INSERT INTO chat_sessions (id, title) VALUES (?, ?)').run('s', 'anonymous')
  for (const row of guard().snapshots!) db.prepare(
    'INSERT INTO chat_messages (id, session_id, role, parent_id, content, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(row.id, row.sessionId, row.role, row.parentId, row.content, row.metadata, row.createdAt)
  adapter.execute.mockImplementation(async (sql: string, params: unknown[] = []) => ({
    rowsAffected: Number(db.prepare(sql).run(Object.fromEntries(params.map((value, index) => [`$${index + 1}`, value]))).changes),
  }))
  adapter.select.mockImplementation(async (sql: string, params: unknown[] = []) =>
    db.prepare(sql).all(Object.fromEntries(params.map((value, index) => [`$${index + 1}`, value]))))
})
afterEach(() => { db.close(); vi.clearAllMocks() })

describe('atomic multi-source memory guard', () => {
  it('accepts intact sources and rejects later metadata, parent, content, and deletion changes', async () => {
    const snapshot = guard()
    expect(await persistMemory(record(), true, snapshot)).toBe(true)
    const next = { ...record(), id: 'm2' }
    for (const [sql, args] of [
      ['UPDATE chat_messages SET metadata = ? WHERE id = ?', ['{}', 'a1']],
      ['UPDATE chat_messages SET parent_id = ? WHERE id = ?', ['u2', 'a1']],
      ['UPDATE chat_messages SET content = ? WHERE id = ?', ['changed', 'u1']],
      ['UPDATE chat_messages SET created_at = ? WHERE id = ?', ['1700000123', 'u1']],
      ['DELETE FROM chat_messages WHERE id = ?', ['u1']],
    ] as Array<[string, string[]]>) {
      db.exec('SAVEPOINT test_change')
      db.prepare(sql).run(...args)
      expect(await persistMemory(next, true, snapshot)).toBe(false)
      db.exec('ROLLBACK TO test_change')
      db.exec('RELEASE test_change')
    }
    expect(db.prepare('SELECT COUNT(*) AS n FROM memories').get()?.n).toBe(1)
  })

  it('rejects stale evidence for update and delete while preserving the existing record', async () => {
    const original = record(), snapshot = guard()
    expect(await persistMemory(original, true, snapshot)).toBe(true)
    db.prepare('UPDATE chat_messages SET metadata = ? WHERE id = ?').run('{}', 'a1')
    expect(await updateMemoryIfUnchanged({ ...original, content: 'changed', updatedAt: original.updatedAt + 1 }, original, snapshot)).toBe(false)
    expect(await removeMemoryIfUnchanged(original, snapshot)).toBe(false)
    expect(db.prepare('SELECT content FROM memories WHERE id = ?').get('m1')?.content).toBe(original.content)
  })

  it('allows update and delete when every source and target snapshot is unchanged', async () => {
    const original = record(), snapshot = guard()
    expect(await persistMemory(original, true, snapshot)).toBe(true)
    const updated = { ...original, content: '项目选择 PostgreSQL 数据库', updatedAt: original.updatedAt + 1000 }
    expect(await updateMemoryIfUnchanged(updated, original, snapshot)).toBe(true)
    expect(await removeMemoryIfUnchanged(updated, snapshot)).toBe(true)
    expect(db.prepare('SELECT COUNT(*) AS n FROM memories').get()?.n).toBe(0)
  })

  it('rejects invalid source sets and preserves legacy single-source behavior', async () => {
    await expect(persistMemory(record(), true, { ...guard(), snapshots: [] })).rejects.toThrow('invalid_memory_source_snapshots')
    await expect(persistMemory(record(), true, { ...guard(), snapshots: guard().snapshots!.map(row => ({ ...row, sessionId: row.id === 'u1' ? 'other' : 's' })) })).rejects.toThrow('invalid_memory_source_snapshots')
    await expect(persistMemory(record(), true, { ...guard(), snapshots: guard().snapshots!.filter(row => row.id !== 'u1') })).rejects.toThrow('invalid_memory_source_snapshots')
    expect(await persistMemory(record(), true, { id: 'u2', content: '选第二个' })).toBe(true)
  })

  it('prevents an existing queue job from writing when metadata changes immediately before the SQL insert', async () => {
    const text = '我喜欢所有技术问题使用中文回答'
    db.prepare('INSERT INTO chat_messages (id, session_id, role, content) VALUES (?, ?, ?, ?)').run('u3', 's', 'user', text)
    const queue = new MemoryExtractionQueue()
    expect(await queue.enqueue({ id: 'u3', role: 'user', content: text }, 's')).toBe(true)
    let raced = false
    adapter.execute.mockImplementation(async (sql: string, params: unknown[] = []) => {
      if (/^INSERT OR IGNORE INTO memories/.test(sql.trim())) {
        raced = true
        db.prepare('UPDATE chat_messages SET metadata = ? WHERE id = ?').run('{"hidden":true}', 'u3')
      }
      return { rowsAffected: Number(db.prepare(sql).run(Object.fromEntries(params.map((value, index) => [`$${index + 1}`, value]))).changes) }
    })
    const chat = vi.fn(async () => ({ content: JSON.stringify([{ action: 'add', content: '技术问题使用中文回答', category: 'preference',
      subject: 'user', factKey: 'language', factValue: '中文', confidence: 0.95, sourceId: 'u3' }]) }))
    await queue.drain({ chat })
    expect(chat).toHaveBeenCalledTimes(1)
    expect(raced).toBe(true)
    expect(db.prepare('SELECT COUNT(*) AS n FROM memories').get()?.n).toBe(0)
  })

  it('checks the durable window owner and expiration in the same statement as each write', async () => {
    const key = 'memory-extraction:v2:window:' + 'a'.repeat(64)
    const receiptKey = 'memory-extraction:v2:intake:u2', receipt = JSON.stringify({ sourceId: 'u2', status: 'pending' })
    const lease = { version: 2, windowId: key + ':1', status: 'running', owner: 'a', leaseUntil: Date.now() + 60_000,
      sourceIds: ['u2'], receiptValues: [receipt], prefixIds: [], sessionId: 's' }
    const value = JSON.stringify(lease), guarded: MemorySourceGuard = { ...guard(), lease: { key, value } }
    db.prepare('INSERT INTO settings (key,value) VALUES (?,?)').run(key, value)
    db.prepare('INSERT INTO settings (key,value) VALUES (?,?)').run(receiptKey, receipt)
    const original = record()
    expect(await persistMemory(original, true, guarded)).toBe(true)
    db.prepare('UPDATE settings SET value = ? WHERE key = ?').run(JSON.stringify({ ...lease, owner: 'b' }), key)
    expect(await persistMemory({ ...original, id: 'm2' }, true, guarded)).toBe(false)
    expect(await updateMemoryIfUnchanged({ ...original, content: 'changed' }, original, guarded)).toBe(false)
    expect(await removeMemoryIfUnchanged(original, guarded)).toBe(false)
    const expired = JSON.stringify({ ...lease, leaseUntil: Date.now() - 1000 })
    db.prepare('UPDATE settings SET value = ? WHERE key = ?').run(expired, key)
    expect(await persistMemory({ ...original, id: 'm3' }, true, { ...guarded, lease: { key, value: expired } })).toBe(false)
    db.prepare('UPDATE settings SET value = ? WHERE key = ?').run(value, key)
    db.prepare('UPDATE settings SET value = ? WHERE key = ?').run(JSON.stringify({ sourceId: 'u2', status: 'invalidated' }), receiptKey)
    expect(await persistMemory({ ...original, id: 'm5' }, true, guarded)).toBe(false)
    expect(db.prepare('SELECT COUNT(*) AS n FROM memories').get()?.n).toBe(1)
    await expect(persistMemory({ ...original, id: 'm4' }, true, { id: 'u2', content: '选第二个', lease: { key, value } }))
      .rejects.toThrow('invalid_memory_source_lease')
  })
})
