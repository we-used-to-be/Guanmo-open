// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DB_SCHEMA, splitDatabaseSchemaStatements } from '@/services/database/schema'
import { contentHash, shouldExtractMemoryCandidate, isExplicitMemoryWriteIntent } from '@/services/memory/memoryPolicy'
import { buildMemoryContext, buildMemoryContextWithSources, extractMemories, loadMemorySourceContext, processMemoryCandidateExtraction, searchMemories, upsertExplicitMemory } from '@/services/memory/memoryService'
import { loadMemories, persistMemory, persistMemoryEmbedding, updateMemoryIfUnchanged, type Memory } from '@/services/database/persistence'
import { MemoryExtractionQueue } from '@/services/memory/memoryExtractionQueue'
import { decodeMemoryEvidence, encodeMemoryEvidence } from '@/services/memory/memoryEvidence'
import type { ChatRequest } from '@/services/ai/types'

const adapter = vi.hoisted(() => ({ execute: vi.fn(), select: vi.fn() }))
const idleTasks = vi.hoisted(() => [] as Array<() => Promise<unknown>>)
vi.mock('@/services/database/db', () => ({ isDatabaseReady: () => true, getDatabase: () => adapter }))
vi.mock('@/services/idleScheduler', () => ({ idleScheduler: { enqueueOptional: (run: () => Promise<unknown>) => { idleTasks.push(run); return () => {} } } }))

let db: DatabaseSync
const record = (override: Partial<Memory> = {}): Memory => ({
  id: 'existing', content: '默认使用中文回答', category: 'preference', source: 'auto_extracted',
  status: 'candidate', locked: false, scopeType: 'global', scopeKey: null,
  createdAt: 1_700_000_000_000, updatedAt: 1_700_000_000_000, ...override,
})
const bindings = (params: unknown[]) => Object.fromEntries(params.map((value, index) => [`$${index + 1}`, value]))

beforeEach(() => {
  idleTasks.length = 0
  db = new DatabaseSync(':memory:')
  for (const sql of splitDatabaseSchemaStatements(DB_SCHEMA)) if (/^CREATE TABLE IF NOT EXISTS (?:memories|settings|chat_sessions|chat_messages)\b/.test(sql)) db.exec(sql)
  adapter.execute.mockImplementation(async (sql: string, params: unknown[] = []) => ({ rowsAffected: Number(db.prepare(sql).run(bindings(params)).changes) }))
  adapter.select.mockImplementation(async (sql: string, params: unknown[] = []) => db.prepare(sql).all(bindings(params)))
})
afterEach(() => db.close())

