/**
 * Persistence layer for RAG vector store.
 * Syncs documents, chunks, and embeddings to/from the database.
 */

import { getDatabase, isDatabaseReady, serializeDatabaseTransaction } from './db'
import type { Document, Chunk } from '@/services/rag/types'

interface DocumentRow {
  id: string
  file_path: string
  title: string
  content: string
  content_hash?: string | null
  last_modified: number
}

interface ChunkRow {
  id: string
  document_id: string
  content: string
  content_hash?: string | null
  chunk_index: number
  start_line: number
  end_line: number
  title_path?: string | null
  heading?: string | null
  source_type?: 'markdown' | 'text' | null
  created_at?: number
  updated_at?: number
}

interface EmbeddingRow {
  chunk_id: string
  embedding: string
  embedding_model?: string | null
  preprocess_version?: string | null
  input_hash?: string | null
}

export type EmbeddingJobStatus = 'pending' | 'running' | 'done' | 'failed'

export interface EmbeddingJob {
  id: string
  documentId: string
  filePath: string
  status: EmbeddingJobStatus
  error: string | null
  retryCount: number
}

export interface BackupPayload {
  version: 1
  exportedAt: number
  sessions: Array<{
    session: ChatSessionRow
    messages: ChatMessageRow[]
  }>
  memories: Memory[]
  note: string
}

/**
 * Save a document and its chunks/embeddings to the database.
 */
export async function persistDocument(
  doc: Document,
  options: { enqueueEmbeddingJob?: boolean } = {},
): Promise<void> {
  if (!isDatabaseReady()) return
  await serializeDatabaseTransaction(async () => {
    const db = getDatabase()
    const [byPath, byId, existingChunks] = await Promise.all([
      db.select<{ id: string }>('SELECT id FROM documents WHERE file_path = $1', [doc.filePath]),
      db.select<{ id: string }>('SELECT id FROM documents WHERE id = $1', [doc.id]),
      db.select<{ id: string }>('SELECT id FROM chunks WHERE document_id = $1', [doc.id]),
    ])
    const conflictingIds = new Set([...byPath, ...byId].map((row) => row.id))
    conflictingIds.delete(doc.id)
    for (const id of conflictingIds) {
      const conflictingChunks = await db.select<{ id: string }>(
        'SELECT id FROM chunks WHERE document_id = $1',
        [id]
      )
      for (const chunk of conflictingChunks) {
        await db.execute('DELETE FROM embeddings WHERE chunk_id = $1', [chunk.id])
        await db.execute('DELETE FROM chunks WHERE id = $1', [chunk.id])
      }
      await db.execute('DELETE FROM documents WHERE id = $1', [id])
    }

    await db.execute(
      `INSERT INTO documents (id, file_path, title, content, content_hash, last_modified, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, COALESCE((SELECT created_at FROM documents WHERE id = $1), unixepoch()))
       ON CONFLICT(id) DO UPDATE SET
         file_path = excluded.file_path,
         title = excluded.title,
         content = excluded.content,
         content_hash = excluded.content_hash,
         last_modified = excluded.last_modified`,
      [doc.id, doc.filePath, doc.title, doc.content, doc.contentHash || null, doc.lastModified]
    )

    const nextIds = new Set(doc.chunks.map((chunk) => chunk.id))
    for (const row of existingChunks) {
      if (!nextIds.has(row.id)) {
        await db.execute('DELETE FROM embeddings WHERE chunk_id = $1', [row.id])
        await db.execute('DELETE FROM chunks WHERE id = $1', [row.id])
      }
    }

    const now = Date.now()
    for (const chunk of doc.chunks) {
      await db.execute(
        `INSERT INTO chunks (
          id, document_id, content, content_hash, chunk_index, start_line, end_line,
          title_path, heading, source_type, created_at, updated_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7,
          $8, $9, $10,
          COALESCE((SELECT created_at FROM chunks WHERE id = $1), $11),
          $12
        ) ON CONFLICT(id) DO UPDATE SET
          document_id = excluded.document_id,
          content = excluded.content,
          content_hash = excluded.content_hash,
          chunk_index = excluded.chunk_index,
          start_line = excluded.start_line,
          end_line = excluded.end_line,
          title_path = excluded.title_path,
          heading = excluded.heading,
          source_type = excluded.source_type,
          updated_at = excluded.updated_at`,
        [
          chunk.id, doc.id, chunk.content, chunk.contentHash || null, chunk.index,
          chunk.startLine, chunk.endLine,
          chunk.titlePath ? JSON.stringify(chunk.titlePath) : null,
          chunk.heading || null, chunk.sourceType || 'markdown',
          chunk.createdAt || now, chunk.updatedAt || now,
        ]
      )

      if (chunk.embedding) {
        await db.execute(
          `INSERT INTO embeddings (
            chunk_id, embedding, embedding_model, preprocess_version, input_hash
          ) VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT(chunk_id) DO UPDATE SET
            embedding = excluded.embedding,
            embedding_model = excluded.embedding_model,
            preprocess_version = excluded.preprocess_version,
            input_hash = excluded.input_hash`,
          [
            chunk.id, JSON.stringify(chunk.embedding), chunk.embeddingModel || null,
            chunk.embeddingPreprocessVersion || null, chunk.embeddingInputHash || null,
          ]
        )
      } else {
        await db.execute('DELETE FROM embeddings WHERE chunk_id = $1', [chunk.id])
      }
    }

    if (options.enqueueEmbeddingJob !== undefined) {
      await db.execute('DELETE FROM embedding_jobs WHERE file_path = $1', [doc.filePath])
      if (options.enqueueEmbeddingJob) {
        await db.execute(
          `INSERT INTO embedding_jobs
            (id, document_id, file_path, status, error, retry_count, created_at, updated_at)
           VALUES ($1, $2, $3, 'pending', NULL, 0, unixepoch(), unixepoch())`,
          [`job-${doc.id}`, doc.id, doc.filePath]
        )
      }
    }
  })
}

