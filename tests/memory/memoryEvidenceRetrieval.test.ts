// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const adapter = vi.hoisted(() => ({ select: vi.fn() }))
vi.mock('@/services/database/db', () => ({ isDatabaseReady: () => true, getDatabase: () => adapter }))
vi.mock('@/services/idleScheduler', () => ({ idleScheduler: { enqueueOptional: vi.fn() } }))
import { encodeWindowMemoryEvidence } from '@/services/memory/memoryEvidence'
import { loadMemorySourceContext } from '@/services/memory/memoryService'
import type { Memory } from '@/services/database/persistence'
import type { MemoryWindowClaim } from '@/services/memory/memoryWindowLedger'
import type { MemoryWindowPacket } from '@/services/memory/memoryWindowInput'
import type { MemoryWindowCandidate } from '@/services/memory/memoryWindowCandidates'

let db: DatabaseSync
const locked = { sessionId: 's', scopeKey: 'p', epoch: 0, sourceIds: ['u1', 'u2'], windowId: 'window:1' }
const claim = { key: 'window', value: JSON.stringify(locked), record: locked } as unknown as MemoryWindowClaim
const candidate: MemoryWindowCandidate = { content: '项目数据库选择 PostgreSQL', category: 'project', kind: 'episodic', scope: 'project',
  primarySourceId: 'u2', supportingSourceIds: ['u1', 'a1'], subject: 'project', factKey: 'database', factValue: 'PostgreSQL',
  confidence: 0.9, segmented: false, requiresSemanticReview: true }
const metadata = JSON.stringify({ tags: [{ id: 'tag' }], displayContent: 'SQLite 或 PostgreSQL？' })
const packet: MemoryWindowPacket = { turns: [
  { id: 'u1', role: 'user', contextOnly: false, text: 'SQLite 或 PostgreSQL？' },
  { id: 'a1', role: 'assistant', contextOnly: false, parentId: 'u1', text: '第二个是 PostgreSQL。' },
  { id: 'u2', role: 'user', contextOnly: false, text: '选第二个。' },
], newSourceIds: ['u1', 'u2'], segmentedSourceIds: [], needsModel: true, estimatedInputTokens: 100, snapshots: [
  { id: 'u1', sessionId: 's', role: 'user', parentId: null, content: '【上下文】匿名附件', metadata, createdAt: 1700000000000 },
  { id: 'a1', sessionId: 's', role: 'assistant', parentId: 'u1', content: '第二个是 PostgreSQL。', metadata: null, createdAt: 1700000000001 },
  { id: 'u2', sessionId: 's', role: 'user', parentId: null, content: '选第二个。', metadata: null, createdAt: 1700000000002 },
] }

beforeEach(() => {
  db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE chat_messages (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, role TEXT NOT NULL, parent_id TEXT, content TEXT NOT NULL, metadata TEXT, created_at INTEGER NOT NULL)')
  for (const row of packet.snapshots) db.prepare('INSERT INTO chat_messages (id,session_id,role,parent_id,content,metadata,created_at) VALUES (?,?,?,?,?,?,?)')
    .run(row.id, row.sessionId, row.role, row.parentId, row.content, row.metadata, row.createdAt)
  adapter.select.mockImplementation(async (sql: string, params: unknown[] = []) =>
    db.prepare(sql).all(Object.fromEntries(params.map((value, index) => [`$${index + 1}`, value]))))
})
afterEach(() => { db.close(); vi.clearAllMocks() })

it('retrieves v2 user evidence only while visible text matches its original fingerprint', async () => {
  const evidence = await encodeWindowMemoryEvidence(claim, packet, candidate)
  const memory: Memory = { id: 'm', content: candidate.content, category: 'project', source: 'auto_extracted', status: 'active',
    locked: false, scopeType: 'project', scopeKey: 'p', createdAt: 1, updatedAt: 1, evidence }
  const first = await loadMemorySourceContext([memory], '当时的原话是什么？')
  expect(first).toContain('SQLite 或 PostgreSQL？')
  expect(first).toContain('选第二个。')
  expect(first).not.toContain('第二个是 PostgreSQL。')
  expect(first).not.toContain('匿名附件')
  db.prepare('UPDATE chat_messages SET metadata = ? WHERE id = ?').run(JSON.stringify({ displayContent: 'MySQL 或 PostgreSQL？' }), 'u1')
  const changed = await loadMemorySourceContext([memory], '原话')
  expect(changed).not.toContain('MySQL')
  expect(changed).toContain('选第二个。')
  db.prepare('UPDATE chat_messages SET metadata = ? WHERE id = ?').run('{broken', 'u1')
  expect(await loadMemorySourceContext([memory], '原话')).not.toContain('匿名附件')
})
