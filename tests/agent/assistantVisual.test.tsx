import { act, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AssistantVisual } from '@/components/ai/AssistantVisual'
import { ChatBubble } from '@/components/ai/AiPanel'
import { __resetAssistantStateForTests } from '@/services/assistantState'

describe('AssistantVisual renderer adapter', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
    __resetAssistantStateForTests()
  })

  it('点击随机表情，连点替换并重新计时，结束后回到 idle', () => {
    vi.useFakeTimers()
    const { container, getByRole } = render(
      <ChatBubble role="assistant" content="已完成" isLast streaming={false} />,
    )
    const random = vi.spyOn(Math, 'random')
    const sprite = () => container.querySelector<HTMLElement>('.gm-ai-sprite')!
    const button = getByRole('button', { name: '逗逗 AI 助手' })
    random.mockReturnValue(0)
    fireEvent.click(button)
    expect(sprite().dataset.reaction).toBe('heart')
    act(() => vi.advanceTimersByTime(1000))
    fireEvent.click(button)
    expect(sprite().dataset.reaction).toBe('happy')
    act(() => vi.advanceTimersByTime(400))
    expect(sprite().dataset.reaction).toBe('happy')
    random.mockReturnValue(0.3)
    fireEvent.click(button)
    expect(sprite().dataset.reaction).toBe('wink')
    random.mockReturnValue(0.6)
    fireEvent.click(button)
    expect(sprite().dataset.reaction).toBe('star')
    random.mockReturnValue(0.99)
    fireEvent.click(button)
    expect(sprite().dataset.reaction).toBe('shy')
    act(() => vi.advanceTimersByTime(1400))
    expect(sprite().dataset.reaction).toBeUndefined()
    expect(sprite().dataset.state).toBe('idle')
  })

  it('开始生成或变为历史消息时退出交互，卸载后清理计时器', () => {
    vi.useFakeTimers()
    const { container, getByRole, queryByRole, rerender, unmount } = render(
      <ChatBubble role="assistant" content="已完成" isLast streaming={false} />,
    )
    fireEvent.click(getByRole('button', { name: '逗逗 AI 助手' }))
    rerender(<ChatBubble role="assistant" content="正在生成" isLast streaming />)
    expect(queryByRole('button', { name: '逗逗 AI 助手' })).toBeNull()
    expect(container.querySelector('.gm-ai-sprite')?.getAttribute('data-reaction')).toBeNull()
    rerender(<ChatBubble role="assistant" content="历史" isLast={false} streaming={false} />)
    expect(queryByRole('button', { name: '逗逗 AI 助手' })).toBeNull()
    rerender(<ChatBubble role="assistant" content="已完成" isLast streaming={false} />)
    const schedule = vi.spyOn(globalThis, 'setTimeout')
    const cancel = vi.spyOn(globalThis, 'clearTimeout')
    fireEvent.click(getByRole('button', { name: '逗逗 AI 助手' }))
    const reactionCall = schedule.mock.calls.findIndex((call) => call[1] === 1400)
    expect(reactionCall).toBeGreaterThanOrEqual(0)
    const reactionTimer = schedule.mock.results[reactionCall].value
    unmount()
    expect(cancel).toHaveBeenCalledWith(reactionTimer)
  })

  it('通过稳定 visual ID 选择内置 renderer，并保留状态与静态策略', () => {
    const { container } = render(
      <AssistantVisual visualId="sprite" state="generating" animated={false} size={30} />,
    )
    const sprite = container.querySelector<HTMLElement>('.gm-ai-sprite')

    expect(sprite).not.toBeNull()
    expect(sprite?.classList.contains('gm-ai-visual--sprite')).toBe(true)
    expect(sprite?.dataset.state).toBe('generating')
    expect(sprite?.dataset.animated).toBe('false')
  })

  it('未知 visual ID 使用静态安全 fallback，而不加载外部组件', () => {
    const { container } = render(
      <AssistantVisual visualId="broken-renderer" state="idle" animated={false} />,
    )

    expect(container.querySelector('.gm-ai-sprite')).not.toBeNull()
    expect(container.querySelector('.gm-ai-sprite')?.classList.contains('gm-ai-visual--sprite')).toBe(true)
  })

  it('历史 assistant 消息保持静态，最新完成消息播放 idle 动画', () => {
    const history = render(
      <ChatBubble role="assistant" content="历史消息" isLast={false} streaming={false} />,
    )
    expect(history.container.querySelector('.gm-ai-sprite')?.dataset.animated).toBe('false')
    history.unmount()

    const completed = render(
      <ChatBubble role="assistant" content="已完成" isLast streaming={false} />,
    )
    expect(completed.container.querySelector('.gm-ai-sprite')?.dataset.state).toBe('idle')
    expect(completed.container.querySelector('.gm-ai-sprite')?.dataset.animated).toBe('true')
    completed.unmount()

    const streaming = render(
      <ChatBubble role="assistant" content="正在生成" isLast streaming />,
    )
    expect(streaming.container.querySelector('.gm-ai-sprite')?.dataset.animated).toBe('true')
  })
})
