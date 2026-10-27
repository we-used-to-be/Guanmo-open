import { normalizeFilePath } from '@/services/pathIdentity'
import { getDatabase, getDatabaseRuntimeState, isDatabaseReady } from '@/services/database/db'

export interface McpServerPath { path: string; directory: boolean }
export interface McpServerQuery {
  requestId: string
  generation: string
  toolName: string
  arguments: Record<string, unknown>
  paths: McpServerPath[]
  artifactKeys: string[]
}
type Reader = Pick<ReturnType<typeof getDatabase>, 'select'>
function databaseReady(): boolean { return isDatabaseReady() && getDatabaseRuntimeState().status === 'ready' }

function integer(value: unknown, fallback: number, max: number): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > max) throw new Error('MCP_SERVER_ARGUMENTS_INVALID')
  return value
}
function like(value: string): string { return value.replace(/!/g, '!!').replace(/%/g, '!%').replace(/_/g, '!_') }
function scopedPath(column: string, paths: readonly McpServerPath[], params: unknown[]): string {
  if (!paths.length) return '0'
  // Match the application's case-insensitive path identity, including Windows extended paths.
  const raw = `lower(replace(trim(${column}), char(92), '/'))`
  const normalized = `replace(CASE WHEN substr(${raw},1,8)='//?/unc/' THEN '//' || substr(${raw},9) WHEN substr(${raw},1,4)='//?/' THEN substr(${raw},5) ELSE ${raw} END, '//', '/')`
  return `(${paths.map(scope => {
    const path = normalizeFilePath(scope.path).replace(/\/$/, '')
    params.push(path)
    if (!scope.directory) return `${normalized} = ?`
    params.push(`${like(path)}/%`)
    return `(${normalized} = ? OR ${normalized} LIKE ? ESCAPE '!')`
  }).join(' OR ')})`
}
function keysFor(keys: readonly string[], prefix: 'ai' | 'mark'): string[] {
  return keys.filter(key => key.startsWith(`${prefix}:`)).map(key => key.slice(prefix.length + 1))
}
function idsClause(ids: string[], params: unknown[]): string {
  if (!ids.length) return '0'
  params.push(...ids)
  return `id IN (${ids.map(() => '?').join(',')})`
}
function page<T>(rows: T[], offset: number, limit: number) {
  return { items: rows.slice(0, limit), nextOffset: rows.length > limit ? offset + limit : null }
}

