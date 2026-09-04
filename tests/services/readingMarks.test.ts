import { describe, expect, it } from 'vitest'
import { createMarkdownPreviewModel } from '@/services/markdownPreviewModel'
import { buildDocumentRangeInfo, getTextForSourceRange } from '@/services/previewHighlight'
import { buildReadingMarkRangeIndex, createReadingMarkAnchor, findReadingMarkConflict, resolveReadingMarkAnchor, readingDocumentId, type ReadingMark } from '@/services/readingMarks'

describe('ReadingMark source anchor', () => {
  it('uses UTF-16 offsets and preserves emoji/context across blocks', () => {
    const model = createMarkdownPreviewModel('前🙂后\n\n第二段文本')
    const from = model.rawContent.indexOf('🙂')
    const to = from + '🙂后'.length
    const info = buildDocumentRangeInfo(model, from, to)
    const anchor = createReadingMarkAnchor(model, { range: info!.range, from, to, text: '🙂后', startLine: 1, endLine: 1 })
    expect(anchor.startOffset).toBe(from)
    expect(anchor.endOffset).toBe(to)
    expect(anchor.quote).toBe('🙂后')
    expect(resolveReadingMarkAnchor(model, { id: 'm', documentId: 'd', documentPath: 'C:/x.md', type: 'highlight', anchor, color: 'yellow', createdAt: 1, updatedAt: 1 })).toEqual({ from, to })
  })

  it('rejects an ambiguous quote without unique context', () => {
    const model = createMarkdownPreviewModel('重复文本\n\n重复文本')
    const from = model.rawContent.indexOf('重复文本')
    const info = buildDocumentRangeInfo(model, from, from + 4)!
    const anchor = { ...createReadingMarkAnchor(model, { range: info.range, from, to: from + 4, text: '重复文本', startLine: 1, endLine: 1 }), range: { ...info.range, startBlockId: 'missing' }, startOffset: 100, endOffset: 104, contextBefore: '', contextAfter: '' }
    expect(resolveReadingMarkAnchor(model, { id: 'm', documentId: 'd', documentPath: 'C:/x.md', type: 'highlight', anchor, color: 'yellow', createdAt: 1, updatedAt: 1 })).toBeNull()
  })

  it('normalizes document identity without changing persisted path display', () => {
    expect(readingDocumentId('C:\\Docs\\Note.md')).toBe('path:c:/docs/note.md')
  })
})

describe('ReadingMark range conflicts', () => {
  const model = createMarkdownPreviewModel('0123456789')
  const makeMark = (id: string, from: number, to: number): ReadingMark => {
    const info = buildDocumentRangeInfo(model, from, to)
    if (!info) throw new Error('range missing')
    return {
      id,
      documentId: 'path:c:/anonymous/a.md',
      documentPath: 'C:/anonymous/a.md',
      type: 'highlight',
      anchor: { ...createReadingMarkAnchor(model, { range: info.range, from, to, text: getTextForSourceRange(model, from, to), startLine: 1, endLine: 1 }) },
      color: 'yellow',
      createdAt: 1,
      updatedAt: 1,
    }
  }

  it.each([
    ['exact', 2, 5, 'exact'],
    ['contains', 1, 6, 'overlap'],
    ['contained', 3, 4, 'overlap'],
    ['overlap-left', 1, 3, 'overlap'],
    ['overlap-right', 4, 7, 'overlap'],
  ])('%s ranges are rejected', (_label, from, to, kind) => {
    const index = buildReadingMarkRangeIndex(model, [makeMark('existing', 2, 5)])
    expect(findReadingMarkConflict(index, from as number, to as number)?.kind).toBe(kind)
  })

  it('allows adjacent and disjoint ranges', () => {
    const index = buildReadingMarkRangeIndex(model, [makeMark('existing', 2, 5)])
    expect(findReadingMarkConflict(index, 0, 2)).toBeNull()
    expect(findReadingMarkConflict(index, 5, 8)).toBeNull()
    expect(findReadingMarkConflict(index, 7, 9)).toBeNull()
  })
})
