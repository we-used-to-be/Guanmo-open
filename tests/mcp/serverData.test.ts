// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { executeMcpServerQuery, handleMcpServerQuery, type McpServerQuery } from '@/services/mcp/serverData'

const mocks = vi.hoisted(() => ({ ready: vi.fn(() => true), state: vi.fn(() => ({ status: 'ready' })), database: vi.fn() }))
vi.mock('@/services/database/db', () => ({ isDatabaseReady: mocks.ready, getDatabaseRuntimeState: mocks.state, getDatabase: mocks.database }))
let sqlite: DatabaseSync
const reader = { async select<T>(sql: string, params: unknown[] = []): Promise<T[]> { return sqlite.prepare(sql).all(...params as Array<string | number | null>) as T[] } }
const request = (toolName: string, args: Record<string, unknown> = {}): McpServerQuery => ({ requestId: 'anonymous-request', generation: 'anonymous-generation', toolName, arguments: args, paths: [{ path: '//?/D:/allowed', directory: true }], artifactKeys: ['ai:a'] })

describe('MCP server fixed read-only queries against anonymous SQLite', () => {
  beforeEach(() => {
    mocks.ready.mockReset().mockReturnValue(true)
    mocks.state.mockReset().mockReturnValue({ status: 'ready' })
    mocks.database.mockReturnValue(reader)
    sqlite = new DatabaseSync(':memory:')
    sqlite.exec(`CREATE TABLE documents(id TEXT,title TEXT,file_path TEXT,last_modified INTEGER);
      CREATE TABLE chunks(id TEXT,document_id TEXT,content TEXT,start_line INTEGER,end_line INTEGER,chunk_index INTEGER);
      CREATE TABLE reading_artifacts(id TEXT,title TEXT,type TEXT,source_file_name TEXT,updated_at INTEGER,content TEXT,structured_content TEXT);
      CREATE TABLE reading_marks(id TEXT,quote TEXT,note TEXT,type TEXT,updated_at INTEGER);`)
    const insert = sqlite.prepare('INSERT INTO documents VALUES (?,?,?,?)')
    insert.run('outside', 'Outside', 'D:/private/secret.md', 100)
    insert.run('sibling', 'Sibling', 'D:/allowed-other/no.md', 99)
    insert.run('one', 'One', 'd:/ALLOWED/one.md', 90)
    insert.run('two', 'Two', '\\\\?\\D:\\allowed\\two.md', 80)
    for (const id of ['outside', 'sibling', 'one', 'two']) sqlite.prepare('INSERT INTO chunks VALUES (?,?,?,?,?,?)').run(id, id, 'anonymous keyword content', 1, 2, 0)
    sqlite.prepare('INSERT INTO reading_artifacts VALUES (?,?,?,?,?,?,?)').run('a', 'Granted', 'note', 'anonymous.md', 1, 'A😀BC', null)
    sqlite.prepare('INSERT INTO reading_artifacts VALUES (?,?,?,?,?,?,?)').run('b', 'Unshared', 'summary', 'private.md', 2, 'private fixture', null)
    sqlite.prepare('INSERT INTO reading_marks VALUES (?,?,?,?,?)').run('m', 'unshared mark', null, 'highlight', 3)
  })
  afterEach(() => sqlite.close())

  it('filters scope before pagination and excludes sibling prefixes and private documents', async () => {
    const first = await executeMcpServerQuery(request('search_knowledge', { query: 'keyword', limit: 1 }), reader)
    expect(first).toMatchObject({ items: [{ id: 'one' }], nextOffset: 1, retrievalMode: 'keyword' })
    const second = await executeMcpServerQuery(request('search_knowledge', { query: 'keyword', offset: 1, limit: 1 }), reader)
    expect(second).toMatchObject({ items: [{ id: 'two' }], nextOffset: null })
  })

  it('supports an exact file grant without sharing siblings and rejects wildcard broadening', async () => {
    const exact = request('search_knowledge', { query: 'keyword' })
    exact.paths = [{ path: 'D:\\allowed\\two.md', directory: false }]
    expect(await executeMcpServerQuery(exact, reader)).toMatchObject({ items: [{ id: 'two' }], nextOffset: null })
    exact.paths = [{ path: 'D:\\allow%', directory: true }]
    expect(await executeMcpServerQuery(exact, reader)).toMatchObject({ items: [] })
  })

  it('returns only explicitly shared artifact keys and uses Unicode character pagination', async () => {
    expect(await executeMcpServerQuery(request('list_reading_artifacts'), reader)).toMatchObject({ items: [{ key: 'ai:a', title: 'Granted' }], nextOffset: null })
    expect(await executeMcpServerQuery(request('read_reading_artifact', { key: 'ai:a', offset: 1, maxChars: 1 }), reader)).toMatchObject({ key: 'ai:a', content: '😀', totalChars: 4, nextOffset: 2 })
    await expect(executeMcpServerQuery(request('read_reading_artifact', { key: 'ai:b' }), reader)).rejects.toThrow('MCP_SERVER_SCOPE_REJECTED')
  })

  it('does no query before readiness and rejects a readiness transition while awaiting data', async () => {
    mocks.ready.mockReturnValue(false)
    await expect(handleMcpServerQuery(request('list_reading_artifacts'))).rejects.toThrow('MCP_SERVER_DATABASE_NOT_READY')
    expect(mocks.database).not.toHaveBeenCalled()
    mocks.ready.mockReturnValue(true); mocks.state.mockReturnValue({ status: 'initializing' })
    await expect(handleMcpServerQuery(request('list_reading_artifacts'))).rejects.toThrow('MCP_SERVER_DATABASE_NOT_READY')
    expect(mocks.database).not.toHaveBeenCalled()
    mocks.state.mockReturnValue({ status: 'ready' })
    mocks.ready.mockReturnValueOnce(true).mockReturnValueOnce(false)
    await expect(handleMcpServerQuery(request('list_reading_artifacts'))).rejects.toThrow('MCP_SERVER_DATABASE_NOT_READY')
  })
})
