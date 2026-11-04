// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const adapter = vi.hoisted(() => ({ execute: vi.fn(), select: vi.fn(), ready: vi.fn() }))
vi.mock('@/services/database/db', () => ({ isDatabaseReady: adapter.ready, getDatabase: () => adapter }))
import { acquireMemoryWindow, countPendingMemoryWindowSources, deferMemoryWindow, finishMemoryWindow,
  getMemoryWindowGroupForSource, getMemoryWindowRetryAt, isMemoryWindowLeaseCurrent, reserveMemoryWindowFormatRepair,
  listPendingMemoryWindowGroups, listPendingMemoryWindowGroupsPage } from '@/services/memory/memoryWindowLedger'
import type { MemoryWindowGroup } from '@/services/memory/memoryWindowLedger'

let db: DatabaseSync
const group: MemoryWindowGroup = { sessionId: 's', scopeKey: 'p', epoch: 0 }
const now = Date.now()
const bind = (params: unknown[]) => Object.fromEntries(params.map((value, index) => [`$${index + 1}`, value]))
function add(id: string, sequence: number, overrides: Partial<MemoryWindowGroup> = {}) {
  const item = { version: 2, ...group, ...overrides, sourceId: id, sequence, sourceFingerprint: 'a'.repeat(64),
    createdAt: now, status: 'pending' }
  db.prepare('INSERT INTO settings (key,value) VALUES (?,?)').run('memory-extraction:v2:intake:' + id, JSON.stringify(item))
}
function status(id: string) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('memory-extraction:v2:intake:' + id)
  return JSON.parse(String(row?.value)).status
}
const globalGroup: MemoryWindowGroup = { sessionId: 'global-session', scopeKey: null, epoch: 0, policyVersion: 3 }
function addGlobal(id: string, sequence: number, createdAt = now) {
  const item = { version: 3, ...globalGroup, sourceId: id, sequence, sourceFingerprint: 'a'.repeat(64), createdAt, status: 'pending' }
  db.prepare('INSERT INTO settings (key,value) VALUES (?,?)').run('memory-extraction:v3:intake:' + id, JSON.stringify(item))
}
function globalStatus(id: string) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('memory-extraction:v3:intake:' + id)
  return JSON.parse(String(row?.value)).status
}
const options = (at: number, foregroundBusy = false) => ({ now: at, lastActivityAt: now, foregroundBusy })

beforeEach(() => {
  db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL DEFAULT (unixepoch()))')
  adapter.ready.mockReturnValue(true)
  adapter.select.mockImplementation(async (sql: string, params: unknown[] = []) => db.prepare(sql).all(bind(params)))
  adapter.execute.mockImplementation(async (sql: string, params: unknown[] = []) => ({ rowsAffected: Number(db.prepare(sql).run(bind(params)).changes) }))
})
afterEach(() => { db.close(); vi.clearAllMocks() })

