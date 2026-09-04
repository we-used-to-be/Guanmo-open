import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReadingArtifact, ReadingArtifactType } from '@/services/database/readingArtifacts'

const mocks = vi.hoisted(() => ({
  persistReadingArtifact: vi.fn(),
  loadReadingArtifactById: vi.fn(),
  loadReadingArtifactsPage: vi.fn(),
  deleteReadingArtifact: vi.fn(),
  loadDocumentContentHashByPath: vi.fn(),
  savedInput: undefined as Record<string, unknown> | undefined,
}))

vi.mock('@/services/database/readingArtifacts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/database/readingArtifacts')>()
  return {
    ...actual,
    persistReadingArtifact: mocks.persistReadingArtifact,
    loadReadingArtifactById: mocks.loadReadingArtifactById,
    loadReadingArtifactsPage: mocks.loadReadingArtifactsPage,
    deleteReadingArtifact: mocks.deleteReadingArtifact,
  }
})

vi.mock('@/services/database/persistence', () => ({
  loadDocumentContentHashByPath: mocks.loadDocumentContentHashByPath,
}))

import { useReadingArtifactsStore } from '@/stores/readingArtifactsStore'

function createArtifact(id: string, overrides: Partial<ReadingArtifact> = {}): ReadingArtifact {
  return {
    id,
    type: 'summary',
    title: '匿名成果',
    content: '匿名正文',
    structuredContent: null,
    source: null,
    status: 'active',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

describe('readingArtifactsStore 保存消息来源', () => {
  beforeEach(() => {
    mocks.savedInput = undefined
    mocks.persistReadingArtifact.mockReset().mockImplementation(async (input: Record<string, unknown>) => {
      mocks.savedInput = input
    })
    mocks.loadDocumentContentHashByPath.mockReset().mockResolvedValue('hash-1')
    mocks.loadReadingArtifactById.mockReset().mockImplementation(async (id: string) => {
      return mocks.savedInput ? createArtifact(id, {
        type: mocks.savedInput.type as ReadingArtifactType,
        title: mocks.savedInput.title as string,
        content: mocks.savedInput.content as string,
        structuredContent: mocks.savedInput.structuredContent,
        source: mocks.savedInput.source as ReadingArtifact['source'],
      }) : undefined
    })
    mocks.loadReadingArtifactsPage.mockReset().mockImplementation(async () => {
      if (!mocks.savedInput) return { artifacts: [], total: 0 }
      return {
        artifacts: [createArtifact(String(mocks.savedInput.id), {
          type: mocks.savedInput.type as ReadingArtifactType,
          title: mocks.savedInput.title as string,
          content: mocks.savedInput.content as string,
          structuredContent: mocks.savedInput.structuredContent,
          source: mocks.savedInput.source as ReadingArtifact['source'],
        })],
        total: 1,
      }
    })
    mocks.deleteReadingArtifact.mockReset().mockResolvedValue(undefined)
    useReadingArtifactsStore.setState({
      artifacts: [],
      allArtifacts: [],
      allLoaded: false,
      allLoading: false,
      filter: 'all',
      query: '',
      page: 1,
      pageSize: 20,
      total: 0,
      loading: false,
      selectedId: null,
      anchorStatuses: {},
    })
  })

  it.each<ReadingArtifactType>(['summary', 'question_set', 'annotation', 'note'])(
    '%s 保存完整混合来源，并保留第一个本地来源为主锚点',
    async (type) => {
      const structuredContent = type === 'annotation'
        ? { quote: '匿名原文', note: '匿名批注' }
        : null
      const saved = await useReadingArtifactsStore.getState().saveArtifactFromMessage({
        type,
        title: '匿名成果',
        content: '匿名正文',
        question: '匿名问题',
        messageId: 'message-1',
        contextScope: 'workspace',
        structuredContent,
        sources: [
          {
            kind: 'local',
            filePath: 'C:/anonymous/note.md',
            fileName: 'note.md',
            titlePath: ['章节A'],
            startLine: 2,
            endLine: 4,
          },
          {
            kind: 'web',
            title: '匿名网页',
            url: 'https://example.com/anonymous',
            siteName: 'Example',
          },
        ],
      })

      expect(saved).toBeDefined()
      expect(mocks.persistReadingArtifact).toHaveBeenCalledOnce()
      const input = mocks.persistReadingArtifact.mock.calls[0][0]
      expect(input.source).toMatchObject({
        filePath: 'C:/anonymous/note.md',
        fileName: 'note.md',
        contentHash: 'hash-1',
        startLine: 2,
        endLine: 4,
        messageId: 'message-1',
        scope: 'workspace',
      })
      expect(input.structuredContent).toMatchObject({
        question: '匿名问题',
        references: [
          expect.objectContaining({ kind: 'local', fileName: 'note.md', startLine: 2, endLine: 4 }),
          expect.objectContaining({ kind: 'web', title: '匿名网页', url: 'https://example.com/anonymous' }),
        ],
        ...(type === 'annotation' ? { quote: '匿名原文', note: '匿名批注' } : {}),
      })
    },
  )

  it('纯 Web 来源不生成本地锚点，但仍写入 references', async () => {
    await useReadingArtifactsStore.getState().saveArtifactFromMessage({
      type: 'summary',
      title: '匿名摘要',
      content: '匿名正文',
      sources: [{ kind: 'web', title: '匿名网页', url: 'https://example.com/web-only' }],
    })

    const input = mocks.persistReadingArtifact.mock.calls[0][0]
    expect(input.source).toBeNull()
    expect(input.structuredContent).toEqual({
      references: [{ kind: 'web', title: '匿名网页', url: 'https://example.com/web-only' }],
    })
    expect(mocks.loadDocumentContentHashByPath).not.toHaveBeenCalled()
  })

  it('使用服务端组合筛选、分页和准确总数，并在条件变化时回到第一页', async () => {
    useReadingArtifactsStore.setState({ page: 3 })
    useReadingArtifactsStore.getState().setFilter('note')
    useReadingArtifactsStore.getState().setQuery('中文')
    mocks.loadReadingArtifactsPage.mockResolvedValueOnce({
      artifacts: [createArtifact('artifact-match', { type: 'note' })],
      total: 41,
    })

    await useReadingArtifactsStore.getState().loadArtifacts()

    expect(mocks.loadReadingArtifactsPage).toHaveBeenCalledWith({
      type: 'note',
      status: 'active',
      query: '中文',
      limit: 20,
      offset: 0,
    })
    expect(useReadingArtifactsStore.getState()).toMatchObject({
      page: 1,
      total: 41,
      artifacts: [expect.objectContaining({ id: 'artifact-match' })],
    })
  })

  it('过期加载响应不能覆盖最新搜索条件', async () => {
    let resolveOld!: (value: { artifacts: ReadingArtifact[]; total: number }) => void
    let resolveNew!: (value: { artifacts: ReadingArtifact[]; total: number }) => void
    mocks.loadReadingArtifactsPage.mockImplementation(({ query }: { query?: string }) => {
      return new Promise((resolve) => {
        if (query === '旧') resolveOld = resolve
        else resolveNew = resolve
      })
    })

    useReadingArtifactsStore.getState().setQuery('旧')
    const oldRequest = useReadingArtifactsStore.getState().loadArtifacts()
    useReadingArtifactsStore.getState().setQuery('新')
    const newRequest = useReadingArtifactsStore.getState().loadArtifacts()

    resolveNew({ artifacts: [createArtifact('new')], total: 1 })
    await newRequest
    resolveOld({ artifacts: [createArtifact('old')], total: 1 })
    await oldRequest

    expect(useReadingArtifactsStore.getState()).toMatchObject({
      query: '新',
      artifacts: [expect.objectContaining({ id: 'new' })],
    })
  })

  it('保存后直接返回持久化成果，即使新成果不在当前页也会刷新当前查询', async () => {
    const saved = createArtifact('persisted-artifact')
    mocks.loadReadingArtifactById.mockResolvedValueOnce(saved)
    mocks.loadReadingArtifactsPage.mockResolvedValueOnce({ artifacts: [], total: 40 })

    const result = await useReadingArtifactsStore.getState().saveArtifactFromMessage({
      type: 'summary',
      title: '匿名摘要',
      content: '匿名正文',
    })

    expect(result).toEqual(saved)
    expect(useReadingArtifactsStore.getState()).toMatchObject({ artifacts: [], total: 40 })
    expect(mocks.loadReadingArtifactById).toHaveBeenCalledWith(expect.stringMatching(/^artifact-/))
  })

  it('删除末页最后一条后自动回退到有效页并重新加载', async () => {
    useReadingArtifactsStore.setState({ page: 2 })
    mocks.loadReadingArtifactsPage
      .mockResolvedValueOnce({ artifacts: [createArtifact('last-page')], total: 21 })
      .mockResolvedValueOnce({ artifacts: [], total: 20 })
      .mockResolvedValueOnce({ artifacts: Array.from({ length: 20 }, (_, index) => createArtifact(`page-1-${index}`)), total: 20 })

    await useReadingArtifactsStore.getState().loadArtifacts()
    await useReadingArtifactsStore.getState().deleteArtifact('last-page')

    expect(mocks.deleteReadingArtifact).toHaveBeenCalledWith('last-page')
    expect(mocks.loadReadingArtifactsPage.mock.calls.map(([options]) => options.offset)).toEqual([20, 20, 0])
    expect(useReadingArtifactsStore.getState()).toMatchObject({ page: 1, total: 20 })
    expect(useReadingArtifactsStore.getState().artifacts).toHaveLength(20)
  })

  it('分批加载全部 active AI 成果且不设置静默总数上限', async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => createArtifact(`artifact-${index}`))
    const secondPage = [createArtifact('artifact-100')]
    mocks.loadReadingArtifactsPage
      .mockResolvedValueOnce({ artifacts: firstPage, total: 101 })
      .mockResolvedValueOnce({ artifacts: secondPage, total: 101 })

    await useReadingArtifactsStore.getState().loadAllArtifacts()

    expect(mocks.loadReadingArtifactsPage).toHaveBeenNthCalledWith(1, { status: 'active', limit: 100, offset: 0 })
    expect(mocks.loadReadingArtifactsPage).toHaveBeenNthCalledWith(2, { status: 'active', limit: 100, offset: 100 })
    expect(useReadingArtifactsStore.getState()).toMatchObject({ allLoaded: true, allLoading: false })
    expect(useReadingArtifactsStore.getState().allArtifacts).toHaveLength(101)
  })
})
