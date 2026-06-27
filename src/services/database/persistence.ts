/**
 * Persistence layer for RAG vector store.
 * Syncs documents, chunks, and embeddings to/from the database.
 */

import { getDatabase, isDatabaseReady } from './db'
import type { Document, Chunk } from '@/services/rag/types'

interface DocumentRow {
  id: string
  file_path: string
  title: string
  content: string
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
export async function persistDocument(doc: Document): Promise<void> {
  if (!isDatabaseReady()) return
  const db = getDatabase()

  const existingRows = await db.select<{ id: string }>(
    'SELECT id FROM documents WHERE file_path = $1 OR id = $2',
    [doc.filePath, doc.id]
  )
  for (const row of existingRows) {
    await db.execute(
      'DELETE FROM embeddings WHERE chunk_id IN (SELECT id FROM chunks WHERE document_id = $1)',
      [row.id]
    )
    await db.execute('DELETE FROM chunks WHERE document_id = $1', [row.id])
    if (row.id !== doc.id) {
      await db.execute('DELETE FROM documents WHERE id = $1', [row.id])
    }
  }

  // Upsert document
  await db.execute(
    `INSERT OR REPLACE INTO documents (id, file_path, title, content, last_modified, created_at)
     VALUES ($1, $2, $3, $4, $5, COALESCE((SELECT created_at FROM documents WHERE id = $1), unixepoch()))`,
    [doc.id, doc.filePath, doc.title, doc.content, doc.lastModified]
  )

  const now = Date.now()

  // Insert chunks
  for (const chunk of doc.chunks) {
    await db.execute(
      `INSERT OR REPLACE INTO chunks (
        id, document_id, content, content_hash, chunk_index, start_line, end_line,
        title_path, heading, source_type, created_at, updated_at
      )
       VALUES (
        $1, $2, $3, $4, $5, $6, $7,
        $8, $9, $10,
        COALESCE((SELECT created_at FROM chunks WHERE id = $1), $11),
        $12
      )`,
      [
        chunk.id,
        doc.id,
        chunk.content,
        chunk.contentHash || null,
        chunk.index,
        chunk.startLine,
        chunk.endLine,
        chunk.titlePath ? JSON.stringify(chunk.titlePath) : null,
        chunk.heading || null,
        chunk.sourceType || 'markdown',
        chunk.createdAt || now,
        chunk.updatedAt || now,
      ]
    )

    // Persist embedding as JSON blob
    if (chunk.embedding) {
      await db.execute(
        `INSERT OR REPLACE INTO embeddings (chunk_id, embedding) VALUES ($1, $2)`,
        [chunk.id, JSON.stringify(chunk.embedding)]
      )
    }
  }
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

  const embeddingByChunkId = new Map(
    embeddingRows.map((row) => [row.chunk_id, row.embedding])
  )
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
    chunks.push(mapChunkRow(row, embRows[0]?.embedding))
  }
  return chunks
}