describe('durable v2 window ledger', () => {
  it('reserves one v3 format correction across foreground deferral and rejects stale claims', async () => {
    for (let i = 1; i <= 8; i++) addGlobal('g' + i, i)
    const first = await acquireMemoryWindow(globalGroup, 'B', 'worker', options(now + 1))
    if (first.kind !== 'claimed') throw new Error('missing claim')
    const stale = structuredClone(first.claim)
    expect(await reserveMemoryWindowFormatRepair(first.claim)).toBe('reserved')
    expect(await reserveMemoryWindowFormatRepair(first.claim)).toBe('used')
    expect(await reserveMemoryWindowFormatRepair(stale)).toBe('lost_lease')
    expect(await deferMemoryWindow(first.claim, 'foreground', now + 2)).toBe(true)
    const resumed = await acquireMemoryWindow(globalGroup, 'B', 'worker', options(now + 3))
    if (resumed.kind !== 'claimed') throw new Error('missing resumed claim')
    expect(await reserveMemoryWindowFormatRepair(resumed.claim)).toBe('used')
  })
  it('keeps sources pending across repeated foreground interruptions without exhausting retries', async () => {
    for (let i = 1; i <= 4; i++) add('u' + i, i)
    for (let attempt = 0; attempt < 4; attempt++) {
      const at = now + 1 + attempt * 60_002
      const result = await acquireMemoryWindow(group, 'B', 'worker', options(at))
      if (result.kind !== 'claimed') throw new Error('missing claim: ' + result.kind)
      expect(result.claim.record.attempts).toBe(1)
      expect(await deferMemoryWindow(result.claim, 'foreground', at + 1)).toBe(true)
      expect(['u1', 'u2', 'u3', 'u4'].map(status)).toEqual(['pending', 'pending', 'pending', 'pending'])
    }
    const final = await acquireMemoryWindow(group, 'B', 'worker', options(now + 1 + 4 * 60_002))
    if (final.kind !== 'claimed') throw new Error('missing final claim')
    expect(await finishMemoryWindow(final.claim, { u1: 'completed', u2: 'noop', u3: 'noop', u4: 'noop' }, now + 2 + 4 * 60_002)).toBe(true)
    expect(status('u1')).toBe('completed')
  })

  it('recovers pending groups from receipts and uses the persisted scope epoch', async () => {
    add('u1', 1)
    add('u2', 2)
    add('project-q', 3, { scopeKey: 'q', epoch: 1 })
    db.prepare("UPDATE settings SET value = json_set(value, '$.status', 'completed') WHERE key = ?")
      .run('memory-extraction:v2:intake:u2')
    const groups = await listPendingMemoryWindowGroups()
    expect(groups).toEqual(expect.arrayContaining([
      { group, pendingCount: 1, lastActivityAt: now },
      { group: { sessionId: 's', scopeKey: 'q', epoch: 1 }, pendingCount: 1, lastActivityAt: now },
    ]))
    expect(await getMemoryWindowGroupForSource('project-q', 's', 'q')).toEqual({ sessionId: 's', scopeKey: 'q', epoch: 1 })
    expect(await getMemoryWindowGroupForSource('u2', 's', 'p')).toBeNull()
    expect(await countPendingMemoryWindowSources(group)).toBe(1)
  })

  it('isolates sessions, scopes, epochs and respects full batches, idle, and foreground activity', async () => {
    add('u1', 1); add('u2', 2); add('other-project', 3, { scopeKey: 'q', epoch: 1 }); add('other-session', 4, { sessionId: 't' })
    expect(await acquireMemoryWindow(group, 'B', 'worker', options(now + 120_000))).toEqual({ kind: 'not_due' })
    expect(await acquireMemoryWindow(group, 'C', 'worker', options(now + 60_000, true))).toEqual({ kind: 'not_due' })
    expect(await acquireMemoryWindow(group, 'C', 'worker', options(now + 59_999))).toEqual({ kind: 'not_due' })
    const result = await acquireMemoryWindow(group, 'C', 'worker', options(now + 60_000))
    expect(result.kind).toBe('claimed')
    if (result.kind !== 'claimed') return
    expect(result.claim.record.sourceIds).toEqual(['u1', 'u2'])
    expect(await isMemoryWindowLeaseCurrent(result.claim)).toBe(true)
    expect(result.claim.value).not.toContain('对话正文')
    expect(await acquireMemoryWindow(group, 'C', 'other', options(now + 60_001))).toEqual({ kind: 'busy' })
  })

  it('finishes all sources atomically and supplies at most two processed prefix turns', async () => {
    for (let i = 1; i <= 4; i++) add('u' + i, i)
    const first = await acquireMemoryWindow(group, 'B', 'worker', options(now + 1))
    expect(first.kind).toBe('claimed')
    if (first.kind !== 'claimed') return
    expect(await finishMemoryWindow(first.claim, { u1: 'completed', u2: 'noop', u3: 'invalidated', u4: 'completed' }, now + 2)).toBe(true)
    expect(['u1', 'u2', 'u3', 'u4'].map(status)).toEqual(['completed', 'noop', 'invalidated', 'completed'])
    for (let i = 5; i <= 8; i++) add('u' + i, i)
    const second = await acquireMemoryWindow(group, 'B', 'worker', options(now + 3))
    expect(second.kind).toBe('claimed')
    if (second.kind === 'claimed') expect(second.claim.record.prefixIds).toEqual(['u2', 'u4'])
  })

  it('uses bounded retries and does not consume attempts while candidate capacity is blocked', async () => {
    for (let i = 1; i <= 4; i++) add('u' + i, i)
    const first = await acquireMemoryWindow(group, 'B', 'a', options(now + 1))
    if (first.kind !== 'claimed') throw new Error('missing first claim')
    expect(await deferMemoryWindow(first.claim, 'capacity', now + 2)).toBe(true)
    expect(await isMemoryWindowLeaseCurrent(first.claim)).toBe(false)
    expect(await acquireMemoryWindow(group, 'B', 'b', options(now + 60_001))).toEqual({ kind: 'busy' })
    const second = await acquireMemoryWindow(group, 'B', 'b', options(now + 60_002))
    if (second.kind !== 'claimed') throw new Error('missing second claim')
    expect(second.claim.record.attempts).toBe(1)
    expect(await deferMemoryWindow(second.claim, 'retry', now + 60_003)).toBe(true)
    const third = await acquireMemoryWindow(group, 'B', 'c', options(now + 62_003))
    if (third.kind !== 'claimed') throw new Error('missing third claim')
    expect(third.claim.record.attempts).toBe(2)
    expect(await deferMemoryWindow(third.claim, 'retry', now + 62_004)).toBe(true)
    const fourth = await acquireMemoryWindow(group, 'B', 'd', options(now + 66_004))
    if (fourth.kind !== 'claimed') throw new Error('missing fourth claim')
    expect(fourth.claim.record.attempts).toBe(3)
    expect(await deferMemoryWindow(fourth.claim, 'retry', now + 66_005)).toBe(true)
    expect(['u1', 'u2', 'u3', 'u4'].map(status)).toEqual(['failed', 'failed', 'failed', 'failed'])
  })

  it('does not let an expired owner finish after another owner claims the same fixed window', async () => {
    for (let i = 1; i <= 4; i++) add('u' + i, i)
    const first = await acquireMemoryWindow(group, 'B', 'a', options(now + 1))
    if (first.kind !== 'claimed') throw new Error('missing first claim')
    const second = await acquireMemoryWindow(group, 'B', 'b', options(now + 60_002))
    if (second.kind !== 'claimed') throw new Error('missing retry claim')
    expect(second.claim.record.sourceIds).toEqual(first.claim.record.sourceIds)
    expect(await finishMemoryWindow(first.claim, { u1: 'completed', u2: 'completed', u3: 'completed', u4: 'completed' }, now + 60_002)).toBe(false)
    expect(['u1', 'u2', 'u3', 'u4'].map(status)).toEqual(['pending', 'pending', 'pending', 'pending'])
  })

  it('recovers when the process stops after receipt settlement but before releasing the lease', async () => {
    for (let i = 1; i <= 4; i++) add('u' + i, i)
    const first = await acquireMemoryWindow(group, 'B', 'a', options(now + 1))
    if (first.kind !== 'claimed') throw new Error('missing first claim')
    const execute = adapter.execute.getMockImplementation()!
    adapter.execute.mockImplementationOnce(execute).mockResolvedValueOnce({ rowsAffected: 0 })
    expect(await finishMemoryWindow(first.claim, { u1: 'completed', u2: 'noop', u3: 'noop', u4: 'completed' }, now + 2)).toBe(false)
    expect(await acquireMemoryWindow(group, 'B', 'b', options(now + 60_002))).toEqual({ kind: 'settled' })
    expect(['u1', 'u2', 'u3', 'u4'].map(status)).toEqual(['completed', 'noop', 'noop', 'completed'])
  })

  it('rejects all receipt writes if one registered snapshot changed while the window was running', async () => {
    for (let i = 1; i <= 4; i++) add('u' + i, i)
    const first = await acquireMemoryWindow(group, 'B', 'a', options(now + 1))
    if (first.kind !== 'claimed') throw new Error('missing first claim')
    db.prepare("UPDATE settings SET value = json_set(value, '$.sourceFingerprint', ?) WHERE key = ?")
      .run('b'.repeat(64), 'memory-extraction:v2:intake:u3')
    expect(await finishMemoryWindow(first.claim, { u1: 'completed', u2: 'completed', u3: 'completed', u4: 'completed' }, now + 2)).toBe(false)
    expect(['u1', 'u2', 'u3', 'u4'].map(status)).toEqual(['pending', 'pending', 'pending', 'pending'])
  })

  it('allows at most one concurrent owner for the same window', async () => {
    for (let i = 1; i <= 4; i++) add('u' + i, i)
    const results = await Promise.all([
      acquireMemoryWindow(group, 'B', 'a', options(now + 1)),
      acquireMemoryWindow(group, 'B', 'b', options(now + 1)),
    ])
    expect(results.filter(result => result.kind === 'claimed')).toHaveLength(1)
    expect(results.filter(result => result.kind === 'lost_race' || result.kind === 'busy')).toHaveLength(1)
  })

  it('does not flush an idle tail if a new user source arrives during claiming', async () => {
    add('u1', 1); add('u2', 2)
    const execute = adapter.execute.getMockImplementation()!
    adapter.execute.mockImplementationOnce(async (...args: unknown[]) => {
      add('u3', 3)
      return execute(...args)
    })
    expect(await acquireMemoryWindow(group, 'C', 'a', options(now + 60_000))).toEqual({ kind: 'lost_race' })
    expect(['u1', 'u2', 'u3'].map(status)).toEqual(['pending', 'pending', 'pending'])
  })

  it('terminates expired sources instead of repeatedly retrying them', async () => {
    for (let i = 1; i <= 4; i++) add('u' + i, i)
    expect(await acquireMemoryWindow(group, 'B', 'a', options(now + 7 * 86_400_000 + 1))).toEqual({ kind: 'failed' })
    expect(['u1', 'u2', 'u3', 'u4'].map(status)).toEqual(['failed', 'failed', 'failed', 'failed'])
  })

  it('rejects settlement when a prefixed context receipt changes', async () => {
    for (let i = 1; i <= 4; i++) add('u' + i, i)
    const first = await acquireMemoryWindow(group, 'B', 'a', options(now + 1))
    if (first.kind !== 'claimed') throw new Error('missing first claim')
    expect(await finishMemoryWindow(first.claim, { u1: 'completed', u2: 'completed', u3: 'completed', u4: 'completed' }, now + 2)).toBe(true)
    for (let i = 5; i <= 8; i++) add('u' + i, i)
    const second = await acquireMemoryWindow(group, 'B', 'b', options(now + 3))
    if (second.kind !== 'claimed') throw new Error('missing second claim')
    db.prepare("UPDATE settings SET value = json_set(value, '$.sourceFingerprint', ?) WHERE key = ?")
      .run('b'.repeat(64), 'memory-extraction:v2:intake:u4')
    expect(await finishMemoryWindow(second.claim, { u5: 'completed', u6: 'completed', u7: 'completed', u8: 'completed' }, now + 4)).toBe(false)
    expect(['u5', 'u6', 'u7', 'u8'].map(status)).toEqual(['pending', 'pending', 'pending', 'pending'])
  })
})

