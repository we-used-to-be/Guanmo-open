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

  it('hydrates a document cache before updating a mark opened from the center', async () => {
    mocks.update.mockResolvedValueOnce({ ...baseMark, color: 'blue' })

    await useReadingMarksStore.getState().update(baseMark.id, baseMark.documentPath, { color: 'blue' })

    expect(mocks.load).toHaveBeenCalledWith(baseMark.documentPath)
    expect(mocks.update).toHaveBeenCalledWith(baseMark.id, { color: 'blue' })
    expect(useReadingMarksStore.getState().byDocumentId[baseMark.documentId][0].color).toBe('blue')
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

  it.each(['update', 'remove'] as const)('a failed %s does not undo another mark saved in the meantime', async (operation) => {
    const other = { ...baseMark, id: 'mark-2', note: '另一条批注' }
    const remote = { ...baseMark, id: 'mark-3', documentId: 'path:c:/anonymous/b.md', documentPath: 'C:/anonymous/B.md' }
    const updatedOther = { ...other, note: '另一条已保存' }
    const updatedRemote = { ...remote, note: '另一文档已保存' }
    useReadingMarksStore.setState({ allMarks: [baseMark, other, remote], byDocumentId: { [baseMark.documentId]: [baseMark, other], [remote.documentId]: [remote] } })
    let reject!: (reason: Error) => void
    mocks[operation].mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail }))
    const pending = operation === 'update'
      ? useReadingMarksStore.getState().update(baseMark.id, baseMark.documentPath, { note: '失败的修改' })
      : useReadingMarksStore.getState().remove(baseMark.id, baseMark.documentPath)
    const failed = expect(pending).rejects.toThrow('匿名写入失败')
    mocks.update.mockResolvedValueOnce(updatedOther).mockResolvedValueOnce(updatedRemote)
    await useReadingMarksStore.getState().update(other.id, other.documentPath, { note: updatedOther.note })
    await useReadingMarksStore.getState().update(remote.id, remote.documentPath, { note: updatedRemote.note })
    reject(new Error('匿名写入失败'))
    await failed
    expect(useReadingMarksStore.getState().allMarks).toEqual(expect.arrayContaining([baseMark, updatedOther, updatedRemote]))
    expect(useReadingMarksStore.getState().byDocumentId[baseMark.documentId]).toEqual(expect.arrayContaining([baseMark, updatedOther]))
    expect(useReadingMarksStore.getState().byDocumentId[remote.documentId]).toEqual([updatedRemote])
  })

  it.each(['update', 'remove'] as const)('ignores a document query that predates a successful %s', async (operation) => {
    useReadingMarksStore.setState({ allMarks: [baseMark], byDocumentId: { [baseMark.documentId]: [baseMark] } })
    let resolve!: (marks: ReadingMark[]) => void
    mocks.load.mockImplementationOnce(() => new Promise<ReadingMark[]>((done) => { resolve = done }))
    const pending = useReadingMarksStore.getState().load(baseMark.documentPath)
    if (operation === 'update') await useReadingMarksStore.getState().update(baseMark.id, baseMark.documentPath, { note: '已保存' })
    else await useReadingMarksStore.getState().remove(baseMark.id, baseMark.documentPath)
    const expected = operation === 'update' ? [{ ...baseMark, note: '已保存' }] : []
    resolve([baseMark])
    expect(await pending).toEqual(expected)
    expect(useReadingMarksStore.getState().byDocumentId[baseMark.documentId]).toEqual(expected)
    expect(useReadingMarksStore.getState().allMarks).toEqual(expected)
    expect(useReadingMarksStore.getState().loading[baseMark.documentId]).toBe(false)
  })

  it('keeps the latest document request in charge of data and loading state', async () => {
    let resolveFirst!: (marks: ReadingMark[]) => void
    let resolveSecond!: (marks: ReadingMark[]) => void
    mocks.load.mockImplementationOnce(() => new Promise<ReadingMark[]>((done) => { resolveFirst = done }))
      .mockImplementationOnce(() => new Promise<ReadingMark[]>((done) => { resolveSecond = done }))
    const first = useReadingMarksStore.getState().load(baseMark.documentPath)
    const second = useReadingMarksStore.getState().load(baseMark.documentPath)
    resolveFirst([baseMark])
    expect(await first).toEqual([])
    expect(useReadingMarksStore.getState().loading[baseMark.documentId]).toBe(true)
    const latest = { ...baseMark, note: '最新查询' }
    resolveSecond([latest])
    expect(await second).toEqual([latest])
    expect(useReadingMarksStore.getState().allMarks).toEqual([latest])
    expect(useReadingMarksStore.getState().loading[baseMark.documentId]).toBe(false)
  })

  it('does not discard a query because another document changed', async () => {
    const other = { ...baseMark, id: 'mark-2', documentId: 'path:c:/anonymous/b.md', documentPath: 'C:/anonymous/B.md' }
    useReadingMarksStore.setState({ allMarks: [other], byDocumentId: { [other.documentId]: [other] } })
    let resolve!: (marks: ReadingMark[]) => void
    mocks.load.mockImplementationOnce(() => new Promise<ReadingMark[]>((done) => { resolve = done }))
    const pending = useReadingMarksStore.getState().load(baseMark.documentPath)
    mocks.update.mockResolvedValueOnce({ ...other, note: '另一文档已保存' })
    await useReadingMarksStore.getState().update(other.id, other.documentPath, { note: '另一文档已保存' })
    resolve([baseMark])
    expect(await pending).toEqual([baseMark])
    expect(useReadingMarksStore.getState().allMarks).toEqual(expect.arrayContaining([baseMark, { ...other, note: '另一文档已保存' }]))
  })

  it('finalizes a deletion even if a query reads the row while deletion is pending', async () => {
    useReadingMarksStore.setState({ allMarks: [baseMark], byDocumentId: { [baseMark.documentId]: [baseMark] } })
    let resolve!: () => void
    mocks.remove.mockImplementationOnce(() => new Promise<void>((done) => { resolve = done }))
    const pending = useReadingMarksStore.getState().remove(baseMark.id, baseMark.documentPath)
    await useReadingMarksStore.getState().load(baseMark.documentPath)
    resolve()
    await pending
    expect(useReadingMarksStore.getState().allMarks).toEqual([])
    expect(useReadingMarksStore.getState().byDocumentId[baseMark.documentId]).toEqual([])
  })

  it('ignores an obsolete query error after a mark was saved', async () => {
    useReadingMarksStore.setState({ allMarks: [baseMark], byDocumentId: { [baseMark.documentId]: [baseMark] } })
    let reject!: (error: Error) => void
    mocks.load.mockImplementationOnce(() => new Promise<ReadingMark[]>((_done, fail) => { reject = fail }))
    const pending = useReadingMarksStore.getState().load(baseMark.documentPath)
    await useReadingMarksStore.getState().update(baseMark.id, baseMark.documentPath, { note: '已保存' })
    reject(new Error('已过期的查询错误'))
    await expect(pending).resolves.toEqual([{ ...baseMark, note: '已保存' }])
    expect(useReadingMarksStore.getState().error).toBeNull()
    expect(useReadingMarksStore.getState().loading[baseMark.documentId]).toBe(false)
  })

  it('still hydrates untouched rows when a mark is created during the first document load', async () => {
    let resolve!: (marks: ReadingMark[]) => void
    mocks.load.mockImplementationOnce(() => new Promise<ReadingMark[]>((done) => { resolve = done }))
    const pending = useReadingMarksStore.getState().load(baseMark.documentPath)
    const created = { ...baseMark, id: 'mark-2' }
    mocks.create.mockResolvedValueOnce(created)
    await useReadingMarksStore.getState().create({
      documentPath: baseMark.documentPath,
      selection: { range: baseMark.anchor.range, from: 0, to: 2, text: '匿名', startLine: 1, endLine: 1 },
    }, createMarkdownPreviewModel('匿名内容'))
    resolve([baseMark])
    expect(await pending).toEqual(expect.arrayContaining([baseMark, created]))
    expect(useReadingMarksStore.getState().allMarks).toHaveLength(2)
    expect(useReadingMarksStore.getState().byDocumentId[baseMark.documentId]).toHaveLength(2)
  })

  it('hydrates other rows without resurrecting a deletion from an initially empty cache', async () => {
    let resolve!: (marks: ReadingMark[]) => void
    mocks.load.mockImplementationOnce(() => new Promise<ReadingMark[]>((done) => { resolve = done }))
    const pending = useReadingMarksStore.getState().load(baseMark.documentPath)
    await useReadingMarksStore.getState().remove(baseMark.id, baseMark.documentPath)
    const other = { ...baseMark, id: 'mark-2' }
    resolve([baseMark, other])
    expect(await pending).toEqual([other])
    expect(useReadingMarksStore.getState().allMarks).toEqual([other])
    expect(useReadingMarksStore.getState().byDocumentId[baseMark.documentId]).toEqual([other])
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
