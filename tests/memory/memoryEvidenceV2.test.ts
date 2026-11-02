// @vitest-environment node
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { decodeMemoryEvidence, encodeMemoryEvidence, encodeWindowMemoryEvidence, withMemoryReplacement } from '@/services/memory/memoryEvidence'
import type { MemoryWindowPacket } from '@/services/memory/memoryWindowInput'
import type { MemoryWindowClaim } from '@/services/memory/memoryWindowLedger'
import type { MemoryWindowCandidate } from '@/services/memory/memoryWindowCandidates'

const locked = { sessionId: 's', scopeKey: 'p', epoch: 0, sourceIds: ['u1', 'u2'], windowId: 'window:1' }
const claim = { key: 'window', value: JSON.stringify(locked), record: locked } as unknown as MemoryWindowClaim
const packet = (): MemoryWindowPacket => ({ turns: [
  { id: 'u1', role: 'user', contextOnly: false, text: '数据库可选 SQLite 或 PostgreSQL。' },
  { id: 'a1', role: 'assistant', contextOnly: false, parentId: 'u1', text: '第二个是 PostgreSQL。' },
  { id: 'u2', role: 'user', contextOnly: false, text: '定第二个。' },
], newSourceIds: ['u1', 'u2'], segmentedSourceIds: [], needsModel: true, estimatedInputTokens: 100, snapshots: [
  { id: 'u1', sessionId: 's', role: 'user', parentId: null, content: '【上下文】不应写入证据的附件', metadata: '{"displayContent":"数据库可选 SQLite 或 PostgreSQL。"}', createdAt: 1700000000000 },
  { id: 'a1', sessionId: 's', role: 'assistant', parentId: 'u1', content: '第二个是 PostgreSQL。', metadata: null, createdAt: 1700000000001 },
  { id: 'u2', sessionId: 's', role: 'user', parentId: null, content: '定第二个。', metadata: null, createdAt: 1700000000002 },
] })
const candidate: MemoryWindowCandidate = { content: '项目数据库选择 PostgreSQL', category: 'project', kind: 'episodic', scope: 'project',
  primarySourceId: 'u2', supportingSourceIds: ['u1', 'a1'], subject: 'project', factKey: 'database', factValue: 'PostgreSQL',
  confidence: 0.9, segmented: false, requiresSemanticReview: true }

describe('v2 multi-source memory evidence', () => {
  it('stores ordered source IDs and visible hashes without raw attachment text', async () => {
    const encoded = await encodeWindowMemoryEvidence(claim, packet(), candidate), evidence = decodeMemoryEvidence(encoded)
    expect(evidence?.version).toBe(2)
    if (!evidence || evidence.version !== 2) return
    expect(evidence.sourceId).toBe('u2')
    expect(evidence.sources.map(source => source.id)).toEqual(['u1', 'a1', 'u2'])
    expect(evidence.sources[0].textHash).toBe(createHash('sha256').update('数据库可选 SQLite 或 PostgreSQL。').digest('hex'))
    expect(encoded).not.toContain('不应写入证据的附件')
    expect(evidence.excerpt).toBe('定第二个。')
  })

  it('preserves a replacement snapshot and compatibility with v1 evidence', async () => {
    const encoded = await encodeWindowMemoryEvidence(claim, packet(), candidate)
    expect(decodeMemoryEvidence(withMemoryReplacement(encoded, { id: 'old', content: '旧项目事实', updatedAt: 1234 })))
      .toMatchObject({ version: 2, replacement: { id: 'old', updatedAt: 1234 } })
    expect(decodeMemoryEvidence(encodeMemoryEvidence({ id: 'old-source', role: 'user', content: '匿名内容', sessionId: 's' })))
      .toMatchObject({ version: 1, sourceId: 'old-source' })
  })

  it('rejects missing support, foreign sessions, future context and malformed evidence', async () => {
    const missing = packet(); missing.snapshots = missing.snapshots.filter(snapshot => snapshot.id !== 'a1')
    await expect(encodeWindowMemoryEvidence(claim, missing, candidate)).rejects.toThrow()
    const foreign = packet(); foreign.snapshots[0].sessionId = 'other'
    await expect(encodeWindowMemoryEvidence(claim, foreign, candidate)).rejects.toThrow()
    const later = packet(); later.turns = [later.turns[2], later.turns[0], later.turns[1]]
    await expect(encodeWindowMemoryEvidence(claim, later, candidate)).rejects.toThrow()
    const encoded = await encodeWindowMemoryEvidence(claim, packet(), candidate), value = JSON.parse(encoded)
    value.sources[1].parentId = 'unknown'
    expect(decodeMemoryEvidence(JSON.stringify(value))).toBeNull()
    value.version = 3
    expect(decodeMemoryEvidence(JSON.stringify(value))).toBeNull()
  })
})
