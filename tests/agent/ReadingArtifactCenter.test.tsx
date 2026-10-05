import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ReadingArtifact } from '@/services/database/readingArtifacts'
import type { ReadingMark } from '@/services/readingMarks'

const mocks = vi.hoisted(() => ({
  fileExists: vi.fn(),
  readRememberedFile: vi.fn(),
  navigateToReadingMark: vi.fn(),
  loadReadingMarksPage: vi.fn(),
  loadReadingArtifactsPage: vi.fn(),
}))

vi.mock('@/hooks/useTauri', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/useTauri')>()),
  fileExists: mocks.fileExists,
}))

vi.mock('@/services/persistedFileAccess', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/persistedFileAccess')>()),
  readRememberedFile: mocks.readRememberedFile,
}))

vi.mock('@/services/browserFileSystem', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/browserFileSystem')>()),
  readBrowserFile: mocks.readRememberedFile,
}))

vi.mock('@/services/readingMarkNavigation', () => ({
  navigateToReadingMark: mocks.navigateToReadingMark,
}))

vi.mock('@/services/readingMarks', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/readingMarks')>()),
  loadReadingMarksPage: mocks.loadReadingMarksPage,
}))

vi.mock('@/services/agent/artifactCommands', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/agent/artifactCommands')>()),
  loadReadingArtifactsPageCommand: mocks.loadReadingArtifactsPage,
}))

import { ReadingArtifactCenter } from '@/components/reading-artifacts/ReadingArtifactCenter'
import { useReadingArtifactsStore } from '@/stores/readingArtifactsStore'
import { useReadingMarksStore } from '@/stores/readingMarksStore'

const readingMark: ReadingMark = {
  id: 'mark-1',
  documentId: 'path:c:/anonymous/a.md',
  documentPath: 'C:/anonymous/A.md',
  type: 'annotation',
  anchor: {
    range: { startBlockId: 'pb-0', startOffset: 0, endBlockId: 'pb-0', endOffset: 4 },
    startOffset: 0,
    endOffset: 4,
    quote: '匿名原文',
    contextBefore: '',
    contextAfter: '',
  },
  color: 'yellow',
  note: '人工批注',
  createdAt: 10,
  updatedAt: 10,
}

const aiArtifact: ReadingArtifact = {
  id: 'artifact-1',
  type: 'annotation',
  title: '匿名解读',
  content: 'AI 解读正文',
  structuredContent: {
    question: '匿名问题',
    quote: '匿名原文',
    note: 'AI 解读正文',
    references: [
      { kind: 'local', filePath: 'C:/anonymous/A.md', fileName: 'A.md', startLine: 1, endLine: 1 },
      { kind: 'local', filePath: 'C:/anonymous/B.md', fileName: 'B.md', startLine: 1, endLine: 1 },
    ],
  },
  source: null,
  status: 'active',
  createdAt: 20,
  updatedAt: 20,
}

const independentArtifact: ReadingArtifact = {
  id: 'artifact-2',
  type: 'question_set',
  title: '独立问题集',
  content: '问题一',
  structuredContent: { references: [{ kind: 'web', title: '匿名网页', url: 'https://example.com' }] },
  source: null,
  status: 'active',
  createdAt: 30,
  updatedAt: 30,
}

