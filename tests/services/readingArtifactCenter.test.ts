import { describe, expect, it } from 'vitest'
import type { ReadingArtifact } from '@/services/database/readingArtifacts'
import {
  adaptAiReadingArtifact,
  adaptReadingMark,
  buildReadingArtifactItems,
  filterReadingArtifactItems,
  listArtifactDocuments,
  listArtifactsByDocument,
  listRecentArtifacts,
} from '@/services/readingArtifactCenter'
import type { ReadingMark } from '@/services/readingMarks'

function mark(overrides: Partial<ReadingMark> = {}): ReadingMark {
  return {
    id: 'mark-1',
    documentId: 'path:c:/anonymous/a.md',
    documentPath: 'C:/anonymous/A.md',
    type: 'highlight',
    anchor: {
      range: { startBlockId: 'b1', startOffset: 1, endBlockId: 'b1', endOffset: 4 },
      startOffset: 1,
      endOffset: 4,
      quote: '匿名原文',
      contextBefore: '',
      contextAfter: '',
    },
    color: 'yellow',
    createdAt: 10,
    updatedAt: 10,
    ...overrides,
  }
}

function artifact(overrides: Partial<ReadingArtifact> = {}): ReadingArtifact {
  return {
    id: 'artifact-1',
    type: 'summary',
    title: '匿名摘要',
    content: '匿名正文',
    structuredContent: null,
    source: null,
    status: 'active',
    createdAt: 20,
    updatedAt: 20,
    ...overrides,
  }
}

describe('reading artifact center adapter', () => {
  it('projects ReadingMark without creating another persistent record', () => {
    expect(adaptReadingMark(mark())).toMatchObject({
      key: 'mark:mark-1',
      backing: 'reading_mark',
      source: 'user',
      type: 'highlight',
      quote: '匿名原文',
      documentRefs: [{ documentId: 'path:c:/anonymous/a.md', fileName: 'A.md' }],
    })
  })

  it('maps legacy AI annotation and note display types without changing stored types', () => {
    expect(adaptAiReadingArtifact(artifact({ type: 'annotation' })).type).toBe('ai_explanation')
    expect(adaptAiReadingArtifact(artifact({ type: 'note' })).type).toBe('reading_note')
    expect(adaptAiReadingArtifact(artifact({ type: 'summary' })).type).toBe('summary')
    expect(adaptAiReadingArtifact(artifact({ type: 'question_set' })).type).toBe('question_set')
  })

  it('deduplicates multi-document references and keeps every document relationship', () => {
    const item = adaptAiReadingArtifact(artifact({
      structuredContent: {
        references: [
          { kind: 'local', filePath: 'C:/anonymous/A.md', fileName: 'A.md', startLine: 1, endLine: 2 },
          { kind: 'local', filePath: 'c:/ANONYMOUS/a.md', fileName: 'A.md', startLine: 5, endLine: 6 },
          { kind: 'local', filePath: 'C:/anonymous/B.md', fileName: 'B.md', startLine: 3, endLine: 4 },
          { kind: 'web', title: '匿名网页', url: 'https://example.com' },
        ],
      },
    }))
    expect(item.documentRefs).toHaveLength(2)
    expect(item.documentRefs[0].locations).toHaveLength(2)
    expect(item.references).toHaveLength(4)
  })

  it('treats web-only artifacts as independent but preserves legacy named unavailable sources', () => {
    const independent = adaptAiReadingArtifact(artifact({
      structuredContent: { references: [{ kind: 'web', title: '匿名网页', url: 'https://example.com' }] },
    }))
    const unavailable = adaptAiReadingArtifact(artifact({
      source: { filePath: '', fileName: '已移动.md' },
    }))
    expect(independent.documentRefs).toEqual([])
    expect(unavailable.documentRefs).toMatchObject([{ fileName: '已移动.md' }])
  })

  it('lists recent items once while counting multi-document items in each document', () => {
    const multi = artifact({
      structuredContent: {
        references: [
          { kind: 'local', filePath: 'C:/anonymous/A.md', fileName: 'A.md', startLine: 1, endLine: 2 },
          { kind: 'local', filePath: 'C:/anonymous/B.md', fileName: 'B.md', startLine: 1, endLine: 2 },
        ],
      },
    })
    const items = buildReadingArtifactItems([mark()], [multi])
    expect(listRecentArtifacts(items).map((item) => item.key)).toEqual(['ai:artifact-1', 'mark:mark-1'])
    expect(listArtifactDocuments(items)).toMatchObject([
      { documentRef: { fileName: 'A.md' }, total: 2, highlights: 1, aiArtifacts: 1 },
      { documentRef: { fileName: 'B.md' }, total: 1, aiArtifacts: 1 },
    ])
    expect(listArtifactsByDocument(items, 'path:c:/anonymous/b.md')).toHaveLength(1)
  })

  it('filters unified types and searches document names and content', () => {
    const items = buildReadingArtifactItems(
      [mark()],
      [artifact({ type: 'note', content: '跨文档知识' })],
    )
    expect(filterReadingArtifactItems(items, new Set(['reading_note']), '知识')).toMatchObject([
      { type: 'reading_note' },
    ])
    expect(filterReadingArtifactItems(items, new Set(['highlight']), 'A.md')).toMatchObject([
      { type: 'highlight' },
    ])
  })
})
