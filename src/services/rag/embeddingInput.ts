import type { Chunk } from './types'
import { createExactContentHash } from './contentHash'

export const EMBEDDING_PREPROCESS_VERSION = 'markdown-chunk-v1'

export function getEmbeddingInput(chunk: Pick<Chunk, 'content'>): string {
  return chunk.content
}

export function createEmbeddingInputHash(chunk: Pick<Chunk, 'content'>): Promise<string> {
  return createExactContentHash(getEmbeddingInput(chunk))
}
