import type { Document, Chunk, SearchResult, RAGConfig, RAGContextBuildOptions, RAGContextBuildResult } from './types'
import { chunkMarkdown } from './chunker'
import { createExactContentHash } from './contentHash'
import {
  averageEmbeddingVectors,
  buildEmbeddingInputs,
  createEmbeddingInputHash,
  EMBEDDING_PREPROCESS_VERSION,
  type EmbeddingInputPart,
} from './embeddingInput'
import { canSkipDocumentIndex, canSkipDocumentIndexMetadata, reconcileDocumentChunks, type IndexUpdateStats } from './reconciler'
import { vectorStore } from './vectorStore'
import { getEmbeddingClient, getEmbeddingConfig, isEmbeddingReady } from '@/services/ai/aiClient'
import {
  loadDocumentByFilePath,
  loadDocumentById,
  loadDocumentIndexMetadata,
  loadKnowledgeDocumentSummaries,
  loadRagStatsAggregate,
  listEmbeddingJobs,
  removeEmbeddingJobByPath,
  retryFailedEmbeddingJobsInDatabase,
  updateEmbeddingJobStatus,
  upsertEmbeddingJob,
} from '@/services/database/persistence'
import { normalizeFilePath } from '@/services/pathIdentity'
import { prepareNativeRagIndex, refreshNativeRagIndexDocument, searchNativeRagIndex, type RagSearchProgress } from './nativeIndex'

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
  topK: 5,
  similarityThreshold: 0.5,
  keywordSearchEnabled: true,
  preferCurrentFile: true,
  preferRecentDocuments: false,
}

let ragConfig: RAGConfig = { ...DEFAULT_CONFIG }
let embeddingQueuePromise: Promise<EmbedResult> | null = null
let embeddingQueueRerunRequested = false
const documentOperations = new Map<string, Promise<void>>()

export type IngestDocumentResult =
  | { unchanged: true; stats: IndexUpdateStats }
  | { unchanged: false; document: Document; stats: IndexUpdateStats }

export async function runSerializedDocumentOperation<T>(
  filePath: string,
  operation: () => Promise<T>,
): Promise<T> {
  const key = normalizeFilePath(filePath)
  const previous = documentOperations.get(key) || Promise.resolve()
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const queued = previous.catch(() => undefined).then(() => gate)
  documentOperations.set(key, queued)
  await previous.catch(() => undefined)
  try {
    return await operation()
  } finally {
    release()
    if (documentOperations.get(key) === queued) documentOperations.delete(key)
  }
}

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
export async function ingestDocument(
  filePath: string,
  title: string,
  content: string
): Promise<IngestDocumentResult | null> {
  if (!filePath) {
    console.warn('ingestDocument: empty filePath, skipping')
    return null
  }

  const contentHash = await createExactContentHash(content)
  const embeddingModel = getEmbeddingConfig()?.embeddingModel || null
  let existing = vectorStore.findByFilePath(filePath)

  if (existing && canSkipDocumentIndex(existing, contentHash, embeddingModel, title)) {
    return {
      stats: {
        total: existing.chunks.length,
        reused: existing.chunks.filter((chunk) => Boolean(chunk.embedding)).length,
        added: 0,
        deleted: 0,
        reembedded: 0,
      },
      unchanged: true,
    }
  }

  if (!existing) {
    const metadata = await loadDocumentIndexMetadata(
      filePath,
      embeddingModel,
      EMBEDDING_PREPROCESS_VERSION,
    )
    if (canSkipDocumentIndexMetadata(metadata, contentHash, embeddingModel, title)) {
      return {
        stats: {
          total: metadata!.totalChunks,
          reused: metadata!.embeddedChunks,
          added: 0,
          deleted: 0,
          reembedded: 0,
        },
        unchanged: true,
      }
    }
    existing = await loadDocumentByFilePath(filePath)
  }

  const docId = existing?.id || `doc-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`

  const chunks = chunkMarkdown(content, docId)

  const nextDocument = {
    id: docId,
    filePath,
    title,
    content,
    contentHash,
    lastModified: Date.now(),
  }
  const reconciled = await reconcileDocumentChunks(
    existing,
    nextDocument,
    chunks,
    embeddingModel,
  )
  return { ...reconciled, unchanged: false }
}

