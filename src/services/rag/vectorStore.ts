import type { Chunk, Document, SearchResult } from './types'
import {
  persistDocument,
  removePersistedDocument,
  loadAllDocumentsBulk,
  persistEmbedding,
} from '@/services/database/persistence'
import { normalizeFilePath } from '@/services/pathIdentity'
import { createContentHash } from './contentHash'

interface SearchRankingOptions {
  filePaths?: string[]
  keywordSearchEnabled?: boolean
  currentFilePath?: string
  preferCurrentFile?: boolean
  preferRecentDocuments?: boolean
}

interface PreparedKeywordQuery {
  normalizedQuery: string
  terms: string[]
}

/**
 * In-memory vector store for RAG with optional DB persistence.
 */
class VectorStore {
  private documents: Map<string, Document> = new Map()
  private chunks: Map<string, Chunk> = new Map()
  private pendingPersistence: Set<Promise<void>> = new Set()
  private _persistenceEnabled = false

  get persistenceEnabled(): boolean {
    return this._persistenceEnabled
  }

  private trackPersistence(promise: Promise<void>): void {
    this.pendingPersistence.add(promise)
    promise.finally(() => {
      this.pendingPersistence.delete(promise)
    })
  }

  async flushPersistence(): Promise<void> {
    while (this.pendingPersistence.size > 0) {
      await Promise.all(Array.from(this.pendingPersistence))
    }
  }

  /**
   * Load persisted documents from database.
   * Call this after initDatabase() succeeds.
   */
  async loadFromDatabase(): Promise<void> {
    try {
      const inMemoryDocs = this.getAllDocuments()
      const docs = await loadAllDocumentsBulk()
      this.documents.clear()
      this.chunks.clear()
      for (const doc of docs) {
        this.documents.set(doc.id, doc)
        for (const chunk of doc.chunks) {
          this.chunks.set(chunk.id, chunk)
        }
      }
      this._persistenceEnabled = true
      for (const doc of inMemoryDocs) {
        this.addDocument(doc)
      }
      await this.flushPersistence()
      console.log(`[VectorStore] Loaded ${docs.length} documents from database`)
    } catch (err) {
      console.warn('[VectorStore] Failed to load from database:', err)
    }
  }

  addDocument(doc: Document): void {
    this.storeDocument(doc)
    // Persist in background (non-blocking)
    if (this._persistenceEnabled) {
      this.trackPersistence(
        persistDocument(doc).catch((err) =>
          console.warn('[VectorStore] persist failed:', err)
        )
      )
    }
  }

  async replaceDocument(doc: Document, enqueueEmbeddingJob: boolean): Promise<void> {
    if (this._persistenceEnabled) {
      await persistDocument(doc, { enqueueEmbeddingJob })
    }
    this.storeDocument(doc)
  }

  private storeDocument(doc: Document): void {
    const existing = this.findByFilePath(doc.filePath)
    if (existing && existing.id !== doc.id) {
      for (const chunk of existing.chunks) {
        this.chunks.delete(chunk.id)
      }
      this.documents.delete(existing.id)
    }
    this.documents.set(doc.id, doc)
    for (const chunk of doc.chunks) {
      chunk.contentHash = chunk.contentHash || createContentHash(chunk.content)
      this.chunks.set(chunk.id, chunk)
    }
  }

  removeDocument(docId: string): void {
    const doc = this.documents.get(docId)
    if (doc) {
      for (const chunk of doc.chunks) {
        this.chunks.delete(chunk.id)
      }
      this.documents.delete(docId)
      if (this._persistenceEnabled) {
        this.trackPersistence(
          removePersistedDocument(docId).catch((err) =>
            console.warn('[VectorStore] remove persist failed:', err)
          )
        )
      }
    }
  }

  removeByFilePath(filePath: string): void {
    const doc = this.findByFilePath(filePath)
    if (doc) {
      this.removeDocument(doc.id)
    }
  }

  getDocument(docId: string): Document | undefined {
    return this.documents.get(docId)
  }

  findByFilePath(filePath: string): Document | undefined {
    const normalized = normalizeFilePath(filePath)
    for (const doc of this.documents.values()) {
      if (normalizeFilePath(doc.filePath) === normalized) return doc
    }
    return undefined
  }

