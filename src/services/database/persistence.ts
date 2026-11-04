/**
 * Persistence layer for RAG vector store.
 * Syncs documents, chunks, and embeddings to/from the database.
 */

import { invoke } from '@tauri-apps/api/core'
import { getDatabase, isDatabaseReady } from './db'
import type { Document, Chunk } from '@/services/rag/types'
import { normalizeFilePath } from '@/services/pathIdentity'
import {
  buildMemoryCountQuery,
  buildMemoryEmbeddingQuery,
  buildMemoryQuery,
  type MemoryQueryFilters,
} from './memoryQuery'
import type { ReadingMark } from '@/services/readingMarks'
import { loadArtifactOrganization, type ArtifactCategory, type ArtifactOrganization } from './artifactOrganization'

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

export interface DocumentIndexMetadata {
  id: string
  filePath: string
  title: string
  contentHash?: string
  totalChunks: number
  embeddedChunks: number
  compatibleChunks: number
}

export interface KnowledgeDocumentSummary {
  id: string
  filePath: string
  title: string
  totalChunks: number
  embeddedChunks: number
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
  artifacts: ReadingArtifactBackupEntry[]
  readingReminders: ReadingReminderBackupEntry[]
  readingMarks?: ReadingMark[]
  artifactCategories?: ArtifactCategory[]
  artifactOrganization?: ArtifactOrganization[]
  note: string
}

/**
 * 备份中的阅读成果条目。
 * 字段经运行时解码后重新序列化为备份友好格式；旧备份缺少该字段时按空数组兼容。
 */
export interface ReadingArtifactBackupEntry {
  id: string
  type: string
  title: string
  content: string
  structuredContent: string | null
  sourceFilePath: string | null
  sourceFileName: string | null
  sourceContentHash: string | null
  sourceHeadingPath: string | null
  sourceStartLine: number | null
  sourceEndLine: number | null
  sourceQuote: string | null
  sourceMessageId: string | null
  sourceScope: string | null
  status: string
  createdAt: number
  updatedAt: number
}

export interface ReadingReminderBackupEntry {
  id: string
  title: string
  description: string | null
  dueAtUtc: number
  createdTimezone: string
  status: string
  sourceArtifactId: string | null
  sourceFilePath: string | null
  sourceMessageId: string | null
  notificationId: number | null
  errorCode: string | null
  createdAt: number
  updatedAt: number
}

/**
 * Save a document and its chunks/embeddings to the database.
 */