describe('ReadingArtifactCenter', () => {
  beforeEach(() => {
    mocks.fileExists.mockReset().mockImplementation(async (path: string) => path.endsWith('A.md'))
    mocks.readRememberedFile.mockReset().mockResolvedValue('匿名原文\n\n第二段')
    mocks.navigateToReadingMark.mockReset().mockResolvedValue(true)
    mocks.loadReadingMarksPage.mockReset().mockResolvedValueOnce([readingMark]).mockResolvedValueOnce([])
    mocks.loadReadingArtifactsPage.mockReset().mockResolvedValue({
      artifacts: [independentArtifact, aiArtifact],
      total: 2,
    })
    useReadingMarksStore.setState({
      byDocumentId: {},
      allMarks: [],
      allLoaded: false,
      allLoading: false,
      loading: {},
      error: null,
      pendingNavigation: null,
    })
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

  it('keeps card measurement stable while ancestor motion changes its visual bounds', async () => {
    let measurements = 0
    let layoutMeasurements = 0
    const bounds = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
      const height = this.textContent === '“匿名原文”' ? 63 + (++measurements % 2 ? 0.5 : 1.5) : 0
      return { x: 0, y: 0, width: 320, height, top: 0, right: 320, bottom: height, left: 0, toJSON: () => ({}) }
    })
    const scrollHeight = vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function () {
      return this.textContent === '“匿名原文”' ? (++layoutMeasurements % 2 ? 65 : 63) : 120
    })
    try {
      render(<ReadingArtifactCenter onOpenAiSource={vi.fn()} />)
      expect(await screen.findByText('人工批注')).toBeInTheDocument()
      expect(layoutMeasurements).toBeLessThanOrEqual(2)
      fireEvent.click(screen.getByRole('tab', { name: '按文档' }))
      expect(await screen.findByText('A.md')).toBeInTheDocument()
    } finally {
      bounds.mockRestore()
      scrollHeight.mockRestore()
    }
  })
  it('shows recent results once and builds document plus independent entries', async () => {
    render(<ReadingArtifactCenter onOpenAiSource={vi.fn()} />)

    expect(await screen.findByText('独立问题集')).toBeInTheDocument()
    expect(screen.getByText('AI · AI 解读')).toBeInTheDocument()
    const cards = screen.getAllByRole('article')
    expect(cards.findIndex((card) => card.textContent?.includes('AI · AI 解读')))
      .toBeLessThan(cards.findIndex((card) => card.textContent?.includes('人工批注')))
    fireEvent.click(screen.getByRole('tab', { name: '按文档' }))

    expect(await screen.findByText('A.md')).toBeInTheDocument()
    expect(await screen.findByRole('button', { name: /B\.md/ })).toBeInTheDocument()
    expect(screen.getByText('独立成果')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByText('来源文档不可用')).toBeInTheDocument())
  })

  it('keeps page controls outside the inner result scroller and restores its position', async () => {
    render(<ReadingArtifactCenter onOpenAiSource={vi.fn()} />)

    const contentRegion = screen.getByRole('region', { name: '阅读成果内容' })
    expect(contentRegion).toHaveClass('overflow-y-auto')
    expect(screen.getByRole('tablist', { name: '阅读成果视图' })).not.toContainElement(contentRegion)

    contentRegion.scrollTop = 120
    fireEvent.click(screen.getByRole('tab', { name: '按文档' }))
    await screen.findByRole('button', { name: /A\.md/ })
    fireEvent.click(screen.getByRole('tab', { name: '最近' }))

    await waitFor(() => expect(contentRegion.scrollTop).toBe(120))

    fireEvent.click(screen.getByRole('tab', { name: '按文档' }))
    fireEvent.click(await screen.findByRole('button', { name: /A\.md/ }))
    expect(screen.getByRole('tablist', { name: '成果分类' })).not.toContainElement(contentRegion)
    await waitFor(() => expect(contentRegion.scrollTop).toBe(0))
  })

  it('opens document detail with four filters and routes manual source navigation', async () => {
    mocks.fileExists.mockResolvedValue(true)
    render(<ReadingArtifactCenter onOpenAiSource={vi.fn()} />)
    fireEvent.click(await screen.findByRole('tab', { name: '按文档' }))
    fireEvent.click(await screen.findByRole('button', { name: /A\.md/ }))

    expect(await screen.findByRole('tablist', { name: '成果分类' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: '全部' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: '高亮' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: '批注' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'AI 成果' })).toBeInTheDocument()
    const sortButton = screen.getByRole('button', { name: '排序：原文顺序' })
    fireEvent.click(sortButton)
    expect(screen.getByRole('menu', { name: '排序方式' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('menuitemradio', { name: '时间顺序' }))
    expect(sortButton).toHaveAccessibleName('排序：时间顺序')
    expect(sortButton).toHaveFocus()
    expect(screen.queryByRole('menu', { name: '排序方式' })).not.toBeInTheDocument()

    fireEvent.click(sortButton)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(sortButton).toHaveFocus()
    expect(screen.queryByRole('menu', { name: '排序方式' })).not.toBeInTheDocument()

    fireEvent.click(sortButton)
    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('menu', { name: '排序方式' })).not.toBeInTheDocument()
    const manualCard = screen.getAllByText('人工批注')[0].closest('article')
    fireEvent.click(within(manualCard!).getByRole('button', { name: 'A.md · 查看原文' }))
    expect(mocks.navigateToReadingMark).toHaveBeenCalledWith('mark-1')
  })

  it('routes every manual card in the recent view to its own mark', async () => {
    const secondMark: ReadingMark = {
      ...readingMark,
      id: 'mark-2',
      note: '第二条人工批注',
      createdAt: 11,
      updatedAt: 11,
    }
    mocks.loadReadingMarksPage.mockReset().mockResolvedValueOnce([readingMark, secondMark])
    mocks.loadReadingArtifactsPage.mockReset().mockResolvedValue({ artifacts: [], total: 0 })

    render(<ReadingArtifactCenter onOpenAiSource={vi.fn()} />)

    const buttons = await screen.findAllByRole('button', { name: 'A.md · 查看原文' })
    expect(buttons).toHaveLength(2)
    fireEvent.click(buttons[0])
    expect(mocks.navigateToReadingMark).toHaveBeenCalledWith('mark-2')
    fireEvent.click(buttons[1])
    expect(mocks.navigateToReadingMark).toHaveBeenCalledWith('mark-1')
  })

  it('keeps short manual content directly readable without an expand control', async () => {
    mocks.loadReadingArtifactsPage.mockReset().mockResolvedValue({ artifacts: [], total: 0 })
    render(<ReadingArtifactCenter onOpenAiSource={vi.fn()} />)

    const card = (await screen.findByText('人工批注')).closest('article')
    expect(card).toBeInTheDocument()
    expect(card).toHaveTextContent('“匿名原文”')
    expect(within(card!).getByText('人工批注')).toBeInTheDocument()
    expect(within(card!).queryByRole('button', { name: '展开全文' })).not.toBeInTheDocument()
  })

  it('uses theme-safe annotation surfaces in dark mode', async () => {
    const root = document.documentElement
    root.dataset.theme = 'dark'
    try {
      mocks.loadReadingArtifactsPage.mockReset().mockResolvedValue({ artifacts: [], total: 0 })
      render(<ReadingArtifactCenter onOpenAiSource={vi.fn()} />)

      const card = (await screen.findByText('人工批注')).closest('article')
      const noteSection = within(card!).getByText('我的批注').closest('section')
      expect(noteSection).toBeInTheDocument()
      expect(noteSection).toHaveAttribute('style', expect.stringContaining('background-color: color-mix'))
      expect(noteSection).not.toHaveClass('bg-pink-50/65')
    } finally {
      delete root.dataset.theme
    }
  })

  it('clamps long highlight and annotation content while keeping source and actions visible', async () => {
    const longHighlight: ReadingMark = {
      ...readingMark,
      id: 'mark-long-highlight',
      type: 'highlight',
      note: undefined,
      anchor: { ...readingMark.anchor, quote: Array.from({ length: 8 }, (_, index) => `高亮原文第${index + 1}行`).join('\n') },
    }
    const longAnnotation: ReadingMark = {
      ...readingMark,
      id: 'mark-long-annotation',
      anchor: { ...readingMark.anchor, quote: Array.from({ length: 5 }, (_, index) => `批注原文第${index + 1}行`).join('\n') },
      note: Array.from({ length: 7 }, (_, index) => `我的批注第${index + 1}行`).join('\n'),
    }
    mocks.loadReadingMarksPage.mockReset().mockResolvedValueOnce([longHighlight, longAnnotation])
    mocks.loadReadingArtifactsPage.mockReset().mockResolvedValue({ artifacts: [], total: 0 })
    render(<ReadingArtifactCenter onOpenAiSource={vi.fn()} />)

    await screen.findAllByRole('button', { name: '展开全文' })
    const cards = screen.getAllByRole('article')
    const highlightCard = cards.find((card) => card.textContent?.includes('高亮原文第1行'))
    const annotationCard = cards.find((card) => card.textContent?.includes('批注原文第1行'))
    expect(highlightCard).toBeDefined()
    expect(annotationCard).toBeDefined()
    const annotationExpand = within(annotationCard!).getByRole('button', { name: '展开全文' })
    expect(highlightCard).toHaveTextContent('高亮原文第8行')
    expect(within(highlightCard!).getByRole('button', { name: 'A.md · 查看原文' })).toBeInTheDocument()
    expect(within(highlightCard!).getByRole('button', { name: '删除' })).toBeInTheDocument()

    fireEvent.click(annotationExpand)
    expect(screen.getAllByRole('button', { name: '收起' })).toHaveLength(1)
    expect(annotationCard).toHaveTextContent('我的批注第7行')
    expect(within(annotationCard!).getByText('我的批注')).toBeInTheDocument()
    expect(within(annotationCard!).getByRole('button', { name: '编辑批注' })).toBeInTheDocument()
  })

  it('cleans up content resize observers when a manual card unmounts', async () => {
    const originalResizeObserver = globalThis.ResizeObserver
    const disconnect = vi.fn()
    class TrackingResizeObserver {
      constructor(_callback: ResizeObserverCallback) {}
      observe = vi.fn()
      disconnect = disconnect
    }
    globalThis.ResizeObserver = TrackingResizeObserver as unknown as typeof ResizeObserver
    try {
      mocks.loadReadingArtifactsPage.mockReset().mockResolvedValue({ artifacts: [], total: 0 })
      const view = render(<ReadingArtifactCenter onOpenAiSource={vi.fn()} />)
      await screen.findByText('人工批注')
      view.unmount()
      expect(disconnect).toHaveBeenCalled()
    } finally {
      globalThis.ResizeObserver = originalResizeObserver
    }
  })

  it('keeps each multi-document AI source as an independent source action', async () => {
    const onOpenAiSource = vi.fn()
    mocks.fileExists.mockResolvedValue(true)
    render(<ReadingArtifactCenter onOpenAiSource={onOpenAiSource} />)
    fireEvent.click(await screen.findByRole('button', { name: /AI · AI 解读.*匿名问题/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'B.md · 查看原文' }))
    expect(onOpenAiSource).toHaveBeenCalledWith(
      aiArtifact,
      expect.objectContaining({ documentId: 'path:c:/anonymous/b.md', fileName: 'B.md' }),
    )
  })

  it('keeps AI results collapsed and shows the three reading layers one at a time', async () => {
    render(<ReadingArtifactCenter onOpenAiSource={vi.fn()} />)

    const explanation = await screen.findByRole('button', { name: /AI · AI 解读.*匿名问题/ })
    expect(explanation).toHaveAttribute('aria-expanded', 'false')
    expect(explanation).toHaveTextContent('匿名问题')
    expect(explanation).not.toHaveTextContent('匿名解读')
    fireEvent.click(explanation)
    expect(explanation).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('原问题')).toBeInTheDocument()
    expect(screen.getAllByText('匿名问题').length).toBeGreaterThan(1)
    expect(screen.getByText('AI 回复')).toBeInTheDocument()
    expect(screen.getAllByText('AI 解读正文').length).toBeGreaterThan(1)
    expect(screen.getByText('参考资料')).toBeInTheDocument()
    expect(screen.getByLabelText('AI 回复正文')).toHaveClass('max-h-80', 'overflow-y-auto')
    expect(screen.queryByText('引用原文')).not.toBeInTheDocument()

    const questionSet = screen.getByRole('button', { name: /AI · 问题集.*独立问题集/ })
    fireEvent.click(questionSet)
    expect(questionSet).toHaveAttribute('aria-expanded', 'true')
    expect(explanation).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByText('未记录原问题')).toBeInTheDocument()
  })

  it('does not present the recent 40-item window as document totals when aggregation fails and can retry', async () => {
    mocks.loadReadingArtifactsPage
      .mockReset()
      .mockResolvedValueOnce({ artifacts: [independentArtifact, aiArtifact], total: 2 })
      .mockRejectedValueOnce(new Error('ambiguous column name: id'))
      .mockResolvedValueOnce({ artifacts: [independentArtifact, aiArtifact], total: 2 })

    render(<ReadingArtifactCenter onOpenAiSource={vi.fn()} />)
    expect(await screen.findByText('独立问题集')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('tab', { name: '按文档' }))

    expect(await screen.findByText(/加载失败：ambiguous column name: id/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /A\.md/ })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(await screen.findByRole('button', { name: /A\.md/ })).toBeInTheDocument()
  })
})