  private createFileScope(filePaths?: string[]): Set<string> | undefined {
    return filePaths?.length ? new Set(filePaths.map(normalizeFilePath)) : undefined
  }

  private isInScope(docFilePath: string, scope?: Set<string>): boolean {
    return !scope || scope.has(normalizeFilePath(docFilePath))
  }

  getAllDocuments(): Document[] {
    return Array.from(this.documents.values())
  }

  /**
   * Cosine similarity between two vectors.
   * Returns 0 for zero vectors to avoid division by zero.
   */
  private cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) return 0
    let dotProduct = 0
    let normA = 0
    let normB = 0
    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i]
      normA += a[i] * a[i]
      normB += b[i] * b[i]
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB)
    if (denom === 0) return 0
    return dotProduct / denom
  }

  /**
   * Sort results by score descending and truncate to topK.
   */
  private sortAndTruncate(results: SearchResult[], topK: number): SearchResult[] {
    const bestByContent = new Map<string, SearchResult>()
    for (const result of results) {
      const key = result.chunk.contentHash || createContentHash(result.chunk.content)
      const existing = bestByContent.get(key)
      if (!existing || result.score > existing.score) {
        bestByContent.set(key, result)
      }
    }

    results = Array.from(bestByContent.values()).sort((a, b) => b.score - a.score)
    const byDocument = new Map<string, SearchResult[]>()
    for (const result of results) {
      const key = normalizeFilePath(result.document.filePath)
      const group = byDocument.get(key)
      if (group) {
        group.push(result)
      } else {
        byDocument.set(key, [result])
      }
    }

    const diversified: SearchResult[] = []
    while (diversified.length < topK) {
      let added = false
      for (const group of byDocument.values()) {
        const next = group.shift()
        if (!next) continue
        diversified.push(next)
        added = true
        if (diversified.length >= topK) break
      }
      if (!added) break
    }
    return diversified
  }

  /**
   * Search for similar chunks given a query embedding.
   */
  search(
    queryEmbedding: number[],
    topK: number = 5,
    threshold: number = 0.5,
    filePaths?: string[]
  ): SearchResult[] {
    const results: SearchResult[] = []
    const fileScope = this.createFileScope(filePaths)

    for (const chunk of this.chunks.values()) {
      if (!chunk.embedding) continue

      const doc = this.documents.get(chunk.documentId)
      if (!doc) continue
      // Scope 过滤：只搜索指定文件路径
      if (!this.isInScope(doc.filePath, fileScope)) continue

      const score = this.cosineSimilarity(queryEmbedding, chunk.embedding)
      if (score >= threshold) {
        results.push({ chunk, score, vectorScore: score, document: doc, retrievalMode: 'vector' })
      }
    }

    return this.sortAndTruncate(results, topK)
  }

  private tokenize(text: string): string[] {
    const normalized = text.toLowerCase()
    const rawTerms = normalized.match(/[a-z0-9_+#./-]{2,}|[\u4e00-\u9fff]{2,}/g) || []
    const terms = new Set<string>()

    for (const term of rawTerms) {
      terms.add(term)
      if (/^[\u4e00-\u9fff]+$/.test(term) && term.length > 3) {
        for (let i = 0; i < term.length - 1; i += 1) {
          terms.add(term.slice(i, i + 2))
        }
      }
    }

    return Array.from(terms)
  }

  private prepareKeywordQuery(query: string): PreparedKeywordQuery {
    return { terms: this.tokenize(query), normalizedQuery: query.trim().toLowerCase() }
  }

  private getKeywordScore(query: PreparedKeywordQuery, chunk: Chunk, doc: Document): number {
    const { terms, normalizedQuery } = query
    if (terms.length === 0) return 0

    const content = chunk.content.toLowerCase()
    const heading = (chunk.heading || '').toLowerCase()
    const titlePath = (chunk.titlePath || []).join(' > ').toLowerCase()
    const fileName = doc.filePath.split(/[/\\]/).pop()?.toLowerCase() || doc.title.toLowerCase()
    const docTitle = doc.title.toLowerCase()

    let score = 0
    for (const term of terms) {
      if (content.includes(term)) score += 1
      if (heading.includes(term)) score += 1.8
      if (titlePath.includes(term)) score += 1.5
      if (fileName.includes(term)) score += 1.4
      if (docTitle.includes(term)) score += 1.2
    }

    if (normalizedQuery.length >= 3) {
      if (content.includes(normalizedQuery)) score += 1.2
      if (titlePath.includes(normalizedQuery) || fileName.includes(normalizedQuery)) score += 1.6
    }

    return Math.min(1, score / Math.max(terms.length, 1))
  }

  private applyRankingBoosts(result: SearchResult, options?: SearchRankingOptions): SearchResult {
    let score = result.score
    if (
      options?.preferCurrentFile
      && options.currentFilePath
      && normalizeFilePath(result.document.filePath) === normalizeFilePath(options.currentFilePath)
    ) {
      score += 0.08
    }

    if (options?.preferRecentDocuments) {
      const ageMs = Math.max(0, Date.now() - result.document.lastModified)
      const sevenDaysMs = 7 * 24 * 60 * 60 * 1000
      if (ageMs < sevenDaysMs) {
        score += 0.04 * (1 - ageMs / sevenDaysMs)
      }
    }

    return { ...result, score: Math.min(1, score) }
  }

  /**
   * Simple keyword search (fallback when no embeddings).
   */
  keywordSearch(
    query: string,
    topK: number = 5,
    filePaths?: string[],
    options?: SearchRankingOptions
  ): SearchResult[] {
    const preparedQuery = this.prepareKeywordQuery(query)
    if (preparedQuery.terms.length === 0) return []

    const results: SearchResult[] = []
    const fileScope = this.createFileScope(filePaths)

    for (const chunk of this.chunks.values()) {
      const doc = this.documents.get(chunk.documentId)
      if (!doc) continue
      // Scope 过滤
      if (!this.isInScope(doc.filePath, fileScope)) continue

      const keywordScore = this.getKeywordScore(preparedQuery, chunk, doc)
      if (keywordScore > 0) {
        results.push(this.applyRankingBoosts({
          chunk,
          score: keywordScore,
          keywordScore,
          document: doc,
          retrievalMode: 'keyword',
        }, options))
      }
    }

    return this.sortAndTruncate(results, topK)
  }

  hybridSearch(
    query: string,
    queryEmbedding: number[] | null,
    topK: number = 5,
    threshold: number = 0.5,
    options: SearchRankingOptions = {}
  ): SearchResult[] {
    const candidateLimit = Math.max(topK * 3, topK)
    const vectorResults = queryEmbedding
      ? this.search(queryEmbedding, candidateLimit, threshold, options.filePaths)
      : []
    const keywordResults = options.keywordSearchEnabled === false
      ? []
      : this.keywordSearch(query, candidateLimit, options.filePaths)

    const byChunk = new Map<string, SearchResult>()
    for (const result of [...vectorResults, ...keywordResults]) {
      const existing = byChunk.get(result.chunk.id)
      if (!existing) {
        byChunk.set(result.chunk.id, this.applyRankingBoosts(result, options))
        continue
      }

      const vectorScore = Math.max(existing.vectorScore || 0, result.vectorScore || 0)
      const keywordScore = Math.max(existing.keywordScore || 0, result.keywordScore || 0)
      const hasVector = vectorScore > 0
      const hasKeyword = keywordScore > 0
      const score = hasVector && hasKeyword
        ? Math.min(1, vectorScore * 0.72 + keywordScore * 0.28 + 0.04)
        : Math.max(vectorScore, keywordScore)

      byChunk.set(result.chunk.id, this.applyRankingBoosts({
        ...existing,
        vectorScore,
        keywordScore,
        score,
        retrievalMode: hasVector && hasKeyword ? 'hybrid' : existing.retrievalMode,
      }, options))
    }

    return this.sortAndTruncate(Array.from(byChunk.values()), topK)
  }

  /**
   * Save an embedding to the database.
   */
  saveEmbedding(chunkId: string, embedding: number[]): void {
    const chunk = this.chunks.get(chunkId)
    if (chunk) {
      chunk.embedding = embedding
    }
    if (chunk && this._persistenceEnabled) {
      this.trackPersistence(
        persistEmbedding(chunk).catch((err) =>
          console.warn('[VectorStore] persist embedding failed:', err)
        )
      )
    }
  }

  get chunkCount(): number {
    return this.chunks.size
  }

  get documentCount(): number {
    return this.documents.size
  }

  clear(): void {
    this.documents.clear()
    this.chunks.clear()
  }
}

export const vectorStore = new VectorStore()
