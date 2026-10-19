import React from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DiffErrorBoundary } from '@/components/editor/DiffErrorBoundary'
import { MarkdownDiffView } from '@/components/editor/MarkdownDiffView'
import { ChatBubble } from '@/components/ai/AiPanel'
import { useChatStore } from '@/stores/chatStore'

function CrashingDiff(): React.ReactNode {
  throw new Error('anonymous diff fixture')
}

describe('历史 Bug 回归', () => {
  beforeEach(() => {
    useChatStore.getState().clearMessages()
  })

  it('Diff 渲染异常显示恢复界面而不是白屏', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const preventExpectedError = (event: ErrorEvent) => event.preventDefault()
    window.addEventListener('error', preventExpectedError)
    const onExitDiff = vi.fn()
    render(
      <DiffErrorBoundary resetKey="anonymous" onExitDiff={onExitDiff}>
        <CrashingDiff />
      </DiffErrorBoundary>,
    )

    expect(screen.getByText('Diff 视图加载失败')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '返回编辑模式' }))
    expect(onExitDiff).toHaveBeenCalledOnce()
    window.removeEventListener('error', preventExpectedError)
  })

  it('清空会话同时清除消息、草稿、上下文和错误状态', () => {
    const store = useChatStore.getState()
    store.addMessage({ role: 'user', content: '匿名消息' })
    store.setDraftInput('匿名草稿')
    store.setError('匿名错误')
    store.addContextTag({ type: 'selection', title: '匿名.md', content: '片段', preview: '片段' })

    useChatStore.getState().clearMessages()
    const cleared = useChatStore.getState()

    expect(cleared.messages).toEqual([])
    expect(cleared.draftInput).toBe('')
    expect(cleared.contextTags).toEqual([])
    expect(cleared.error).toBeNull()
  })

  it('超长 Diff 行允许容器滚动并在换行模式下断词', () => {
    const longLine = 'anonymous-token-'.repeat(500)
    const { container } = render(
      <MarkdownDiffView
        original="short"
        current={longLine}
        fontSize={14}
        lineHeight={1.6}
        fontFamily="monospace"
        wordWrap
        lineNumbers
      />,
    )

    expect(container.firstElementChild).toHaveClass('min-w-0', 'overflow-auto')
    expect(screen.getByText(longLine)).toHaveClass('whitespace-pre-wrap', 'break-words')
  })

  it('超长聊天消息限制气泡宽度并允许任意位置换行', () => {
    const longMessage = 'anonymous-message-'.repeat(500)
    const { container } = render(
      <ChatBubble role="user" content={longMessage} isLast={false} streaming={false} />,
    )

    const message = screen.getByText(longMessage)
    expect(container.firstElementChild).toHaveClass('min-w-0')
    expect(message.parentElement).toHaveClass('overflow-wrap-anywhere')
    expect(message.closest('.max-w-\\[80\\%\\]')).toHaveClass('min-w-0')
  })
})
