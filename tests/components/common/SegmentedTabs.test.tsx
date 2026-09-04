import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { SegmentedTabs } from '@/components/common/SegmentedTabs'

const originalResizeObserver = globalThis.ResizeObserver

afterEach(() => {
  globalThis.ResizeObserver = originalResizeObserver
})

function setLayout(element: HTMLElement, left: number, width: number) {
  Object.defineProperties(element, {
    offsetLeft: { configurable: true, value: left },
    offsetWidth: { configurable: true, value: width },
  })
}

describe('SegmentedTabs', () => {
  const items = [
    { value: 'short', label: '短' },
    { value: 'long', label: '更长的文案' },
    { value: 'disabled', label: '禁用', disabled: true },
  ] as const

  it('renders controlled tabs with basic ARIA and moves the indicator to the measured item', () => {
    const resizeCallbacks: Array<() => void> = []
    class TrackingResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        resizeCallbacks.push(() => callback([], this as unknown as ResizeObserver))
      }

      observe() {}
      disconnect() {}
    }
    globalThis.ResizeObserver = TrackingResizeObserver as unknown as typeof ResizeObserver

    const view = render(
      <SegmentedTabs ariaLabel="示例切换" items={items} value="short" onChange={vi.fn()} />,
    )
    const root = screen.getByRole('tablist')
    const short = screen.getByRole('tab', { name: '短' })
    const long = screen.getByRole('tab', { name: '更长的文案' })
    expect(root.querySelector('.gm-segmented-tabs__indicator')).not.toBeInTheDocument()
    setLayout(short, 4, 36)
    setLayout(long, 42, 88)

    act(() => resizeCallbacks.forEach((callback) => callback()))
    expect(root).toHaveAttribute('aria-label', '示例切换')
    expect(short).toHaveAttribute('aria-selected', 'true')
    expect(short).toHaveAttribute('tabindex', '0')
    expect(long).toHaveAttribute('aria-selected', 'false')
    expect(root.style.getPropertyValue('--gm-segmented-tabs-indicator-left')).toBe('4px')
    expect(root.style.getPropertyValue('--gm-segmented-tabs-indicator-width')).toBe('36px')
    expect(root).toHaveAttribute('data-indicator-initial', 'true')
    view.rerender(<SegmentedTabs ariaLabel="示例切换" items={items} value="long" onChange={vi.fn()} />)
    expect(root.style.getPropertyValue('--gm-segmented-tabs-indicator-left')).toBe('42px')
    expect(root.style.getPropertyValue('--gm-segmented-tabs-indicator-width')).toBe('88px')
    expect(root).toHaveAttribute('data-indicator-initial', 'false')
    view.unmount()
  })

  it('mounts the initial indicator at the selected item without a transition', () => {
    const offsetLeft = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetLeft')
    const offsetWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth')
    Object.defineProperties(HTMLElement.prototype, {
      offsetLeft: {
        configurable: true,
        get() { return this.textContent?.includes('更长') ? 42 : 4 },
      },
      offsetWidth: {
        configurable: true,
        get() { return this.textContent?.includes('更长') ? 88 : 36 },
      },
    })

    try {
      render(<SegmentedTabs ariaLabel="示例切换" items={items} value="short" onChange={vi.fn()} />)
      const root = screen.getByRole('tablist')
      expect(root).toHaveAttribute('data-indicator-initial', 'true')
      expect(root.style.getPropertyValue('--gm-segmented-tabs-indicator-left')).toBe('4px')
      expect(root.style.getPropertyValue('--gm-segmented-tabs-indicator-width')).toBe('36px')
    } finally {
      if (offsetLeft) Object.defineProperty(HTMLElement.prototype, 'offsetLeft', offsetLeft)
      if (offsetWidth) Object.defineProperty(HTMLElement.prototype, 'offsetWidth', offsetWidth)
    }
  })

  it('calls onChange from clicks and keyboard navigation skips disabled items', () => {
    const onChange = vi.fn()
    render(<SegmentedTabs ariaLabel="示例切换" items={items} value="short" onChange={onChange} />)
    const short = screen.getByRole('tab', { name: '短' })
    const long = screen.getByRole('tab', { name: '更长的文案' })

    fireEvent.click(long)
    expect(onChange).toHaveBeenCalledWith('long')

    fireEvent.keyDown(short, { key: 'ArrowRight' })
    expect(onChange).toHaveBeenCalledWith('long')
    fireEvent.keyDown(short, { key: 'ArrowLeft' })
    expect(onChange).toHaveBeenCalledWith('long')
  })

  it('supports Home/End, disabled state, and controlled updates', () => {
    const onChange = vi.fn()
    const view = render(<SegmentedTabs ariaLabel="示例切换" items={items} value="short" onChange={onChange} />)
    const short = screen.getByRole('tab', { name: '短' })
    const long = screen.getByRole('tab', { name: '更长的文案' })
    const disabled = screen.getByRole('tab', { name: '禁用' })

    expect(disabled).toBeDisabled()
    fireEvent.keyDown(short, { key: 'End' })
    expect(onChange).toHaveBeenCalledWith('long')
    view.rerender(<SegmentedTabs ariaLabel="示例切换" items={items} value="long" onChange={onChange} />)
    fireEvent.keyDown(long, { key: 'Home' })
    expect(onChange).toHaveBeenCalledWith('short')
    view.rerender(<SegmentedTabs ariaLabel="示例切换" items={items} value="short" onChange={onChange} />)
    expect(short).toHaveAttribute('aria-selected', 'true')

    view.rerender(<SegmentedTabs ariaLabel="示例切换" items={items} value="long" onChange={onChange} />)
    expect(long).toHaveAttribute('aria-selected', 'true')
    expect(long).toHaveAttribute('tabindex', '0')
  })

  it('supports overall disabled state and class/size extensions', () => {
    const onChange = vi.fn()
    render(
      <SegmentedTabs
        ariaLabel="示例切换"
        className="custom-tabs"
        disabled
        items={items}
        size="medium"
        value="short"
        onChange={onChange}
      />,
    )
    const root = screen.getByRole('tablist')
    const short = screen.getByRole('tab', { name: '短' })
    fireEvent.click(short)
    expect(onChange).not.toHaveBeenCalled()
    expect(root).toHaveClass('custom-tabs', 'gm-segmented-tabs--medium')
    expect(root).toHaveAttribute('aria-disabled', 'true')
    expect(short).toBeDisabled()
  })
})
