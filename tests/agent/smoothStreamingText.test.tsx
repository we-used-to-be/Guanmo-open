import { act, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SmoothStreamingText } from '@/components/ai/SmoothStreamingText'
import { ChatBubble } from '@/components/ai/AiPanel'

describe('SmoothStreamingText', () => {
  afterEach(() => vi.restoreAllMocks())

  it('逐帧显示突发文本，并在三帧内追平', () => {
    const frames: FrameRequestCallback[] = []
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      frames.push(callback)
      return frames.length
    })
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {})
    vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: false } as MediaQueryList)

    const view = render(<SmoothStreamingText content="开" />)
    view.rerender(<SmoothStreamingText content="开始输出一大段连续文字" />)
    expect(view.container.textContent).toBe('开')

    act(() => { frames.shift()?.(0) })
    expect(view.container.textContent?.length).toBeGreaterThan(1)
    expect(view.container.textContent?.length).toBeLessThan('开始输出一大段连续文字'.length)

    act(() => { frames.shift()?.(16) })
    act(() => { frames.shift()?.(32) })
    expect(view.container.textContent).toBe('开始输出一大段连续文字')

    view.rerender(<SmoothStreamingText content="开始输出一大段连续文字，继续" />)
    view.unmount()
    expect(window.cancelAnimationFrame).toHaveBeenCalled()
  })

  it('前缀被替换时立即显示新内容', () => {
    vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: false } as MediaQueryList)
    const view = render(<SmoothStreamingText content="旧内容" />)
    view.rerender(<SmoothStreamingText content="新回答" />)
    expect(view.container.textContent).toBe('新回答')
  })

  it('流结束时立即显示完整最终回答', () => {
    vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: false } as MediaQueryList)
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 1)
    const view = render(<ChatBubble role="assistant" content="开" isLast streaming />)
    view.rerender(<ChatBubble role="assistant" content="开始输出完整回答" isLast streaming />)
    expect(view.container.textContent).not.toContain('开始输出完整回答')
    view.rerender(<ChatBubble role="assistant" content="开始输出完整回答" isLast streaming={false} />)
    expect(view.container.textContent).toContain('开始输出完整回答')
  })
})
