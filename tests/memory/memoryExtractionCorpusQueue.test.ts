// @vitest-environment node
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { expect, it, vi } from 'vitest'
import { DB_SCHEMA, splitDatabaseSchemaStatements } from '@/services/database/schema'
import { MemoryExtractionQueue } from '@/services/memory/memoryExtractionQueue'

const adapter = vi.hoisted(() => ({ execute: vi.fn(), select: vi.fn() }))
vi.mock('@/services/database/db', () => ({ isDatabaseReady: () => true, getDatabase: () => adapter }))
vi.mock('@/services/idleScheduler', () => ({ idleScheduler: { enqueueOptional: vi.fn() } }))

type Message = { id: string; role: 'user' | 'assistant'; parentId: string | null; text: string; session: string; scope: string }
type Case = { id: string; split: string; schedule: string; messages: Message[] }
const cases = readFileSync('docs/memory/evaluation/extraction-v1/cases.jsonl', 'utf8').trim().split('\n')
  .map(line => JSON.parse(line) as Case)
  .filter(item => item.split === 'development' && ['S1', 'S3'].includes(item.schedule))
const bindings = (params: unknown[]) => Object.fromEntries(params.map((value, index) => [`$${index + 1}`, value]))

it('runs A queue with a NOOP mock against isolated development conversations', async () => {
  let requests = 0, accepted = 0
  for (const item of cases) {
    const db = new DatabaseSync(':memory:')
    try {
      for (const sql of splitDatabaseSchemaStatements(DB_SCHEMA)) {
        if (/^CREATE TABLE IF NOT EXISTS (?:memories|settings|chat_sessions|chat_messages)\b/.test(sql)) db.exec(sql)
      }
      adapter.execute.mockImplementation(async (sql: string, params: unknown[] = []) => ({ rowsAffected: Number(db.prepare(sql).run(bindings(params)).changes) }))
      adapter.select.mockImplementation(async (sql: string, params: unknown[] = []) => db.prepare(sql).all(bindings(params)))
      const queue = new MemoryExtractionQueue()
      const chat = vi.fn(async () => ({ content: '[]' }))
      for (const message of item.messages) {
        db.prepare('INSERT OR IGNORE INTO chat_sessions (id, title) VALUES (?, ?)').run(message.session, '匿名')
        db.prepare('INSERT INTO chat_messages (id, session_id, role, content) VALUES (?, ?, ?, ?)')
          .run(message.id, message.session, message.role, message.text)
        if (message.role !== 'user') continue
        // S1/S3 posit a successful answer after each user turn, including turns
        // whose answer text is unspecified in the frozen script.
        const source = message
        const workspace = source.scope === 'global' ? null : `D:/memory-eval/${source.scope}`
        if (await queue.enqueue({ id: source.id, role: 'user', content: source.text }, source.session, workspace)) accepted++
        await queue.drain({ chat })
      }
      requests += chat.mock.calls.length
      expect(db.prepare('SELECT COUNT(*) AS n FROM memories').get()).toEqual({ n: 0 })
    } finally { db.close() }
  }
  expect(cases).toHaveLength(40)
  expect(accepted).toBeGreaterThan(0)
  expect(requests).toBe(accepted)
  process.stdout.write(`A NOOP mock: ${cases.length} cases, ${accepted} queued, ${requests} requests\n`)
})

