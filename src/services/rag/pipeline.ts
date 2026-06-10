import type { Document, Chunk, SearchResult, RAGConfig } from './types'
import { chunkMarkdown } from './chunker'
import { vectorStore } from './vectorStore'
import { getEmbeddingClient, isEmbeddingReady } from '@/services/ai/aiClient'
import {
  loadAllDocuments,
  listEmbeddingJobs,
  removeEmbeddingJobByPath,
  retryFailedEmbeddingJobsInDatabase,
  updateEmbeddingJobStatus,
  upsertEmbeddingJob,
} from '@/services/database/persistence'
import { normalizeFilePath } from '@/services/pathIdentity'

export interface RAGStats {
  documents: number
  totalChunks: number
  embeddedChunks: number
  pendingEmbeddings: number
}

export interface EmbedResult {
  embedded: number
  failed: number
  errors: string[]
}

export interface EmbeddingJobStats {
  pending: number
  running: number
  done: number
  failed: number
}

export type KnowledgeIndexState = 'PENDING' | 'CHUNKED' | 'EMBEDDING' | 'INDEXED' | 'FAILED'

export interface KnowledgeDocumentState {
  filePath: string
  title: string
  state: KnowledgeIndexState
  totalChunks: number
  embeddedChunks: number
}

const DEFAULT_CONFIG: RAGConfig = {
  chunkSize: 900,
  chunkOverlap: 150,
  topK: 5,
  similarityThreshold: 0.5,
  keywordSearchEnabled: true,
  preferCurrentFile: true,
  preferRecentDocuments: false,
}

let ragConfig: RAGConfig = { ...DEFAULT_CONFIG }
let embeddingQueuePromise: Promise<EmbedResult> | null = null
let embeddingQueueRerunRequested = false
let hydratePromise: Promise<void> | null = null

export function updateRagConfig(config: Partial<RAGConfig>): void {
  ragConfig = { ...ragConfig, ...config }
}

export function getRagConfig(): RAGConfig {
  return { ...ragConfig }
}

export function getDefaultConfig(): RAGConfig {
  return { ...DEFAULT_CONFIG }
}

/**
 * Ingest a document: chunk it and store in vector store.
 * Atomic: creates new doc first, then replaces old one if exists.
 */
export function ingestDocument(
  filePath: string,
  title: string,
  content: string
): Document | null {
  if (!content.trim()) {
    console.warn('ingestDocument: empty content, skipping')
    return null
  }
  if (!filePath) {
    console.warn('ingestDocument: empty filePath, skipping')
    return null
  }

  const existing = vectorStore.findByFilePath(filePath)
  const docId = existing?.id || `doc-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`

  const chunks = chunkMarkdown(content, docId, {
    chunkSize: ragConfig.chunkSize,
    overlap: ragConfig.chunkOverlap,
  })

  if (chunks.length === 0) {
    console.warn('ingestDocument: no meaningful chunks, skipping')
    return null
  }

  const doc: Document = {
    id: docId,
    filePath,
    title,
    content,
    lastModified: Date.now(),
    chunks,
  }

  if (existing) {
    vectorStore.removeDocument(existing.id)
  }
  vectorStore.addDocument(doc)

  return doc
}

export async function enqueueEmbeddingJob(doc: Document): Promise<void> {
  await upsertEmbeddingJob(doc)
}

async function hydrateVectorStoreFromDatabase(): Promise<void> {
  if (hydratePromise) return hydratePromise
  hydratePromise = vectorStore.loadFromDatabase().finally(() => {
    hydratePromise = null
  })
  return hydratePromise
}

async function getDocumentForJob(documentId: string, filePath: string): Promise<Document | undefined> {
  let doc = vectorStore.getDocument(documentId) || vectorStore.findByFilePath(filePath)
  if (doc) return doc

  await hydrateVectorStoreFromDatabase()
  doc = vectorStore.getDocument(documentId) || vectorStore.findByFilePath(filePath)
  return doc
}

