import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FullscreenPanelNavigation } from '@/components/ai/FullscreenPanelNavigation'

describe('全屏小窗导航自动收起', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())
  const advance = (ms: number) => act(() => { vi.advanceTimersByTime(ms) })
  function mount(open = true) {
    const onSelect = vi.fn()
    const props = { active: true, view: 'chat' as const, databaseEnabled: true, onSelect }
    const result = render(<FullscreenPanelNavigation {...props} />)
    if (open) fireEvent.click(screen.getByRole('button', { name: '切换页面' }), { detail: 1 })
    return { ...result, props, onSelect }
  }

  it('打开与重新打开都只显示三个点，点击才展开', () => {
    const { rerender, props } = mount(false)
    expect(screen.queryByRole('navigation')).toBeNull()
    advance(5000)
    expect(screen.queryByRole('navigation')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '切换页面' }), { detail: 1 })
    expect(screen.getByRole('navigation')).toBeInTheDocument()
    advance(2000)
    expect(screen.queryByRole('navigation')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '切换页面' }), { detail: 1 })
    rerender(<FullscreenPanelNavigation {...props} active={false} />)
    rerender(<FullscreenPanelNavigation {...props} />)
    expect(screen.queryByRole('navigation')).toBeNull()
    expect(screen.getByRole('button', { name: '切换页面' })).toHaveAttribute('aria-expanded', 'false')
  })

  it('悬停时暂停，移出后重新等待两秒，反复移入不会被旧计时收起', () => {
    mount()
    const root = screen.getByRole('navigation').parentElement!.parentElement!
    advance(500)
    fireEvent.pointerEnter(root)
    advance(5000)
    expect(screen.getByRole('navigation')).toBeInTheDocument()
    fireEvent.pointerLeave(root)
    advance(1500)
    fireEvent.pointerEnter(root)
    advance(1000)
    expect(screen.getByRole('navigation')).toBeInTheDocument()
    fireEvent.pointerLeave(root)
    advance(2000)
    expect(screen.queryByRole('navigation')).toBeNull()
  })

  it('键盘展开后焦点进入导航，空闲不隐藏焦点，Esc 收起并恢复焦点', () => {
    mount(false)
    const trigger = screen.getByRole('button', { name: '切换页面' })
    fireEvent.click(trigger)
    expect(screen.getByRole('button', { name: 'AI 助手' })).toHaveFocus()
    advance(5000)
    expect(screen.getByRole('navigation')).toBeInTheDocument()
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    expect(screen.queryByRole('navigation')).toBeNull()
    expect(trigger).toHaveFocus()
  })

  it('离开键盘焦点后两秒收起，点击外部和窗口缩放立即收起', () => {
    mount()
    act(() => screen.getByRole('button', { name: '阅读成果' }).focus())
    advance(5000)
    act(() => (document.activeElement as HTMLElement).blur())
    advance(2000)
    expect(screen.queryByRole('navigation')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '切换页面' }), { detail: 1 })
    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('navigation')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '切换页面' }), { detail: 1 })
    fireEvent(window, new Event('resize'))
    expect(screen.queryByRole('navigation')).toBeNull()
  })

  it('选择页面后保持导航可用，关闭和卸载清理待执行计时', () => {
    const { onSelect, rerender, props, unmount } = mount()
    fireEvent.click(screen.getByRole('button', { name: '阅读成果' }))
    expect(onSelect).toHaveBeenCalledWith('artifacts')
    expect(screen.getByRole('navigation')).toBeInTheDocument()
    rerender(<FullscreenPanelNavigation {...props} active={false} />)
    advance(5000)
    expect(screen.queryByRole('navigation')).toBeNull()
    rerender(<FullscreenPanelNavigation {...props} />)
    unmount()
    advance(5000)
    expect(onSelect).toHaveBeenCalledTimes(1)
  })

  it('小窗宽度变化收起导航，首次尺寸通知不误收起，卸载解除观察', () => {
    let notify!: (entries: ResizeObserverEntry[]) => void
    const disconnect = vi.fn()
    const original = globalThis.ResizeObserver
    globalThis.ResizeObserver = class {
      constructor(callback: ResizeObserverCallback) { notify = (entries) => callback(entries, this) }
      observe() {}
      unobserve() {}
      disconnect = disconnect
    }
    try {
      const { unmount } = render(<div><div><FullscreenPanelNavigation active view="chat" databaseEnabled onSelect={vi.fn()} /></div></div>)
      const resize = (width: number) => act(() => notify([{ contentRect: { width } } as ResizeObserverEntry]))
      fireEvent.click(screen.getByRole('button', { name: '切换页面' }), { detail: 1 })
      resize(480)
      expect(screen.getByRole('navigation')).toBeInTheDocument()
      resize(420)
      expect(screen.queryByRole('navigation')).toBeNull()
      unmount()
      expect(disconnect).toHaveBeenCalledOnce()
    } finally {
      globalThis.ResizeObserver = original
    }
  })
})
