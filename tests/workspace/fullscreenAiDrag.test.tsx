import type { PointerEventHandler } from 'react'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { panelRender } = vi.hoisted(() => ({ panelRender: vi.fn() }))
vi.mock('@/components/ai/AiPanel', () => ({
  AiPanel: ({ fullscreenDragHandleProps }: { fullscreenDragHandleProps?: Record<string, PointerEventHandler<HTMLDivElement>> }) => {
    panelRender()
    return <div data-testid="drag-handle" {...fullscreenDragHandleProps}>阅读成果</div>
  },
}))
vi.mock('@/components/editor/EditorArea', () => ({ EditorArea: () => <div>文档</div> }))
vi.mock('@/components/layout/Sidebar', () => ({ Sidebar: () => null }))
vi.mock('@/components/layout/StatusBar', () => ({ StatusBar: () => null }))
vi.mock('@/components/layout/TitleBar', () => ({ TitleBar: () => null }))
vi.mock('@/components/editor/FullscreenControlBar', () => ({ FullscreenControlBar: () => null }))
vi.mock('@/components/layout/FullscreenFileDrawer', () => ({ FullscreenFileDrawer: () => null }))
vi.mock('@/components/common/CommandPalette', () => ({ CommandPalette: () => null }))
vi.mock('@/hooks/useKeyboard', () => ({ useKeyboardShortcuts: () => {} }))
vi.mock('@/hooks/useFileOperations', () => ({ useFileOperations: () => ({}) }))
vi.mock('@/hooks/useFullscreen', async () => {
  const { useAppStore } = await import('@/stores/appStore')
  return { useFullscreen: () => ({ isFullscreen: useAppStore((s) => s.isFullscreen) }) }
})

import { AppLayout } from '@/components/layout/AppLayout'
import { useAppStore } from '@/stores/appStore'

let frames: Map<number, FrameRequestCallback>
let frameId: number
const flushFrames = () => act(() => {
  const pending = [...frames.values()]
  frames.clear()
  pending.forEach((callback) => callback(0))
})

async function mountPanel() {
  const view = render(<AppLayout databaseReady />)
  act(() => useAppStore.getState().toggleAiPanel())
  const handle = await screen.findByTestId('drag-handle')
  Object.assign(handle, {
    setPointerCapture: vi.fn(), hasPointerCapture: () => true, releasePointerCapture: vi.fn(),
  })
  flushFrames()
  const panel = document.querySelector<HTMLElement>('[data-fullscreen-ai-panel]')!
  panel.hasPointerCapture = () => false
  return { ...view, handle, panel }
}