async function getRagDocuments(): Promise<Document[]> {
  let docs = vectorStore.getAllDocuments()
  if (docs.length > 0 || vectorStore.persistenceEnabled) return docs

  await hydrateVectorStoreFromDatabase()
  docs = vectorStore.getAllDocuments()
  if (docs.length > 0) return docs

  return loadAllDocuments()
}

/**
 * Internal: embed chunks in batches of up to 100 per API call.
 */
async function embedChunks(chunks: Chunk[]): Promise<EmbedResult> {
  const client = getEmbeddingClient()
  const result: EmbedResult = { embedded: 0, failed: 0, errors: [] }
  const BATCH_SIZE = 100

  for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
    const batch = chunks.slice(i, i + BATCH_SIZE)
    const texts = batch.map((c) => c.content)

    try {
      const embeddings = await client.batchEmbedding(texts)
      for (let j = 0; j < batch.length; j++) {
        if (embeddings[j]) {
          batch[j].embedding = embeddings[j]
          result.embedded++
        } else {
          result.failed++
          result.errors.push(`chunk ${batch[j].id}: no embedding returned`)
        }
      }
    } catch (err) {
      // If batch fails, fall back to serial
      const msg = err instanceof Error ? err.message : String(err)
      console.warn(`Batch embedding failed, falling back to serial: ${msg}`)
      for (const chunk of batch) {
        try {
          const response = await client.embedding(chunk.content)
          chunk.embedding = response.embedding
          result.embedded++
        } catch (serialErr) {
          result.failed++
          const serialMsg = serialErr instanceof Error ? serialErr.message : String(serialErr)
          result.errors.push(`chunk ${chunk.id}: ${serialMsg}`)
        }
      }
    }
  }

  return result
}

/**
 * Generate embeddings for all chunks in a document.
 */
export async function embedDocument(doc: Document): Promise<EmbedResult> {
  if (!isEmbeddingReady()) {
    throw new Error('Embedding client not initialized. Configure embedding API first.')
  }

  const result = await embedChunks(doc.chunks)
  vectorStore.addDocument(doc)
  await vectorStore.flushPersistence()
  return result
}

async function processEmbeddingQueueInternal(): Promise<EmbedResult> {
  if (!isEmbeddingReady()) {
    throw new Error('Embedding client not initialized. Configure embedding API first.')
  }

  const total: EmbedResult = { embedded: 0, failed: 0, errors: [] }

  while (true) {
    const jobs = await listEmbeddingJobs(['pending', 'running'])
    if (jobs.length === 0) break

    for (const job of jobs) {
      const doc = await getDocumentForJob(job.documentId, job.filePath)
      if (!doc) {
        await removeEmbeddingJobByPath(job.filePath)
        total.errors.push(`${job.filePath}: removed stale embedding job`)
        continue
      }

      await updateEmbeddingJobStatus(job.id, 'running')
      try {
        const pending = doc.chunks.filter((chunk) => !chunk.embedding)
        const result = pending.length > 0 ? await embedChunks(pending) : { embedded: 0, failed: 0, errors: [] }
        total.embedded += result.embedded
        total.failed += result.failed
        total.errors.push(...result.errors)
        vectorStore.addDocument(doc)
        await vectorStore.flushPersistence()
        await updateEmbeddingJobStatus(
          job.id,
          result.failed > 0 ? 'failed' : 'done',
          result.errors.join('\n') || null
        )
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        await updateEmbeddingJobStatus(job.id, 'failed', message)
        total.failed++
        total.errors.push(`${job.filePath}: ${message}`)
      }
    }
  }

  return total
}

export async function processEmbeddingQueue(): Promise<EmbedResult> {
  if (embeddingQueuePromise) {
    embeddingQueueRerunRequested = true
    return embeddingQueuePromise
  }

  embeddingQueuePromise = (async () => {
    const total: EmbedResult = { embedded: 0, failed: 0, errors: [] }
    do {
      embeddingQueueRerunRequested = false
      const result = await processEmbeddingQueueInternal()
      total.embedded += result.embedded
      total.failed += result.failed
      total.errors.push(...result.errors)
    } while (embeddingQueueRerunRequested)
    return total
  })()
  try {
    return await embeddingQueuePromise
  } finally {
    embeddingQueuePromise = null
  }
}

