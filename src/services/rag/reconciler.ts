import type { Chunk, Document } from './types'
import { createEmbeddingInputHash, EMBEDDING_PREPROCESS_VERSION } from './embeddingInput'

export interface IndexUpdateStats {
  total: number
  reused: number
  added: number
  deleted: number
  reembedded: number
}

export interface ReconciledDocument {
  document: Document
  stats: IndexUpdateStats
}

export function canSkipDocumentIndex(
  existing: Document | undefined,
  contentHash: string,
  embeddingModel: string | null,
): boolean {
  if (!existing || existing.contentHash !== contentHash) return false
  if (embeddingModel === null) return true
  return existing.chunks.every((chunk) => (
    chunk.embeddingModel === embeddingModel
    && chunk.embeddingPreprocessVersion === EMBEDDING_PREPROCESS_VERSION
    && Boolean(chunk.embeddingInputHash)
  ))
}

function allocateChunkId(documentId: string, usedIds: Set<string>, nextIndex: { value: number }): string {
  while (usedIds.has(`${documentId}-chunk-${nextIndex.value}`)) nextIndex.value += 1
  const id = `${documentId}-chunk-${nextIndex.value}`
  nextIndex.value += 1
  usedIds.add(id)
  return id
}

export async function reconcileDocumentChunks(
  existing: Document | undefined,
  nextDocument: Omit<Document, 'chunks'>,
  parsedChunks: Chunk[],
  embeddingModel: string | null,
): Promise<ReconciledDocument> {
  const oldByInputHash = new Map<string, Chunk[]>()
  const oldChunks = existing?.chunks || []
  const oldInputHashes = await Promise.all(oldChunks.map((chunk) => (
    chunk.embeddingInputHash || createEmbeddingInputHash(chunk)
  )))
  for (let index = 0; index < oldChunks.length; index += 1) {
    const oldChunk = oldChunks[index]
    const inputHash = oldInputHashes[index]
    const matches = oldByInputHash.get(inputHash)
    if (matches) matches.push(oldChunk)
    else oldByInputHash.set(inputHash, [oldChunk])
  }

  const usedIds = new Set((existing?.chunks || []).map((chunk) => chunk.id))
  const nextIdIndex = { value: 0 }
  const chunks: Chunk[] = []
  let reused = 0
  let added = 0
  let reembedded = 0

  const nextInputHashes = await Promise.all(parsedChunks.map(createEmbeddingInputHash))
  for (let index = 0; index < parsedChunks.length; index += 1) {
    const parsedChunk = parsedChunks[index]
    const embeddingInputHash = nextInputHashes[index]
    const matches = oldByInputHash.get(embeddingInputHash)
    const oldChunk = matches?.shift()
    if (matches?.length === 0) oldByInputHash.delete(embeddingInputHash)

    const canReuseEmbedding = Boolean(
      oldChunk?.embedding && (
        embeddingModel === null
          ? true
          : oldChunk.embeddingModel === embeddingModel
            && oldChunk.embeddingPreprocessVersion === EMBEDDING_PREPROCESS_VERSION
            && oldChunk.embeddingInputHash === embeddingInputHash
      )
    )
    const id = oldChunk?.id || allocateChunkId(nextDocument.id, usedIds, nextIdIndex)
    if (canReuseEmbedding) reused += 1
    else if (embeddingModel !== null) reembedded += 1
    if (!oldChunk) added += 1

    chunks.push({
      ...parsedChunk,
      id,
      documentId: nextDocument.id,
      embeddingInputHash,
      embeddingModel: canReuseEmbedding ? oldChunk?.embeddingModel || null : embeddingModel,
      embeddingPreprocessVersion: canReuseEmbedding
        ? oldChunk?.embeddingPreprocessVersion || null
        : EMBEDDING_PREPROCESS_VERSION,
      embedding: canReuseEmbedding ? oldChunk?.embedding : undefined,
      createdAt: oldChunk?.createdAt || parsedChunk.createdAt,
      updatedAt: Date.now(),
    })
  }

  const deleted = Array.from(oldByInputHash.values()).reduce((count, matches) => count + matches.length, 0)
  return {
    document: { ...nextDocument, chunks },
    stats: { total: chunks.length, reused, added, deleted, reembedded },
  }
}
