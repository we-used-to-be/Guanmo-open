import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AiPanel } from '@/components/ai/AiPanel'
import { StatusBar } from '@/components/layout/StatusBar'
import { consumePendingPanelNavigation, requestOpenReadingArtifacts } from '@/services/aiPanelNavigation'
import type { TimelineItem } from '@/stores/chatStore'
import { useAppStore } from '@/stores/appStore'

const aiChat = vi.hoisted(() => ({
  messages: [
    { id: 'user-1', role: 'user' as const, content: '匿名问题', timestamp: 1 },
    { id: 'assistant-1', parentId: 'user-1', role: 'assistant' as const, content: '匿名回答', timestamp: 2 },
  ],
  streaming: false,
  error: null,
  timeline: [],
  sendMessage: vi.fn(),
  cancelStream: vi.fn(),
}))

const readingArtifacts = vi.hoisted(() => ({
  artifacts: [{
    id: 'artifact-1',
    type: 'summary' as const,
    title: '匿名摘要',
    content: '匿名成果正文',
    structuredContent: {
      question: '这是一个较长的原问题，用来验证阅读成果展开后默认只显示三行内容，并且用户可以根据需要继续展开查看完整问题。为了确保测试稳定，这段问题会明显超过默认收起阈值。',
      references: [
        {
          kind: 'local' as const,
          filePath: 'C:/anonymous/note.md',
          fileName: 'note.md',
          titlePath: ['章节A'],
          startLine: 2,
          endLine: 4,
        },
        {
          kind: 'web' as const,
          title: '匿名网页',
          url: 'https://example.com/anonymous',
          siteName: 'Example',
          publishedAt: '2026-08-10',
        },
      ],
    },
    source: null,
    status: 'active' as const,
    createdAt: 1,
    updatedAt: 1,
  }],
  loading: false,
  filter: 'all' as 'all' | 'summary' | 'question_set' | 'annotation' | 'note',
  query: '',
  page: 1,
  pageSize: 20,
  total: 1,
  selectedId: null,
  anchorStatuses: {},
  loadArtifacts: vi.fn(),
  setFilter: vi.fn(),
  setQuery: vi.fn(),
  setPage: vi.fn(),
  setSelected: vi.fn(),
  deleteArtifact: vi.fn(),
  saveArtifactFromMessage: vi.fn(),
  checkAnchor: vi.fn(),
  resetAnchorStatus: vi.fn(),
}))

const artifactFixture = readingArtifacts.artifacts[0]

vi.mock('@/hooks/useAiChat', () => ({
  useAiChat: () => aiChat,
}))

vi.mock('@/services/runtimeCapabilities', () => ({
  isWebRuntime: () => false,
  getRuntimeCapabilities: () => ({ database: true }),
}))

vi.mock('@/stores/readingArtifactsStore', () => ({
  useReadingArtifactsStore: (selector: (state: typeof readingArtifacts) => unknown) => selector(readingArtifacts),
}))

describe('AI 面板视图返回', () => {
  const scrollTo = vi.fn()

  beforeEach(() => {
    readingArtifacts.artifacts = [artifactFixture]
    readingArtifacts.loading = false
    readingArtifacts.filter = 'all'
    readingArtifacts.query = ''
    readingArtifacts.page = 1
    readingArtifacts.pageSize = 20
    readingArtifacts.total = 1
    aiChat.timeline = []
    readingArtifacts.setQuery.mockReset()
    readingArtifacts.setPage.mockReset()
    scrollTo.mockReset()
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
      configurable: true,
      value: scrollTo,
    })
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0)
      return 1
    })
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    delete (HTMLElement.prototype as { scrollTo?: unknown }).scrollTo
  })

  it('从阅读成果顶部返回聊天时滚动到对话底部', () => {
    render(<AiPanel />)
    const container = document.querySelector<HTMLElement>('.overflow-y-auto')!
    Object.defineProperty(container, 'scrollHeight', { configurable: true, value: 960 })

    fireEvent.click(screen.getByTitle('阅读成果'))
    scrollTo.mockClear()
    fireEvent.click(screen.getByTitle('返回'))

    expect(scrollTo).toHaveBeenCalledWith({ top: 960 })
  })

  it('阅读成果视图不显示聊天的 Agent 状态链路', () => {
    aiChat.timeline = [{ id: 'timeline-1', type: 'done', label: '生成回答完成', timestamp: 1 } as TimelineItem]
    render(<AiPanel />)

    expect(screen.getByText('Agent 状态链路：')).toBeInTheDocument()
    fireEvent.click(screen.getByTitle('阅读成果'))
    expect(screen.queryByText('Agent 状态链路：')).not.toBeInTheDocument()
  })

  it('底部 AI 与阅读成果入口按当前页面切换或收起侧边栏', () => {
    vi.useFakeTimers()
    useAppStore.getState().closeAiPanel()
    render(<><StatusBar /><AiPanel /></>)

    const aiButton = screen.getByRole('button', { name: /打开 AI 助手/ })
    const artifactsButton = screen.getByRole('button', { name: '打开阅读成果' })
    const flushNavigation = () => act(() => { vi.runOnlyPendingTimers() })

    fireEvent.click(aiButton)
    flushNavigation()
    expect(useAppStore.getState().aiPanelOpen).toBe(true)
    expect(screen.getByText('AI 助手')).toBeInTheDocument()

    fireEvent.click(artifactsButton)
    flushNavigation()
    expect(screen.getByText('阅读成果')).toBeInTheDocument()
    expect(useAppStore.getState().aiPanelOpen).toBe(true)

    fireEvent.click(aiButton)
    flushNavigation()
    expect(screen.getByText('AI 助手')).toBeInTheDocument()
    expect(useAppStore.getState().aiPanelOpen).toBe(true)

    fireEvent.click(aiButton)
    flushNavigation()
    expect(useAppStore.getState().aiPanelOpen).toBe(false)

    fireEvent.click(artifactsButton)
    flushNavigation()
    expect(screen.getByText('阅读成果')).toBeInTheDocument()
    fireEvent.click(artifactsButton)
    flushNavigation()
    expect(useAppStore.getState().aiPanelOpen).toBe(false)
  })

  it('侧边栏懒加载前会保留阅读成果导航意图', () => {
    requestOpenReadingArtifacts()
    expect(consumePendingPanelNavigation()).toEqual({ mode: 'open', view: 'artifacts' })
  })

})
