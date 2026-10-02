import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AiPanel } from '@/components/ai/AiPanel'
import { StatusBar } from '@/components/layout/StatusBar'
import { consumePendingPanelNavigation, requestOpenReadingArtifacts } from '@/services/aiPanelNavigation'
import type { TimelineItem } from '@/stores/chatStore'
import { useChatStore } from '@/stores/chatStore'
import { useAppStore } from '@/stores/appStore'
import { useSettingsStore } from '@/stores/settingsStore'

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
    aiChat.messages = [
      { id: 'user-1', role: 'user' as const, content: '匿名问题', timestamp: 1 },
      { id: 'assistant-1', parentId: 'user-1', role: 'assistant' as const, content: '匿名回答', timestamp: 2 },
    ]
    aiChat.sendMessage.mockReset()
    aiChat.cancelStream.mockReset()
    readingArtifacts.artifacts = [artifactFixture]
    readingArtifacts.loading = false
    readingArtifacts.filter = 'all'
    readingArtifacts.query = ''
    readingArtifacts.page = 1
    readingArtifacts.pageSize = 20
    readingArtifacts.total = 1
    aiChat.timeline = []
    useSettingsStore.getState().updateAppearanceSettings({ aiAssistantFontSize: 14, sendMessageAnimationEnabled: false })
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
    expect(screen.getByRole('region', { name: '阅读成果内容' }).closest('.overflow-hidden')).toBeInTheDocument()
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

  it('AI 助手字号会同步应用到消息和输入框', () => {
    render(<AiPanel />)

    const panel = document.querySelector('.gm-instant-color') as HTMLElement
    const userBubble = screen.getByText('匿名问题').closest('.select-text') as HTMLElement
    const assistantBubble = screen.getByText('匿名回答').closest('.select-text') as HTMLElement
    const input = screen.getByPlaceholderText('输入消息... (Enter 发送)') as HTMLTextAreaElement

    expect(panel.style.getPropertyValue('--gm-ai-chat-font-size')).toBe('14px')
    expect(panel.style.getPropertyValue('--gm-ai-chat-meta-font-size')).toBe('calc(14px - 2px)')
    expect(userBubble.style.fontSize).toBe('var(--gm-ai-chat-font-size)')
    expect(assistantBubble.style.fontSize).toBe('var(--gm-ai-chat-font-size)')
    expect(input.style.fontSize).toBe('var(--gm-ai-chat-font-size)')

    act(() => {
      useSettingsStore.getState().updateAppearanceSettings({ aiAssistantFontSize: 18 })
    })

    expect(panel.style.getPropertyValue('--gm-ai-chat-font-size')).toBe('18px')
    expect(panel.style.getPropertyValue('--gm-ai-chat-meta-font-size')).toBe('calc(18px - 2px)')
  })

  it('默认关闭时按 Enter 发送不会创建光点', () => {
    act(() => { useChatStore.getState().setDraftInput('键盘发送') })
    render(<AiPanel />)
    fireEvent.keyDown(screen.getByPlaceholderText('输入消息... (Enter 发送)'), { key: 'Enter', shiftKey: false })
    expect(aiChat.sendMessage).toHaveBeenCalledTimes(1)
    expect(document.querySelector('.gm-ai-send-flight-dot')).not.toBeInTheDocument()
  })

  it('系统减少动态效果时跳过发送光点动画', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true, addListener: vi.fn(), removeListener: vi.fn() }))
    act(() => {
      useSettingsStore.getState().updateAppearanceSettings({ sendMessageAnimationEnabled: true })
      useChatStore.getState().setDraftInput('减少动态效果')
    })
    render(<AiPanel />)
    fireEvent.click(screen.getByRole('button', { name: '发送' }))
    expect(document.querySelector('.gm-ai-send-flight-dot')).not.toBeInTheDocument()
  })

  it('开启动画后按 Enter 也从发送按钮发射且只发送一次', () => {
    act(() => {
      useSettingsStore.getState().updateAppearanceSettings({ sendMessageAnimationEnabled: true })
      useChatStore.getState().setDraftInput('键盘直接发送')
    })
    render(<AiPanel />)
    const sendButton = screen.getByRole('button', { name: '发送' })
    vi.spyOn(sendButton, 'getBoundingClientRect').mockReturnValue({ left: 20, top: 30, width: 40, height: 28 } as DOMRect)
    fireEvent.keyDown(screen.getByPlaceholderText('输入消息... (Enter 发送)'), { key: 'Enter', shiftKey: false })
    expect(aiChat.sendMessage).toHaveBeenCalledTimes(1)
    expect(document.querySelector('.gm-ai-send-flight-dot')).toBeInTheDocument()
  })

  it('点击发送时光点飞入新用户消息并在到达后显现气泡', () => {
    vi.useFakeTimers()
    vi.stubGlobal('matchMedia', () => ({ matches: false, addListener: vi.fn(), removeListener: vi.fn() }))
    const rafCallbacks: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      rafCallbacks.push(callback)
      return rafCallbacks.length
    })
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    act(() => {
      useSettingsStore.getState().updateAppearanceSettings({ sendMessageAnimationEnabled: true })
      useChatStore.getState().setDraftInput('新的匿名问题')
    })

    const view = render(<AiPanel />)
    const sendButton = screen.getByRole('button', { name: '发送' })
    vi.spyOn(sendButton, 'getBoundingClientRect').mockReturnValue({ left: 20, top: 30, width: 40, height: 28 } as DOMRect)
    fireEvent.click(sendButton)
    expect(aiChat.sendMessage).toHaveBeenCalledTimes(1)

    aiChat.messages = [
      ...aiChat.messages,
      { id: 'user-2', role: 'user' as const, content: '新的匿名问题', timestamp: 3 },
      { id: 'assistant-2', parentId: 'user-2', role: 'assistant' as const, content: '正在准备 AI 请求...', timestamp: 4 },
    ]
    view.rerender(<AiPanel />)
    const container = document.querySelector<HTMLElement>('[data-chat-message-id="user-2"]')!.parentElement!.parentElement!
    vi.spyOn(container, 'getBoundingClientRect').mockReturnValue({ top: 0, bottom: 600, left: 0, right: 360, width: 360, height: 600 } as DOMRect)
    const target = document.querySelector<HTMLElement>('[data-chat-message-id="user-2"]')!
    const bubble = target.querySelector<HTMLElement>('[data-send-animation-bubble]')!
    vi.spyOn(bubble, 'getBoundingClientRect').mockReturnValue({ left: 180, top: 420, width: 120, height: 40, bottom: 460, right: 300 } as DOMRect)

    // 流式消息在测量前更新内容时，不应取消待起飞的帧。
    aiChat.messages = aiChat.messages.map((message) => message.id === 'assistant-2'
      ? { ...message, content: '正在处理匿名请求...' }
      : message)
    view.rerender(<AiPanel />)

    act(() => {
      while (rafCallbacks.length > 0) rafCallbacks.shift()!(0)
    })
    const flightDot = document.querySelector('.gm-ai-send-flight-dot--flying')
    expect(flightDot).toBeInTheDocument()
    expect(flightDot?.parentElement).toBe(document.body)
    expect(target.firstElementChild).toHaveStyle({ opacity: '0' })

    act(() => { vi.advanceTimersByTime(380) })
    expect(target.firstElementChild).toHaveClass('gm-ai-send-message-reveal')
    expect(target.firstElementChild).toHaveStyle({ opacity: '1' })
    expect(target.firstElementChild).not.toHaveStyle({ transform: 'translateY(0)' })
    act(() => { vi.advanceTimersByTime(120) })
    expect(target.firstElementChild).not.toHaveClass('animate-slideInUp')
  })

  it('发送动画飞行期间滚动会停在当前位置并渐隐光点', () => {
    vi.useFakeTimers()
    vi.stubGlobal('matchMedia', () => ({ matches: false, addListener: vi.fn(), removeListener: vi.fn() }))
    const rafCallbacks: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      rafCallbacks.push(callback)
      return rafCallbacks.length
    })
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    act(() => {
      useSettingsStore.getState().updateAppearanceSettings({ sendMessageAnimationEnabled: true })
      useChatStore.getState().setDraftInput('滚动测试')
    })

    const view = render(<AiPanel />)
    const sendButton = screen.getByRole('button', { name: '发送' })
    vi.spyOn(sendButton, 'getBoundingClientRect').mockReturnValue({ left: 20, top: 30, width: 40, height: 28 } as DOMRect)
    fireEvent.click(sendButton)
    aiChat.messages = [
      ...aiChat.messages,
      { id: 'user-2', role: 'user' as const, content: '滚动测试', timestamp: 3 },
      { id: 'assistant-2', parentId: 'user-2', role: 'assistant' as const, content: '正在准备 AI 请求...', timestamp: 4 },
    ]
    view.rerender(<AiPanel />)
    const target = document.querySelector<HTMLElement>('[data-chat-message-id="user-2"]')!
    const container = target.parentElement!.parentElement!
    vi.spyOn(container, 'getBoundingClientRect').mockReturnValue({ top: 0, bottom: 600, left: 0, right: 360, width: 360, height: 600 } as DOMRect)
    const bubble = target.querySelector<HTMLElement>('[data-send-animation-bubble]')!
    let bubbleTop = 420
    const measureBubble = vi.spyOn(bubble, 'getBoundingClientRect').mockImplementation(() => ({
      left: 180, top: bubbleTop, width: 120, height: 40, bottom: bubbleTop + 40, right: 300,
    } as DOMRect))
    act(() => {
      while (rafCallbacks.length > 0) rafCallbacks.shift()!(0)
    })

    // 发送时的程序滚动不能打断飞行；用户主动滚动则立即取消。
    bubbleTop = 350
    const measureCount = measureBubble.mock.calls.length
    fireEvent.scroll(container)
    expect(measureBubble.mock.calls.length).toBeGreaterThan(measureCount)
    expect(document.querySelector('.gm-ai-send-flight-dot--flying')).toBeInTheDocument()
    fireEvent.wheel(container)
    expect(document.querySelector('.gm-ai-send-flight-dot--fading')).toBeInTheDocument()
    expect(target.firstElementChild).not.toHaveStyle({ opacity: '0' })
    act(() => { vi.advanceTimersByTime(120) })
    expect(document.querySelector('.gm-ai-send-flight-dot')).not.toBeInTheDocument()
  })

  it('消息未出现时自动清理发射物', () => {
    vi.useFakeTimers()
    vi.stubGlobal('matchMedia', () => ({ matches: false, addListener: vi.fn(), removeListener: vi.fn() }))
    act(() => {
      useSettingsStore.getState().updateAppearanceSettings({ sendMessageAnimationEnabled: true })
      useChatStore.getState().setDraftInput('等待超时')
    })
    render(<AiPanel />)
    fireEvent.click(screen.getByRole('button', { name: '发送' }))
    expect(document.querySelector('.gm-ai-send-flight-dot')).toBeInTheDocument()
    act(() => { vi.advanceTimersByTime(1000) })
    expect(document.querySelector('.gm-ai-send-flight-dot')).not.toBeInTheDocument()
  })

})
