import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createMarkdownPreviewModel } from '@/services/markdownPreviewModel'
import type { ReadingMark } from '@/services/readingMarks'

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  load: vi.fn(),
  loadPage: vi.fn(),
}))

vi.mock('@/services/readingMarks', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/readingMarks')>()),
  createReadingMark: mocks.create,
  updateReadingMark: mocks.update,
  deleteReadingMark: mocks.remove,
  loadReadingMarks: mocks.load,
  loadReadingMarksPage: mocks.loadPage,
}))

import { useReadingMarksStore } from '@/stores/readingMarksStore'

const baseMark: ReadingMark = {
  id: 'mark-1',
  documentId: 'path:c:/anonymous/a.md',
  documentPath: 'C:/anonymous/A.md',
  type: 'annotation',
  anchor: {
    range: { startBlockId: 'b1', startOffset: 0, endBlockId: 'b1', endOffset: 2 },
    startOffset: 0,
    endOffset: 2,
    quote: '匿名',
    contextBefore: '',
    contextAfter: '',
  },
  color: 'yellow',
  note: '原批注',
  createdAt: 1,
  updatedAt: 1,
}

describe('readingMarksStore unified cache', () => {
  beforeEach(() => {
    mocks.create.mockReset().mockResolvedValue(baseMark)
    mocks.update.mockReset().mockImplementation(async (_id: string, patch: Partial<ReadingMark>) => ({ ...baseMark, ...patch }))
    mocks.remove.mockReset().mockResolvedValue(undefined)
    mocks.load.mockReset().mockResolvedValue([baseMark])
    mocks.loadPage.mockReset().mockResolvedValueOnce([baseMark]).mockResolvedValueOnce([])
    useReadingMarksStore.setState({
      byDocumentId: {},
      allMarks: [],
      allLoaded: false,
      allLoading: false,
      loading: {},
      error: null,
      pendingNavigation: null,
    })
  })

  it('loads all pages into the same cache used by document preview', async () => {
    await useReadingMarksStore.getState().loadAll()
    expect(useReadingMarksStore.getState()).toMatchObject({
      allMarks: [baseMark],
      byDocumentId: { [baseMark.documentId]: [baseMark] },
      allLoaded: true,
    })
  })

  it('updates and removes both center and document projections immediately', async () => {
    useReadingMarksStore.setState({ allMarks: [baseMark], byDocumentId: { [baseMark.documentId]: [baseMark] } })
    await useReadingMarksStore.getState().update(baseMark.id, baseMark.documentPath, { note: '新批注' })
    expect(useReadingMarksStore.getState().allMarks[0].note).toBe('新批注')
    expect(useReadingMarksStore.getState().byDocumentId[baseMark.documentId][0].note).toBe('新批注')

    await useReadingMarksStore.getState().remove(baseMark.id, baseMark.documentPath)
    expect(useReadingMarksStore.getState().allMarks).toEqual([])
    expect(useReadingMarksStore.getState().byDocumentId[baseMark.documentId]).toEqual([])
  })

  it('rolls back both projections when persistence fails', async () => {
    mocks.update.mockRejectedValueOnce(new Error('写入失败'))
    useReadingMarksStore.setState({ allMarks: [baseMark], byDocumentId: { [baseMark.documentId]: [baseMark] } })
    await expect(useReadingMarksStore.getState().update(baseMark.id, baseMark.documentPath, { color: 'blue' })).rejects.toThrow('写入失败')
    expect(useReadingMarksStore.getState().allMarks[0]).toEqual(baseMark)
    expect(useReadingMarksStore.getState().byDocumentId[baseMark.documentId][0]).toEqual(baseMark)
  })

  it('rejects duplicate and overlapping ranges before persistence', async () => {
    const model = createMarkdownPreviewModel('匿名内容')
    useReadingMarksStore.setState({ byDocumentId: { [baseMark.documentId]: [baseMark] }, allMarks: [baseMark] })
    const result = await useReadingMarksStore.getState().create({
      documentPath: baseMark.documentPath,
      selection: { range: baseMark.anchor.range, from: 0, to: 2, text: '匿名', startLine: 1, endLine: 1 },
    }, model)
    expect(result).toMatchObject({ status: 'conflict', kind: 'exact', mark: baseMark })
    expect(mocks.create).not.toHaveBeenCalled()
  })

  it('serializes concurrent creates for one document', async () => {
    const model = createMarkdownPreviewModel('匿名内容')
    mocks.create.mockResolvedValueOnce(baseMark)
    const input = {
      documentPath: baseMark.documentPath,
      selection: { range: baseMark.anchor.range, from: 0, to: 2, text: '匿名', startLine: 1, endLine: 1 },
    }
    const first = useReadingMarksStore.getState().create(input, model)
    const second = useReadingMarksStore.getState().create(input, model)
    await expect(first).resolves.toMatchObject({ status: 'created', mark: baseMark })
    await expect(second).resolves.toMatchObject({ status: 'conflict', kind: 'exact', mark: baseMark })
    expect(mocks.create).toHaveBeenCalledTimes(1)
  })
})
