import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatMessage } from '@/services/ai/types'
import { useChatStore } from '@/stores/chatStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { AiPanel } from '@/components/ai/AiPanel'
import { StatusBar } from '@/components/layout/StatusBar'

const mocks = vi.hoisted(() => ({ load: vi.fn(), database: true }))
vi.mock('@/hooks/useAiChat', () => ({ useAiChat: () => ({
  messages: useChatStore((state) => state.messages), timeline: [], streaming: false,
  error: null, sendMessage: vi.fn(), cancelStream: vi.fn(),
}) }))
vi.mock('@/services/runtimeCapabilities', () => ({
  isWebRuntime: () => false, getRuntimeCapabilities: () => ({ database: mocks.database }),
}))
vi.mock('@/components/reading-artifacts/ReadingArtifactCenter', () => ({ ReadingArtifactCenter: () => <div>阅读成果页面</div> }))

const messages: ChatMessage[] = [
  { id: 'question', role: 'user', content: '匿名问题', timestamp: 2 },
  { id: 'answer', parentId: 'question', role: 'assistant', content: '匿名回答', timestamp: 3 },
]
const originalLoad = useChatStore.getState().loadMoreHistory
function scroll(container: HTMLElement, top: number) {
  container.scrollTop = top
  fireEvent.scroll(container)
}
function mount() {
  render(<><StatusBar /><AiPanel /></>)
  return document.querySelector<HTMLElement>('.overflow-y-auto')!
}

describe('AI 历史记录上滑分页', () => {
  beforeEach(() => {
    mocks.database = true
    mocks.load.mockReset().mockResolvedValue(undefined)
    useChatStore.setState({ messages, hasMoreHistory: true, loadMoreHistory: mocks.load })
    useSettingsStore.getState().updateAppearanceSettings({ sendMessageAnimationEnabled: false })
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: vi.fn() })
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
  })
  afterEach(() => {
    useChatStore.setState({ loadMoreHistory: originalLoad })
    vi.unstubAllGlobals()
  })

  it('未手动点击时不加载，点击后仅在上滑接近顶部时加载', async () => {
    const container = mount()
    scroll(container, 300)
    scroll(container, 60)
    expect(mocks.load).not.toHaveBeenCalled()
    await act(async () => fireEvent.click(screen.getByText('加载更早的记录')))
    expect(mocks.load).toHaveBeenCalledTimes(1)
    scroll(container, 300)
    scroll(container, 180)
    expect(mocks.load).toHaveBeenCalledTimes(1)
    await act(async () => scroll(container, 100))
    expect(mocks.load).toHaveBeenCalledTimes(2)
    scroll(container, 110)
    expect(mocks.load).toHaveBeenCalledTimes(2)
  })

  it('空聊天首次加载历史后也启用上滑，并对进行中的请求防重', async () => {
    useChatStore.setState({ messages: [] })
    mocks.load.mockImplementationOnce(async () => { useChatStore.setState({ messages }) })
    const container = mount()
    await act(async () => fireEvent.click(screen.getByText('加载历史记录')))
    let resolve!: () => void
    mocks.load.mockImplementationOnce(() => new Promise<void>((done) => { resolve = done }))
    scroll(container, 300)
    scroll(container, 100)
    scroll(container, 50)
    expect(mocks.load).toHaveBeenCalledTimes(2)
    await act(async () => resolve())
  })

  it('历史插入顶部后保持原消息在视口中的位置，不触发滚到底部', async () => {
    const container = mount()
    container.scrollTop = 200
    const anchor = container.querySelector<HTMLElement>('[data-chat-message-id="question"]')!
    let anchorTop = 20
    vi.spyOn(anchor, 'getBoundingClientRect').mockImplementation(() => ({ top: anchorTop, bottom: anchorTop + 100 } as DOMRect))
    mocks.load.mockImplementationOnce(async () => {
      anchorTop = 320
      useChatStore.setState({ messages: [{ id: 'older', role: 'user', content: '更早的匿名问题', timestamp: 1 }, ...messages] })
    })
    await act(async () => fireEvent.click(screen.getByText('加载更早的记录')))
    expect(container.scrollTop).toBe(500)
    expect(container.scrollTo).not.toHaveBeenCalled()
  })

  it('加载失败后可重试，分页结束后停止请求', async () => {
    const container = mount()
    mocks.load.mockRejectedValueOnce(new Error('匿名加载失败'))
    await act(async () => fireEvent.click(screen.getByText('加载更早的记录')))
    scroll(container, 300)
    await act(async () => scroll(container, 100))
    expect(mocks.load).toHaveBeenCalledTimes(2)
    act(() => useChatStore.setState({ hasMoreHistory: false }))
    scroll(container, 300)
    scroll(container, 100)
    expect(mocks.load).toHaveBeenCalledTimes(2)
    expect(screen.queryByText('加载更早的记录')).toBeNull()
  })

  it('切到阅读成果时不触发历史加载，返回聊天后仍可上滑加载', async () => {
    const container = mount()
    await act(async () => fireEvent.click(screen.getByText('加载更早的记录')))
    await act(async () => {
      fireEvent.click(screen.getByTitle('阅读成果'))
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    scroll(container, 300)
    scroll(container, 100)
    expect(mocks.load).toHaveBeenCalledTimes(1)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /打开 AI 助手/ }))
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    scroll(container, 300)
    await act(async () => scroll(container, 100))
    expect(mocks.load).toHaveBeenCalledTimes(2)
  })

  it('Web 能力边界仍禁止历史加载', () => {
    mocks.database = false
    const container = mount()
    fireEvent.click(screen.getByText('加载更早的记录'))
    scroll(container, 300)
    scroll(container, 100)
    expect(mocks.load).not.toHaveBeenCalled()
  })

  it('不再提供清空对话按钮，已有消息保持可见', () => {
    mount()
    expect(screen.queryByTitle('清空对话')).toBeNull()
    expect(screen.getByText('匿名问题')).toBeVisible()
    expect(screen.getByText('匿名回答')).toBeVisible()
  })
})