export async function retryFailedEmbeddingJobs(): Promise<void> {
  await retryFailedEmbeddingJobsInDatabase()
}

export async function getEmbeddingJobStats(): Promise<EmbeddingJobStats> {
  const jobs = await listEmbeddingJobs()
  return jobs.reduce<EmbeddingJobStats>(
    (stats, job) => {
      stats[job.status]++
      return stats
    },
    { pending: 0, running: 0, done: 0, failed: 0 }
  )
}

function deriveKnowledgeIndexState(
  totalChunks: number,
  embeddedChunks: number,
  jobStatus?: 'pending' | 'running' | 'done' | 'failed'
): KnowledgeIndexState {
  if (jobStatus === 'failed') return 'FAILED'
  if (totalChunks === 0) return 'PENDING'
  if (embeddedChunks >= totalChunks) return 'INDEXED'
  if (jobStatus === 'running' || embeddedChunks > 0) return 'EMBEDDING'
  return 'CHUNKED'
}

export async function getKnowledgeDocumentStates(): Promise<KnowledgeDocumentState[]> {
  const docs = await getRagDocuments()
  const jobs = await listEmbeddingJobs()
  const jobByPath = new Map(jobs.map((job) => [normalizeFilePath(job.filePath), job]))
  const docPathSet = new Set(docs.map((doc) => normalizeFilePath(doc.filePath)))

  const states: KnowledgeDocumentState[] = docs.map((doc) => {
    const embeddedChunks = doc.chunks.filter((chunk) => chunk.embedding).length
    const totalChunks = doc.chunks.length
    return {
      filePath: doc.filePath,
      title: doc.title,
      state: deriveKnowledgeIndexState(totalChunks, embeddedChunks, jobByPath.get(normalizeFilePath(doc.filePath))?.status),
      totalChunks,
      embeddedChunks,
    }
  })

  for (const job of jobs) {
    if (!docPathSet.has(normalizeFilePath(job.filePath))) {
      await removeEmbeddingJobByPath(job.filePath)
      continue
    }
    if (states.some((item) => normalizeFilePath(item.filePath) === normalizeFilePath(job.filePath))) continue
    states.push({
      filePath: job.filePath,
      title: job.filePath,
      state: job.status === 'failed' ? 'FAILED' : 'PENDING',
      totalChunks: 0,
      embeddedChunks: 0,
    })
  }

  return states
}

export async function getKnowledgeIndexStateSummary(): Promise<Record<KnowledgeIndexState, number>> {
  const counts: Record<KnowledgeIndexState, number> = {
    PENDING: 0,
    CHUNKED: 0,
    EMBEDDING: 0,
    INDEXED: 0,
    FAILED: 0,
  }

  const states = await getKnowledgeDocumentStates()
  for (const item of states) {
    counts[item.state] += 1
  }
  return counts
}

/**
 * Embed all chunks that don't have embeddings yet.
 */
export async function embedPendingChunks(): Promise<EmbedResult> {
  if (!isEmbeddingReady()) {
    throw new Error('Embedding client not initialized. Configure embedding API first.')
  }

  const docs = await getRagDocuments()
  const total: EmbedResult = { embedded: 0, failed: 0, errors: [] }

  for (const doc of docs) {
    const pending = doc.chunks.filter((c) => !c.embedding)
    if (pending.length === 0) continue

    const result = await embedChunks(pending)
    total.embedded += result.embedded
    total.failed += result.failed
    total.errors.push(...result.errors)
    vectorStore.addDocument(doc)
    await vectorStore.flushPersistence()
  }

  return total
}

/**
 * Search for relevant chunks using embeddings or keyword fallback.
 * @param filePaths - 可选的文件路径过滤（用于用户显式添加的上下文文件范围）
 */
