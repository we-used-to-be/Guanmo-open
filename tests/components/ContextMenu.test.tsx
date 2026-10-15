import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useState } from 'react'
import { ContextMenu, ContextMenuItem } from '@/components/common/ContextMenu'

afterEach(cleanup)

describe('ContextMenu', () => {
  it('renders outside a clipped stacking context and removes the portal on unmount', () => {
    const { unmount } = render(
      <div data-testid="sidebar-section" style={{ opacity: 0.9, overflow: 'hidden' }}>
        <ContextMenu position={{ x: 100, y: 120 }} onClose={vi.fn()}>
          <ContextMenuItem onClick={vi.fn()}>重命名</ContextMenuItem>
        </ContextMenu>
      </div>,
    )
    const menu = screen.getByText('重命名').closest('[data-context-menu]')
    expect(menu?.parentElement).toBe(document.body)
    expect(screen.getByTestId('sidebar-section').contains(menu)).toBe(false)
    unmount()
    expect(document.querySelector('[data-context-menu]')).toBeNull()
  })

  it('keeps item clicks isolated and closes on outside clicks and ancestor scrolling', () => {
    const onClose = vi.fn()
    const onAction = vi.fn()
    render(
      <div data-testid="scroll-container" onClick={vi.fn()}>
        <ContextMenu position={{ x: 100, y: 120 }} onClose={onClose}>
          <ContextMenuItem onClick={onAction}>打开文件位置</ContextMenuItem>
        </ContextMenu>
      </div>,
    )
    fireEvent.click(screen.getByText('打开文件位置'))
    expect(onAction).toHaveBeenCalledOnce()
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.click(document.body)
    expect(onClose).toHaveBeenCalledTimes(1)
    fireEvent.scroll(screen.getByTestId('scroll-container'))
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it('focuses the selected option and navigates past disabled items', () => {
    render(<ContextMenu position={{ x: 100, y: 120 }} onClose={vi.fn()}>
      <ContextMenuItem>第一项</ContextMenuItem>
      <ContextMenuItem disabled>禁用项</ContextMenuItem>
      <ContextMenuItem role="menuitemradio" selected>选中项</ContextMenuItem>
    </ContextMenu>)
    const selected = screen.getByRole('menuitemradio', { name: '选中项' })
    expect(selected).toHaveFocus()
    expect(selected).toHaveAttribute('aria-checked', 'true')
    fireEvent.keyDown(selected, { key: 'ArrowDown' })
    expect(screen.getByRole('menuitem', { name: '第一项' })).toHaveFocus()
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' })
    expect(selected).toHaveFocus()
    fireEvent.keyDown(selected, { key: 'Home' })
    expect(screen.getByRole('menuitem', { name: '第一项' })).toHaveFocus()
    fireEvent.keyDown(document.activeElement!, { key: 'End' })
    expect(selected).toHaveFocus()
  })

  it('restores the trigger on Escape and removes event listeners on unmount', () => {
    const onClose = vi.fn()
    function Harness() {
      const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null)
      return <><button onClick={(event) => setAnchor(event.currentTarget)}>打开菜单</button>
        {anchor && <ContextMenu anchor={anchor} onClose={() => { onClose(); setAnchor(null) }}><ContextMenuItem>操作</ContextMenuItem></ContextMenu>}
      </>
    }
    render(<Harness />)
    const trigger = screen.getByRole('button', { name: '打开菜单' })
    fireEvent.click(trigger)
    fireEvent.keyDown(screen.getByRole('menuitem'), { key: 'Escape' })
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('allows internal scrolling and preserves custom input keyboard handling', () => {
    const onClose = vi.fn()
    render(<ContextMenu position={{ x: 100, y: 120 }} role="dialog" onClose={onClose}>
      <button>关闭</button>
      <input aria-label="分类名称" />
      <div data-testid="menu-scroll"><button>保存</button></div>
    </ContextMenu>)
    const input = screen.getByRole('textbox')
    expect(input).toHaveFocus()
    expect(fireEvent.keyDown(input, { key: 'ArrowDown' })).toBe(true)
    expect(input).toHaveFocus()
    fireEvent.scroll(screen.getByTestId('menu-scroll'))
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.scroll(window)
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('focuses custom form content when switching from menu to dialog', () => {
    const { rerender } = render(<ContextMenu position={{ x: 100, y: 120 }} onClose={vi.fn()}><ContextMenuItem>设置分类</ContextMenuItem></ContextMenu>)
    rerender(<ContextMenu position={{ x: 100, y: 120 }} role="dialog" onClose={vi.fn()}><input aria-label="搜索分类" /></ContextMenu>)
    expect(screen.getByRole('textbox', { name: '搜索分类' })).toHaveFocus()
  })

  it('does not restore focus over a control clicked outside the menu', () => {
    function Harness() {
      const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null)
      return <><button onClick={(event) => setAnchor(event.currentTarget)}>打开菜单</button><input aria-label="外部输入" />
        {anchor && <ContextMenu anchor={anchor} onClose={() => setAnchor(null)}><ContextMenuItem>操作</ContextMenuItem></ContextMenu>}
      </>
    }
    render(<Harness />)
    const trigger = screen.getByRole('button', { name: '打开菜单' })
    fireEvent.click(trigger)
    fireEvent.pointerDown(screen.getByRole('textbox'))
    expect(trigger).not.toHaveFocus()
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })
})
