import { act, renderHook } from '@testing-library/react'
import { createRef } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { usePreviewSwitchSnapshot } from '@/components/editor/usePreviewSwitchSnapshot'
import { useEditorStore } from '@/stores/editorStore'

afterEach(() => document.querySelectorAll('[data-snapshot-fixture]').forEach((element) => element.remove()))

function setup(fullscreen = false) {
  useEditorStore.setState({ activeTabId: 'a', viewMode: 'preview' })
  const host = document.createElement('div')
  host.dataset.snapshotFixture = ''
  const source = document.createElement('div')
  source.className = fullscreen ? 'gm-fullscreen-preview-content' : ''
  const root = document.createElement('div')
  root.className = 'gm-markdown-preview'
  source.append(root)
  host.append(source)
  document.body.append(host)
  const ref = createRef<HTMLDivElement>()
  Object.assign(ref, { current: source })
  const hook = renderHook(({ key, enabled, masked }) => usePreviewSwitchSnapshot(ref, key, enabled, masked), {
    initialProps: { key: 'a', enabled: true, masked: false },
  })
  const snapshot = () => host.querySelector<HTMLElement>('[data-preview-switch-snapshot]')
  return { host, source, root, hook, snapshot }
}

describe('preview switch visual copy', () => {
  it('退出预览、关闭最后文档和卸载都会释放副本；首次挂载不创建副本', () => {
    const { hook, snapshot } = setup()
    expect(snapshot()).toBeNull()
    act(() => useEditorStore.getState().setActiveTab('b'))
    expect(snapshot()).not.toBeNull()
    act(() => useEditorStore.getState().setViewMode('edit'))
    expect(snapshot()).toBeNull()
    act(() => useEditorStore.getState().setViewMode('preview'))
    act(() => useEditorStore.getState().setActiveTab('c'))
    expect(snapshot()).not.toBeNull()
    act(() => useEditorStore.setState({ activeTabId: null }))
    expect(snapshot()).toBeNull()
    act(() => useEditorStore.getState().setActiveTab('d'))
    expect(snapshot()).not.toBeNull()
    hook.unmount()
    expect(snapshot()).toBeNull()
    act(() => useEditorStore.getState().setActiveTab('e'))
    expect(snapshot()).toBeNull()
  })

  it('全屏副本保持 SVG 引用、滚动和 Canvas 像素，且不复制事件监听器', () => {
    const { root, source, hook, snapshot } = setup(true)
    const click = vi.fn()
    root.addEventListener('click', click)
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    const marker = document.createElementNS(svg.namespaceURI, 'marker')
    marker.id = 'arrow'
    const path = document.createElementNS(svg.namespaceURI, 'path')
    path.setAttribute('marker-end', 'url(#arrow)')
    svg.append(marker, path)
    const canvas = document.createElement('canvas')
    const drawImage = vi.fn()
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage } as unknown as CanvasRenderingContext2D)
    root.append(svg, canvas)
    source.scrollTop = 240
    root.scrollLeft = 60
    act(() => useEditorStore.getState().setActiveTab('b'))
    const copy = snapshot()!
    expect(copy).toHaveAttribute('inert')
    expect(copy).toHaveAttribute('aria-hidden', 'true')
    expect(copy.firstElementChild).toHaveClass('gm-fullscreen-preview-content')
    expect(copy.firstElementChild?.scrollTop).toBe(240)
    const copiedRoot = copy.querySelector<HTMLElement>('.gm-markdown-preview')!
    expect(copiedRoot.scrollLeft).toBe(60)
    copiedRoot.click()
    expect(click).not.toHaveBeenCalled()
    const copiedId = copy.querySelector('marker')!.id
    expect(copiedId).not.toBe('arrow')
    expect(copy.querySelector('path')).toHaveAttribute('marker-end', `url(#${copiedId})`)
    expect(drawImage).toHaveBeenCalledWith(canvas, 0, 0)
    hook.rerender({ key: 'b', enabled: true, masked: false })
    expect(snapshot()).toBeNull()
  })
})