/** Fixed read-only SQL only. The Rust host supplies grants, never caller-provided SQL. */
export async function executeMcpServerQuery(request: McpServerQuery, database: Reader): Promise<unknown> {
  const args = request.arguments
  const offset = integer(args.offset, 0, request.toolName === 'read_reading_artifact' ? Number.MAX_SAFE_INTEGER : 10000)
  const limit = integer(args.limit, 10, 20)
  if (limit === 0) throw new Error('MCP_SERVER_ARGUMENTS_INVALID')
  if (request.toolName === 'search_knowledge') {
    if (typeof args.query !== 'string' || !args.query.trim() || args.query.length > 500) throw new Error('MCP_SERVER_ARGUMENTS_INVALID')
    const params: unknown[] = []
    const scope = scopedPath('d.file_path', request.paths, params)
    const terms = args.query.trim().split(/\s+/)
    const search = terms.map(term => { params.push(`%${like(term)}%`, `%${like(term)}%`); return "(c.content LIKE ? ESCAPE '!' OR d.title LIKE ? ESCAPE '!')" }).join(' AND ')
    params.push(limit + 1, offset)
    const rows = await database.select<{ path: string }>(`SELECT c.id, d.file_path AS path, d.title, c.start_line AS startLine, c.end_line AS endLine, substr(c.content,1,4096) AS snippet, length(c.content)>4096 AS truncated FROM chunks c JOIN documents d ON d.id=c.document_id WHERE ${scope} AND ${search} ORDER BY d.last_modified DESC, d.id ASC, c.chunk_index ASC, c.id ASC LIMIT ? OFFSET ?`, params)
    return { ...page(rows, offset, limit), retrievalMode: 'keyword' }
  }
  if (request.toolName === 'list_reading_artifacts') {
    const params: unknown[] = []
    const ai = idsClause(keysFor(request.artifactKeys, 'ai'), params)
    const marks = idsClause(keysFor(request.artifactKeys, 'mark'), params)
    params.push(limit + 1, offset)
    const rows = await database.select(`SELECT 'ai:' || id AS key, title, type, source_file_name AS sourceName, updated_at AS updatedAt FROM reading_artifacts WHERE ${ai} UNION ALL SELECT 'mark:' || id AS key, substr(COALESCE(NULLIF(note,''),quote),1,80) AS title, type, NULL AS sourceName, updated_at AS updatedAt FROM reading_marks WHERE ${marks} ORDER BY updatedAt DESC, key ASC LIMIT ? OFFSET ?`, params)
    return page(rows, offset, limit)
  }
  if (request.toolName === 'read_reading_artifact') {
    if (typeof args.key !== 'string' || !request.artifactKeys.includes(args.key)) throw new Error('MCP_SERVER_SCOPE_REJECTED')
    const maxChars = integer(args.maxChars, 8192, 32768)
    if (maxChars === 0) throw new Error('MCP_SERVER_ARGUMENTS_INVALID')
    const kind = args.key.startsWith('ai:') ? 'ai' : args.key.startsWith('mark:') ? 'mark' : null
    if (!kind) throw new Error('MCP_SERVER_SCOPE_REJECTED')
    const table = kind === 'ai' ? 'reading_artifacts' : 'reading_marks'
    const body = kind === 'ai' ? "COALESCE(content,'') || CASE WHEN structured_content IS NULL THEN '' ELSE char(10) || structured_content END" : "quote || CASE WHEN note IS NULL THEN '' ELSE char(10) || note END"
    const title = kind === 'ai' ? 'title' : 'substr(quote,1,80)'
    const rows = await database.select<{ title: string; type: string; content: string; totalChars: number }>(`SELECT ${title} AS title, type, substr(${body},?,?) AS content, length(${body}) AS totalChars FROM ${table} WHERE id=?`, [offset + 1, maxChars, args.key.slice(kind.length + 1)])
    const row = rows[0]
    if (!row) throw new Error('MCP_SERVER_ARTIFACT_MISSING')
    return { ...row, key: args.key, offset, nextOffset: offset + maxChars < row.totalChars ? offset + maxChars : null }
  }
  throw new Error('MCP_SERVER_TOOL_UNAVAILABLE')
}

/** Recheck readiness after the async query, so a maintenance/close transition fails closed. */
export async function handleMcpServerQuery(request: McpServerQuery): Promise<unknown> {
  if (!databaseReady()) throw new Error('MCP_SERVER_DATABASE_NOT_READY')
  const result = await executeMcpServerQuery(request, getDatabase())
  if (!databaseReady()) throw new Error('MCP_SERVER_DATABASE_NOT_READY')
  return result
}

/** User-facing selection only; this operation is never dispatched by an external tool. */
export async function listMcpShareableArtifacts(query: string, offset: number): Promise<{ items: Array<{ key: string; title: string; type: string }>; nextOffset: number | null }> {
  if (!databaseReady()) throw new Error('MCP_SERVER_DATABASE_NOT_READY')
  const pattern = `%${like(query.trim().slice(0, 500))}%`
  const rows = await getDatabase().select<{ key: string; title: string; type: string }>("SELECT 'ai:' || id AS key,title,type,updated_at AS updatedAt FROM reading_artifacts WHERE title LIKE ? ESCAPE '!' UNION ALL SELECT 'mark:' || id AS key,substr(COALESCE(NULLIF(note,''),quote),1,80) AS title,type,updated_at AS updatedAt FROM reading_marks WHERE quote LIKE ? ESCAPE '!' OR COALESCE(note,'') LIKE ? ESCAPE '!' ORDER BY updatedAt DESC,key ASC LIMIT 21 OFFSET ?", [pattern, pattern, pattern, integer(offset, 0, 10000)])
  if (!databaseReady()) throw new Error('MCP_SERVER_DATABASE_NOT_READY')
  return page(rows, offset, 20)
}