/**
 * Remove a document and all related data from the database.
 */
export async function removePersistedDocument(docId: string): Promise<void> {
  if (!isDatabaseReady()) return
  const db = getDatabase()
  // Chunks and embeddings cascade-delete
  await db.execute('DELETE FROM documents WHERE id = $1', [docId])
}

/**
 * Remove a document by file path.
 */
export async function removePersistedDocumentByPath(filePath: string): Promise<void> {
  if (!isDatabaseReady()) return
  const db = getDatabase()
  await db.execute('DELETE FROM documents WHERE file_path = $1', [filePath])
}

export async function removeEmbeddingJobByPath(filePath: string): Promise<void> {
  if (!isDatabaseReady()) return
  const db = getDatabase()
  await db.execute('DELETE FROM embedding_jobs WHERE file_path = $1', [filePath])
}

/**
 * Load all documents from the database.
 */
export async function loadAllDocuments(): Promise<Document[]> {
  if (!isDatabaseReady()) return []
  const db = getDatabase()

  const docs = await db.select<DocumentRow>('SELECT * FROM documents')

  const result: Document[] = []
  for (const row of docs) {
    const chunks = await loadChunksForDocument(row.id)
    result.push({
      id: row.id,
      filePath: row.file_path,
      title: row.title,
      content: row.content,
      contentHash: row.content_hash || undefined,
      lastModified: row.last_modified,
      chunks,
    })
  }
  return result
}

/**
 * Load all documents, chunks, and embeddings with a constant number of queries.
 */