describe('全屏小窗拖动隔离', () => {
  beforeEach(() => {
    frames = new Map()
    frameId = 0
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.set(++frameId, callback)
      return frameId
    })
    vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
    vi.stubGlobal('PointerEvent', class extends MouseEvent {
      pointerId: number
      constructor(type: string, options: PointerEventInit = {}) {
        super(type, options)
        this.pointerId = options.pointerId ?? 1
      }
    })
    useAppStore.setState({
      isFullscreen: true, aiPanelOpen: false, sidebarCollapsed: true,
      fullscreenAiPosition: { x: 100, y: 100 }, fullscreenAiSize: { width: 360, height: 420 },
    })
  })
  afterEach(() => vi.unstubAllGlobals())

  it('合并移动事件，逐帧移动不重渲染内容，松手才保存位置', async () => {
    const { handle, panel } = await mountPanel()
    fireEvent.pointerDown(handle, { clientX: 120, clientY: 120 })
    const renders = panelRender.mock.calls.length
    fireEvent.pointerMove(handle, { clientX: 130, clientY: 130 })
    fireEvent.pointerMove(handle, { clientX: 160, clientY: 150 })
    expect(frames.size).toBe(1)
    expect(useAppStore.getState().fullscreenAiPosition).toEqual({ x: 100, y: 100 })
    flushFrames()
    expect(panel.style.translate).toBe('40px 30px')
    expect(panelRender).toHaveBeenCalledTimes(renders)
    fireEvent.pointerMove(handle, { clientX: 180, clientY: 170 })
    flushFrames()
    expect(panelRender).toHaveBeenCalledTimes(renders)
    fireEvent.pointerUp(handle)
    expect(panel.style.left).toBe('160px')
    expect(panel.style.top).toBe('150px')
    expect(panel.style.translate).toBe('')
    expect(useAppStore.getState().fullscreenAiPosition).toEqual({ x: 160, y: 150 })
  })

  it('松手前未执行的帧也落地，重新拖动从最终位置开始', async () => {
    const { handle, panel } = await mountPanel()
    fireEvent.pointerDown(handle, { clientX: 100, clientY: 100 })
    fireEvent.pointerMove(handle, { clientX: 140, clientY: 140 })
    fireEvent.pointerUp(handle)
    expect(frames.size).toBe(0)
    expect(panel.style.left).toBe('140px')
    fireEvent.pointerDown(handle, { clientX: 200, clientY: 200 })
    fireEvent.pointerMove(handle, { clientX: 210, clientY: 210 })
    fireEvent.pointerCancel(handle)
    expect(useAppStore.getState().fullscreenAiPosition).toEqual({ x: 150, y: 150 })
    expect(document.body.style.userSelect).toBe('')
  })

  it('边界限制保留，关闭重开不回跳，也不残留待执行帧', async () => {
    const { handle, panel } = await mountPanel()
    fireEvent.pointerDown(handle, { clientX: 100, clientY: 100 })
    fireEvent.pointerMove(handle, { clientX: -500, clientY: -500 })
    act(() => useAppStore.getState().closeAiPanel())
    flushFrames()
    expect(useAppStore.getState().fullscreenAiPosition).toEqual({ x: 16, y: 16 })
    expect(document.body.style.userSelect).toBe('')
    act(() => useAppStore.getState().toggleAiPanel())
    expect(panel.style.left).toBe('16px')
    expect(panel.style.translate).toBe('')
  })

  it('卸载时取消帧并保留最终位置', async () => {
    const { handle, unmount } = await mountPanel()
    fireEvent.pointerDown(handle, { clientX: 100, clientY: 100 })
    fireEvent.pointerMove(handle, { clientX: 125, clientY: 130 })
    unmount()
    expect(frames.size).toBe(0)
    expect(document.body.style.userSelect).toBe('')
    expect(useAppStore.getState().fullscreenAiPosition).toEqual({ x: 125, y: 130 })
  })

  it('忽略其他指针，丢失捕获时落地最新坐标', async () => {
    const { handle, panel } = await mountPanel()
    fireEvent.pointerDown(handle, { clientX: 100, clientY: 100, pointerId: 1 })
    fireEvent.pointerMove(handle, { clientX: 500, clientY: 500, pointerId: 2 })
    fireEvent.pointerUp(handle, { pointerId: 2 })
    expect(frames.size).toBe(0)
    fireEvent.pointerMove(handle, { clientX: 130, clientY: 150, pointerId: 1 })
    fireEvent.lostPointerCapture(panel, { pointerId: 1 })
    expect(frames.size).toBe(0)
    expect(panel.style.left).toBe('130px')
    expect(useAppStore.getState().fullscreenAiPosition).toEqual({ x: 130, y: 150 })
  })

  it('视口变化终止当前拖动，旧帧不会覆盖校正后位置', async () => {
    const { handle, panel } = await mountPanel()
    fireEvent.pointerDown(handle, { clientX: 100, clientY: 100 })
    fireEvent.pointerMove(handle, { clientX: 140, clientY: 150 })
    fireEvent(window, new Event('resize'))
    expect(frames.size).toBe(0)
    expect(panel.style.left).toBe('140px')
    expect(panel.style.translate).toBe('')
    fireEvent.pointerMove(handle, { clientX: 200, clientY: 200 })
    flushFrames()
    expect(panel.style.left).toBe('140px')
  })

  it('拖动后缩放保持当前位置并保存新尺寸', async () => {
    const { handle, panel } = await mountPanel()
    fireEvent.pointerDown(handle, { clientX: 100, clientY: 100 })
    fireEvent.pointerMove(handle, { clientX: 130, clientY: 140 })
    fireEvent.pointerUp(handle)
    const resize = screen.getByLabelText('调整 AI 助手窗口大小')
    Object.assign(resize, {
      setPointerCapture: vi.fn(), hasPointerCapture: () => true, releasePointerCapture: vi.fn(),
    })
    fireEvent.pointerDown(resize, { clientX: 400, clientY: 500 })
    fireEvent.pointerMove(resize, { clientX: 430, clientY: 530 })
    fireEvent.pointerUp(resize)
    expect(panel.style.left).toBe('130px')
    expect(panel.style.top).toBe('140px')
    expect(useAppStore.getState().fullscreenAiSize).toEqual({ width: 390, height: 550 })
    expect(panel.style.translate).toBe('')
  })
})
