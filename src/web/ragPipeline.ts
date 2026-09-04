import { UnsupportedCapabilityError } from './externalHttp'
import type { RAGContextBuildResult, RAGContextBuildOptions, SearchResult } from '@/services/rag/types'
type KnowledgeIndexState = 'PENDING' | 'CHUNKED' | 'EMBEDDING' | 'INDEXED' | 'FAILED'

interface KnowledgeDocumentState {
  filePath: string
  title: string
  state: KnowledgeIndexState
  totalChunks: number
  embeddedChunks: number
}
const unsupported = async (): Promise<never> => { throw new UnsupportedCapabilityError('RAG 与 Embedding') }
export const processEmbeddingQueue = unsupported
export const retryFailedEmbeddingJobs = unsupported
export const embedPendingChunks = unsupported
export const getRagStatsAsync = async () => ({ documents: 0, totalChunks: 0, embeddedChunks: 0, pendingEmbeddings: 0 })
export const getEmbeddingJobStats = async () => ({ pending: 0, running: 0, done: 0, failed: 0 })
export const getKnowledgeIndexStateSummary = async () => ({ PENDING: 0, CHUNKED: 0, EMBEDDING: 0, INDEXED: 0, FAILED: 0 })
export const getKnowledgeDocumentStates = async (): Promise<KnowledgeDocumentState[]> => []
export const searchRelevant = async (): Promise<SearchResult[]> => []
export function buildContextResult(_results: SearchResult[], _maxChars = 6000, _options: RAGContextBuildOptions = {}): RAGContextBuildResult {
  return { text: '', includedSources: [], skippedSources: [], coverage: { requested: 0, included: 0, skipped: 0 } }
}
