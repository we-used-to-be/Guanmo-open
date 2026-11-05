// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DB_SCHEMA, splitDatabaseSchemaStatements } from '@/services/database/schema'
import { persistMemory, type Memory } from '@/services/database/persistence'
import { contentHash } from '@/services/memory/memoryPolicy'
import { searchMemories } from '@/services/memory/memoryService'

const adapter = vi.hoisted(() => ({ execute: vi.fn(), select: vi.fn() }))
vi.mock('@/services/database/db', () => ({ isDatabaseReady: () => true, getDatabase: () => adapter }))
vi.mock('@/services/idleScheduler', () => ({ idleScheduler: { enqueueOptional: vi.fn() } }))
let db: DatabaseSync
const model = 'fixed-mock-model'
const bindings = (params: unknown[]) => Object.fromEntries(params.map((value, index) => [`$${index + 1}`, value]))
const memory = (id: string, content: string, embedding: number[] | null, extra: Partial<Memory> = {}): Memory => ({
  id, content, embedding, embeddingModel: model, contentHash: contentHash(content),
  category: 'project', source: 'manual_created', locked: false, status: 'active',
  scopeType: 'global', scopeKey: null, createdAt: 1, updatedAt: 1, ...extra,
})
beforeEach(() => {
  db = new DatabaseSync(':memory:')
  for (const sql of splitDatabaseSchemaStatements(DB_SCHEMA)) if (/^CREATE TABLE IF NOT EXISTS (?:memories|chat_sessions|chat_messages|settings)\b/.test(sql)) db.exec(sql)
  adapter.execute.mockImplementation(async (sql: string, params: unknown[] = []) => ({ rowsAffected: Number(db.prepare(sql).run(bindings(params)).changes) }))
  adapter.select.mockImplementation(async (sql: string, params: unknown[] = []) => db.prepare(sql).all(bindings(params)))
})
afterEach(() => db.close())