describe('durable v3 global window ledger', () => {
  it('claims exactly eight sources in one session and flushes an underfilled tail only after five idle minutes', async () => {
    for (let i = 1; i <= 8; i++) addGlobal('g' + i, i)
    const full = await acquireMemoryWindow(globalGroup, 'B', 'worker', options(now + 1))
    expect(full.kind).toBe('claimed')
    if (full.kind === 'claimed') expect(full.claim.record.sourceIds).toHaveLength(8)

    const tailGroup = { ...globalGroup, sessionId: 'tail-session' }
    for (let i = 1; i <= 3; i++) {
      const item = { version: 3, ...tailGroup, sourceId: 'tail-' + i, sequence: i, sourceFingerprint: 'a'.repeat(64),
        createdAt: now + i, status: 'pending' }
      db.prepare('INSERT INTO settings (key,value) VALUES (?,?)').run('memory-extraction:v3:intake:tail-' + i, JSON.stringify(item))
    }
    expect(await acquireMemoryWindow(tailGroup, 'C', 'worker', { now: now + 299_999, lastActivityAt: now + 3, foregroundBusy: false }))
      .toEqual({ kind: 'not_due' })
    const tail = await acquireMemoryWindow(tailGroup, 'C', 'worker', { now: now + 300_003, lastActivityAt: now + 3, foregroundBusy: false })
    expect(tail.kind).toBe('claimed')
    if (tail.kind === 'claimed') expect(tail.claim.record.sourceIds).toEqual(['tail-1', 'tail-2', 'tail-3'])
  })

  it('keeps sessions isolated and does not reset one session idle time when another receives a message', async () => {
    addGlobal('a1', 1, now); addGlobal('b1', 1, now + 240_000)
    const sessionA = { ...globalGroup }
    const sessionB = { ...globalGroup, sessionId: 'other-session' }
    db.prepare('UPDATE settings SET value = json_set(value, \'$.sessionId\', ?) WHERE key = ?')
      .run('other-session', 'memory-extraction:v3:intake:b1')
    expect(await acquireMemoryWindow(sessionA, 'C', 'worker', { now: now + 300_000, lastActivityAt: now, foregroundBusy: false })).toMatchObject({ kind: 'claimed' })
    expect(await acquireMemoryWindow(sessionB, 'C', 'worker', { now: now + 300_000, lastActivityAt: now + 240_000, foregroundBusy: false }))
      .toEqual({ kind: 'not_due' })
    expect(await acquireMemoryWindow(sessionB, 'C', 'worker', { now: now + 540_000, lastActivityAt: now + 240_000, foregroundBusy: false }))
      .toMatchObject({ kind: 'claimed' })
  })

  it('pauses for foreground work without charging an attempt and persists 60/120 second retries', async () => {
    const base = Date.now() + 1_000
    for (let i = 1; i <= 8; i++) addGlobal('r' + i, i, base)
    const first = await acquireMemoryWindow(globalGroup, 'B', 'worker', options(base + 1))
    if (first.kind !== 'claimed') throw new Error('missing v3 claim')
    expect(await deferMemoryWindow(first.claim, 'foreground', base + 2)).toBe(true)
    const afterForeground = await acquireMemoryWindow(globalGroup, 'B', 'worker', options(base + 3))
    if (afterForeground.kind !== 'claimed') throw new Error('foreground should be immediately retryable')
    expect(afterForeground.claim.record.attempts).toBe(1)
    expect(await deferMemoryWindow(afterForeground.claim, 'retry', base + 4)).toBe(true)
    expect(await getMemoryWindowRetryAt(globalGroup)).toBeGreaterThanOrEqual(base + 60_004)
    const second = await acquireMemoryWindow(globalGroup, 'B', 'worker', options(base + 60_004))
    if (second.kind !== 'claimed') throw new Error('missing second v3 claim')
    expect(second.claim.record.attempts).toBe(2)
    expect(await deferMemoryWindow(second.claim, 'retry', base + 60_005)).toBe(true)
    const third = await acquireMemoryWindow(globalGroup, 'B', 'worker', options(base + 180_005))
    if (third.kind !== 'claimed') throw new Error('missing third v3 claim')
    expect(third.claim.record.attempts).toBe(3)
    expect(await deferMemoryWindow(third.claim, 'retry', base + 180_006)).toBe(true)
    expect(Array.from({ length: 8 }, (_, i) => globalStatus('r' + (i + 1)))).toEqual(Array(8).fill('failed'))
  })

  it('continues keyset recovery scans beyond 512 pending sources', async () => {
    for (let i = 1; i <= 513; i++) addGlobal('page-' + String(i).padStart(4, '0'), i)
    const first = await listPendingMemoryWindowGroupsPage(3)
    expect(first.nextCursor).not.toBeNull()
    const second = await listPendingMemoryWindowGroupsPage(3, first.nextCursor)
    expect(second.nextCursor).toBeNull()
    const total = [...first.groups, ...second.groups].reduce((sum, item) => sum + item.pendingCount, 0)
    expect(total).toBe(513)
  })
})