export async function loadAllDocumentsBulk(): Promise<Document[]> {
  if (!isDatabaseReady()) return []
  const db = getDatabase()

  const [documents, chunkRows, embeddingRows] = await Promise.all([
    db.select<DocumentRow>('SELECT * FROM documents'),
    db.select<ChunkRow>('SELECT * FROM chunks'),
    db.select<EmbeddingRow>('SELECT * FROM embeddings'),
  ])

  const embeddingByChunkId = new Map(embeddingRows.map((row) => [row.chunk_id, row]))
  const chunksByDocumentId = new Map<string, Chunk[]>()

  for (const row of chunkRows) {
    const chunk = mapChunkRow(row, embeddingByChunkId.get(row.id))
    const chunks = chunksByDocumentId.get(row.document_id)
    if (chunks) {
      chunks.push(chunk)
    } else {
      chunksByDocumentId.set(row.document_id, [chunk])
    }
  }

  for (const chunks of chunksByDocumentId.values()) {
    chunks.sort((a, b) => a.index - b.index)
  }

  return documents.map((row) => ({
    id: row.id,
    filePath: row.file_path,
    title: row.title,
    content: row.content,
    contentHash: row.content_hash || undefined,
    lastModified: row.last_modified,
    chunks: chunksByDocumentId.get(row.id) || [],
  }))
}

export async function loadDocumentFilePaths(): Promise<string[]> {
  if (!isDatabaseReady()) return []
  const db = getDatabase()
  const rows = await db.select<{ file_path: string }>('SELECT file_path FROM documents')
  return rows.map((row) => row.file_path)
}

export async function loadChatSourceFilePaths(): Promise<string[]> {
  if (!isDatabaseReady()) return []
  const db = getDatabase()
  const rows = await db.select<{ metadata: string | null }>(
    'SELECT metadata FROM chat_messages WHERE metadata IS NOT NULL'
  )
  return rows.flatMap((row) => {
    try {
      const sources = JSON.parse(row.metadata ?? '{}').sources
      if (!Array.isArray(sources)) return []
      return sources.flatMap((source): string[] => (
        source && typeof source === 'object' && source.kind !== 'web' && typeof source.filePath === 'string'
          ? [source.filePath]
          : []
      ))
    } catch {
      return []
    }
  })
}

/**
 * Load chunks for a document, including embeddings.
 */
async function loadChunksForDocument(docId: string): Promise<Chunk[]> {
  const db = getDatabase()
  const rows = await db.select<ChunkRow>(
    'SELECT * FROM chunks WHERE document_id = $1 ORDER BY chunk_index',
    [docId]
  )

  const chunks: Chunk[] = []
  for (const row of rows) {
    // Load embedding if exists
    const embRows = await db.select<EmbeddingRow>(
      'SELECT * FROM embeddings WHERE chunk_id = $1',
      [row.id]
    )
    chunks.push(mapChunkRow(row, embRows[0]))
  }
  return chunks
}

function mapChunkRow(row: ChunkRow, embeddingRow?: EmbeddingRow): Chunk {
  let embedding: number[] | undefined
  if (embeddingRow?.embedding) {
    try {
      embedding = JSON.parse(embeddingRow.embedding)
    } catch {
      console.warn(`Failed to parse embedding for chunk ${row.id}`)
    }
  }

  let titlePath: string[] | undefined
  if (row.title_path) {
    try {
      const parsed = JSON.parse(row.title_path)
      if (Array.isArray(parsed) && parsed.every((item) => typeof item === 'string')) {
        titlePath = parsed
      }
    } catch {
      console.warn(`Failed to parse titlePath for chunk ${row.id}`)
    }
  }

  return {
    id: row.id,
    documentId: row.document_id,
    content: row.content,
    contentHash: row.content_hash || undefined,
    embeddingInputHash: embeddingRow?.input_hash || undefined,
    embeddingModel: embeddingRow?.embedding_model || null,
    embeddingPreprocessVersion: embeddingRow?.preprocess_version || null,
    index: row.chunk_index,
    startLine: row.start_line,
    endLine: row.end_line,
    titlePath,
    heading: row.heading || undefined,
    sourceType: row.source_type || 'markdown',
    createdAt: row.created_at || undefined,
    updatedAt: row.updated_at || undefined,
    embedding,
  }
}

/**
 * Persist a single embedding update.
 */
