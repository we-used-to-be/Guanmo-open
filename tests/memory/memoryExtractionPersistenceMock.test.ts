// @vitest-environment node
import { mkdtempSync, rmdirSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { expect, it, vi } from 'vitest'
import { DB_SCHEMA, splitDatabaseSchemaStatements } from '@/services/database/schema'
import { loadMemories } from '@/services/database/persistence'
import { MemoryExtractionQueue } from '@/services/memory/memoryExtractionQueue'
import { decodeMemoryEvidence } from '@/services/memory/memoryEvidence'
import { buildMemoryContextWithSources, searchMemories } from '@/services/memory/memoryService'
import type { ChatRequest } from '@/services/ai/types'

const adapter = vi.hoisted(() => ({ execute: vi.fn(), select: vi.fn() }))
vi.mock('@/services/database/db', () => ({ isDatabaseReady: () => true, getDatabase: () => adapter }))
vi.mock('@/services/idleScheduler', () => ({ idleScheduler: { enqueueOptional: vi.fn() } }))
const bind = (params: unknown[]) => Object.fromEntries(params.map((value, index) => [`$${index + 1}`, value]))

it('persists a supported mock extraction and recalls it after reopening an isolated SQLite database', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'guanmo-memory-eval-'))
  const path = join(directory, 'anonymous.sqlite')
  let db = new DatabaseSync(path)
  try {
    const attach = () => {
      adapter.execute.mockImplementation(async (sql: string, params: unknown[] = []) => ({ rowsAffected: Number(db.prepare(sql).run(bind(params)).changes) }))
      adapter.select.mockImplementation(async (sql: string, params: unknown[] = []) => db.prepare(sql).all(bind(params)))
    }
    for (const sql of splitDatabaseSchemaStatements(DB_SCHEMA)) {
      if (/^CREATE TABLE IF NOT EXISTS (?:memories|settings|chat_sessions|chat_messages)\b/.test(sql)) db.exec(sql)
    }
    attach()
    const sourceId = 'anonymous-source-1', sessionId = 'anonymous-session-1', content = '我喜欢所有技术问题使用中文回答'
    db.prepare('INSERT INTO chat_sessions (id, title) VALUES (?, ?)').run(sessionId, '匿名会话')
    db.prepare('INSERT INTO chat_messages (id, session_id, role, content) VALUES (?, ?, ?, ?)').run(sourceId, sessionId, 'user', content)
    const queue = new MemoryExtractionQueue()
    expect(await queue.enqueue({ id: sourceId, role: 'user', content }, sessionId)).toBe(true)
    const chat = vi.fn(async (request: ChatRequest) => {
      expect(JSON.stringify(request.messages)).toContain(sourceId)
      return { content: JSON.stringify([{ action: 'add', content: '技术问题使用中文回答', category: 'preference',
        subject: 'user', factKey: 'language', factValue: '中文', confidence: 0.95, sourceId }]) }
    })
    await queue.drain({ chat })
    expect(chat).toHaveBeenCalledTimes(1)
    const [memory] = await loadMemories()
    expect(memory.status).toBe('active')
    expect(decodeMemoryEvidence(memory.evidence)).toMatchObject({ sourceId, sessionId })
    db.close()
    db = new DatabaseSync(path)
    attach()
    await new MemoryExtractionQueue().drain({ chat })
    expect(chat).toHaveBeenCalledTimes(1)
    const recalled = await searchMemories('中文回答', { mode: 'light' })
    expect(recalled.map(item => item.id)).toContain(memory.id)
    const injection = buildMemoryContextWithSources(recalled)
    expect(injection.sources.map(item => item.memoryId)).toContain(memory.id)
    expect(injection.context).toContain('中文回答')
  } finally {
    db.close()
    unlinkSync(path)
    rmdirSync(directory)
  }
})
