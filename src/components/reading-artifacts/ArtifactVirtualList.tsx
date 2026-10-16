import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react'
import type { ReadingArtifactItem } from '@/services/readingArtifactCenter'

export type ArtifactListRow = { key: string; item?: ReadingArtifactItem; heading?: string }
const OVERSCAN = 2
const FOCUSABLE = 'button:not(:disabled), a[href], input:not(:disabled), textarea:not(:disabled), summary, [tabindex="0"]'

function indexAt(offsets: number[], top: number) {
  let low = 0
  let high = offsets.length - 1
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (offsets[middle] <= top) low = middle
    else high = middle - 1
  }
  return Math.min(low, offsets.length - 2)
}

const MeasuredRow = memo(function MeasuredRow({ row, top, virtual, register, children }: {
  row: ArtifactListRow; top: number; virtual: boolean
  register: (key: string, node: HTMLDivElement | null) => void; children: ReactNode
}) {
  const ref = useCallback((node: HTMLDivElement | null) => register(row.key, node), [register, row.key])
  return <div ref={ref} data-artifact-row={row.key} style={virtual ? { position: 'absolute', top, left: 0, right: 0, paddingBottom: 8 } : { paddingBottom: 8 }}>{children}</div>
})

/** 数据由成果中心持有；这里只管理已加载条目的测量、挂载和键盘焦点。 */
export function ArtifactVirtualList({ rows, scrollerRef, renderRow, active = true }: {
  rows: ArtifactListRow[]; scrollerRef: RefObject<HTMLDivElement>
  renderRow: (row: ArtifactListRow) => ReactNode; active?: boolean
}) {
  const rootRef = useRef<HTMLDivElement>(null)
  const nodes = useRef(new Map<string, HTMLDivElement>())
  const [heights, setHeights] = useState(() => new Map<string, number>())
  const heightsRef = useRef(heights)
  const observer = useRef<ResizeObserver | null>(null)
  const frame = useRef<number | null>(null)
  const [viewport, setViewport] = useState({ top: 0, height: 600, width: 0 })
  const viewportRef = useRef(viewport)
  const [focusedKey, setFocusedKey] = useState<string | null>(null)
  const pendingFocus = useRef<{ key: string; last: boolean } | null>(null)
  const virtual = rows.length > 0
  const layout = useMemo(() => {
    const offsets = [0]
    const indices = new Map<string, number>()
    rows.forEach((row, index) => {
      indices.set(row.key, index)
      const estimate = row.heading ? 40 : row.item?.source === 'user' ? 260 : 160
      offsets.push(offsets[index] + (heights.get(row.key) ?? estimate))
    })
    return { rows, offsets, indices }
  }, [rows, heights])
  const previousLayout = useRef(layout)

  const readViewport = useCallback(() => {
    const scroller = scrollerRef.current
    const root = rootRef.current
    if (!scroller || !root || scroller.clientHeight === 0) return
    const origin = root.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop - scroller.clientTop
    const next = { top: Math.max(0, scroller.scrollTop - origin), height: scroller.clientHeight, width: scroller.clientWidth }
    const current = viewportRef.current
    if (current.top === next.top && current.height === next.height && current.width === next.width) return
    viewportRef.current = next
    setViewport(next)
  }, [scrollerRef])

  const measure = useCallback(() => {
    if (rootRef.current?.closest('[hidden]')) return
    const current = heightsRef.current
    let next = current
    nodes.current.forEach((node, key) => {
      // offsetHeight excludes ancestor and entrance transforms.
      const height = node.offsetHeight
      if (height > 0 && current.get(key) !== height) {
        if (next === current) next = new Map(current)
        next.set(key, height)
      }
    })
    if (next !== current) { heightsRef.current = next; setHeights(next) }
  }, [])

  const register = useCallback((key: string, node: HTMLDivElement | null) => {
    const previous = nodes.current.get(key)
    if (previous) observer.current?.unobserve(previous)
    if (node) {
      nodes.current.set(key, node)
      observer.current?.observe(node)
    } else nodes.current.delete(key)
  }, [])

  useEffect(() => {
    if (!active) return
    const scroller = scrollerRef.current
    if (!scroller) return
    const schedule = () => {
      if (frame.current !== null) return
      frame.current = requestAnimationFrame(() => {
        frame.current = null
        readViewport()
      })
    }
    const resize = new ResizeObserver(() => { readViewport(); measure() })
    observer.current = resize
    resize.observe(scroller)
    nodes.current.forEach((node) => resize.observe(node))
    scroller.addEventListener('scroll', schedule, { passive: true })
    readViewport()
    measure()
    return () => {
      resize.disconnect()
      observer.current = null
      scroller.removeEventListener('scroll', schedule)
      if (frame.current !== null) cancelAnimationFrame(frame.current)
      frame.current = null
    }
  }, [active, measure, readViewport, scrollerRef])

  useLayoutEffect(() => {
    // A width change invalidates offscreen measurements too.
    heightsRef.current = new Map()
    setHeights(heightsRef.current)
    measure()
  }, [viewport.width, measure])

  useLayoutEffect(() => {
    const previous = previousLayout.current
    previousLayout.current = layout
    const scroller = scrollerRef.current
    if (virtual && previous !== layout && scroller && previous.rows.length && viewport.top > 0) {
      const anchor = indexAt(previous.offsets, viewport.top)
      // Prefer the old visible row; if deleted, keep the next surviving row in place.
      for (let index = anchor; index < previous.rows.length; index++) {
        const nextIndex = layout.indices.get(previous.rows[index].key)
        if (nextIndex === undefined) continue
        const delta = layout.offsets[nextIndex] - previous.offsets[index]
        if (delta) {
          const root = rootRef.current!
          const origin = root.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop - scroller.clientTop
          // Use the old viewport, since a shrinking list may already have clamped scrollTop.
          scroller.scrollTop = viewport.top + origin + delta
        }
        break
      }
    }
    readViewport()
    measure()
    if (focusedKey && previous.indices.has(focusedKey) && !layout.indices.has(focusedKey)) {
      setFocusedKey(null)
      scroller?.focus({ preventScroll: true })
    }
    const pending = pendingFocus.current
    if (pending) {
      const targets = nodes.current.get(pending.key)?.querySelectorAll<HTMLElement>(FOCUSABLE)
      if (targets?.length) {
        pendingFocus.current = null
        targets[pending.last ? targets.length - 1 : 0].focus()
      }
    }
  }, [layout, measure, readViewport, scrollerRef, virtual, viewport.top, focusedKey])

  const start = virtual ? Math.max(0, indexAt(layout.offsets, viewport.top) - OVERSCAN) : 0
  const end = virtual ? Math.min(rows.length, indexAt(layout.offsets, viewport.top + viewport.height) + OVERSCAN + 1) : rows.length
  const visible = new Set(Array.from({ length: Math.max(0, end - start) }, (_, index) => start + index))
  const focusedIndex = focusedKey ? layout.indices.get(focusedKey) : undefined
  if (focusedIndex !== undefined) visible.add(focusedIndex)

  const moveFocus = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!virtual || event.key !== 'Tab' || event.altKey || event.ctrlKey || event.metaKey) return
    const rowNode = (event.target as HTMLElement).closest<HTMLElement>('[data-artifact-row]')
    const index = rowNode ? layout.indices.get(rowNode.dataset.artifactRow!) : undefined
    if (index === undefined) return
    const controls = [...rowNode!.querySelectorAll<HTMLElement>(FOCUSABLE)]
    const boundary = event.shiftKey ? controls[0] : controls[controls.length - 1]
    if (event.target !== boundary) return
    for (let next = index + (event.shiftKey ? -1 : 1); next >= 0 && next < rows.length; next += event.shiftKey ? -1 : 1) {
      if (!rows[next].item) continue
      if (visible.has(next)) return
      event.preventDefault()
      pendingFocus.current = { key: rows[next].key, last: event.shiftKey }
      setFocusedKey(rows[next].key)
      return
    }
  }

  return <div ref={rootRef} data-artifact-virtual-list={virtual || undefined} onKeyDownCapture={moveFocus}
    onFocusCapture={(event) => {
      const row = (event.target as HTMLElement).closest<HTMLElement>('[data-artifact-row]')
      if (row) setFocusedKey(row.dataset.artifactRow!)
    }} style={virtual ? { position: 'relative', height: layout.offsets[rows.length], overflowAnchor: 'none' } : { overflowAnchor: 'none' }}>
    {[...visible].sort((a, b) => a - b).map((index) => <MeasuredRow key={rows[index].key} row={rows[index]} top={layout.offsets[index]} virtual={virtual} register={register}>{renderRow(rows[index])}</MeasuredRow>)}
  </div>
}
