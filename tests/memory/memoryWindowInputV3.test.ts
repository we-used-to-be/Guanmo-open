// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const adapter = vi.hoisted(() => ({ execute: vi.fn(), select: vi.fn(), ready: vi.fn() }))
vi.mock('@/services/database/db', () => ({ isDatabaseReady: adapter.ready, getDatabase: () => adapter }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('@/services/runtimeCapabilities', () => ({ isWebRuntime: () => false }))
vi.mock('@/services/externalHttp', () => ({ UnsupportedCapabilityError: class extends Error {} }))
import { fingerprintGlobalMemorySource } from '@/services/memory/memoryIntake'
import { acquireMemoryWindow } from '@/services/memory/memoryWindowLedger'
import { buildMemoryWindowInput } from '@/services/memory/memoryWindowInput'

let db: DatabaseSync
const now = Date.now(), group = { sessionId: 's', scopeKey: null, epoch: 0, policyVersion: 3 as const }
const bind = (params: unknown[]) => Object.fromEntries(params.map((value, index) => [`$${index + 1}`, value]))
async function addUser(id: string, sequence: number, content: string, metadata: string | null = null) {
  const createdAt = now + sequence
  db.prepare('INSERT INTO chat_messages (id,session_id,role,parent_id,content,metadata,created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, 's', 'user', null, content, metadata, createdAt)
  const item = { version: 3, ...group, sourceId: id, sequence, sourceFingerprint: await fingerprintGlobalMemorySource(content, createdAt),
    createdAt, status: 'pending' }
  db.prepare('INSERT INTO settings (key,value) VALUES (?,?)').run('memory-extraction:v3:intake:' + id, JSON.stringify(item))
}
function addAssistant(id: string, parent: string, content: string, metadata: string | null = null) {
  db.prepare('INSERT INTO chat_messages (id,session_id,role,parent_id,content,metadata,created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, 's', 'assistant', parent, content, metadata, now + 10)
}
async function claim() {
  const value = await acquireMemoryWindow(group, 'B', 'worker', { now: now + 100, lastActivityAt: now, foregroundBusy: false })
  if (value.kind !== 'claimed') throw new Error('missing claim: ' + value.kind)
  return value.claim
}
beforeEach(() => {
  db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL DEFAULT (unixepoch()))')
  db.exec('CREATE TABLE chat_messages (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, role TEXT NOT NULL, parent_id TEXT, content TEXT NOT NULL, metadata TEXT, created_at INTEGER NOT NULL)')
  adapter.ready.mockReturnValue(true)
  adapter.select.mockImplementation(async (sql: string, params: unknown[] = []) => db.prepare(sql).all(bind(params)))
  adapter.execute.mockImplementation(async (sql: string, params: unknown[] = []) => ({ rowsAffected: Number(db.prepare(sql).run(bind(params)).changes) }))
})
afterEach(() => { db.close(); vi.clearAllMocks() })

import { createMemoryWindowRequest, requestMemoryWindowProposals } from '@/services/memory/memoryWindowModel'
describe('single-request v3 input and model boundary', () => {
  it.each(['password=ExampleCredential123', 'secret: ExampleCredential123', 'token:ExampleCredential123', 'token = ExampleCredential123'])('redacts credential sources during input construction and makes no model call: %s', async secret => {
    for (let i = 1; i <= 8; i++) await addUser('u' + i, i, secret)
    const locked = await claim(), result = await buildMemoryWindowInput(locked)
    if (result.kind !== 'ready') throw new Error(result.kind)
    expect(JSON.stringify(result.packets)).not.toContain(secret)
    expect(result.packets[0].turns.every(turn => turn.gap === 'sensitive')).toBe(true)
    const chat = vi.fn(async () => ({ content: '[]' }))
    await expect(requestMemoryWindowProposals(locked, result.packets[0], [], { chat }, { foregroundBusy: () => false }))
      .resolves.toEqual({ kind: 'noop' })
    expect(chat).not.toHaveBeenCalled()
  })
  it('accepts eight users with their eight parented assistant replies', async () => {
    for (let i = 1; i <= 8; i++) { await addUser('u' + i, i, '我喜欢简洁回答。'); addAssistant('a' + i, 'u' + i, '这是可见的最终回复。'.repeat(40)) }
    const result = await buildMemoryWindowInput(await claim())
    if (result.kind !== 'ready') throw new Error(result.kind)
    expect(result.packets).toHaveLength(1)
    expect(result.packets[0].turns).toHaveLength(16)
    expect(result.packets[0].turns.filter(turn => turn.role === 'assistant').map(turn => turn.text))
      .toEqual(Array(8).fill('这是可见的最终回复。'.repeat(40)))
    expect(createMemoryWindowRequest(result.packets[0], null, []).kind).toBe('ready')
  })
  it('includes visible final replies with tool metadata without sending tool or hidden content', async () => {
    for (let i = 1; i <= 8; i++) await addUser('u' + i, i, '请继续说明。')
    addAssistant('a1', 'u1', '正式回复一', JSON.stringify({ sources: [{ text: '匿名工具原文' }], contextMeta: { webSearchUsed: true, ragSourceCount: 1 } }))
    addAssistant('a2', 'u2', '不可见正文', JSON.stringify({ displayContent: '正式回复二', tags: [{ text: '匿名附件原文' }] }))
    addAssistant('a3', 'u3', '隐藏回复', JSON.stringify({ hidden: true }))
    addAssistant('a4', 'u4', 'token:ExampleCredential123')
    const result = await buildMemoryWindowInput(await claim())
    if (result.kind !== 'ready') throw new Error(result.kind)
    const turns = result.packets[0].turns
    expect(turns).toContainEqual(expect.objectContaining({ id: 'a1', text: '正式回复一' }))
    expect(turns).toContainEqual(expect.objectContaining({ id: 'a2', text: '正式回复二' }))
    expect(turns).toContainEqual(expect.objectContaining({ id: 'a3', gap: 'restricted' }))
    expect(turns).toContainEqual(expect.objectContaining({ id: 'a4', gap: 'restricted' }))
    const input = JSON.stringify(turns)
    expect(input).not.toContain('匿名工具原文')
    expect(input).not.toContain('匿名附件原文')
    expect(input).not.toContain('不可见正文')
    expect(input).not.toContain('ExampleCredential123')
  })
  it('makes exactly one model call for eight messages exceeding the old packet budget', async () => {
    for (let i = 1; i <= 8; i++) await addUser('u' + i, i, '我长期偏好清晰的回答。'.repeat(20))
    const locked = await claim(), result = await buildMemoryWindowInput(locked)
    if (result.kind !== 'ready') throw new Error(result.kind)
    expect(result.packets).toHaveLength(1)
    const chat = vi.fn(async () => ({ content: '[]' }))
    for (const packet of result.packets) await requestMemoryWindowProposals(locked, packet, [], { chat }, { foregroundBusy: () => false })
    expect(chat).toHaveBeenCalledTimes(1)
  })
  it('accepts twenty turns including two processed prefix pairs', async () => {
    for (let i = 1; i <= 10; i++) {
      await addUser('u' + i, i, '我喜欢简洁回答。'); addAssistant('a' + i, 'u' + i, '好的。')
      if (i <= 2) db.prepare("UPDATE settings SET value = json_set(value, '$.status', 'completed') WHERE key = ?")
        .run('memory-extraction:v3:intake:u' + i)
    }
    const result = await buildMemoryWindowInput(await claim())
    if (result.kind !== 'ready') throw new Error(result.kind)
    expect(result.packets[0].turns).toHaveLength(20)
    expect(result.packets[0].turns.filter(turn => turn.contextOnly)).toHaveLength(4)
    expect(createMemoryWindowRequest(result.packets[0], null, []).kind).toBe('ready')
  })
  it('drops optional context before complete fresh sources at the byte bound', async () => {
    const ids = Array.from({ length: 10 }, (_, i) => ('u' + i).padEnd(290, 'x'))
    const text = '偏好清晰回答。'.repeat(130)
    for (let i = 0; i < 10; i++) {
      await addUser(ids[i], i + 1, text); addAssistant(('a' + i).padEnd(290, 'x'), ids[i], '好的。'.repeat(80))
      if (i < 2) db.prepare("UPDATE settings SET value = json_set(value, '$.status', 'completed') WHERE key = ?")
        .run('memory-extraction:v3:intake:' + ids[i])
    }
    const result = await buildMemoryWindowInput(await claim())
    if (result.kind !== 'ready') throw new Error(result.kind)
    expect(result.packets).toHaveLength(1)
    expect(result.failedSourceIds).toEqual([])
    expect(result.packets[0].turns.filter(turn => turn.role === 'user' && !turn.contextOnly).map(turn => turn.text))
      .toEqual(Array(8).fill(text))
    expect(result.packets[0].estimatedInputTokens).toBeLessThanOrEqual(32_000)
    expect(createMemoryWindowRequest(result.packets[0], null, []).kind).toBe('ready')
  })
  it('records oversized complete sources without splitting or truncating them', async () => {
    await addUser('u1', 1, '字'.repeat(1100))
    for (let i = 2; i <= 8; i++) await addUser('u' + i, i, '我喜欢清晰回答。')
    const result = await buildMemoryWindowInput(await claim())
    if (result.kind !== 'ready') throw new Error(result.kind)
    expect(result.packets).toHaveLength(1)
    expect(result.failedSourceIds).toEqual(['u1'])
    expect(result.packets[0].turns[0]).toMatchObject({ id: 'u1', gap: 'oversize' })
    expect(result.packets[0].segmentedSourceIds).toEqual([])
    expect(createMemoryWindowRequest(result.packets[0], null, []).kind).toBe('ready')
  })
})
