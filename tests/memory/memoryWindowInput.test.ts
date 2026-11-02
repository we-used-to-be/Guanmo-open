// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const adapter = vi.hoisted(() => ({ execute: vi.fn(), select: vi.fn(), ready: vi.fn() }))
vi.mock('@/services/database/db', () => ({ isDatabaseReady: adapter.ready, getDatabase: () => adapter }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('@/services/runtimeCapabilities', () => ({ isWebRuntime: () => false }))
vi.mock('@/services/externalHttp', () => ({ UnsupportedCapabilityError: class extends Error {} }))
import { fingerprintMemorySource } from '@/services/memory/memoryIntake'
import { acquireMemoryWindow } from '@/services/memory/memoryWindowLedger'
import { buildMemoryWindowInput } from '@/services/memory/memoryWindowInput'

let db: DatabaseSync
const now = Date.now(), group = { sessionId: 's', scopeKey: 'p', epoch: 0 }
const bind = (params: unknown[]) => Object.fromEntries(params.map((value, index) => [`$${index + 1}`, value]))
async function addUser(id: string, sequence: number, content: string, metadata: string | null = null) {
  const createdAt = now + sequence
  db.prepare('INSERT INTO chat_messages (id,session_id,role,parent_id,content,metadata,created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, 's', 'user', null, content, metadata, createdAt)
  const item = { version: 2, ...group, sourceId: id, sequence, sourceFingerprint: await fingerprintMemorySource(content, metadata, createdAt),
    createdAt, status: 'pending' }
  db.prepare('INSERT INTO settings (key,value) VALUES (?,?)').run('memory-extraction:v2:intake:' + id, JSON.stringify(item))
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

describe('continuous v2 model input', () => {
  it('isolates an oversized source while preserving the other new turns', async () => {
    await addUser('u1', 1, '字'.repeat(384_001))
    await addUser('u2', 2, '我的专业是计算机科学。')
    await addUser('u3', 3, '谢谢。'); await addUser('u4', 4, '明白。')
    const result = await buildMemoryWindowInput(await claim())
    expect(result.kind).toBe('ready')
    if (result.kind !== 'ready') return
    expect(result.failedSourceIds).toEqual(['u1'])
    const turns = result.packets.flatMap(packet => packet.turns)
    expect(turns).toContainEqual(expect.objectContaining({ id: 'u1', gap: 'oversize' }))
    expect(turns).toContainEqual(expect.objectContaining({ id: 'u2', text: '我的专业是计算机科学。' }))
    expect(result.packets.some(packet => packet.needsModel)).toBe(true)
  })

  it('preserves user options, the actual parented assistant answer and the later decision', async () => {
    await addUser('u1', 1, '数据库在 SQLite 和 PostgreSQL 中选择。')
    addAssistant('a1', 'u1', '第二个是 PostgreSQL。')
    await addUser('u2', 2, '定第二个。')
    await addUser('u3', 3, '谢谢。')
    await addUser('u4', 4, '明白了。')
    const result = await buildMemoryWindowInput(await claim())
    expect(result.kind).toBe('ready')
    if (result.kind !== 'ready') return
    expect(result.packets).toHaveLength(1)
    expect(result.packets[0].turns.map(turn => turn.id)).toEqual(['u1', 'a1', 'u2', 'u3', 'u4'])
    expect(result.packets[0].turns[1]).toMatchObject({ role: 'assistant', parentId: 'u1', text: '第二个是 PostgreSQL。' })
    expect(result.packets[0].snapshots.map(snapshot => snapshot.id)).toContain('a1')
    expect(result.packets[0].estimatedInputTokens).toBeLessThanOrEqual(4000)
  })

  it('does not discard fresh facts when a processed prefix is oversized', async () => {
    await addUser('prefix', 1, '字'.repeat(384_001))
    db.prepare("UPDATE settings SET value = json_set(value, '$.status', 'completed') WHERE key = ?")
      .run('memory-extraction:v2:intake:prefix')
    await addUser('u1', 2, '我的专业是计算机科学。')
    await addUser('u2', 3, '谢谢。'); await addUser('u3', 4, '好。'); await addUser('u4', 5, '明白。')
    const result = await buildMemoryWindowInput(await claim())
    if (result.kind !== 'ready') throw new Error('expected ready')
    expect(result.failedSourceIds).toEqual([])
    expect(result.packets.flatMap(packet => packet.turns)).toContainEqual(
      expect.objectContaining({ id: 'prefix', gap: 'oversize', contextOnly: true }),
    )
    expect(result.packets.flatMap(packet => packet.newSourceIds)).toEqual(['u1', 'u2', 'u3', 'u4'])
    expect(result.packets.some(packet => packet.needsModel)).toBe(true)
  })

  it('sends only visible text and gaps for sensitive content and assistant output grounded in documents', async () => {
    const hidden = '【上下文】匿名附件完整正文'
    await addUser('u1', 1, hidden, JSON.stringify({ tags: [{ id: 'tag' }], displayContent: '这个项目怎么做？' }))
    addAssistant('a1', 'u1', '这里有匿名附件内容', JSON.stringify({ contextMeta: { tagCount: 1 } }))
    await addUser('u2', 2, '我的密码是匿名口令')
    addAssistant('a2', 'u2', '我看到了匿名口令')
    await addUser('u3', 3, '不要记住我的偏好')
    await addUser('u4', 4, '谢谢。')
    const result = await buildMemoryWindowInput(await claim())
    expect(result.kind).toBe('ready')
    if (result.kind !== 'ready') return
    const modelInput = JSON.stringify(result.packets.map(packet => packet.turns))
    expect(modelInput).not.toContain(hidden)
    expect(modelInput).not.toContain('匿名口令')
    expect(modelInput).not.toContain('匿名附件内容')
    expect(modelInput).toContain('这个项目怎么做？')
    expect(modelInput).toContain('restricted')
    expect(modelInput).toContain('sensitive')
  })

  it('does not choose between ambiguous assistant replies', async () => {
    await addUser('u1', 1, '提供两个方案。')
    addAssistant('a1', 'u1', '选甲。'); addAssistant('a2', 'u1', '选乙。')
    await addUser('u2', 2, '第二个。'); await addUser('u3', 3, '好。'); await addUser('u4', 4, '谢谢。')
    const result = await buildMemoryWindowInput(await claim())
    if (result.kind !== 'ready') throw new Error('expected ready')
    expect(result.packets[0].turns).toContainEqual(expect.objectContaining({ role: 'assistant', gap: 'ambiguous', parentId: 'u1' }))
    expect(result.packets[0].turns.some(turn => turn.id === 'a1' || turn.id === 'a2')).toBe(false)
  })

  it('splits long messages into explicitly incomplete bounded packets without dropping text', async () => {
    const long = '😀匿名文字。'.repeat(1400)
    await addUser('u1', 1, long); await addUser('u2', 2, '下一条。'); await addUser('u3', 3, '好。'); await addUser('u4', 4, '谢谢。')
    const result = await buildMemoryWindowInput(await claim())
    if (result.kind !== 'ready') throw new Error('expected ready')
    const segments = result.packets.flatMap(packet => packet.turns.filter(turn => turn.id === 'u1' && !turn.contextOnly))
    expect(segments.length).toBeGreaterThan(1)
    expect(segments.map(segment => segment.text).join('')).toBe(long)
    expect(segments.every(segment => segment.segment && segment.segment.total === segments.length)).toBe(true)
    expect(result.packets.every(packet => packet.estimatedInputTokens <= 4000)).toBe(true)
  })

  it('does not build input after losing the durable lease', async () => {
    for (let i = 1; i <= 4; i++) await addUser('u' + i, i, '匿名消息' + i)
    const value = await claim()
    db.prepare('UPDATE settings SET value = ? WHERE key = ?').run(JSON.stringify({ ...value.record, owner: 'other' }), value.key)
    expect(await buildMemoryWindowInput(value)).toEqual({ kind: 'lost_lease' })
  })
})