export async function enqueueEmbeddingJob(doc: Document): Promise<void> {
  await upsertEmbeddingJob(doc)
}

async function getDocumentForJob(documentId: string, filePath: string): Promise<Document | undefined> {
  let doc = vectorStore.getDocument(documentId) || vectorStore.findByFilePath(filePath)
  if (doc) return doc
  return (await loadDocumentById(documentId)) || loadDocumentByFilePath(filePath)
}

/**
 * Internal: embed chunks in batches of up to 100 per API call.
 */
async function embedChunks(chunks: Chunk[], documentTitle = ''): Promise<EmbedResult> {
  const client = getEmbeddingClient()
  const embeddingModel = getEmbeddingConfig()?.embeddingModel || null
  const result: EmbedResult = { embedded: 0, failed: 0, errors: [] }
  const BATCH_SIZE = 100

  interface EmbeddingWorkItem extends EmbeddingInputPart {
    chunk: Chunk
    partCount: number
  }

  await Promise.all(chunks.map(async (chunk) => {
    chunk.embeddingInputHash = await createEmbeddingInputHash(chunk, documentTitle)
    chunk.embeddingModel = embeddingModel
    chunk.embeddingPreprocessVersion = EMBEDDING_PREPROCESS_VERSION
  }))
  const workItems = chunks.flatMap((chunk) => {
    const parts = buildEmbeddingInputs(chunk, undefined, documentTitle)
    return parts.map((part): EmbeddingWorkItem => ({ ...part, chunk, partCount: parts.length }))
  })
  const vectorsByChunk = new Map<string, number[][]>()

  const recordFailure = (item: EmbeddingWorkItem, reason: string): void => {
    result.errors.push(
      `chunk ${item.chunk.id} input ${item.partIndex + 1}/${item.partCount} lines ${item.startLine}-${item.endLine}: ${reason}`,
    )
  }
  const recordVector = (item: EmbeddingWorkItem, vector: number[] | undefined): void => {
    if (!vector?.length || vector.some((value) => !Number.isFinite(value))) {
      recordFailure(item, 'invalid embedding response')
      return
    }
    const vectors = vectorsByChunk.get(item.chunk.id) || []
    if (vectors[0] && vectors[0].length !== vector.length) {
      recordFailure(item, 'embedding dimension mismatch')
      return
    }
    vectors.push(vector)
    vectorsByChunk.set(item.chunk.id, vectors)
  }

  for (let i = 0; i < workItems.length; i += BATCH_SIZE) {
    const batch = workItems.slice(i, i + BATCH_SIZE)
    const texts = batch.map((item) => item.text)

    try {
      const embeddings = await client.batchEmbedding(texts)
      for (let j = 0; j < batch.length; j++) {
        recordVector(batch[j], embeddings[j])
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      // 网络错误（本地服务不可用等）直接抛出，不逐个重试
      if (msg.includes('连接失败') || msg.includes('Failed to fetch') || msg.includes('ECONNREFUSED') || msg.includes('timeout')) {
        throw err
      }
      // 其他错误（如单条文本过长）fallback 到逐个重试
      console.warn('Batch embedding failed, falling back to bounded serial retries')
      for (const item of batch) {
        try {
          const response = await client.embedding(item.text)
          recordVector(item, response.embedding)
        } catch {
          recordFailure(item, 'embedding request failed')
        }
      }
    }
  }

  for (const chunk of chunks) {
    const embedding = averageEmbeddingVectors(vectorsByChunk.get(chunk.id) || [])
    if (embedding) {
      chunk.embedding = embedding
      result.embedded += 1
    } else {
      chunk.embedding = undefined
      result.failed += 1
      if (!result.errors.some((error) => error.startsWith(`chunk ${chunk.id} `))) {
        result.errors.push(`chunk ${chunk.id}: no valid embedding returned`)
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

  const result = await embedChunks(doc.chunks, doc.title)
  vectorStore.addDocument(doc)
  await vectorStore.flushPersistence()
  await refreshNativeRagIndexDocument(doc.filePath)
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
      await runSerializedDocumentOperation(job.filePath, async () => {
        const doc = await getDocumentForJob(job.documentId, job.filePath)
        if (!doc) {
          await removeEmbeddingJobByPath(job.filePath)
          total.errors.push(`${job.filePath}: removed stale embedding job`)
          return
        }

        await updateEmbeddingJobStatus(job.id, 'running')
        try {
        const pending = doc.chunks.filter((chunk) => !chunk.embedding)
        const result = pending.length > 0 ? await embedChunks(pending, doc.title) : { embedded: 0, failed: 0, errors: [] }
        total.embedded += result.embedded
        total.failed += result.failed
        total.errors.push(...result.errors)
        vectorStore.addDocument(doc)
        await vectorStore.flushPersistence()
        await refreshNativeRagIndexDocument(doc.filePath)
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
      })
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
  const docs = await loadKnowledgeDocumentSummaries()
  const jobs = await listEmbeddingJobs()
  const jobByPath = new Map(jobs.map((job) => [normalizeFilePath(job.filePath), job]))
  const docPathSet = new Set(docs.map((doc) => normalizeFilePath(doc.filePath)))

  const states: KnowledgeDocumentState[] = docs.map((doc) => {
    const { embeddedChunks, totalChunks } = doc
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

  const summaries = await loadKnowledgeDocumentSummaries()
  const total: EmbedResult = { embedded: 0, failed: 0, errors: [] }

  for (const summary of summaries) {
    if (summary.embeddedChunks >= summary.totalChunks) continue
    const doc = await loadDocumentById(summary.id)
    if (!doc) continue
    const pending = doc.chunks.filter((c) => !c.embedding)
    if (pending.length === 0) continue

    const result = await embedChunks(pending, doc.title)
    total.embedded += result.embedded
    total.failed += result.failed
    total.errors.push(...result.errors)
    vectorStore.addDocument(doc)
    await vectorStore.flushPersistence()
    await refreshNativeRagIndexDocument(doc.filePath)
  }

  return total
}

/**
 * Search for relevant chunks using embeddings or keyword fallback.
 * @param filePaths - 可选的文件路径过滤（用于用户显式添加的上下文文件范围）
 */
async function searchRelevantInner(
  query: string,
  options?: Partial<RAGConfig> & {
    filePaths?: string[]
    currentFilePath?: string
    signal?: AbortSignal
    onProgress?: (progress: RagSearchProgress) => void
  }
): Promise<SearchResult[]> {
  if (!query.trim()) return []

  const topK = options?.topK ?? ragConfig.topK
  const threshold = options?.similarityThreshold ?? ragConfig.similarityThreshold
  const filePaths = options?.filePaths
  const keywordSearchEnabled = options?.keywordSearchEnabled ?? ragConfig.keywordSearchEnabled
  const preferCurrentFile = options?.preferCurrentFile ?? ragConfig.preferCurrentFile
  const preferRecentDocuments = options?.preferRecentDocuments ?? ragConfig.preferRecentDocuments
  const indexPromise = prepareNativeRagIndex(options?.onProgress, options?.signal)
  const embeddingPromise = (async (): Promise<number[] | null> => {
    if (!isEmbeddingReady()) return null
    try {
      const client = getEmbeddingClient()
      const response = await client.embedding(query, options?.signal)
      return response.embedding
    } catch (err) {
      console.warn('Vector search failed, using keyword-only search:', err)
      return null
    }
  })()
  const [indexMode, queryEmbedding] = await Promise.all([indexPromise, embeddingPromise])
  if (indexMode === 'ready' && typeof requestAnimationFrame === 'function') {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  }

  return searchNativeRagIndex({
    queryText: query,
    queryVector: queryEmbedding,
    topK,
    threshold,
    filePaths,
    keywordSearchEnabled,
    currentFilePath: options?.currentFilePath,
    preferCurrentFile,
    preferRecentDocuments,
    keywordOnlyFallback: indexMode === 'fallback',
  }, options?.onProgress, options?.signal)
}

export async function searchRelevant(
  query: string,
  options?: Partial<RAGConfig> & {
    filePaths?: string[]
    currentFilePath?: string
    signal?: AbortSignal
    onProgress?: (progress: RagSearchProgress) => void
  },
): Promise<SearchResult[]> {
  const startedAt = performance.now()
  try {
    const results = await searchRelevantInner(query, options)
    const durationMs = performance.now() - startedAt
    if (durationMs >= 1000) void import('@/services/productionDiagnostics').then(({ recordDiagnostic }) =>
      recordDiagnostic('rag.search_slow', 'slow', durationMs, results.length)).catch(() => undefined)
    return results
  } catch (error) {
    void import('@/services/productionDiagnostics').then(({ recordDiagnostic }) =>
      recordDiagnostic('rag.search_failed', 'error', performance.now() - startedAt)).catch(() => undefined)
    throw error
  }
}

export async function getRagStatsAsync(): Promise<RAGStats> {
  const { documents, totalChunks, embeddedChunks } = await loadRagStatsAggregate()

  return {
    documents,
    totalChunks,
    embeddedChunks,
    pendingEmbeddings: totalChunks - embeddedChunks,
  }
}

const RAG_CONTEXT_PREFIX = '【知识库检索结果】'
const RAG_CONTEXT_SEPARATOR = '\n\n---\n\n'

function formatContextSource(
  r: SearchResult,
  sourceNumber: number,
  neighbors: SearchResult['neighborChunks'] = [],
  referenceId?: string,
): string {
  const source = r.document.title || r.document.filePath
  const titlePath = r.chunk.titlePath?.length ? r.chunk.titlePath.join(' > ') : r.chunk.heading || '未命名位置'
  const main = [
    referenceId ? `[${referenceId}]` : `[知识来源 ${sourceNumber}]`,
    `来源：${source}`,
    `文件：${r.document.filePath}`,
    `位置：${titlePath}`,
    `行号：${r.chunk.startLine}-${r.chunk.endLine}`,
    `检索：${r.retrievalMode}，相关度 ${r.score.toFixed(3)}`,
    '内容：',
    r.chunk.content,
  ].join('\n')
  const neighborParts = neighbors.map((chunk) => [
    '[neighbor-context]',
    `位置：${chunk.titlePath?.join(' > ') || chunk.heading || '未命名位置'}`,
    `行号：${chunk.startLine}-${chunk.endLine}`,
    '内容：',
    chunk.content,
  ].join('\n'))
  return neighborParts.length > 0 ? [main, ...neighborParts].join('\n\n') : main
}

function formatContextOmission(skippedSourceNumbers: number[]): string {
  return `【上下文覆盖】已跳过 ${skippedSourceNumbers.length} 个超出预算的来源：${skippedSourceNumbers.join('、')}`
}

function joinContextParts(parts: string[]): string {
  return parts.length > 0 ? `${RAG_CONTEXT_PREFIX}\n${parts.join(RAG_CONTEXT_SEPARATOR)}` : ''
}

/**
 * Pack complete search-result chunks into a character budget.
 */
export function buildContextResult(
  results: SearchResult[],
  maxChars = 6000,
  options: RAGContextBuildOptions = {},
): RAGContextBuildResult {
  const budget = Math.max(0, Math.floor(maxChars))
  const useReferenceIds = options.referenceIds === true
  const includedSources: RAGContextBuildResult['includedSources'] = []
  let skippedSources: RAGContextBuildResult['skippedSources'] = []
  const includedNeighbors = new Map<string, NonNullable<SearchResult['neighborChunks']>>()
  const usedChunkIds = new Set(results.map((result) => result.chunk.id))
  const referenceIdsBySourceKey = new Map<string, string>()

  const getSourceKey = (result: SearchResult): string =>
    `${normalizeFilePath(result.document.filePath)}:${result.chunk.startLine}:${result.chunk.endLine}`

  const getReferenceId = (result: SearchResult): string | undefined => {
    if (!useReferenceIds) return undefined
    const key = getSourceKey(result)
    return referenceIdsBySourceKey.get(key) || `S${referenceIdsBySourceKey.size + 1}`
  }

  const buildParts = (
    sources: RAGContextBuildResult['includedSources'],
    skippedNumbers: number[],
  ): string[] => {
    const parts = sources.map((source) => formatContextSource(
      source.result,
      source.sourceNumber,
      includedNeighbors.get(source.result.chunk.id),
      source.referenceId,
    ))
    if (skippedNumbers.length > 0) parts.push(formatContextOmission(skippedNumbers))
    return parts
  }

  if (results.length === 0) {
    return {
      text: '',
      includedSources,
      skippedSources,
      coverage: { requested: 0, included: 0, skipped: 0 },
    }
  }

  for (const [index, result] of results.entries()) {
    const sourceNumber = index + 1
    const referenceId = getReferenceId(result)
    const candidate = {
      result,
      sourceNumber,
      ...(referenceId ? { referenceId } : {}),
    }
    const nextIncluded = [...includedSources, candidate]
    const nextSkippedNumbers = skippedSources.map((source) => source.sourceNumber)
    const parts = buildParts(nextIncluded, nextSkippedNumbers)

    if (joinContextParts(parts).length <= budget) {
      includedSources.push(candidate)
      if (referenceId) referenceIdsBySourceKey.set(getSourceKey(result), referenceId)
      for (const neighbor of result.neighborChunks || []) {
        if (usedChunkIds.has(neighbor.id)) continue
        const selected = includedNeighbors.get(result.chunk.id) || []
        includedNeighbors.set(result.chunk.id, [...selected, neighbor])
        if (joinContextParts(buildParts(includedSources, nextSkippedNumbers)).length <= budget) {
          usedChunkIds.add(neighbor.id)
        } else if (selected.length > 0) {
          includedNeighbors.set(result.chunk.id, selected)
        } else {
          includedNeighbors.delete(result.chunk.id)
        }
      }
    } else {
      skippedSources.push({ result, sourceNumber, reason: 'budget_exceeded' })
    }
  }

  const contextParts = buildParts(includedSources, skippedSources.map((source) => source.sourceNumber))
  let text = joinContextParts(contextParts)

  if (text.length > budget && includedNeighbors.size > 0) {
    for (const source of [...includedSources].reverse()) {
      const neighbors = includedNeighbors.get(source.result.chunk.id)
      while (neighbors?.length && text.length > budget) {
        neighbors.pop()
        text = joinContextParts(buildParts(
          includedSources,
          skippedSources.map((skipped) => skipped.sourceNumber),
        ))
      }
      if (neighbors?.length === 0) includedNeighbors.delete(source.result.chunk.id)
    }
  }

  if (text.length > budget) {
    text = ''
    skippedSources = results.map((result, index) => ({
      result,
      sourceNumber: index + 1,
      reason: 'budget_exceeded',
    }))
  }

  return {
    text,
    includedSources: text ? includedSources : [],
    skippedSources,
    coverage: {
      requested: results.length,
      included: text ? includedSources.length : 0,
      skipped: skippedSources.length,
    },
  }
}

/**
 * Build context string from search results for AI prompt.
 */
export function buildContext(results: SearchResult[], maxChars = 6000, options?: RAGContextBuildOptions): string {
  return buildContextResult(results, maxChars, options).text
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
