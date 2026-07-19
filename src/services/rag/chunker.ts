import type { Chunk } from './types'
import { createContentHash } from './contentHash'
import { buildSemanticDocumentChunks } from './semanticChunker'

/**
 * Split Markdown content into semantic chunks for RAG.
 * The splitter keeps heading metadata and avoids cutting fenced code blocks.
 */
export function chunkMarkdown(
  content: string,
  documentId: string,
  _options: { chunkSize?: number; overlap?: number } = {}
): Chunk[] {
  const semanticChunks = buildSemanticDocumentChunks(content, true)
  const now = Date.now()
  return semanticChunks.map((chunk, index) => {
    const contentHash = createContentHash(chunk.content)
    return {
      id: `${documentId}-chunk-${index}`,
      documentId,
      content: chunk.content,
      contentHash,
      index,
      startLine: chunk.startLine,
      endLine: chunk.endLine,
      titlePath: chunk.headingPath,
      heading: chunk.heading,
      sourceType: 'markdown' as const,
      createdAt: now,
      updatedAt: now,
    }
  })
}