it.each(['delete', 'metadata_only'] as const)('rejects a late response after confirmed %s', async mutation => {
  const db = new DatabaseSync(':memory:')
  try {
    for (const sql of splitDatabaseSchemaStatements(DB_SCHEMA)) {
      if (/^CREATE TABLE IF NOT EXISTS (?:memories|settings|chat_sessions|chat_messages)\b/.test(sql)) db.exec(sql)
    }
    adapter.execute.mockImplementation(async (sql: string, params: unknown[] = []) => ({ rowsAffected: Number(db.prepare(sql).run(bindings(params)).changes) }))
    adapter.select.mockImplementation(async (sql: string, params: unknown[] = []) => db.prepare(sql).all(bindings(params)))
    db.prepare('INSERT INTO chat_sessions (id, title) VALUES (?, ?)').run('S', '匿名')
    const text = '我喜欢默认使用中文回答'
    db.prepare('INSERT INTO chat_messages (id, session_id, role, content, metadata) VALUES (?, ?, ?, ?, ?)')
      .run('source', 'S', 'user', text, JSON.stringify({ displayContent: text }))
    const queue = new MemoryExtractionQueue()
    expect(await queue.enqueue({ id: 'source', role: 'user', content: text }, 'S')).toBe(true)
    let release!: (result: { content: string }) => void
    let onStarted!: () => void
    const started = new Promise<void>(resolve => { onStarted = resolve })
    const chat = vi.fn(() => new Promise<{ content: string }>(resolve => { release = resolve; onStarted() }))
    const draining = queue.drain({ chat })
    await started
    expect(chat).toHaveBeenCalledTimes(1)
    const change = mutation === 'delete'
      ? db.prepare('DELETE FROM chat_messages WHERE id = ?').run('source')
      : db.prepare('UPDATE chat_messages SET metadata = ? WHERE id = ?')
        .run(JSON.stringify({ displayContent: '只是引用，非用户偏好' }), 'source')
    expect(Number(change.changes)).toBe(1)
    const row = db.prepare('SELECT content, metadata FROM chat_messages WHERE id = ?').get('source') as { content: string; metadata: string } | undefined
    if (mutation === 'delete') expect(row).toBeUndefined()
    else {
      expect(row?.content).toBe(text)
      expect(JSON.parse(row!.metadata).displayContent).toBe('只是引用，非用户偏好')
    }
    release({ content: '[{"action":"add","content":"默认使用中文回答","category":"preference","sourceId":"source"}]' })
    await draining
    expect(db.prepare('SELECT COUNT(*) AS n FROM memories').get()).toEqual({ n: 0 })
  } finally { db.close() }
})

it('retries a transient failure and does not repeat a completed write', async () => {
  const db = new DatabaseSync(':memory:')
  try {
    for (const sql of splitDatabaseSchemaStatements(DB_SCHEMA)) {
      if (/^CREATE TABLE IF NOT EXISTS (?:memories|settings|chat_sessions|chat_messages)\b/.test(sql)) db.exec(sql)
    }
    adapter.execute.mockImplementation(async (sql: string, params: unknown[] = []) => ({ rowsAffected: Number(db.prepare(sql).run(bindings(params)).changes) }))
    adapter.select.mockImplementation(async (sql: string, params: unknown[] = []) => db.prepare(sql).all(bindings(params)))
    db.prepare('INSERT INTO chat_sessions (id, title) VALUES (?, ?)').run('S', '匿名')
    const text = '我喜欢默认使用中文回答'
    db.prepare('INSERT INTO chat_messages (id, session_id, role, content) VALUES (?, ?, ?, ?)').run('source', 'S', 'user', text)
    const queue = new MemoryExtractionQueue()
    expect(await queue.enqueue({ id: 'source', role: 'user', content: text }, 'S')).toBe(true)
    const chat = vi.fn()
      .mockRejectedValueOnce(new Error('simulated 503'))
      .mockResolvedValue({ content: '[{"action":"add","content":"默认使用中文回答","category":"preference","sourceId":"source"}]' })
    expect(await queue.drain({ chat })).toBe(2000)
    // The caller supplies the delay; drain itself can be invoked directly in this isolated test.
    await new MemoryExtractionQueue().drain({ chat })
    await new MemoryExtractionQueue().drain({ chat })
    expect(chat).toHaveBeenCalledTimes(2)
    expect(db.prepare('SELECT COUNT(*) AS n FROM memories').get()).toEqual({ n: 1 })
  } finally { db.close() }
})
