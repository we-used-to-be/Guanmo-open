import assert from 'node:assert/strict'
import { createExactContentHash } from '../src/services/rag/contentHash'
import { EMBEDDING_PREPROCESS_VERSION, createEmbeddingInputHash } from '../src/services/rag/embeddingInput'
import { canSkipDocumentIndex, reconcileDocumentChunks } from '../src/services/rag/reconciler'
import { runSerializedDocumentOperation } from '../src/services/rag/pipeline'
import type { Chunk, Document } from '../src/services/rag/types'

const MODEL = 'embedding-model-a'

function parsedChunk(content: string, index: number, lineOffset = 0): Chunk {
  return {
    id: `temporary-${index}`,
    documentId: 'doc-1',
    content,
    index,
    startLine: index + 1 + lineOffset,
    endLine: index + 1 + lineOffset,
    titlePath: [`section-${index}`],
    sourceType: 'markdown',
  }
}

async function indexedDocument(size = 100): Promise<Document> {
  const chunks = await Promise.all(Array.from({ length: size }, async (_, index) => {
    const chunk = parsedChunk(`paragraph-${index}`, index)
    return {
      ...chunk,
      id: `doc-1-chunk-${index}`,
      embedding: [index, 1],
      embeddingModel: MODEL,
      embeddingPreprocessVersion: EMBEDDING_PREPROCESS_VERSION,
      embeddingInputHash: await createEmbeddingInputHash(chunk),
    }
  }))
  const content = chunks.map((chunk) => chunk.content).join('\n')
  return {
    id: 'doc-1',
    filePath: 'C:\\notes\\test.md',
    title: 'test.md',
    content,
    contentHash: await createExactContentHash(content),
    lastModified: 1,
    chunks,
  }
}

const exactA = await createExactContentHash('Alpha  Beta\n')
assert.notEqual(exactA, await createExactContentHash('alpha  beta\n'))
assert.notEqual(exactA, await createExactContentHash('Alpha Beta\n'))
assert.equal(exactA, await createExactContentHash('Alpha  Beta\n'))

const existing = await indexedDocument()
assert.equal(canSkipDocumentIndex(existing, existing.contentHash!, MODEL), true)
assert.equal(canSkipDocumentIndex(existing, existing.contentHash!, 'embedding-model-b'), false)
const nextBase = { ...existing, content: 'updated', contentHash: 'updated', lastModified: 2 }

const oneChanged = existing.chunks.map((chunk, index) => parsedChunk(
  index === 40 ? 'paragraph-40-updated' : chunk.content,
  index,
))
const changedResult = await reconcileDocumentChunks(existing, nextBase, oneChanged, MODEL)
assert.deepEqual(changedResult.stats, { total: 100, reused: 99, added: 1, deleted: 1, reembedded: 1 })
assert.equal(changedResult.document.chunks[41].id, existing.chunks[41].id)

const inserted = [parsedChunk('new introduction', 0), ...existing.chunks.map((chunk, index) => (
  parsedChunk(chunk.content, index + 1, 1)
))]
const insertedResult = await reconcileDocumentChunks(existing, nextBase, inserted, MODEL)
assert.deepEqual(insertedResult.stats, { total: 101, reused: 100, added: 1, deleted: 0, reembedded: 1 })
assert.equal(insertedResult.document.chunks[51].id, existing.chunks[50].id)

const deletedResult = await reconcileDocumentChunks(existing, nextBase, oneChanged.filter((_, index) => index !== 20), MODEL)
assert.equal(deletedResult.stats.deleted, 2)

const emptiedResult = await reconcileDocumentChunks(existing, nextBase, [], MODEL)
assert.deepEqual(emptiedResult.stats, { total: 0, reused: 0, added: 0, deleted: 100, reembedded: 0 })

const metadataOnly = existing.chunks.map((chunk, index) => ({
  ...parsedChunk(chunk.content, index, 10),
  titlePath: ['moved', `section-${index}`],
}))
const metadataResult = await reconcileDocumentChunks(existing, nextBase, metadataOnly, MODEL)
assert.deepEqual(metadataResult.stats, { total: 100, reused: 100, added: 0, deleted: 0, reembedded: 0 })
assert.equal(metadataResult.document.chunks[0].id, existing.chunks[0].id)
assert.deepEqual(metadataResult.document.chunks[0].titlePath, ['moved', 'section-0'])

const modelResult = await reconcileDocumentChunks(existing, nextBase, metadataOnly, 'embedding-model-b')
assert.deepEqual(modelResult.stats, { total: 100, reused: 0, added: 0, deleted: 0, reembedded: 100 })
assert.equal(modelResult.document.chunks[0].id, existing.chunks[0].id)

const duplicateChunk = parsedChunk('duplicate', 0)
const duplicateHash = await createEmbeddingInputHash(duplicateChunk)
const duplicates: Document = {
  ...existing,
  chunks: [0, 1].map((index) => ({
    ...parsedChunk('duplicate', index),
    id: `duplicate-${index}`,
    embedding: [index, 1],
    embeddingModel: MODEL,
    embeddingPreprocessVersion: EMBEDDING_PREPROCESS_VERSION,
    embeddingInputHash: duplicateHash,
  })),
}
const duplicateResult = await reconcileDocumentChunks(
  duplicates,
  nextBase,
  [parsedChunk('duplicate', 0), parsedChunk('duplicate', 1)],
  MODEL,
)
assert.deepEqual(duplicateResult.document.chunks.map((chunk) => chunk.id), ['duplicate-0', 'duplicate-1'])
assert.equal(duplicateResult.stats.reused, 2)

let running = 0
let maxRunning = 0
await Promise.all(Array.from({ length: 5 }, () => runSerializedDocumentOperation(existing.filePath, async () => {
  running += 1
  maxRunning = Math.max(maxRunning, running)
  await Promise.resolve()
  running -= 1
})))
assert.equal(maxRunning, 1)

console.log('RAG index checks passed: exact hash, 99/100 reuse, insertion, deletion, metadata, model invalidation, duplicates, serialization')
