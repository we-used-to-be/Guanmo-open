export type RetrievalMode = 'vector' | 'keyword' | 'hybrid'

export interface Chunk {
  id: string
  documentId: string
  content: string
  contentHash?: string
  index: number
  startLine: number
  endLine: number
  titlePath?: string[]
  heading?: string
  sourceType?: 'markdown' | 'text'
  createdAt?: number
  updatedAt?: number
  embedding?: number[]
}

export interface Document {
  id: string
  filePath: string
  title: string
  content: string
  lastModified: number
  chunks: Chunk[]
}

export interface SearchResult {
  chunk: Chunk
  score: number
  document: Document
  retrievalMode: RetrievalMode
  keywordScore?: number
  vectorScore?: number
}

export interface Memory {
  id: string
  content: string
  category: string
  createdAt: number
  updatedAt: number
  embedding?: number[]
}

export interface RAGConfig {
  chunkSize: number
  chunkOverlap: number
  topK: number
  similarityThreshold: number
  keywordSearchEnabled: boolean
  preferCurrentFile: boolean
  preferRecentDocuments: boolean
}