export async function searchRelevant(
  query: string,
  options?: Partial<RAGConfig> & { filePaths?: string[]; currentFilePath?: string; signal?: AbortSignal }
): Promise<SearchResult[]> {
  if (!query.trim()) return []

  const topK = options?.topK ?? ragConfig.topK
  const threshold = options?.similarityThreshold ?? ragConfig.similarityThreshold
  const filePaths = options?.filePaths
  const keywordSearchEnabled = options?.keywordSearchEnabled ?? ragConfig.keywordSearchEnabled
  const preferCurrentFile = options?.preferCurrentFile ?? ragConfig.preferCurrentFile
  const preferRecentDocuments = options?.preferRecentDocuments ?? ragConfig.preferRecentDocuments

  if (vectorStore.documentCount === 0) {
    await hydrateVectorStoreFromDatabase()
  }

  let queryEmbedding: number[] | null = null
  if (isEmbeddingReady()) {
    try {
      const client = getEmbeddingClient()
      const response = await client.embedding(query, options?.signal)
      queryEmbedding = response.embedding
    } catch (err) {
      console.warn('Vector search failed, using keyword-only search:', err)
    }
  }

  return vectorStore.hybridSearch(query, queryEmbedding, topK, threshold, {
    filePaths,
    keywordSearchEnabled,
    currentFilePath: options?.currentFilePath,
    preferCurrentFile,
    preferRecentDocuments,
  })
}

export async function getRagStatsAsync(): Promise<RAGStats> {
  const docs = await getRagDocuments()
  const totalChunks = docs.reduce((count, doc) => count + doc.chunks.length, 0)
  const embeddedChunks = docs.reduce(
    (count, doc) => count + doc.chunks.filter((chunk) => chunk.embedding).length,
    0
  )

  return {
    documents: docs.length,
    totalChunks,
    embeddedChunks,
    pendingEmbeddings: totalChunks - embeddedChunks,
  }
}

/**
 * Build context string from search results for AI prompt.
 */
export function buildContext(results: SearchResult[], maxChars = 6000): string {
  if (results.length === 0) return ''

  const parts: string[] = []
  let usedChars = 0

  for (const [i, r] of results.entries()) {
    const source = r.document.title || r.document.filePath
    const titlePath = r.chunk.titlePath?.length ? r.chunk.titlePath.join(' > ') : r.chunk.heading || '未命名位置'
    const part = [
      `[知识来源 ${i + 1}]`,
      `来源：${source}`,
      `文件：${r.document.filePath}`,
      `位置：${titlePath}`,
      `行号：${r.chunk.startLine}-${r.chunk.endLine}`,
      `检索：${r.retrievalMode}，相关度 ${r.score.toFixed(3)}`,
      '内容：',
      r.chunk.content,
    ].join('\n')

    const remaining = maxChars - usedChars
    if (remaining <= 240) break
    if (part.length > remaining) {
      parts.push(`${part.slice(0, remaining)}\n...（知识库上下文已截断）`)
      break
    }
    parts.push(part)
    usedChars += part.length
  }

  if (parts.length === 0) return ''
  return `【知识库检索结果】\n${parts.join('\n\n---\n\n')}`
}

/**
 * Get stats about the vector store.
 */
export function getRagStats(): RAGStats {
  const docs = vectorStore.getAllDocuments()
  const totalChunks = vectorStore.chunkCount
  const embeddedChunks = docs.reduce(
    (count, doc) => count + doc.chunks.filter((c) => c.embedding).length,
    0
  )

  return {
    documents: docs.length,
    totalChunks,
    embeddedChunks,
    pendingEmbeddings: totalChunks - embeddedChunks,
  }
}

/**
 * Remove a document from the vector store.
 */
export function removeDocument(filePath: string): boolean {
  const doc = vectorStore.findByFilePath(filePath)
  if (doc) {
    vectorStore.removeDocument(doc.id)
    return true
  }
  return false
}

export { vectorStore }
