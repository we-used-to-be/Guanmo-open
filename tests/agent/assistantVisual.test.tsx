import { render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { AssistantVisual } from '@/components/ai/AssistantVisual'
import { ChatBubble } from '@/components/ai/AiPanel'
import { __resetAssistantStateForTests } from '@/services/assistantState'

describe('AssistantVisual renderer adapter', () => {
  afterEach(() => {
    __resetAssistantStateForTests()
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

  it('已完成的最新 assistant 消息保持静态，只有当前流式消息播放动画', () => {
    const completed = render(
      <ChatBubble role="assistant" content="已完成" isLast streaming={false} />,
    )
    expect(completed.container.querySelector('.gm-ai-sprite')?.dataset.animated).toBe('false')
    completed.unmount()

    const streaming = render(
      <ChatBubble role="assistant" content="正在生成" isLast streaming />,
    )
    expect(streaming.container.querySelector('.gm-ai-sprite')?.dataset.animated).toBe('true')
  })
})
