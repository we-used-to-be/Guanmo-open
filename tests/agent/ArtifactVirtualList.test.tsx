import { useRef } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ArtifactVirtualList, type ArtifactListRow } from '@/components/reading-artifacts/ArtifactVirtualList'
import type { ReadingArtifactItem } from '@/services/readingArtifactCenter'

const rows: ArtifactListRow[] = Array.from({ length: 1000 }, (_, index) => ({
  key: `ai:${index}`, item: { key: `ai:${index}`, source: 'ai' } as ReadingArtifactItem,
}))
let observers: Array<{ notify: () => void; disconnect: ReturnType<typeof vi.fn> }>
let heights: Map<string, number>
let width = 400
const originalResizeObserver = globalThis.ResizeObserver

function List({ entries = rows }: { entries?: ArtifactListRow[] }) {
  const scroller = useRef<HTMLDivElement>(null)
  return <div ref={scroller} data-testid="scroller"><ArtifactVirtualList rows={entries} scrollerRef={scroller} renderRow={(row) => <div>
    <button>{row.key} first</button><button>{row.key} last</button>
  </div>} /></div>
}
const frame = () => act(() => vi.advanceTimersByTime(20))
function scroll(top: number) {
  const scroller = screen.getByTestId('scroller')
  scroller.scrollTop = top
  fireEvent.scroll(scroller)
  frame()
  return scroller
}

describe('成果列表动态高度虚拟化', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => window.setTimeout(() => callback(0), 16))
    vi.stubGlobal('cancelAnimationFrame', (id: number) => window.clearTimeout(id))
    observers = []
    heights = new Map()
    width = 400
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return this.dataset.testid === 'scroller' ? 300 : 0
    })
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => width)
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
      const key = this.dataset.artifactRow
      return key ? heights.get(key) ?? 100 : 0
    })
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const top = this.hasAttribute('data-artifact-virtual-list') ? -screen.getByTestId('scroller').scrollTop : 0
      return { x: 0, y: top, top, left: 0, right: width, bottom: top + 300, width, height: 300, toJSON() {} }
    })
    globalThis.ResizeObserver = class {
      disconnect = vi.fn()
      constructor(callback: ResizeObserverCallback) {
        observers.push({ notify: () => callback([], this), disconnect: this.disconnect })
      }
      observe() {}
      unobserve() {}
    }
  })
  afterEach(() => { cleanup(); globalThis.ResizeObserver = originalResizeObserver; vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers() })

  it('一千条已加载数据只挂载视口和缓冲行，滚动后能回来', () => {
    render(<List />)
    expect(document.querySelectorAll('[data-artifact-row]').length).toBeLessThan(12)
    expect(screen.getByRole('button', { name: 'ai:0 first' })).toBeInTheDocument()
    scroll(50000)
    expect(screen.queryByRole('button', { name: 'ai:0 first' })).toBeNull()
    expect(document.querySelectorAll('[data-artifact-row]').length).toBeLessThan(12)
    scroll(0)
    expect(screen.getByRole('button', { name: 'ai:0 first' })).toBeInTheDocument()
  })

  it('视口上方卡片高度变化时补偿滚动，保持当前阅读行的位置', () => {
    render(<List />)
    const scroller = scroll(1200)
    const above = [...document.querySelectorAll<HTMLElement>('[data-artifact-row]')].find((node) => Number.parseFloat(node.style.top) + node.offsetHeight <= scroller.scrollTop)!
    expect(above).toBeDefined()
    const previous = scroller.scrollTop
    heights.set(above.dataset.artifactRow!, 180)
    act(() => observers.forEach((observer) => observer.notify()))
    expect(scroller.scrollTop).toBe(previous + 80)
  })

  it('滚出视口保留当前焦点；Tab 能进入下一张尚未挂载的卡片', () => {
    render(<List />)
    const first = screen.getByRole('button', { name: 'ai:0 first' })
    act(() => first.focus())
    scroll(50000)
    expect(first).toHaveFocus()
    expect(document.querySelectorAll('[data-artifact-row]').length).toBeLessThan(13)
    scroll(0)
    const last = [...document.querySelectorAll<HTMLElement>('[data-artifact-row]')].at(-1)!
    const index = Number(last.dataset.artifactRow!.split(':')[1])
    const button = screen.getByRole('button', { name: `ai:${index} last` })
    act(() => button.focus())
    fireEvent.keyDown(button, { key: 'Tab' })
    expect(screen.getByRole('button', { name: `ai:${index + 1} first` })).toHaveFocus()
  })

  it('删除视口上方条目后保持存活锚点，并清理测量与滚动任务', () => {
    const view = render(<List />)
    const scroller = scroll(1200)
    const previous = scroller.scrollTop
    view.rerender(<List entries={rows.slice(1)} />)
    expect(scroller.scrollTop).toBe(previous - 100)
    fireEvent.scroll(scroller)
    view.unmount()
    expect(observers.every((observer) => observer.disconnect.mock.calls.length > 0)).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })
})