describe('memory writes against isolated SQLite', () => {
  it('requires content relevance before category and structured-field bonuses can rank results', async () => {
    await persistMemory(record({ id: 'major', status: 'active', category: 'profile', content: '用户的专业是计算机科学' }))
    await persistMemory(record({ id: 'unrelated-profile', status: 'active', category: 'profile', content: '每年秋季参加马拉松', subject: 'user', factKey: '专业' }))
    await persistMemory(record({ id: 'burger', status: 'active', content: '用户偏好双层牛肉汉堡' }))
    await persistMemory(record({ id: 'unrelated-preference', status: 'active', content: '技术回答先给结论', factValue: '汉堡' }))
    const major = await searchMemories('专业', { mode: 'strong' })
    expect(major.map(item => item.id)).toEqual(['major'])
    const burger = await searchMemories('汉堡偏好', { mode: 'strong' })
    expect(burger.map(item => item.id)).toEqual(['burger'])
    expect(await searchMemories('职业背景', { mode: 'strong' })).toEqual([])
  })
  it('keeps the extraction system prompt stable when existing memories change', async () => {
    const chat = vi.fn(async (_request: ChatRequest) => ({ content: '[]' }))
    const messages = [{ role: 'user' as const, content: '我喜欢使用中文回答' }]
    await extractMemories(messages, { chat })
    await persistMemory(record({ status: 'active' }))
    await extractMemories(messages, { chat })
    const first = chat.mock.calls[0][0] as ChatRequest
    const second = chat.mock.calls[1][0] as ChatRequest
    expect(second.messages[0]).toEqual(first.messages[0])
    expect(second.messages.slice(1).some(message => message.content.includes('默认使用中文回答'))).toBe(true)
  })
  it('snapshots only injected active memory content within the context budget', () => {
    const records = [record({ status: 'active', content: '已确认的长事实'.repeat(300) }),
      record({ id: 'later', status: 'active', content: '预算外事实' }), record({ id: 'candidate', content: '待确认事实' })]
    const snapshot = buildMemoryContextWithSources(records)
    expect(snapshot.context).toBe(buildMemoryContext(records))
    expect(snapshot.sources).toHaveLength(1)
    expect(snapshot.sources[0]).toMatchObject({ kind: 'memory', memoryId: 'existing' })
    expect(snapshot.sources[0].content.endsWith('…')).toBe(true)
    expect(snapshot.context).toContain(`内容：${snapshot.sources[0].content}`)
    expect(snapshot.context).not.toContain('预算外事实')
    expect(buildMemoryContextWithSources([record()]).sources).toEqual([])
  })
  it('conditional updates preserve a concurrent manual edit and cannot resurrect deletion', async () => {
    const old = record()
    await persistMemory(old)
    await persistMemory({ ...old, source: 'manual_created', content: '手动修改后的中文偏好', updatedAt: 101 })
    expect(await updateMemoryIfUnchanged({ ...old, content: '后台旧结果' }, old)).toBe(false)
    db.exec("DELETE FROM memories WHERE id = 'existing'")
    expect(await updateMemoryIfUnchanged({ ...old, content: '后台旧结果' }, old)).toBe(false)
    expect(await loadMemories()).toEqual([])
  })

  it('vector cache writes preserve edits/status and never insert deleted rows', async () => {
    const active = record({ status: 'active', contentHash: contentHash('默认使用中文回答') })
    await persistMemory(active)
    expect(await persistMemoryEmbedding(active, [1, 0], 'anonymous-model', active.contentHash!)).toBe(true)
    expect((await loadMemories({ includeEmbedding: true }))[0]).toMatchObject({ updatedAt: active.updatedAt, embedding: [1, 0], source: 'auto_extracted' })
    await persistMemory({ ...active, content: '现在使用英文回答', updatedAt: 200 })
    expect(await persistMemoryEmbedding(active, [0, 1], 'anonymous-model', active.contentHash!)).toBe(false)
    db.exec("DELETE FROM memories WHERE id = 'existing'")
    expect(await persistMemoryEmbedding(active, [1], 'anonymous-model', active.contentHash!)).toBe(false)
    expect(await loadMemories()).toEqual([])
  })

  it('cold recall never waits for candidate embedding and discards a deleted idle fill', async () => {
    await persistMemory(record({ id: 'cold', status: 'active' }))
    const embedding = vi.fn(async () => [1, 0])
    const batchEmbedding = vi.fn(async () => [[1, 0]])
    const result = await searchMemories('中文回答', { mode: 'light', embedding, batchEmbedding, embeddingModel: 'anonymous-model' })
    expect(result.map(memory => memory.id)).toEqual(['cold'])
    expect(embedding).not.toHaveBeenCalled()
    expect(batchEmbedding).not.toHaveBeenCalled()
    expect(idleTasks).toHaveLength(1)
    db.prepare('DELETE FROM memories WHERE id = ?').run('cold')
    await idleTasks[0]()
    expect(batchEmbedding).not.toHaveBeenCalled()
    expect(await loadMemories()).toEqual([])
  })

  it('reuses cached vectors with one query embedding and falls back to lexical on provider error', async () => {
    const active = record({ id: 'cached', status: 'active', embedding: [1, 0], embeddingModel: 'anonymous-model', contentHash: contentHash('默认使用中文回答') })
    await persistMemory(active)
    const embedding = vi.fn(async () => [1, 0])
    expect((await searchMemories('中文回答', { embedding, embeddingModel: 'anonymous-model' })).map(memory => memory.id)).toEqual(['cached'])
    expect(embedding).toHaveBeenCalledTimes(1)
    expect((await searchMemories('中文回答', { embedding: async () => { throw new Error('offline') }, embeddingModel: 'anonymous-model' })).map(memory => memory.id)).toEqual(['cached'])
  })

  it('warms strong zero-lexical cold recall only at idle and reuses the filled vectors', async () => {
    for (let index = 0; index < 45; index++) await persistMemory(record({ id: `cold-${index}`, status: 'active', content: '优先启动速度与资源效率' }))
    const embedding = vi.fn(async () => [1, 0])
    const batchEmbedding = vi.fn(async (texts: string[]) => texts.map(() => [1, 0]))
    const options = { mode: 'strong' as const, embedding, batchEmbedding, embeddingModel: 'anonymous-model' }
    expect(await searchMemories('应用为何拒绝常驻作业？', options)).toEqual([])
    expect(embedding).not.toHaveBeenCalled()
    expect(batchEmbedding).not.toHaveBeenCalled()
    expect(idleTasks).toHaveLength(1)
    await idleTasks[0]()
    expect(batchEmbedding).toHaveBeenCalledTimes(1)
    expect(batchEmbedding.mock.calls[0][0]).toHaveLength(8)
    expect(await searchMemories('应用为何拒绝常驻作业？', options)).toHaveLength(8)
    expect(embedding).toHaveBeenCalledTimes(1)
    // Later uncached rows can fill at idle, but the eight reusable rows must not be regenerated.
    expect(batchEmbedding).toHaveBeenCalledTimes(1)
  })

  it('does not fill a zero-lexical cold fallback after its request is cancelled', async () => {
    await persistMemory(record({ status: 'active', content: '优先启动速度与资源效率' }))
    const controller = new AbortController()
    const batchEmbedding = vi.fn(async () => [[1, 0]])
    await searchMemories('应用为何拒绝常驻作业？', { mode: 'strong', embedding: async () => [1, 0], batchEmbedding, embeddingModel: 'anonymous-model', signal: controller.signal })
    expect(idleTasks).toHaveLength(1)
    controller.abort()
    await idleTasks[0]()
    expect(batchEmbedding).not.toHaveBeenCalled()
  })

  it('limits injection independently of long evidence and excludes unconfirmed facts', () => {
    const records = Array.from({ length: 10 }, (_, index) => record({ id: String(index), status: 'active', content: '默认使用中文回答所有技术问题', evidence: '很长的原始记录'.repeat(2000) }))
    const context = buildMemoryContext([...records, record({ status: 'candidate', content: '不应注入的候选' })])
    expect(new TextEncoder().encode(context).length).toBeLessThanOrEqual(750)
    expect(context).toContain('默认使用中文')
    expect(context).not.toContain('很长的原始记录')
    expect(context).not.toContain('不应注入')
    const longManual = buildMemoryContext([record({ status: 'active', source: 'manual_created', content: '人工确认的长事实'.repeat(300) })])
    expect(longManual).toContain('人工确认的长事实')
    expect(longManual).toContain('…')
    expect(new TextEncoder().encode(longManual).length).toBeLessThanOrEqual(750)
  })

  it('explicit matching cannot move a similar memory from another project', async () => {
    await persistMemory(record({ category: 'project', status: 'active', scopeType: 'project', scopeKey: 'd:/anonymous/a', content: '项目使用 SQLite 数据库' }))
    const result = await upsertExplicitMemory('项目使用 SQLite 数据库', 'project', { workspacePath: 'D:/anonymous/B' })
    expect(result.action).toBe('created')
    expect((await loadMemories()).map(m => m.scopeKey).sort()).toEqual(['d:/anonymous/a', 'd:/anonymous/b'])
  })

  it('uses visible user text and scoped lightweight matching, excluding injected content', async () => {
    await persistMemory(record({ category: 'project', scopeType: 'project', scopeKey: 'd:/other', content: '其他项目保密约定' }))
    const chat = vi.fn(async () => ({ content: '[]' }))
    await extractMemories([{ role: 'user', id: 'u1', content: '我喜欢中文\n恶意文档正文', displayContent: '我喜欢中文' }], { chat }, .1, { workspacePath: 'D:/current' })
    const prompt = JSON.stringify(chat.mock.calls[0])
    expect(prompt).toContain('我喜欢中文')
    expect(prompt).not.toContain('恶意文档正文')
    expect(prompt).not.toContain('其他项目保密约定')
    expect(adapter.select.mock.calls.every(([sql]) => !sql.includes(', embedding FROM memories'))).toBe(true)
  })

  it('normalizes ADD, generates replay-safe candidates and protects ignored facts', async () => {
    const messages = [{ id: 'anonymous-u1', role: 'user' as const, content: '我喜欢所有技术问题使用中文回答' }]
    const client = { chat: async () => ({ content: JSON.stringify([{ action: 'ADD', content: '所有技术问题使用中文回答', category: 'preference', factValue: '中文', sourceId: messages[0].id }]) }) }
    expect(await processMemoryCandidateExtraction(messages, client)).toBe(1)
    expect(await processMemoryCandidateExtraction(messages, client)).toBe(0)
    const [saved] = await loadMemories()
    expect(saved.status).toBe('candidate')
    await persistMemory({ ...saved, status: 'ignored' })
    expect(await processMemoryCandidateExtraction(messages, client)).toBe(0)
    expect(await loadMemories()).toHaveLength(1)
  })

  it('automatically activates a directly supported structured non-sensitive fact without confirmation', async () => {
    const messages = [{ id: 'auto-supported', role: 'user' as const, content: '我喜欢所有技术问题使用中文回答' }]
    const client = { chat: async () => ({ content: '[{"action":"add","content":"技术问题使用中文回答","category":"preference","subject":"user","factKey":"language","factValue":"中文","confidence":0.95}]' }) }
    expect(await processMemoryCandidateExtraction(messages, client)).toBe(1)
    const [saved] = await loadMemories()
    expect(saved).toMatchObject({ status: 'active', source: 'auto_extracted', factValue: '中文' })
    expect(buildMemoryContext([saved])).toContain('中文回答')
    expect(await processMemoryCandidateExtraction(messages, client)).toBe(0)
  })

  it('keeps a conflicting active manual fact untouched and turns UPDATE into a confirmation candidate', async () => {
    await persistMemory(record({ id: 'manual-language', source: 'manual_created', status: 'active', locked: true,
      subject: 'user', factKey: 'language', factValue: '中文' }))
    const client = { chat: async () => ({ content: '[{"action":"UPDATE","id":"manual-language","content":"技术问题使用英文回答","category":"preference","subject":"user","factKey":"language","factValue":"英文","confidence":1}]' }) }
    await processMemoryCandidateExtraction([{ role: 'user', id: 'update-language', content: '我偏好技术问题使用英文回答' }], client)
    const memories = await loadMemories()
    expect(memories.find(memory => memory.id === 'manual-language')).toMatchObject({ status: 'active', locked: true, factValue: '中文' })
    expect(memories.find(memory => memory.id !== 'manual-language')).toMatchObject({ status: 'candidate', supersedesId: 'manual-language', factValue: '英文' })
  })

  it('atomically catches an active fact created after extraction and falls back to confirmation', async () => {
    const execute = adapter.execute.getMockImplementation()!
    adapter.execute.mockImplementationOnce(async (sql: string, params: unknown[]) => {
      await persistMemory(record({ id: 'concurrent-manual', source: 'manual_created', status: 'active', subject: 'user', factKey: 'language', factValue: '中文' }))
      return execute(sql, params)
    })
    const client = { chat: async () => ({ content: '[{"action":"add","content":"技术问题使用英文回答","category":"preference","subject":"user","factKey":"language","factValue":"英文","confidence":0.95}]' }) }
    await processMemoryCandidateExtraction([{ role: 'user', id: 'racing-language', content: '我偏好技术问题使用英文回答' }], client)
    const memories = await loadMemories()
    expect(memories.filter(memory => memory.status === 'active')).toHaveLength(1)
    expect(memories.find(memory => memory.id !== 'concurrent-manual')).toMatchObject({ status: 'candidate', supersedesId: 'concurrent-manual' })
  })

  it('does not send an existing sensitive fact into an unrelated extraction prompt', async () => {
    await persistMemory(record({ content: '我的手机号是 13800138000', factKey: 'phone', factValue: '13800138000', status: 'active' }))
    const chat = vi.fn(async () => ({ content: '[]' }))
    await extractMemories([{ role: 'user', content: '我喜欢默认使用中文回答' }], { chat })
    expect(JSON.stringify(chat.mock.calls)).not.toContain('13800138000')
  })

  it('does not apply a late extraction after invalidation or fabricate fact values', async () => {
    let valid = true
    const client = { chat: async () => { valid = false; return { content: '[{"action":"add","content":"默认使用中文回答","category":"preference"}]' } } }
    const messages = [{ role: 'user' as const, content: '我喜欢使用中文回答' }]
    expect(await processMemoryCandidateExtraction(messages, client, .1, { isValid: () => valid })).toBe(0)
    expect(await processMemoryCandidateExtraction(messages, { chat: async () => ({ content: '[{"action":"add","content":"用户毕业于未知大学","category":"profile","factValue":"未知大学"}]' }) })).toBe(0)
    expect(await loadMemories()).toEqual([])
  })

  it('does not let the extractor target a global candidate from a project update', async () => {
    await persistMemory(record())
    const messages = [{ role: 'user' as const, content: '项目约定使用中文输出' }]
    const client = { chat: async () => ({ content: '[{"action":"update","id":"existing","content":"项目约定使用中文输出","category":"project"}]' }) }
    expect(await processMemoryCandidateExtraction(messages, client, .1, { workspacePath: 'D:/anonymous' })).toBe(0)
    expect((await loadMemories())[0].content).toBe('默认使用中文回答')
  })

  const saveSource = (id: string, content: string, session = 'anonymous-session') => {
    db.prepare('INSERT OR IGNORE INTO chat_sessions (id, title) VALUES (?, ?)').run(session, '匿名会话')
    db.prepare("INSERT INTO chat_messages (id, session_id, role, content, created_at) VALUES (?, ?, 'user', ?, ?)").run(id, session, content, Date.now())
    return { id, role: 'user' as const, content, timestamp: Date.now() }
  }

  it('retrieves original user detail by exact ID/session only when requested', async () => {
    const source = { ...saveSource('detail-user', '项目约定使用 SQLite，因为需要离线使用'), sessionId: 'anonymous-session' }
    db.prepare("INSERT INTO chat_messages (id, session_id, role, content) VALUES (?, ?, 'assistant', ?)").run('assistant-history', 'anonymous-session', '助手推测的背景不得变成用户原话')
    const remembered = record({ status: 'active', evidence: encodeMemoryEvidence(source, 'episodic') })
    expect(await loadMemorySourceContext([remembered], '当时为什么选择这个数据库')).toContain('因为需要离线使用')
    expect(await loadMemorySourceContext([remembered], '项目约定')).toBe('')
    expect(await loadMemorySourceContext([{ ...remembered, evidence: encodeMemoryEvidence({ ...source, sessionId: 'other-session' }) }], '原话')).toBe('')
    expect(await loadMemorySourceContext([{ ...remembered, evidence: encodeMemoryEvidence({ ...source, id: 'assistant-history' }) }], '原话')).toBe('')
  })

  it('batches three user sources into one request and keeps origin/time for replay-safe recovery', async () => {
    const queue = new MemoryExtractionQueue()
    const sourceTexts = ['项目约定：数据库使用 SQLite', '项目技术栈采用 React 构建界面', '项目规则要求所有发布经过人工验收']
    for (let index = 0; index < 3; index++) {
      const message = saveSource(`source-${index}`, sourceTexts[index])
      await queue.enqueue(message, 'anonymous-session', 'D:/Anonymous/A')
    }
    const chat = vi.fn(async (request: ChatRequest) => ({ content: JSON.stringify(request.messages.filter(message => message.role === 'user').flatMap(message => {
      try { const source = JSON.parse(message.content); return source.sourceId ? [{ action: 'add', content: source.text, sourceId: source.sourceId, category: 'project', kind: 'episodic' }] : [] } catch { return [] }
    })) }))
    await queue.drain({ chat })
    expect(chat).toHaveBeenCalledTimes(1)
    const memories = await loadMemories()
    expect(memories).toHaveLength(3)
    expect(memories.every(memory => memory.scopeKey === 'd:/anonymous/a')).toBe(true)
    expect(decodeMemoryEvidence(memories[0].evidence)).toMatchObject({ kind: 'episodic', sessionId: 'anonymous-session' })
    const restarted = new MemoryExtractionQueue()
    await restarted.drain({ chat })
    expect(chat).toHaveBeenCalledTimes(1)
  })

  it('retries transient failures only three times across queue instances', async () => {
    const queue = new MemoryExtractionQueue()
    await queue.enqueue(saveSource('retry-user', '我喜欢中文回答所有技术问题'), 'anonymous-session', null)
    const chat = vi.fn(async () => { throw new Error('anonymous network failure') })
    for (let count = 0; count < 4; count++) await new MemoryExtractionQueue().drain({ chat })
    expect(chat).toHaveBeenCalledTimes(3)
    const [row] = db.prepare('SELECT value FROM settings').all() as Array<{ value: string }>
    expect(JSON.parse(row.value)).toMatchObject({ status: 'failed', attempts: 3 })
    expect(await loadMemories()).toEqual([])
  })

  it('backs off a full candidate inbox without model calls, deletion, or lost pending jobs', async () => {
    for (let index = 0; index < 200; index++) await persistMemory(record({ id: `capacity-${index}` }))
    const queue = new MemoryExtractionQueue()
    await queue.enqueue(saveSource('capacity-source', '我喜欢默认使用英文回答'), 'anonymous-session', null)
    const chat = vi.fn(async () => ({ content: '[]' }))
    expect(await queue.drain({ chat })).toBeGreaterThanOrEqual(60_000)
    expect(chat).not.toHaveBeenCalled()
    expect(await loadMemories()).toHaveLength(200)
    const row = db.prepare('SELECT value FROM settings').get() as { value: string }
    expect(JSON.parse(row.value)).toMatchObject({ status: 'pending', attempts: 0 })
  })

  it('skips deleted sources after restart and never sends sensitive or explicit-save requests to automatic extraction', async () => {
    const queue = new MemoryExtractionQueue()
    const message = saveSource('deleted-source', '我喜欢所有技术问题使用中文回答')
    await queue.enqueue(message, 'anonymous-session', null)
    db.prepare('DELETE FROM chat_messages WHERE id = ?').run(message.id)
    const chat = vi.fn(async () => ({ content: '[]' }))
    await new MemoryExtractionQueue().drain({ chat })
    expect(chat).not.toHaveBeenCalled()
    expect(await queue.enqueue(saveSource('sensitive', '我的手机号是 13800138000'), 'anonymous-session', null)).toBe(false)
    expect(await queue.enqueue(saveSource('explicit', '记住，以后默认使用中文回答'), 'anonymous-session', null)).toBe(false)
  })

  it('invalidates an in-flight batch when the source disappears before model completion', async () => {
    const queue = new MemoryExtractionQueue()
    await queue.enqueue(saveSource('remove-in-flight', '我喜欢默认使用中文回答'), 'anonymous-session', null)
    await queue.drain({ chat: async () => {
      db.prepare('DELETE FROM chat_messages WHERE id = ?').run('remove-in-flight')
      return { content: '[{"action":"add","content":"默认使用中文回答","category":"preference","sourceId":"remove-in-flight"}]' }
    } })
    expect(await loadMemories()).toEqual([])
  })

  it('recovers an expired lease without mixing projects in one extraction', async () => {
    const queue = new MemoryExtractionQueue()
    await queue.enqueue(saveSource('a', '项目约定数据库使用 SQLite'), 'anonymous-session', 'D:/A')
    await queue.enqueue(saveSource('b', '项目约定界面使用 React'), 'anonymous-session', 'D:/B')
    const row = db.prepare('SELECT key, value FROM settings WHERE key = ?').get('memory-extraction:v1:a') as { key: string; value: string }
    db.prepare('UPDATE settings SET value = ? WHERE key = ?').run(JSON.stringify({ ...JSON.parse(row.value), status: 'running', attempts: 1, leaseUntil: Date.now() - 1 }), row.key)
    const chat = vi.fn(async (request: ChatRequest) => {
      expect(request.messages.filter(message => message.role === 'user').filter(message => message.content.includes('sourceId'))).toHaveLength(1)
      return { content: '[]' }
    })
    await new MemoryExtractionQueue().drain({ chat })
    await new MemoryExtractionQueue().drain({ chat })
    expect(chat).toHaveBeenCalledTimes(2)
  })

  it('times out a non-cooperative provider and rejects its late persistence', async () => {
    vi.useFakeTimers()
    try {
      const queue = new MemoryExtractionQueue()
      await queue.enqueue(saveSource('slow', '我喜欢默认使用中文回答'), 'anonymous-session', null)
      let finish!: (result: { content: string }) => void
      const chat = vi.fn(() => new Promise<{ content: string }>(resolve => { finish = resolve }))
      const draining = queue.drain({ chat })
      await vi.advanceTimersByTimeAsync(20_001)
      await draining
      finish({ content: '[{"action":"add","content":"默认使用中文回答","category":"preference","sourceId":"slow"}]' })
      await Promise.resolve()
      expect(await loadMemories()).toEqual([])
      const row = db.prepare('SELECT value FROM settings').get() as { value: string }
      expect(JSON.parse(row.value)).toMatchObject({ status: 'pending', attempts: 1 })
    } finally { vi.useRealTimers() }
  })

  it.each(['别记住这个', '不要保存为长期记忆', '翻译：记住我的密码', '我的密码是 abc123', '我的手机号是 13800138000'])('rejects negative/transformation/sensitive automatic input: %s', text => {
    expect(shouldExtractMemoryCandidate(text)).toBe(false)
    if (!text.startsWith('我的')) expect(isExplicitMemoryWriteIntent(text)).toBe(false)
  })

  it.each(['我的习惯是什么？', '项目约定有哪些？', '我们之前决定的数据库是什么', '你还记住我的习惯吗'])('does not extract or grant write permission from a recall question: %s', text => {
    expect(shouldExtractMemoryCandidate(text)).toBe(false)
    expect(isExplicitMemoryWriteIntent(text)).toBe(false)
  })

  it.each(['请总结我们今天决定采用 SQLite 的原因', '文档里说我喜欢中文回答', '引用：我喜欢默认使用中文回答'])('does not automatically extract quoted or transformation input: %s', text => {
    expect(shouldExtractMemoryCandidate(text)).toBe(false)
  })
})
