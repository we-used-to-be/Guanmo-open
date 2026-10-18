import { act, fireEvent, render as renderComponent, screen } from '@testing-library/react'
import type { ReactElement, ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FullscreenPanelNavigation } from '@/components/ai/FullscreenPanelNavigation'
import { FULLSCREEN_NAVIGATION_HINT_KEY } from '@/components/ai/FullscreenNavigationHint'

function Panel({ children }: { children: ReactNode }) {
  return <div data-fullscreen-ai-panel="true"><div data-fullscreen-ai-drag-handle="">{children}</div><div data-fullscreen-ai-resize-handle="" /></div>
}
const render = (ui: ReactElement) => renderComponent(ui, { wrapper: Panel })

describe('全屏小窗导航自动收起', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.useFakeTimers()
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const rect = this.hasAttribute('data-fullscreen-ai-panel') ? { x: 100, y: 100, width: 360, height: 420 }
        : this.hasAttribute('data-fullscreen-ai-resize-handle') ? { x: 440, y: 500, width: 20, height: 20 }
          : this.hasAttribute('data-fullscreen-ai-drag-handle') ? { x: 100, y: 100, width: 360, height: 24 }
            : this.getAttribute('role') === 'dialog' ? { x: 140, y: 140, width: 280, height: 180 }
              : { x: 264, y: 104, width: 32, height: 12 }
      return { ...rect, left: rect.x, top: rect.y, right: rect.x + rect.width, bottom: rect.y + rect.height, toJSON() {} }
    })
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(360)
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(420)
  })
  afterEach(() => vi.useRealTimers())
  const advance = (ms: number) => act(() => { vi.advanceTimersByTime(ms) })
  function mount(open = true) {
    localStorage.setItem(FULLSCREEN_NAVIGATION_HINT_KEY, '1')
    const onSelect = vi.fn()
    const props = { active: true, view: 'chat' as const, databaseEnabled: true, onSelect }
    const result = render(<FullscreenPanelNavigation {...props} />)
    if (open) fireEvent.click(screen.getByRole('button', { name: '切换页面' }), { detail: 1 })
    return { ...result, props, onSelect }
  }

  it('首次实际打开才提示，点击知道了后重开和重新挂载都不重复', () => {
    const props = { active: false, view: 'chat' as const, databaseEnabled: true, onSelect: vi.fn() }
    const { rerender, unmount } = render(<FullscreenPanelNavigation {...props} />)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(localStorage.getItem(FULLSCREEN_NAVIGATION_HINT_KEY)).toBeNull()
    rerender(<FullscreenPanelNavigation {...props} active />)
    expect(screen.getByRole('dialog')).toHaveTextContent('点击顶部三点，可切换 AI 助手、阅读成果和阅读提醒。')
    expect(localStorage.getItem(FULLSCREEN_NAVIGATION_HINT_KEY)).toBe('1')
    advance(10000)
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(document.querySelector('[data-product-tour-focus]')).toHaveAttribute('x', '258')
    fireEvent.click(screen.getByRole('button', { name: '下一步' }))
    expect(screen.getByRole('dialog')).toHaveTextContent('顶部除三点按钮外的任意位置')
    const regions = document.querySelectorAll('[data-product-tour-focus]')
    expect(regions).toHaveLength(2)
    expect(Number(regions[0].getAttribute('x')) + Number(regions[0].getAttribute('width'))).toBe(264)
    expect(regions[1]).toHaveAttribute('x', '296')
    fireEvent.click(screen.getByRole('button', { name: '下一步' }))
    expect(screen.getByRole('dialog')).toHaveTextContent('右下角的缩放手柄')
    expect(document.querySelector('[data-product-tour-focus]')).toHaveAttribute('x', '434')
    expect(document.querySelector('[data-product-tour-focus]')).toHaveAttribute('y', '494')
    expect(document.querySelector('.gm-product-tour__connector')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '知道了' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByRole('button', { name: '切换页面' })).toHaveFocus()
    rerender(<FullscreenPanelNavigation {...props} />)
    rerender(<FullscreenPanelNavigation {...props} active />)
    expect(screen.queryByRole('dialog')).toBeNull()
    unmount()
    render(<FullscreenPanelNavigation {...props} active />)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('产品导览不消耗首次提示，点击三点后在导航收起时继续介绍拖动', () => {
    const props = { active: true, view: 'chat' as const, databaseEnabled: true, onSelect: vi.fn() }
    const { rerender } = render(<FullscreenPanelNavigation {...props} productTourActive />)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(localStorage.getItem(FULLSCREEN_NAVIGATION_HINT_KEY)).toBeNull()
    rerender(<FullscreenPanelNavigation {...props} />)
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    fireEvent.pointerEnter(screen.getByRole('dialog'))
    fireEvent.click(screen.getByRole('button', { name: '切换页面' }), { detail: 1 })
    expect(screen.queryByRole('dialog')).toBeNull()
    advance(2000)
    expect(screen.getByRole('dialog')).toHaveTextContent('顶部除三点按钮外的任意位置')
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('关闭未确认的气泡也不再提示，Web 文案说明能力限制', () => {
    const props = { active: true, view: 'chat' as const, databaseEnabled: false, onSelect: vi.fn() }
    const { rerender } = render(<FullscreenPanelNavigation {...props} />)
    expect(screen.getByRole('dialog')).toHaveTextContent('仅桌面版可用')
    rerender(<FullscreenPanelNavigation {...props} active={false} />)
    rerender(<FullscreenPanelNavigation {...props} />)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

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
      const { unmount } = render(<div><div><FullscreenPanelNavigation active view="chat" databaseEnabled productTourActive onSelect={vi.fn()} /></div></div>)
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