function mapChunkRow(row: ChunkRow, serializedEmbedding?: string): Chunk {
  let embedding: number[] | undefined
  if (serializedEmbedding) {
    try {
      embedding = JSON.parse(serializedEmbedding)
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
export async function persistEmbedding(chunkId: string, embedding: number[]): Promise<void> {
  if (!isDatabaseReady()) return
  const db = getDatabase()
  await db.execute(
    'INSERT OR REPLACE INTO embeddings (chunk_id, embedding) VALUES ($1, $2)',
    [chunkId, JSON.stringify(embedding)]
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
export type MemoryStatus = 'active' | 'candidate' | 'ignored'

export interface Memory {
  id: string
  content: string
  category: string
  source: MemorySource
  locked: boolean
  status: MemoryStatus
  createdAt: number
  updatedAt: number
}

export async function persistMemory(memory: Memory): Promise<void> {
  if (!isDatabaseReady()) return
  const db = getDatabase()
  await db.execute(
    `INSERT OR REPLACE INTO memories (id, content, category, source, locked, status, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      memory.id,
      memory.content,
      memory.category,
      memory.source,
      memory.locked ? 1 : 0,
      memory.status,
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
  }>(sql, params)
  return rows
    .map((row) => ({
      id: row.id,
      content: row.content,
      category: row.category,
      source: (row.source || 'auto_extracted') as MemorySource,
      locked: row.locked === 1,
      status: (row.status || 'active') as MemoryStatus,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }))
    .filter((memory) => !statuses || statuses.includes(memory.status))
}

export async function updateMemoryContent(id: string, content: string): Promise<void> {
  if (!isDatabaseReady()) return
  const db = getDatabase()
  await db.execute(
    'UPDATE memories SET content = $1, updated_at = unixepoch() WHERE id = $2',
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
    'UPDATE memories SET locked = $1, updated_at = unixepoch() WHERE id = $2',
    [locked ? 1 : 0, id]
  )
}

export async function updateMemoryStatus(id: string, status: MemoryStatus): Promise<void> {
  if (!isDatabaseReady()) return
  const db = getDatabase()
  await db.execute(
    'UPDATE memories SET status = $1, updated_at = unixepoch() WHERE id = $2',
    [status, id]
  )
}

export async function confirmMemoryCandidate(id: string): Promise<boolean> {
  if (!isDatabaseReady()) return false
  const db = getDatabase()
  const result = await db.execute(
    `UPDATE memories
     SET status = 'active', source = 'user_explicit', updated_at = unixepoch()
     WHERE id = $1 AND status = 'candidate'`,
    [id]
  )
  return result.rowsAffected > 0
}

export async function removeOldestAutoMemories(count: number): Promise<void> {
  if (!isDatabaseReady()) return
  const db = getDatabase()
  await db.execute(
    `DELETE FROM memories WHERE id IN (
      SELECT id FROM memories WHERE source = 'auto_extracted' AND locked = 0 AND status != 'ignored'
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
  role: string
  content: string
  metadata?: string
  createdAt?: number
}): Promise<void> {
  if (!isDatabaseReady()) return
  const db = getDatabase()
  const createdAt = msg.createdAt ?? Date.now()
  await db.execute(
    `INSERT OR REPLACE INTO chat_messages (id, session_id, role, content, metadata, created_at)
     VALUES ($1, $2, $3, $4, $5, COALESCE((SELECT created_at FROM chat_messages WHERE id = $1), $6))`,
    [msg.id, msg.sessionId, msg.role, msg.content, msg.metadata || null, createdAt]
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
    for (const message of item.messages) {
      await persistChatMessage({
        id: message.id,
        sessionId: item.session.id,
        role: message.role,
        content: message.content,
        metadata: message.metadata ?? undefined,
        createdAt: message.created_at,
      })
      messageCount++
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
 * Load recent chat messages across all sessions, ordered newest-first.
 * Returns messages with session info attached.
 */
export async function loadRecentChatMessages(offset: number, limit: number): Promise<Array<ChatMessageRow & { session_title: string }>> {
  if (!isDatabaseReady()) return []
  const db = getDatabase()
  const rows = await db.select<ChatMessageRow & { session_title?: string }>(
    `SELECT m.*, m.rowid as message_order, s.title as session_title
     FROM chat_messages m
     JOIN chat_sessions s ON m.session_id = s.id
     ORDER BY m.created_at DESC, m.rowid DESC
     LIMIT $1 OFFSET $2`,
    [limit, offset]
  )

  if (rows.length <= limit && rows.every((row) => row.session_title)) {
    return rows as Array<ChatMessageRow & { session_title: string }>
  }

  const sessions = await db.select<ChatSessionRow>('SELECT * FROM chat_sessions')
  const sessionTitles = new Map(sessions.map((session) => [session.id, session.title]))
  return rows
    .map((row, index) => ({
      ...row,
      session_title: row.session_title || sessionTitles.get(row.session_id) || '历史对话',
      message_order: row.message_order ?? index,
    }))
    .sort((a, b) => {
      if (b.created_at !== a.created_at) return b.created_at - a.created_at
      return (b.message_order ?? 0) - (a.message_order ?? 0)
    })
    .slice(offset, offset + limit) as Array<ChatMessageRow & { session_title: string }>
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
