import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FullscreenControlBar } from '@/components/editor/FullscreenControlBar'
import { useSettingsStore } from '@/stores/settingsStore'

const exitFullscreen = vi.hoisted(() => vi.fn())
vi.mock('@/hooks/useFullscreen', () => ({
  useFullscreen: () => ({ exitFullscreen }),
}))

describe('FullscreenControlBar auto hide', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
  })

  afterEach(() => {
    useSettingsStore.getState().restoreDefaultThemes()
    vi.useRealTimers()
  })

  it('hides after the pointer leaves the top reveal region without entering the bar', () => {
    const { container } = render(
      <FullscreenControlBar
        fileDrawerOpen={false}
        onToggleFileDrawer={vi.fn()}
        onCloseFileDrawer={vi.fn()}
        onNewFile={vi.fn()}
        onOpenFile={vi.fn()}
      />,
    )
    const trigger = container.querySelector<HTMLElement>('[data-fullscreen-control-trigger]')
    const bar = container.querySelector<HTMLElement>('[data-fullscreen-control-bar]')

    expect(trigger).not.toBeNull()
    expect(bar).toHaveClass('opacity-0')

    fireEvent.mouseEnter(trigger!)
    expect(bar).toHaveClass('opacity-100')

    fireEvent.mouseLeave(trigger!)
    act(() => vi.advanceTimersByTime(699))
    expect(bar).toHaveClass('opacity-100')

    act(() => vi.advanceTimersByTime(1))
    expect(bar).toHaveClass('opacity-0')
  })

  it('restarts auto hide after the file drawer closes while the pointer is outside', () => {
    const props = {
      onToggleFileDrawer: vi.fn(),
      onCloseFileDrawer: vi.fn(),
      onNewFile: vi.fn(),
      onOpenFile: vi.fn(),
    }
    const { container, rerender } = render(
      <FullscreenControlBar fileDrawerOpen {...props} />,
    )
    const bar = container.querySelector<HTMLElement>('[data-fullscreen-control-bar]')

    expect(bar).toHaveClass('opacity-100')
    fireEvent.mouseLeave(bar!)

    rerender(<FullscreenControlBar fileDrawerOpen={false} {...props} />)
    act(() => vi.advanceTimersByTime(700))

    expect(bar).toHaveClass('opacity-0')
  })

  it('uses the current settings theme slots in fullscreen', () => {
    expect(useSettingsStore.getState().removeTheme('paper')).toBe(true)
    expect(useSettingsStore.getState().addCustomTheme({
      id: 'custom-sea',
      label: '海盐蓝',
      description: '清爽蓝色',
      colorScheme: 'light',
      startupCanvas: '#F5F8FC',
      palette: {
        canvas: '#F5F8FC', surface: '#FFFFFF', elevated: '#EEF4FA', text: '#1F2937', mutedText: '#64748B',
        border: '#CBD5E1', primary: '#2563EB', onPrimary: '#FFFFFF', accent: '#0F766E', editorBackground: '#FFFFFF',
        heading: '#172554', link: '#1D4ED8', codeBackground: '#EFF6FF', codeText: '#1E3A8A', selection: '#93C5FD',
        success: '#16A34A', warning: '#D97706', error: '#DC2626',
      },
    })).toBe(true)

    const { container } = render(
      <FullscreenControlBar
        fileDrawerOpen={false}
        onToggleFileDrawer={vi.fn()}
        onCloseFileDrawer={vi.fn()}
        onNewFile={vi.fn()}
        onOpenFile={vi.fn()}
      />,
    )
    fireEvent.click(container.querySelector('[data-fullscreen-theme-control] button[title="选择主题"]')!)

    const options = Array.from(container.querySelectorAll('#fullscreen-theme-card button')).map((button) => button.textContent)
    expect(options).toEqual(['暖色', '浅色', '深色', 'GitHub Light', '海盐蓝'])
  })

  it('keeps the file action menu open for selection and closes it on Escape', () => {
    const onNewFile = vi.fn()
    const onOpenFile = vi.fn()
    const onCloseFileDrawer = vi.fn()
    const { container } = render(
      <FullscreenControlBar
        fileDrawerOpen
        onToggleFileDrawer={vi.fn()}
        onCloseFileDrawer={onCloseFileDrawer}
        onNewFile={onNewFile}
        onOpenFile={onOpenFile}
      />,
    )
    const plus = container.querySelector<HTMLButtonElement>('[data-fullscreen-file-menu] button[title="新建或打开文件"]')!

    fireEvent.click(plus)
    expect(plus).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('menu', { name: '文件操作' }).parentElement).toBe(document.body)
    fireEvent.click(screen.getByRole('menuitem', { name: '新增文件' }))
    expect(onNewFile).toHaveBeenCalledOnce()
    expect(onCloseFileDrawer).toHaveBeenCalledOnce()
    expect(screen.queryByRole('menu', { name: '文件操作' })).not.toBeInTheDocument()

    fireEvent.click(plus)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('menu', { name: '文件操作' })).not.toBeInTheDocument()
    expect(onOpenFile).not.toHaveBeenCalled()
    expect(exitFullscreen).not.toHaveBeenCalled()
    expect(plus).toHaveFocus()

    fireEvent.click(plus)
    fireEvent.click(screen.getByRole('menuitem', { name: '打开文件' }))
    expect(onOpenFile).toHaveBeenCalledOnce()
  })
})
