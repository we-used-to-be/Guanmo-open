export const PREVIEW_SCROLL_DAMPING = { min: 0, max: 180, step: 15, default: 90 } as const

export function normalizePreviewScrollDamping(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(PREVIEW_SCROLL_DAMPING.min, Math.min(PREVIEW_SCROLL_DAMPING.max, Math.round(value / PREVIEW_SCROLL_DAMPING.step) * PREVIEW_SCROLL_DAMPING.step))
    : PREVIEW_SCROLL_DAMPING.default
}

export function attachPreviewWheel(container: HTMLElement, damping: number): () => void {
  if (damping <= 0) return () => {}
  let frame = 0
  let remaining = 0
  let previousTime = 0
  const stop = () => {
    cancelAnimationFrame(frame)
    frame = 0
    remaining = 0
    previousTime = 0
  }
  const tick = (time: number) => {
    const elapsed = previousTime ? Math.min(time - previousTime, 32) : 16
    previousTime = time
    const step = remaining * (1 - Math.exp(-elapsed / damping))
    const before = container.scrollTop
    container.scrollTop += step
    remaining -= step
    if (Math.abs(remaining) < 0.5 || container.scrollTop === before) {
      stop()
    } else {
      frame = requestAnimationFrame(tick)
    }
  }
  const wheel = (event: WheelEvent) => {
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey
      || event.deltaX !== 0 || !event.deltaY || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      stop()
      return
    }
    // Small pixel deltas usually come from a precision touchpad; leave those native.
    if (event.deltaMode === WheelEvent.DOM_DELTA_PIXEL && Math.abs(event.deltaY) < 40) {
      stop()
      return
    }
    let target = event.target instanceof Element ? event.target : null
    while (target && target !== container) {
      if (target instanceof HTMLElement && target.scrollHeight > target.clientHeight
        && /(auto|scroll)/.test(getComputedStyle(target).overflowY)) {
        stop()
        return
      }
      target = target.parentElement
    }
    const delta = event.deltaY * (event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? container.clientHeight : 1)
    if ((delta < 0 && container.scrollTop <= 0) || (delta > 0 && container.scrollTop >= container.scrollHeight - container.clientHeight)) {
      stop()
      return
    }
    event.preventDefault()
    if (remaining * delta < 0) remaining = 0
    remaining += delta
    if (!frame) frame = requestAnimationFrame(tick)
  }
  container.addEventListener('wheel', wheel, { passive: false })
  window.addEventListener('pointerdown', stop)
  window.addEventListener('keydown', stop)
  return () => {
    stop()
    container.removeEventListener('wheel', wheel)
    window.removeEventListener('pointerdown', stop)
    window.removeEventListener('keydown', stop)
  }
}
