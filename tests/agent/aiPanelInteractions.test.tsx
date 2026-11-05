import { act, fireEvent, render, screen, within } from '@testing-library/react'
import type { ChatMessage } from '@/services/ai/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AiPanel } from '@/components/ai/AiPanel'
import { StatusBar } from '@/components/layout/StatusBar'
import { useSidebarContent } from '@/components/layout/useSidebarContent'
import { consumePendingPanelNavigation, OPEN_AI_CHAT_EVENT, OPEN_READING_ARTIFACTS_EVENT, OPEN_READING_REMINDERS_EVENT, requestOpenReadingArtifacts } from '@/services/aiPanelNavigation'
import type { TimelineItem } from '@/stores/chatStore'
import { useChatStore } from '@/stores/chatStore'
import { useAppStore } from '@/stores/appStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { AI_SHORTCUT_SUBMIT_EVENT, setAiShortcutPrompt } from '@/services/aiContext'

const aiChat = vi.hoisted(() => ({
  messages: [
    { id: 'user-1', role: 'user' as const, content: '匿名问题', timestamp: 1 },
    { id: 'assistant-1', parentId: 'user-1', role: 'assistant' as const, content: '匿名回答', timestamp: 2 },
  ] as ChatMessage[],
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

function RetainedAiPanel() {
  const open = useAppStore((state) => state.aiPanelOpen)
  const { contentRef, present } = useSidebarContent(open, 'button[aria-label^="打开 AI 助手"]', { keepMounted: true })
  return present ? <div ref={contentRef} aria-hidden={!open}><AiPanel /></div> : null
}

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
    aiChat.streaming = false
    aiChat.messages = [
      { id: 'user-1', role: 'user' as const, content: '匿名问题', timestamp: 1 },
      { id: 'assistant-1', parentId: 'user-1', role: 'assistant' as const, content: '匿名回答', timestamp: 2 },
    ]
    aiChat.sendMessage.mockReset()
    aiChat.cancelStream.mockReset()
    useChatStore.getState().setDraftInput('')
    useChatStore.getState().clearContextTags()
    useSettingsStore.getState().updateEditorSettings({ autoSendAiShortcut: false })
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
    readingArtifacts.saveArtifactFromMessage.mockReset().mockResolvedValue(artifactFixture)
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

  it('流式输出按间隔分段滚动，手动离开后暂停并可在底部恢复', () => {
    let now = Date.now()
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now)
    let frameTime = performance.now()
    const performanceClock = vi.spyOn(performance, 'now').mockImplementation(() => frameTime)
    const frames = new Map<number, FrameRequestCallback>()
    let frameId = 0
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId })
    vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id) })
    const flushFrames = () => { const pending = [...frames.values()]; frames.clear(); act(() => pending.forEach((callback) => callback(frameTime))) }
    const view = render(<AiPanel />)
    flushFrames()
    const container = document.querySelector<HTMLElement>('[data-chat-message-id="assistant-1"]')!.parentElement!.parentElement!
    Object.defineProperty(container, 'clientHeight', { configurable: true, value: 400 })
    Object.defineProperty(container, 'scrollHeight', { configurable: true, value: 800 })
    aiChat.streaming = true
    aiChat.messages = [...aiChat.messages.slice(0, 1), { ...aiChat.messages[1], content: '流式内容' }]
    scrollTo.mockClear()
    view.rerender(<AiPanel />)
    flushFrames()
    frameTime += 300
    flushFrames()
    const halfwayTop = container.scrollTop
    expect(halfwayTop).toBeGreaterThan(0)
    expect(halfwayTop).toBeLessThan(240)
    frameTime += 150
    flushFrames()
    const nearEndTop = container.scrollTop
    frameTime += 150
    flushFrames()
    expect(container.scrollTop).toBe(240)
    expect(240 - nearEndTop).toBeLessThan(nearEndTop - halfwayTop)

    scrollTo.mockClear()
    aiChat.messages = [...aiChat.messages.slice(0, 1), { ...aiChat.messages[1], content: '流式内容继续' }]
    view.rerender(<AiPanel />)
    flushFrames()
    expect(scrollTo).not.toHaveBeenCalled()

    now += 3000
    container.scrollTop = 240
    Object.defineProperty(container, 'scrollHeight', { configurable: true, value: 1100 })
    aiChat.messages = [...aiChat.messages.slice(0, 1), { ...aiChat.messages[1], content: '流式内容继续增长' }]
    view.rerender(<AiPanel />)
    flushFrames()
    frameTime += 600
    flushFrames()
    expect(container.scrollTop).toBe(480)

    fireEvent.wheel(container)
    scrollTo.mockClear()
    now += 3000
    aiChat.messages = [...aiChat.messages.slice(0, 1), { ...aiChat.messages[1], content: '用户阅读历史' }]
    view.rerender(<AiPanel />)
    flushFrames()
    expect(scrollTo).not.toHaveBeenCalled()
    container.scrollTop = 700
    fireEvent.scroll(container)
    Object.defineProperty(container, 'scrollHeight', { configurable: true, value: 1500 })
    aiChat.messages = [...aiChat.messages.slice(0, 1), { ...aiChat.messages[1], content: '恢复跟随' }]
    view.rerender(<AiPanel />)
    flushFrames()
    frameTime += 600
    flushFrames()
    expect(container.scrollTop).toBe(940)
    clock.mockRestore()
    performanceClock.mockRestore()
  })

  it('普通模式移除顶部导航，切回聊天保留滚动位置', () => {
    render(<AiPanel />)
    const container = document.querySelector<HTMLElement>('.overflow-y-auto')!
    Object.defineProperty(container, 'scrollHeight', { configurable: true, value: 960 })

    fireEvent(window, new Event(OPEN_READING_ARTIFACTS_EVENT))
    expect(screen.getByRole('region', { name: '阅读成果内容' }).closest('.overflow-hidden')).toBeInTheDocument()
    scrollTo.mockClear()
    fireEvent(window, new Event(OPEN_AI_CHAT_EVENT))

    expect(scrollTo).not.toHaveBeenCalled()
    expect(screen.queryByTitle('返回')).toBeNull()
    expect(screen.queryByTitle('阅读成果')).toBeNull()
    expect(screen.queryByTitle('阅读提醒（功能开发中）')).toBeNull()
  })

  it('阅读成果视图不显示聊天的 Agent 状态链路', () => {
    aiChat.timeline = [{ id: 'timeline-1', type: 'done', label: '生成回答完成', timestamp: 1 } as TimelineItem]
    render(<AiPanel />)

    expect(screen.getByText('Agent 状态链路：')).toBeInTheDocument()
    fireEvent(window, new Event(OPEN_READING_ARTIFACTS_EVENT))
    expect(screen.queryByText('Agent 状态链路：')).not.toBeInTheDocument()
  })

  it('阅读成果首次访问后切换聊天和提醒仍保留页面与滚动位置', () => {
    render(<AiPanel />)
    expect(screen.queryByRole('region', { name: '阅读成果内容', hidden: true })).toBeNull()
    fireEvent(window, new Event(OPEN_READING_ARTIFACTS_EVENT))
    const region = screen.getByRole('region', { name: '阅读成果内容' })
    region.scrollTop = 420
    fireEvent(window, new Event(OPEN_AI_CHAT_EVENT))
    expect(region).toBeInTheDocument()
    expect(region).not.toBeVisible()
    fireEvent(window, new Event(OPEN_READING_REMINDERS_EVENT))
    expect(region).toBeInTheDocument()
    fireEvent(window, new Event(OPEN_READING_ARTIFACTS_EVENT))
    expect(screen.getByRole('region', { name: '阅读成果内容' })).toBe(region)
    expect(region.scrollTop).toBe(420)
    expect(region).toBeVisible()
  })

  it('快捷提问发送前先渲染聊天界面，并保留阅读成果', () => {
    render(<AiPanel />)
    fireEvent(window, new Event(OPEN_READING_ARTIFACTS_EVENT))
    const region = screen.getByRole('region', { name: '阅读成果内容' })
    useChatStore.getState().setDraftInput('解释选中文本')
    aiChat.sendMessage.mockImplementationOnce(() => {
      expect(screen.getByText('AI 助手')).toBeVisible()
      expect(screen.getByPlaceholderText('输入消息... (Enter 发送)')).toBeVisible()
      expect(region).not.toBeVisible()
    })
    act(() => window.dispatchEvent(new Event(AI_SHORTCUT_SUBMIT_EVENT)))
    expect(aiChat.sendMessage).toHaveBeenCalledTimes(1)
    expect(aiChat.sendMessage).toHaveBeenCalledWith('解释选中文本', undefined, undefined, undefined, 'off')
    expect(region).toBeInTheDocument()
  })

  it('关闭自动发送时快捷提问也会切到聊天并保留草稿', () => {
    vi.useFakeTimers()
    useSettingsStore.getState().updateEditorSettings({ autoSendAiShortcut: false })
    render(<AiPanel />)
    fireEvent(window, new Event(OPEN_READING_ARTIFACTS_EVENT))
    act(() => setAiShortcutPrompt('解释选中文本'))
    act(() => vi.runOnlyPendingTimers())
    expect(screen.getByText('AI 助手')).toBeVisible()
    expect(useChatStore.getState().draftInput).toBe('解释选中文本')
    expect(aiChat.sendMessage).not.toHaveBeenCalled()
    useChatStore.getState().setDraftInput('')
  })

  it('关闭面板后从底部重开阅读成果仍使用同一页面和滚动位置', () => {
    vi.useFakeTimers()
    useAppStore.getState().closeAiPanel()
    render(<><StatusBar /><RetainedAiPanel /></>)
    expect(screen.queryByText('AI 助手')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '打开阅读成果' }))
    act(() => vi.runOnlyPendingTimers())
    const region = screen.getByRole('region', { name: '阅读成果内容' })
    region.scrollTop = 520
    fireEvent.click(screen.getByTitle('关闭面板'))
    act(() => vi.advanceTimersByTime(300))
    expect(region).toBeInTheDocument()
    expect(region.closest('[aria-hidden="true"]')).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '打开阅读成果' }))
    act(() => vi.runOnlyPendingTimers())
    expect(screen.getByRole('region', { name: '阅读成果内容' })).toBe(region)
    expect(region.scrollTop).toBe(520)
  })

  it('开启自动发送时快捷提问从阅读成果切到聊天且只发送一次', () => {
    vi.useFakeTimers()
    useSettingsStore.getState().updateEditorSettings({ autoSendAiShortcut: true })
    render(<AiPanel />)
    fireEvent(window, new Event(OPEN_READING_ARTIFACTS_EVENT))
    act(() => setAiShortcutPrompt('解释选中文本'))
    act(() => vi.runOnlyPendingTimers())
    expect(screen.getByText('AI 助手')).toBeVisible()
    expect(aiChat.sendMessage).toHaveBeenCalledTimes(1)
    act(() => vi.advanceTimersByTime(150))
    expect(aiChat.sendMessage).toHaveBeenCalledTimes(1)
    expect(useChatStore.getState().draftInput).toBe('')
  })

  it('底部提醒、阅读成果和 AI 入口按当前页面切换或收起侧边栏', () => {
    vi.useFakeTimers()
    useAppStore.getState().closeAiPanel()
    render(<><StatusBar /><AiPanel /></>)

    const aiButton = screen.getByRole('button', { name: /打开 AI 助手/ })
    const artifactsButton = screen.getByRole('button', { name: '打开阅读成果' })
    const remindersButton = screen.getByRole('button', { name: '打开阅读提醒' })
    expect(remindersButton.compareDocumentPosition(artifactsButton) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
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

    fireEvent.click(remindersButton)
    flushNavigation()
    expect(useAppStore.getState().aiPanelOpen).toBe(true)
    expect(screen.getByText('阅读提醒')).toBeInTheDocument()
    fireEvent.click(artifactsButton)
    flushNavigation()
    expect(screen.getByText('阅读成果')).toBeInTheDocument()
    fireEvent.click(remindersButton)
    flushNavigation()
    expect(screen.getByText('阅读提醒')).toBeInTheDocument()
    fireEvent.click(remindersButton)
    flushNavigation()
    expect(useAppStore.getState().aiPanelOpen).toBe(false)
  })

  it('全屏固定三个导航入口，切换选中态且不触发拖动', () => {
    if (!useAppStore.getState().aiPanelOpen) useAppStore.getState().toggleAiPanel()
    const onPointerDown = vi.fn()
    render(<AiPanel fullscreenDragHandleProps={{
      onPointerDown, onPointerMove: vi.fn(), onPointerUp: vi.fn(), onPointerCancel: vi.fn(),
    }} />)
    expect(screen.queryByRole('navigation', { name: '侧栏页面' })).toBeNull()
    expect(screen.queryByTitle('清空对话')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '切换页面' }), { detail: 1 })
    const nav = screen.getByRole('navigation', { name: '侧栏页面' })
    const buttons = within(nav).getAllByRole('button')
    expect(buttons.map((button) => button.textContent)).toEqual(['AI 助手', '阅读成果', '阅读提醒'])
    expect(buttons[0]).toHaveAttribute('aria-current', 'page')
    for (const index of [1, 2, 0]) {
      fireEvent.pointerDown(buttons[index])
      fireEvent.click(buttons[index])
      expect(buttons[index]).toHaveAttribute('aria-current', 'page')
      expect(within(nav).getAllByRole('button')).toEqual(buttons)
      expect(buttons.filter((button) => button.getAttribute('aria-current') === 'page')).toHaveLength(1)
    }
    expect(onPointerDown).not.toHaveBeenCalled()
    expect(screen.queryByTitle('返回')).toBeNull()
    expect(screen.queryByTitle('关闭面板')).toBeNull()
    const dragArea = screen.getByLabelText('拖动 AI 助手')
    fireEvent.pointerDown(dragArea)
    expect(onPointerDown).toHaveBeenCalledOnce()
    act(() => useAppStore.getState().closeAiPanel())
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

  it.each(['selection', 'rag', 'web', 'mixed'] as const)('按parentId显示并保存%s回复的原始选区，候选/引用保持分离', async (mode) => {
    const sources: ChatMessage['sources'] = mode === 'selection' ? [] : [
      ...(mode !== 'web' ? [{ kind: 'local' as const, filePath: 'C:/anonymous/Rag.md', fileName: 'Rag.md', startLine: 8, endLine: 9 }] : []),
      ...(mode !== 'rag' ? [{ kind: 'web' as const, title: '检索网页', url: 'https://example.com' }] : []),
    ]
    aiChat.messages = [
      { id: 'user-old', role: 'user', content: '旧问题', tags: [{ type: 'selection', title: '旧选区', filePath: null, content: '旧轮文本', preview: '旧轮文本' }] },
      { id: 'user-1', role: 'user', content: '当轮问题', tags: [
        { type: 'selection', title: 'A.md', filePath: 'C:/anonymous/A.md', content: '当轮选中文本', preview: '预览', startLine: 2, endLine: 3 },
        { type: 'selection', title: 'A.md', filePath: 'C:/anonymous/A.md', content: '当轮第二选区', preview: '预览', startLine: 5, endLine: 6 },
      ] },
      { id: 'assistant-1', parentId: 'user-1', role: 'assistant', content: '匿名回答', sources, referencedSourceIds: sources.length ? ['S1'] : [] },
    ]
    useChatStore.getState().addContextTag({ type: 'selection', title: '新草稿', filePath: null, content: '不能用的当前选区', preview: '新草稿' })
    render(<AiPanel />)
    const assistant = document.querySelector('[data-chat-message-id="assistant-1"]')!
    const contextToggle = within(assistant as HTMLElement).getByRole('button', { name: /^来源 · / })
    expect(contextToggle).toHaveAttribute('aria-expanded', 'false')
    expect(within(assistant as HTMLElement).queryByText('当轮选中文本')).not.toBeInTheDocument()
    fireEvent.click(contextToggle)
    expect(contextToggle).toHaveAttribute('aria-expanded', 'true')
    expect(within(assistant as HTMLElement).getByTitle('Open C:/anonymous/A.md:2-3')).toBeInTheDocument()
    expect(within(assistant as HTMLElement).getByTitle('Open C:/anonymous/A.md:5-6')).toBeInTheDocument()
    expect(assistant).not.toHaveTextContent('原始选区')
    expect(within(assistant as HTMLElement).queryByText('当轮选中文本')).not.toBeInTheDocument()
    expect(within(assistant as HTMLElement).queryByText('当轮第二选区')).not.toBeInTheDocument()
    expect(assistant).not.toHaveTextContent('旧轮文本')
    expect(assistant).not.toHaveTextContent('不能用的当前选区')
    fireEvent.click(within(assistant as HTMLElement).getByRole('button', { name: '保存回复' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '摘要' }))
    expect(readingArtifacts.saveArtifactFromMessage).toHaveBeenCalledWith(expect.objectContaining({
      question: '当轮问题', sources, referencedSourceIds: sources.length ? ['S1'] : [],
      originalSelections: [expect.objectContaining({ text: '当轮选中文本', startLine: 2 }), expect.objectContaining({ text: '当轮第二选区', startLine: 5 })],
    }))
  })

  it('没有关联用户消息时不猜相邻选区', () => {
    aiChat.messages = [
      { id: 'user-1', role: 'user', content: '问题', tags: [{ type: 'selection', title: '片段', filePath: null, content: '不可猜测', preview: '预览' }] },
      { id: 'assistant-1', parentId: 'missing', role: 'assistant', content: '匿名回答' },
    ]
    render(<AiPanel />)
    expect(document.querySelector('[data-chat-message-id="assistant-1"]')).not.toHaveTextContent('来源 · ')
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