export async function persistDocument(
  doc: Document,
  options: { enqueueEmbeddingJob?: boolean } = {},
): Promise<void> {
  if (!isDatabaseReady()) return
  await invoke('persist_document_transaction', {
    request: {
      document: doc,
      enqueueEmbeddingJob: options.enqueueEmbeddingJob,
    },
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

export interface RemoveKnowledgeDocumentResult {
  deleted: boolean
  documentId?: string
  chunksDeleted: number
  embeddingJobsDeleted: number
}

/**
 * 通过 Rust SQLx 事务删除知识库文档。
 * 同一事务内删除 embedding_jobs 和 documents，依赖外键级联删除 chunks 和 embeddings。
 */
export async function removePersistedDocumentByPathTransaction(
  filePath: string
): Promise<RemoveKnowledgeDocumentResult> {
  if (!isDatabaseReady()) return { deleted: false, chunksDeleted: 0, embeddingJobsDeleted: 0 }
  return invoke<RemoveKnowledgeDocumentResult>('remove_knowledge_document_by_path', {
    filePath,
  })
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

async function findDocumentRowByFilePath(filePath: string): Promise<DocumentRow | undefined> {
  if (!isDatabaseReady()) return undefined
  const db = getDatabase()
  const rows = await db.select<DocumentRow>(
    'SELECT id, file_path, title, content_hash, last_modified FROM documents'
  )
  const normalizedPath = normalizeFilePath(filePath)
  return rows.find((row) => normalizeFilePath(row.file_path) === normalizedPath)
}

/**
 * Read only the fields required to decide whether a document needs re-indexing.
 * Embedding JSON is deliberately excluded from this query.
 */
export async function loadDocumentIndexMetadata(
  filePath: string,
  embeddingModel: string | null,
  embeddingPreprocessVersion: string,
): Promise<DocumentIndexMetadata | undefined> {
  const row = await findDocumentRowByFilePath(filePath)
  if (!row) return undefined
  const db = getDatabase()
  const [counts] = await db.select<{
    total_chunks: number
    embedded_chunks: number
    compatible_chunks: number
  }>(
    `SELECT
       COUNT(c.id) AS total_chunks,
       COUNT(e.chunk_id) AS embedded_chunks,
       SUM(CASE
         WHEN $2 IS NULL THEN 1
         WHEN e.embedding_model = $2
          AND e.preprocess_version = $3
          AND e.input_hash IS NOT NULL
          AND e.input_hash <> '' THEN 1
         ELSE 0
       END) AS compatible_chunks
     FROM chunks c
     LEFT JOIN embeddings e ON e.chunk_id = c.id
     WHERE c.document_id = $1`,
    [row.id, embeddingModel, embeddingPreprocessVersion]
  )
  return {
    id: row.id,
    filePath: row.file_path,
    title: row.title,
    contentHash: row.content_hash || undefined,
    totalChunks: counts?.total_chunks || 0,
    embeddedChunks: counts?.embedded_chunks || 0,
    compatibleChunks: counts?.compatible_chunks || 0,
  }
}

/** Load one document and parse only its embeddings. */
export async function loadDocumentByFilePath(filePath: string): Promise<Document | undefined> {
  const row = await findDocumentRowByFilePath(filePath)
  if (!row) return undefined
  return loadDocumentById(row.id)
}

export async function loadDocumentById(documentId: string): Promise<Document | undefined> {
  if (!isDatabaseReady()) return undefined
  const db = getDatabase()
  const [documents, chunkRows, embeddingRows] = await Promise.all([
    db.select<DocumentRow>('SELECT * FROM documents WHERE id = $1', [documentId]),
    db.select<ChunkRow>('SELECT * FROM chunks WHERE document_id = $1 ORDER BY chunk_index', [documentId]),
    db.select<EmbeddingRow>(
      `SELECT e.* FROM embeddings e
       INNER JOIN chunks c ON c.id = e.chunk_id
       WHERE c.document_id = $1`,
      [documentId]
    ),
  ])
  const row = documents[0]
  if (!row) return undefined
  const embeddingByChunkId = new Map(embeddingRows.map((embedding) => [embedding.chunk_id, embedding]))
  return {
    id: row.id,
    filePath: row.file_path,
    title: row.title,
    content: row.content,
    contentHash: row.content_hash || undefined,
    lastModified: row.last_modified,
    chunks: chunkRows.map((chunk) => mapChunkRow(chunk, embeddingByChunkId.get(chunk.id))),
  }
}

export async function loadKnowledgeDocumentSummaries(): Promise<KnowledgeDocumentSummary[]> {
  if (!isDatabaseReady()) return []
  const db = getDatabase()
  const rows = await db.select<{
    id: string
    file_path: string
    title: string
    total_chunks: number
    embedded_chunks: number
  }>(
    `SELECT d.id, d.file_path, d.title,
       COUNT(c.id) AS total_chunks,
       COUNT(e.chunk_id) AS embedded_chunks
     FROM documents d
     LEFT JOIN chunks c ON c.document_id = d.id
     LEFT JOIN embeddings e ON e.chunk_id = c.id
     GROUP BY d.id, d.file_path, d.title`
  )
  return rows.map((row) => ({
    id: row.id,
    filePath: row.file_path,
    title: row.title,
    totalChunks: row.total_chunks || 0,
    embeddedChunks: row.embedded_chunks || 0,
  }))
}

export async function loadRagStatsAggregate(): Promise<{
  documents: number
  totalChunks: number
  embeddedChunks: number
}> {
  if (!isDatabaseReady()) return { documents: 0, totalChunks: 0, embeddedChunks: 0 }
  const db = getDatabase()
  const [row] = await db.select<{
    documents: number
    total_chunks: number
    embedded_chunks: number
  }>(
    `SELECT
       (SELECT COUNT(*) FROM documents) AS documents,
       (SELECT COUNT(*) FROM chunks) AS total_chunks,
       (SELECT COUNT(*) FROM embeddings) AS embedded_chunks`
  )
  return {
    documents: row?.documents || 0,
    totalChunks: row?.total_chunks || 0,
    embeddedChunks: row?.embedded_chunks || 0,
  }
}

/** Scalar-only estimate for optional native index initialization; never loads content. */
export async function estimateRagWarmupMb(): Promise<number> {
  if (!isDatabaseReady()) return Number.POSITIVE_INFINITY
  // Rust owns the estimate used by both optional warmup and foreground admission.
  const budget = await invoke<unknown>('estimate_rag_index_memory')
  return typeof budget === 'number' && Number.isSafeInteger(budget) && budget >= 128
    ? budget : Number.POSITIVE_INFINITY
}

export async function loadDocumentFilePaths(): Promise<string[]> {
  if (!isDatabaseReady()) return []
  const db = getDatabase()
  const rows = await db.select<{ file_path: string }>('SELECT file_path FROM documents')
  return rows.map((row) => row.file_path)
}

/**
 * 轻量查询：按文件路径读取已索引文档的内容哈希，用于阅读成果来源锚点校验。
 * 文档未索引时返回 undefined；不加载 chunks/embeddings。
 */
export async function loadDocumentContentHashByPath(filePath: string): Promise<string | undefined> {
  if (!isDatabaseReady()) return undefined
  const db = getDatabase()
  const rows = await db.select<{ content_hash: string | null }>(
    'SELECT content_hash FROM documents WHERE file_path = $1',
    [filePath],
  )
  return rows[0]?.content_hash || undefined
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

export interface MemorySourceSnapshot {
  id: string
  sessionId: string
  role: 'user' | 'assistant'
  parentId: string | null
  content: string
  metadata: string | null
  createdAt: number
}

export interface MemorySourceGuard {
  id: string
  content: string
  snapshots?: readonly MemorySourceSnapshot[]
  lease?: { key: string; value: string }
}

// Snapshots are bound only to this statement, never stored as another copy of the conversation.
function encodeSourceSnapshots(source?: MemorySourceGuard): string | null {
  if (source?.snapshots === undefined) return null
  const snapshots = source.snapshots
  if (snapshots.length === 0 || snapshots.length > 12 || new Set(snapshots.map(item => item.id)).size !== snapshots.length
    || !snapshots.some(item => item.id === source.id && item.role === 'user' && item.content === source.content)
    || snapshots.some(item => typeof item.id !== 'string' || !item.id || item.id.length > 300
      || typeof item.sessionId !== 'string' || !item.sessionId || item.sessionId.length > 300 || item.sessionId !== snapshots[0].sessionId
      || !['user', 'assistant'].includes(item.role) || typeof item.content !== 'string'
      || !Number.isSafeInteger(item.createdAt) || item.createdAt <= 0
      || (item.parentId !== null && typeof item.parentId !== 'string')
      || (item.metadata !== null && typeof item.metadata !== 'string')
      || (item.role === 'assistant' && !snapshots.some(parent => parent.id === item.parentId && parent.role === 'user')))) {
    throw new Error('invalid_memory_source_snapshots')
  }
  return JSON.stringify(snapshots)
}

function sourceSnapshotsCondition(parameter: string): string {
  return `(${parameter} IS NULL OR NOT EXISTS (SELECT 1 FROM json_each(${parameter}) snapshot
    WHERE NOT EXISTS (SELECT 1 FROM chat_messages message
      WHERE message.id = json_extract(snapshot.value, '$.id')
        AND message.session_id = json_extract(snapshot.value, '$.sessionId')
        AND message.role = json_extract(snapshot.value, '$.role')
        AND message.parent_id IS json_extract(snapshot.value, '$.parentId')
        AND message.content = json_extract(snapshot.value, '$.content')
        AND message.metadata IS json_extract(snapshot.value, '$.metadata')
        AND message.created_at = json_extract(snapshot.value, '$.createdAt'))))`
}

function sourceLeaseParameters(source?: MemorySourceGuard): [string | null, string | null] {
  if (!source?.lease) return [null, null]
  const { key, value } = source.lease
  try {
    const lease: unknown = JSON.parse(value)
    if (!/^memory-extraction:v2:window:[a-f0-9]{64}$/.test(key) || !source.snapshots?.length
      || !lease || typeof lease !== 'object' || Array.isArray(lease)) throw new Error()
    const item = lease as Record<string, unknown>
    if (item.version !== 2 || item.status !== 'running' || typeof item.owner !== 'string' || !item.owner
      || typeof item.windowId !== 'string' || !item.windowId.startsWith(key + ':')
      || !Number.isSafeInteger(item.leaseUntil) || !Array.isArray(item.sourceIds) || !item.sourceIds.includes(source.id)
      || item.sourceIds.length < 1 || item.sourceIds.length > 4 || !Array.isArray(item.receiptValues)
      || item.receiptValues.length !== item.sourceIds.length || item.receiptValues.some(receipt => typeof receipt !== 'string')
      || !Array.isArray(item.prefixIds) || item.prefixIds.length > 2
      || (item.prefixIds.length > 0 && (!Array.isArray(item.prefixReceiptValues) || item.prefixReceiptValues.length !== item.prefixIds.length))
      || (Array.isArray(item.prefixReceiptValues) && item.prefixReceiptValues.some(receipt => typeof receipt !== 'string'))
      || source.snapshots.some(snapshot => snapshot.sessionId !== item.sessionId)) throw new Error()
    return [key, value]
  } catch { throw new Error('invalid_memory_source_lease') }
}

function sourceLeaseCondition(key: string, value: string): string {
  return `(${key} IS NULL OR EXISTS (SELECT 1 FROM settings lease_row WHERE lease_row.key = ${key} AND lease_row.value = ${value}
    AND CASE WHEN json_valid(lease_row.value) THEN json_extract(lease_row.value, '$.status') = 'running'
      AND json_extract(lease_row.value, '$.leaseUntil') > CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
      AND NOT EXISTS (SELECT 1 FROM json_each(lease_row.value, '$.sourceIds') entry
        WHERE NOT EXISTS (SELECT 1 FROM settings receipt WHERE receipt.key = 'memory-extraction:v2:intake:' || entry.value
          AND receipt.value = json_extract(lease_row.value, '$.receiptValues[' || entry.key || ']')))
      AND NOT EXISTS (SELECT 1 FROM json_each(lease_row.value, '$.prefixIds') entry
        WHERE NOT EXISTS (SELECT 1 FROM settings receipt WHERE receipt.key = 'memory-extraction:v2:intake:' || entry.value
          AND receipt.value = json_extract(lease_row.value, '$.prefixReceiptValues[' || entry.key || ']'))) ELSE 0 END))`
}

export async function persistMemory(memory: Memory, insertOnly = false, source?: MemorySourceGuard): Promise<boolean> {
  if (!isDatabaseReady()) return false
  const db = getDatabase()
  const result = await db.execute(
    `INSERT OR ${insertOnly ? 'IGNORE' : 'REPLACE'} INTO memories (
       id, content, category, source, locked, status, scope_type, scope_key,
       subject, fact_key, fact_value, confidence, evidence, supersedes_id,
       embedding, embedding_model, content_hash, created_at, updated_at
     ) SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19
       WHERE ($20 IS NULL OR EXISTS (SELECT 1 FROM chat_messages WHERE id = $20 AND role = 'user' AND content = $21))
       AND ${sourceSnapshotsCondition('$23')}
       AND ${sourceLeaseCondition('$24', '$25')}
       AND ($22 = 0 OR NOT EXISTS (SELECT 1 FROM memories existing WHERE existing.status = 'active'
         AND existing.category = $3 AND COALESCE(existing.scope_type, 'global') = $7 AND COALESCE(existing.scope_key, '') = COALESCE($8, '')
         AND lower(trim(existing.subject)) = lower(trim($9)) AND lower(trim(existing.fact_key)) = lower(trim($10)) AND existing.id <> $1))`,
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
      source?.id || null,
      source?.content || null,
      memory.status === 'active' && memory.source === 'auto_extracted' ? 1 : 0,
      encodeSourceSnapshots(source),
      ...sourceLeaseParameters(source),
    ]
  )
  return result.rowsAffected === 1
}

/** Optimistic single-row update: background work cannot overwrite manual edits or recreate a deleted row. */
export async function updateMemoryIfUnchanged(memory: Memory, expected: Memory, source?: MemorySourceGuard): Promise<boolean> {
  if (!isDatabaseReady()) return false
  const result = await getDatabase().execute(
    `UPDATE memories SET content = $1, subject = $2, fact_key = $3, fact_value = $4,
       confidence = $5, evidence = $6, supersedes_id = $7, embedding = $8,
       embedding_model = $9, content_hash = $10, updated_at = $11, status = $21
     WHERE id = $12 AND content = $13 AND status = $14 AND source = $15
       AND locked = 0 AND CASE WHEN updated_at > 0 AND updated_at < 1000000000000 THEN updated_at * 1000 ELSE updated_at END = $16
       AND COALESCE(scope_type, 'global') = $17 AND COALESCE(scope_key, '') = $18
       AND ($19 IS NULL OR EXISTS (SELECT 1 FROM chat_messages WHERE id = $19 AND role = 'user' AND content = $20))
       AND ${sourceSnapshotsCondition('$23')}
       AND ${sourceLeaseCondition('$24', '$25')}
       AND ($21 <> 'active' OR NOT EXISTS (SELECT 1 FROM memories existing WHERE existing.status = 'active'
         AND existing.category = $22 AND COALESCE(existing.scope_type, 'global') = $17 AND COALESCE(existing.scope_key, '') = $18
         AND lower(trim(existing.subject)) = lower(trim($2)) AND lower(trim(existing.fact_key)) = lower(trim($3)) AND existing.id <> $12))`,
    [memory.content, memory.subject || null, memory.factKey || null, memory.factValue || null,
      memory.confidence ?? 0.7, memory.evidence || null, memory.supersedesId || null,
      memory.embedding ? JSON.stringify(memory.embedding) : null, memory.embeddingModel || null,
      memory.contentHash || null, memory.updatedAt, expected.id, expected.content,
      expected.status, expected.source, expected.updatedAt, expected.scopeType || 'global', expected.scopeKey || '', source?.id || null, source?.content || null,
      memory.status, memory.category, encodeSourceSnapshots(source), ...sourceLeaseParameters(source)],
  )
  return result.rowsAffected === 1
}

export async function removeMemoryIfUnchanged(expected: Memory, source?: MemorySourceGuard): Promise<boolean> {
  if (!isDatabaseReady()) return false
  const result = await getDatabase().execute(
    `DELETE FROM memories WHERE id = $1 AND content = $2
       AND CASE WHEN updated_at > 0 AND updated_at < 1000000000000 THEN updated_at * 1000 ELSE updated_at END = $3
       AND source = 'auto_extracted' AND status = 'candidate' AND locked = 0
       AND COALESCE(scope_type, 'global') = $4 AND COALESCE(scope_key, '') = $5
       AND ($6 IS NULL OR EXISTS (SELECT 1 FROM chat_messages WHERE id = $6 AND role = 'user' AND content = $7))
       AND ${sourceSnapshotsCondition('$8')}
       AND ${sourceLeaseCondition('$9', '$10')}`,
    [expected.id, expected.content, expected.updatedAt, expected.scopeType || 'global', expected.scopeKey || '', source?.id || null, source?.content || null,
      encodeSourceSnapshots(source), ...sourceLeaseParameters(source)],
  )
  return result.rowsAffected === 1
}

/** A cache fill is deliberately not a business-data upsert. */
export async function persistMemoryEmbedding(
  memory: Pick<Memory, 'id' | 'content' | 'contentHash'>,
  embedding: number[],
  model: string | null,
  nextHash: string,
): Promise<boolean> {
  if (!isDatabaseReady() || !embedding.length || !embedding.every(Number.isFinite)) return false
  const result = await getDatabase().execute(
    `UPDATE memories SET embedding = $1, embedding_model = $2, content_hash = $3
       WHERE id = $4 AND content = $5 AND COALESCE(content_hash, '') = $6 AND status = 'active'`,
    [JSON.stringify(embedding), model, nextHash, memory.id, memory.content, memory.contentHash || ''],
  )
  return result.rowsAffected === 1
}

export interface LoadMemoryOptions extends Omit<MemoryQueryFilters, 'statuses'> {
  statuses?: readonly MemoryStatus[]
}

interface MemoryRow {
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
  embedding?: string | null
  embedding_model: string | null
  content_hash: string | null
}

function mapMemoryRow(row: MemoryRow): Memory {
  return {
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
  }
}

export async function loadMemories(options: LoadMemoryOptions = {}): Promise<Memory[]> {
  if (!isDatabaseReady()) return []
  const db = getDatabase()
  const query = buildMemoryQuery(options)
  const rows = await db.select<MemoryRow>(query.sql, query.params)
  return rows.map(mapMemoryRow)
}

export interface MemoryPage {
  memories: Memory[]
  total: number
}

export async function loadMemoryCount(options: LoadMemoryOptions = {}): Promise<number> {
  if (!isDatabaseReady()) return 0
  const query = buildMemoryCountQuery(options)
  const rows = await getDatabase().select<{ total: number }>(query.sql, query.params)
  return Number(rows[0]?.total) || 0
}

export async function loadMemoryPage(
  options: LoadMemoryOptions & { limit: number; offset?: number }
): Promise<MemoryPage> {
  const [memories, total] = await Promise.all([
    loadMemories({ ...options, includeEmbedding: false }),
    loadMemoryCount(options),
  ])
  return { memories, total }
}

export async function loadAllMemories(category?: string, statuses?: MemoryStatus[]): Promise<Memory[]> {
  return loadMemories({ category, statuses, includeEmbedding: true })
}

export async function loadMemoryEmbeddings(ids: readonly string[]): Promise<Map<string, Pick<Memory, 'embedding' | 'embeddingModel' | 'contentHash'>>> {
  if (!isDatabaseReady()) return new Map()
  const query = buildMemoryEmbeddingQuery(ids)
  if (!query) return new Map()
  const rows = await getDatabase().select<{
    id: string
    embedding: string | null
    embedding_model: string | null
    content_hash: string | null
  }>(query.sql, query.params)
  return new Map(rows.map((row) => [row.id, {
    embedding: row.embedding ? safeParseEmbedding(row.embedding) : null,
    embeddingModel: row.embedding_model || null,
    contentHash: row.content_hash || null,
  }]))
}

export async function loadMemorySourceMessages(references: readonly { id: string; sessionId: string }[]): Promise<Array<{ id: string; content: string; created_at: number }>> {
  if (!isDatabaseReady() || references.length === 0) return []
  const selected = references.slice(0, 2)
  const params = selected.flatMap(reference => [reference.id, reference.sessionId])
  const conditions = selected.map((_, index) => `(id = $${index * 2 + 1} AND session_id = $${index * 2 + 2})`).join(' OR ')
  return getDatabase().select(
    `SELECT id, created_at, substr(CASE WHEN metadata IS NULL THEN
       CASE WHEN instr(content, '【上下文') > 0 THEN '' ELSE content END
     WHEN json_valid(metadata) THEN CASE WHEN json_type(metadata) <> 'object' THEN ''
       WHEN json_type(metadata, '$.hidden') IS NOT NULL AND json_type(metadata, '$.hidden') <> 'false' THEN ''
       WHEN json_type(metadata, '$.displayContent') = 'text' THEN json_extract(metadata, '$.displayContent')
       WHEN json_type(metadata, '$.displayContent') IS NOT NULL OR json_type(metadata, '$.tags') IS NOT NULL
         OR instr(content, '【上下文') > 0 THEN '' ELSE content END
     ELSE '' END, 1, 3001) AS content
     FROM chat_messages WHERE role = 'user' AND (${conditions}) LIMIT 2`, params,
  )
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

export async function confirmMemoryCandidate(id: string, coexist = false): Promise<boolean> {
  if (!isDatabaseReady()) return false
  return invoke<boolean>('confirm_memory_candidate_transaction', coexist ? { id, coexist: true } : { id })
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
    'SELECT * FROM chat_messages WHERE session_id = $1 ORDER BY created_at ASC, rowid ASC',
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
  const { loadReadingArtifactsForBackup } = await import('./readingArtifacts')
  const artifacts = await loadReadingArtifactsForBackup()
  const { loadReadingRemindersForBackup } = await import('./readingReminders')
  const readingReminders = await loadReadingRemindersForBackup()
  const { loadAllReadingMarksForBackup } = await import('./readingMarks')
  const readingMarks = await loadAllReadingMarksForBackup()
  const organization = await loadArtifactOrganization()
  return {
    version: 1,
    exportedAt: Date.now(),
    sessions: serializedSessions,
    memories,
    artifacts,
    readingReminders,
    readingMarks,
    artifactCategories: organization.categories,
    artifactOrganization: organization.entries,
    note: '不包含 API Key 等敏感密钥。知识库文档索引可在新环境通过工作区重建恢复。',
  }
}

export async function importBackupPayload(payload: BackupPayload): Promise<{ sessions: number; messages: number; memories: number; artifacts: number; readingReminders: number; readingMarks: number }> {
  if (payload.version !== 1) {
    throw new Error(`不支持的备份版本：${payload.version}`)
  }
  return invoke('import_backup_transaction', { payload })
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