export async function persistEmbedding(chunk: Chunk): Promise<void> {
  if (!isDatabaseReady()) return
  const db = getDatabase()
  await db.execute(
    `INSERT OR REPLACE INTO embeddings
      (chunk_id, embedding, embedding_model, preprocess_version, input_hash)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      chunk.id, JSON.stringify(chunk.embedding), chunk.embeddingModel || null,
      chunk.embeddingPreprocessVersion || null, chunk.embeddingInputHash || null,
    ]
  )
}

export async function upsertEmbeddingJob(doc: Document): Promise<void> {
  if (!isDatabaseReady()) return
  const db = getDatabase()
  await db.execute(
    `INSERT OR REPLACE INTO embedding_jobs
      (id, document_id, file_path, status, error, retry_count, created_at, updated_at)
     VALUES (
      $1, $2, $3, 'pending', NULL,
      COALESCE((SELECT retry_count FROM embedding_jobs WHERE id = $1), 0),
      COALESCE((SELECT created_at FROM embedding_jobs WHERE id = $1), unixepoch()),
      unixepoch()
     )`,
    [`job-${doc.id}`, doc.id, doc.filePath]
  )
}

export async function listEmbeddingJobs(statuses?: EmbeddingJobStatus[]): Promise<EmbeddingJob[]> {
  if (!isDatabaseReady()) return []
  const db = getDatabase()
  const rows = await db.select<{
    id: string
    document_id: string
    file_path: string
    status: EmbeddingJobStatus
    error: string | null
    retry_count: number
  }>('SELECT * FROM embedding_jobs ORDER BY updated_at ASC')
  return rows
    .filter((row) => !statuses || statuses.includes(row.status))
    .map((row) => ({
      id: row.id,
      documentId: row.document_id,
      filePath: row.file_path,
      status: row.status,
      error: row.error,
      retryCount: row.retry_count,
    }))
}

export async function updateEmbeddingJobStatus(
  id: string,
  status: EmbeddingJobStatus,
  error: string | null = null
): Promise<void> {
  if (!isDatabaseReady()) return
  const db = getDatabase()
  await db.execute(
    `UPDATE embedding_jobs
     SET status = $1,
         error = $2,
         retry_count = retry_count + CASE WHEN $1 = 'failed' THEN 1 ELSE 0 END,
         updated_at = unixepoch()
     WHERE id = $3`,
    [status, error, id]
  )
}

export async function retryFailedEmbeddingJobsInDatabase(): Promise<void> {
  if (!isDatabaseReady()) return
  const db = getDatabase()
  await db.execute(
    `UPDATE embedding_jobs
     SET status = 'pending', error = NULL, updated_at = unixepoch()
     WHERE status = 'failed'`
  )
}

// --- Memories ---

export type MemorySource = 'user_explicit' | 'auto_extracted' | 'manual_created'
export type MemoryStatus = 'active' | 'candidate' | 'ignored' | 'archived' | 'superseded'

export interface Memory {
  id: string
  content: string
  category: string
  source: MemorySource
  locked: boolean
  status: MemoryStatus
  scopeType?: 'global' | 'project'
  scopeKey?: string | null
  subject?: string | null
  factKey?: string | null
  factValue?: string | null
  confidence?: number
  evidence?: string | null
  supersedesId?: string | null
  embedding?: number[] | null
  embeddingModel?: string | null
  contentHash?: string | null
  createdAt: number
  updatedAt: number
}

export async function persistMemory(memory: Memory): Promise<void> {
  if (!isDatabaseReady()) return
  const db = getDatabase()
  await db.execute(
    `INSERT OR REPLACE INTO memories (
       id, content, category, source, locked, status, scope_type, scope_key,
       subject, fact_key, fact_value, confidence, evidence, supersedes_id,
       embedding, embedding_model, content_hash, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)`,
    [
      memory.id,
      memory.content,
      memory.category,
      memory.source,
      memory.locked ? 1 : 0,
      memory.status,
      memory.scopeType || 'global',
      memory.scopeKey || null,
      memory.subject || null,
      memory.factKey || null,
      memory.factValue || null,
      memory.confidence ?? 1,
      memory.evidence || null,
      memory.supersedesId || null,
      memory.embedding ? JSON.stringify(memory.embedding) : null,
      memory.embeddingModel || null,
      memory.contentHash || null,
      memory.createdAt,
      memory.updatedAt,
    ]
  )
}

export async function loadAllMemories(category?: string, statuses?: MemoryStatus[]): Promise<Memory[]> {
  if (!isDatabaseReady()) return []
  const db = getDatabase()
  const sql = category
    ? 'SELECT * FROM memories WHERE category = $1 ORDER BY updated_at DESC'
    : 'SELECT * FROM memories ORDER BY updated_at DESC'
  const params = category ? [category] : []
  const rows = await db.select<{
    id: string
    content: string
    category: string
    source: string
    locked: number
    status: string
    created_at: number
    updated_at: number
    scope_type: string
    scope_key: string | null
    subject: string | null
    fact_key: string | null
    fact_value: string | null
    confidence: number
    evidence: string | null
    supersedes_id: string | null
    embedding: string | null
    embedding_model: string | null
    content_hash: string | null
  }>(sql, params)
  return rows
    .map((row) => ({
      id: row.id,
      content: row.content,
      category: row.category,
      source: (row.source || 'auto_extracted') as MemorySource,
      locked: row.locked === 1,
      status: (row.status || 'active') as MemoryStatus,
      scopeType: (row.scope_type === 'project' ? 'project' : 'global') as Memory['scopeType'],
      scopeKey: row.scope_key || null,
      subject: row.subject || null,
      factKey: row.fact_key || null,
      factValue: row.fact_value || null,
      confidence: Number.isFinite(row.confidence) ? row.confidence : 1,
      evidence: row.evidence || null,
      supersedesId: row.supersedes_id || null,
      embedding: row.embedding ? safeParseEmbedding(row.embedding) : null,
      embeddingModel: row.embedding_model || null,
      contentHash: row.content_hash || null,
      createdAt: normalizeMemoryTimestamp(row.created_at),
      updatedAt: normalizeMemoryTimestamp(row.updated_at),
    }))
    .filter((memory) => !statuses || statuses.includes(memory.status))
}

export async function updateMemoryContent(id: string, content: string): Promise<void> {
  if (!isDatabaseReady()) return
  const db = getDatabase()
  await db.execute(
    'UPDATE memories SET content = $1, embedding = NULL, embedding_model = NULL, content_hash = NULL, updated_at = unixepoch() * 1000 WHERE id = $2',
    [content, id]
  )
}

export async function removeMemory(id: string): Promise<void> {
  if (!isDatabaseReady()) return
  const db = getDatabase()
  await db.execute('DELETE FROM memories WHERE id = $1', [id])
}

export async function toggleMemoryLocked(id: string, locked: boolean): Promise<void> {
  if (!isDatabaseReady()) return
  const db = getDatabase()
  await db.execute(
    'UPDATE memories SET locked = $1, updated_at = unixepoch() * 1000 WHERE id = $2',
    [locked ? 1 : 0, id]
  )
}

export async function updateMemoryStatus(id: string, status: MemoryStatus): Promise<void> {
  if (!isDatabaseReady()) return
  const db = getDatabase()
  await db.execute(
    'UPDATE memories SET status = $1, updated_at = unixepoch() * 1000 WHERE id = $2',
    [status, id]
  )
}

export async function confirmMemoryCandidate(id: string): Promise<boolean> {
  if (!isDatabaseReady()) return false
  const candidate = (await loadAllMemories(undefined, ['candidate'])).find((memory) => memory.id === id)
  if (!candidate) return false
  return serializeDatabaseTransaction(async () => {
    const db = getDatabase()
    if (candidate.supersedesId) {
      await db.execute(
        `UPDATE memories SET status = 'superseded', updated_at = unixepoch() * 1000
         WHERE id = $1 AND status = 'active'`,
        [candidate.supersedesId]
      )
    }
    const result = await db.execute(
      `UPDATE memories
       SET status = 'active', source = 'user_explicit', updated_at = unixepoch() * 1000
       WHERE id = $1 AND status = 'candidate'`,
      [id]
    )
    return result.rowsAffected > 0
  })
}

function safeParseEmbedding(value: string): number[] | null {
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) && parsed.every((item) => typeof item === 'number') ? parsed : null
  } catch {
    return null
  }
}

function normalizeMemoryTimestamp(value: number): number {
  return value > 0 && value < 1_000_000_000_000 ? value * 1000 : value
}

export async function removeOldestAutoMemories(count: number): Promise<void> {
  if (!isDatabaseReady()) return
  const db = getDatabase()
  await db.execute(
    `DELETE FROM memories WHERE id IN (
      SELECT id FROM memories WHERE source = 'auto_extracted' AND locked = 0 AND status = 'candidate'
      ORDER BY updated_at ASC LIMIT $1
    )`,
    [count]
  )
}

// --- Chat Sessions & Messages ---

export interface ChatSessionRow {
  id: string
  title: string
  created_at: number
  updated_at: number
}

export interface ChatMessageRow {
  id: string
  session_id: string
  parent_id: string | null
  role: string
  content: string
  created_at: number
  metadata: string | null
  message_order?: number
}

export async function persistChatSession(session: { id: string; title: string }): Promise<void> {
  if (!isDatabaseReady()) return
  const db = getDatabase()
  const now = Math.floor(Date.now() / 1000)
  await db.execute(
    `INSERT OR REPLACE INTO chat_sessions (id, title, created_at, updated_at)
     VALUES ($1, $2, COALESCE((SELECT created_at FROM chat_sessions WHERE id = $1), $3), $4)`,
    [session.id, session.title, now, now]
  )
}

export async function persistChatMessage(msg: {
  id: string
  sessionId: string
  parentId?: string
  role: string
  content: string
  metadata?: string
  createdAt?: number
}): Promise<void> {
  if (!isDatabaseReady()) return
  const db = getDatabase()
  const createdAt = msg.createdAt ?? Date.now()
  await db.execute(
    `INSERT OR REPLACE INTO chat_messages (id, session_id, parent_id, role, content, metadata, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, COALESCE((SELECT created_at FROM chat_messages WHERE id = $1), $7))`,
    [msg.id, msg.sessionId, msg.parentId || null, msg.role, msg.content, msg.metadata || null, createdAt]
  )
}

export async function loadChatSessions(offset: number, limit: number): Promise<ChatSessionRow[]> {
  if (!isDatabaseReady()) return []
  const db = getDatabase()
  return db.select<ChatSessionRow>(
    'SELECT * FROM chat_sessions ORDER BY created_at DESC LIMIT $1 OFFSET $2',
    [limit, offset]
  )
}

export async function loadAllChatSessions(): Promise<ChatSessionRow[]> {
  if (!isDatabaseReady()) return []
  const db = getDatabase()
  return db.select<ChatSessionRow>('SELECT * FROM chat_sessions ORDER BY updated_at DESC, created_at DESC')
}

export async function loadChatMessages(sessionId: string): Promise<ChatMessageRow[]> {
  if (!isDatabaseReady()) return []
  const db = getDatabase()
  return db.select<ChatMessageRow>(
    'SELECT * FROM chat_messages WHERE session_id = $1 ORDER BY created_at ASC',
    [sessionId]
  )
}

export async function deleteChatSession(sessionId: string): Promise<void> {
  if (!isDatabaseReady()) return
  const db = getDatabase()
  await db.execute('DELETE FROM chat_messages WHERE session_id = $1', [sessionId])
  await db.execute('DELETE FROM chat_sessions WHERE id = $1', [sessionId])
}

export async function clearAllChatSessions(): Promise<void> {
  if (!isDatabaseReady()) return
  const db = getDatabase()
  await db.execute('DELETE FROM chat_messages')
  await db.execute('DELETE FROM chat_sessions')
}

export async function clearMemoriesByStatus(statuses: MemoryStatus[]): Promise<void> {
  if (!isDatabaseReady() || statuses.length === 0) return
  const db = getDatabase()
  const placeholders = statuses.map((_, index) => `$${index + 1}`).join(', ')
  await db.execute(`DELETE FROM memories WHERE status IN (${placeholders})`, statuses)
}

export async function exportBackupPayload(): Promise<BackupPayload> {
  const sessions = await loadAllChatSessions()
  const serializedSessions = await Promise.all(
    sessions.map(async (session) => ({
      session,
      messages: await loadChatMessages(session.id),
    }))
  )
  const memories = await loadAllMemories()
  return {
    version: 1,
    exportedAt: Date.now(),
    sessions: serializedSessions,
    memories,
    note: '不包含 API Key 等敏感密钥。知识库文档索引可在新环境通过工作区重建恢复。',
  }
}

export async function importBackupPayload(payload: BackupPayload): Promise<{ sessions: number; messages: number; memories: number }> {
  if (payload.version !== 1) {
    throw new Error(`不支持的备份版本：${payload.version}`)
  }

  let messageCount = 0
  for (const item of payload.sessions) {
    await persistChatSession({ id: item.session.id, title: item.session.title })
    let previousMessage: ChatMessageRow | null = null
    for (const message of item.messages) {
      await persistChatMessage({
        id: message.id,
        sessionId: item.session.id,
        parentId: message.parent_id
          ?? (message.role === 'assistant' && previousMessage?.role === 'user'
            ? previousMessage.id
            : undefined),
        role: message.role,
        content: message.content,
        metadata: message.metadata ?? undefined,
        createdAt: message.created_at,
      })
      messageCount++
      previousMessage = message
    }
  }

  for (const memory of payload.memories) {
    await persistMemory(memory)
  }

  return {
    sessions: payload.sessions.length,
    messages: messageCount,
    memories: payload.memories.length,
  }
}

/**
 * Load recent complete chat turns across all sessions, ordered newest-first.
 * Each assistant is paired only with its explicit parent user message.
 */
export async function loadRecentChatTurns(offset: number, limit: number): Promise<Array<ChatMessageRow & { session_title: string }>> {
  if (!isDatabaseReady()) return []
  const db = getDatabase()
  const rows = await db.select<ChatMessageRow>('SELECT *, rowid AS message_order FROM chat_messages')
  const sessions = await db.select<ChatSessionRow>('SELECT * FROM chat_sessions')
  const sessionTitles = new Map(sessions.map((session) => [session.id, session.title]))
  const rowsById = new Map(rows.map((row) => [row.id, row]))
  const turns = rows
    .filter((row) => row.role === 'assistant' && row.parent_id)
    .flatMap((assistant) => {
      const user = rowsById.get(assistant.parent_id!)
      if (!user || user.role !== 'user' || user.session_id !== assistant.session_id) return []
      return [{ user, assistant }]
    })
    .sort((a, b) => {
      if (b.assistant.created_at !== a.assistant.created_at) {
        return b.assistant.created_at - a.assistant.created_at
      }
      if ((b.assistant.message_order ?? 0) !== (a.assistant.message_order ?? 0)) {
        return (b.assistant.message_order ?? 0) - (a.assistant.message_order ?? 0)
      }
      return b.assistant.id.localeCompare(a.assistant.id)
    })
    .slice(offset, offset + limit)

  return turns.flatMap(({ user, assistant }) => [user, assistant].map((row) => ({
    ...row,
    session_title: sessionTitles.get(row.session_id) || '历史对话',
  })))
}

/**
 * Save a key-value setting to the database.
 */
export async function persistSetting(key: string, value: unknown): Promise<void> {
  if (!isDatabaseReady()) return
  const db = getDatabase()
  await db.execute(
    `INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ($1, $2, unixepoch())`,
    [key, JSON.stringify(value)]
  )
}

/**
 * Load a setting from the database.
 */
export async function loadSetting<T>(key: string): Promise<T | null> {
  if (!isDatabaseReady()) return null
  const db = getDatabase()
  const rows = await db.select<{ key: string; value: string }>(
    'SELECT * FROM settings WHERE key = $1',
    [key]
  )
  if (rows.length === 0) return null
  try {
    return JSON.parse(rows[0].value) as T
  } catch {
    return null
  }
}
