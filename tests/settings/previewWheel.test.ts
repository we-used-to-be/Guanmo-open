import { afterEach, describe, expect, it, vi } from 'vitest'
import { attachPreviewWheel } from '@/services/previewWheel'

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('preview wheel', () => {
  it('animates mouse wheel input and cancels on cleanup', () => {
    let callback: FrameRequestCallback | undefined
    const cancel = vi.fn()
    vi.stubGlobal('requestAnimationFrame', vi.fn((fn: FrameRequestCallback) => { callback = fn; return 1 }))
    vi.stubGlobal('cancelAnimationFrame', cancel)
    vi.stubGlobal('matchMedia', () => ({ matches: false }))
    const element = document.createElement('div')
    Object.defineProperties(element, { scrollHeight: { value: 1000 }, clientHeight: { value: 200 } })
    const detach = attachPreviewWheel(element, 90)
    const event = new WheelEvent('wheel', { deltaY: 100, bubbles: true, cancelable: true })
    element.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
    expect(element.scrollTop).toBe(0)
    callback?.(16)
    expect(element.scrollTop).toBeGreaterThan(0)
    expect(element.scrollTop).toBeLessThan(100)
    detach()
    expect(cancel).toHaveBeenCalled()
    const next = new WheelEvent('wheel', { deltaY: 100, cancelable: true })
    element.dispatchEvent(next)
    expect(next.defaultPrevented).toBe(false)
  })

  it('leaves native scrolling alone at zero', () => {
    const element = document.createElement('div')
    const detach = attachPreviewWheel(element, 0)
    const event = new WheelEvent('wheel', { deltaY: 100, cancelable: true })
    element.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
    detach()
  })
})