describe('independent cached recall (mock vectors, real isolated SQLite)', () => {
  it.each(['light', 'strong'] as const)('compares fixed labeled queries, including lexical crowd-out in %s mode', async mode => {
    await persistMemory(memory('speed', '用户开发观墨时优先考虑启动速度和低资源占用。', [1, 0, 0]))
    await persistMemory(memory('language', '默认使用中文回答', [0, 1, 0]))
    await persistMemory(memory('decision', '团队选定 SQLite 统一业务持久化，避免维护两套存储。', [0, 0, 1]))
    // Low lexical overlap must survive even when positive lexical matches exist.
    for (let i = 0; i < 45; i++) await persistMemory(memory(`noise-${i}`, '桌面端后台任务：天气预报和壁纸轮换的功能名称。', [-1, 0, 0]))
    const cases = [
      { query: '默认使用中文回答', vector: [0, 1, 0], expected: ['language'] },
      { query: '怎样才能让程序更快打开、少吃内存？', vector: [1, 0, 0], expected: ['speed'] },
      { query: '之前做桌面端的时候，我们为什么一直不愿意增加后台任务？', vector: [1, 0, 0], expected: ['speed'] },
      { query: '为何不再并行保留两个持久层？', vector: [0, 0, 1], expected: ['decision'] },
      { query: '海王星距离太阳多远？', vector: [-1, -1, -1], expected: [] },
    ]
    let hits = 0, returned = 0, expectedCount = 0
    const started = performance.now()
    const results: string[][] = []
    const embedding = vi.fn(async (query: string) => cases.find(item => item.query === query)!.vector)
    for (const item of cases) {
      const ids = (await searchMemories(item.query, { mode, embedding, embeddingModel: model, topK: 1 })).map(row => row.id)
      results.push(ids)
      hits += ids.filter(id => item.expected.includes(id)).length
      returned += ids.length
      expectedCount += item.expected.length
    }
    process.stdout.write(`MOCK recall metrics ${JSON.stringify({ mode, recall: hits / expectedCount, precision: hits / (returned || 1), durationMs: performance.now() - started, queryEmbeddingCalls: embedding.mock.calls.length, results })}\n`)
    expect(results).toEqual(cases.map(item => item.expected))
    expect(embedding.mock.calls.length).toBeLessThanOrEqual(cases.length)
  })

  it.each(['light', 'strong'] as const)('recalls zero lexical overlap in %s mode', async mode => {
    await persistMemory(memory('target', '优先启动速度与资源效率', [1, 0]))
    const embedding = vi.fn(async () => [1, 0])
    expect((await searchMemories('应用为何拒绝常驻作业？', { mode, embedding, embeddingModel: model })).map(row => row.id)).toEqual(['target'])
    expect(embedding).toHaveBeenCalledTimes(1)
  })

  it('keeps scope, category, status, supersession and sensitive-data filters before vector reads', async () => {
    const rows = [
      memory('global', '优先启动速度与资源效率', [1, 0]),
      memory('project', '优先启动速度与资源效率', [1, 0], { scopeType: 'project', scopeKey: 'd:/a' }),
      memory('other', '优先启动速度与资源效率', [1, 0], { scopeType: 'project', scopeKey: 'd:/b' }),
      memory('candidate', '优先启动速度与资源效率', [1, 0], { status: 'candidate' }),
      memory('archived', '优先启动速度与资源效率', [1, 0], { status: 'archived' }),
      memory('old', '优先启动速度与资源效率', [1, 0]),
      memory('replacement', '日常使用蓝色主题', [0, 1], { supersedesId: 'old' }),
      memory('sensitive', '我的手机号是 13800138000', [1, 0]),
      memory('category', '优先启动速度与资源效率', [1, 0], { category: 'learning' }),
    ]
    for (const row of rows) await persistMemory(row)
    const options = { embedding: async () => [1, 0], embeddingModel: model, categories: ['project'] }
    const query = '应用为何拒绝常驻作业？'
    expect((await searchMemories(query, options)).map(row => row.id)).toEqual(['global'])
    expect(new Set((await searchMemories(query, { ...options, scopeType: 'project', scopeKey: 'D:/A' })).map(row => row.id))).toEqual(new Set(['project', 'global']))
    const loaded = adapter.select.mock.calls.filter(([sql]) => sql.startsWith('SELECT id, embedding,')).flatMap(([, params]) => params)
    expect(loaded).not.toEqual(expect.arrayContaining(['other']))
    for (const id of ['candidate', 'archived', 'old', 'sensitive', 'category']) expect(loaded).not.toContain(id)
  })

  it('does not generate missing, stale or mismatched memory vectors during retrieval', async () => {
    for (const row of [memory('missing', '默认使用中文回答', null), memory('stale', '优先启动速度与资源效率', [1, 0], { contentHash: 'stale' }), memory('model', '优先启动速度与资源效率', [1, 0], { embeddingModel: 'other' })]) await persistMemory(row)
    const embedding = vi.fn(async () => [1, 0])
    const batchEmbedding = vi.fn(async () => [[1, 0]])
    expect((await searchMemories('中文回答', { embedding, batchEmbedding, embeddingModel: model })).map(row => row.id)).toEqual(['missing'])
    expect(embedding).not.toHaveBeenCalled()
    expect(batchEmbedding).not.toHaveBeenCalled()
  })

  it('deduplicates both recall paths and rejects weak semantic-only matches', async () => {
    await persistMemory(memory('both', '默认使用中文回答', [1, 0]))
    await persistMemory(memory('weak', '优先启动速度与资源效率', [0.6, 0.8]))
    expect((await searchMemories('中文回答', { embedding: async () => [1, 0], embeddingModel: model })).map(row => row.id)).toEqual(['both'])
  })

  it.each(['light', 'strong'] as const)('admits moderate BGE-like similarity but rejects a weaker match in %s mode', async mode => {
    const embeddingModel = 'BAAI/bge-large-zh-v1.5'
    await persistMemory(memory('moderate', '优先启动速度与资源效率', [0.45, Math.sqrt(1 - 0.45 ** 2)], { embeddingModel }))
    await persistMemory(memory('weak', '日常使用蓝色主题', [0.35, Math.sqrt(1 - 0.35 ** 2)], { embeddingModel }))
    expect((await searchMemories('应用为何拒绝常驻作业？', { mode, embedding: async () => [1, 0], embeddingModel })).map(row => row.id)).toEqual(['moderate'])
  })

  it('preserves all lexical matches when embedding is unavailable, including beyond the old cap', async () => {
    for (let i = 0; i < 20; i++) await persistMemory(memory(`lex-${i}`, '默认使用中文回答', [1, 0]))
    const options = { topK: 20, embeddingModel: model }
    const lexical = await searchMemories('中文回答', options)
    const fallback = await searchMemories('中文回答', { ...options, embedding: async () => { throw Error('offline') } })
    expect(fallback.map(row => row.id)).toEqual(lexical.map(row => row.id))
    expect(fallback).toHaveLength(20)
  })

  it('bounds concurrent vector reads to four and cancels before the query provider after reads finish', async () => {
    for (let i = 0; i < 300; i++) await persistMemory(memory(`parallel-${i}`, '优先启动速度与资源效率', [1, 0]))
    const select = adapter.select.getMockImplementation()!
    let active = 0, peak = 0
    const controller = new AbortController()
    adapter.select.mockImplementation(async (sql: string, params: unknown[] = []) => {
      if (!sql.startsWith('SELECT id, embedding,')) return select(sql, params)
      peak = Math.max(peak, ++active)
      try {
        await new Promise(resolve => setTimeout(resolve, 5))
        controller.abort()
        return await select(sql, params)
      } finally { active-- }
    })
    const embedding = vi.fn(async () => [1, 0])
    expect(await searchMemories('应用为何拒绝常驻作业？', { mode: 'strong', embedding, embeddingModel: model, signal: controller.signal })).toEqual([])
    expect(peak).toBe(4)
    expect(active).toBe(0)
    expect(embedding).not.toHaveBeenCalled()
  })

  it('falls back on query failure, timeout and cache-read failure; abort rejects late results', async () => {
    await persistMemory(memory('lexical', '默认使用中文回答', [1, 0]))
    const options = { embeddingModel: model }
    expect((await searchMemories('中文回答', { ...options, embedding: async () => { throw Error('offline') } })).map(row => row.id)).toEqual(['lexical'])
    vi.useFakeTimers()
    try {
      let finish!: (vector: number[]) => void
      const embedding = vi.fn(() => new Promise<number[]>(resolve => { finish = resolve }))
      const pending = searchMemories('中文回答', { ...options, embedding })
      await vi.advanceTimersByTimeAsync(1201)
      expect((await pending).map(row => row.id)).toEqual(['lexical'])
      finish([0, 1])
      const controller = new AbortController()
      const aborted = searchMemories('中文回答', { ...options, embedding, signal: controller.signal })
      await vi.advanceTimersByTimeAsync(0)
      controller.abort()
      expect(await aborted).toEqual([])
      finish([1, 0])
    } finally { vi.useRealTimers() }
    const select = adapter.select.getMockImplementation()!
    adapter.select.mockImplementation(async (sql: string, params: unknown[] = []) => {
      if (sql.startsWith('SELECT id, embedding,')) throw Error('cache unavailable')
      return select(sql, params)
    })
    expect((await searchMemories('中文回答', { ...options, embedding: async () => [1, 0] })).map(row => row.id)).toEqual(['lexical'])
  })

  it.each(['light', 'strong'] as const)('bounds vector reads with 5000 cached 768D memories in %s mode', async mode => {
    const vector = Array.from({ length: 768 }, (_, i) => i === 0 ? 1 : 0)
    for (let i = 0; i < 5000; i++) await persistMemory(memory(`bulk-${i}`, '优先启动速度与资源效率', vector, { updatedAt: i }))
    const embedding = vi.fn(async () => vector)
    const started = performance.now()
    const results = await searchMemories('应用为何拒绝常驻作业？', { mode, embedding, embeddingModel: model })
    const durationMs = performance.now() - started
    const reads = adapter.select.mock.calls.filter(([sql]) => sql.startsWith('SELECT id, embedding,'))
    const count = reads.reduce((sum, [, params]) => sum + params.length, 0)
    process.stdout.write(`MOCK bulk metrics ${JSON.stringify({ mode, durationMs, vectorsRead: count, queryEmbeddingCalls: embedding.mock.calls.length })}\n`)
    expect(results).toHaveLength(mode === 'light' ? 3 : 10)
    expect(count).toBeLessThanOrEqual(mode === 'light' ? 268 : 1064)
    expect(reads.every(([, params]) => params.length <= 64)).toBe(true)
    expect(embedding).toHaveBeenCalledTimes(1)
    expect(durationMs).toBeLessThan(2000)
  })
})
