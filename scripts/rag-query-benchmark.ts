import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { vectorStore } from '../src/services/rag/vectorStore'
import type { Document } from '../src/services/rag/types'

vectorStore.clear()
const documents: Document[] = Array.from({ length: 50 }, (_, documentIndex) => ({
  id: `benchmark-doc-${documentIndex}`,
  filePath: `C:\\notes\\benchmark-${documentIndex}.md`,
  title: `benchmark-${documentIndex}.md`,
  content: '',
  lastModified: Date.now(),
  chunks: Array.from({ length: 100 }, (_, chunkIndex) => ({
    id: `benchmark-${documentIndex}-${chunkIndex}`,
    documentId: `benchmark-doc-${documentIndex}`,
    content: chunkIndex % 10 === 0
      ? `观墨 查询性能 benchmark target ${documentIndex}-${chunkIndex}`
      : `ordinary paragraph ${documentIndex}-${chunkIndex}`,
    heading: `section ${chunkIndex}`,
    index: chunkIndex,
    startLine: chunkIndex + 1,
    endLine: chunkIndex + 1,
    sourceType: 'markdown' as const,
  })),
}))

for (const document of documents) vectorStore.addDocument(document)

const startedAt = performance.now()
for (let iteration = 0; iteration < 20; iteration += 1) {
  const results = vectorStore.keywordSearch('观墨 查询性能', 10)
  assert.equal(results.length, 10)
}
const elapsedMs = performance.now() - startedAt

console.log(JSON.stringify({ documents: 50, chunks: 5000, iterations: 20, elapsedMs: Math.round(elapsedMs * 100) / 100 }))
vectorStore.clear()
