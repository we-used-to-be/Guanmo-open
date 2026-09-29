import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getProductTourSteps, PRODUCT_TOUR_TOPICS } from '@/features/productTour/productTourContent'
import { chooseTourPosition, clipTourRectToViewport, scrollTourTargetIntoView } from '@/features/productTour/ProductTourOverlay'
import {
  hasShownProductTourInvite,
  markProductTourInviteShown,
  PRODUCT_TOUR_INVITE_KEY,
} from '@/features/productTour/productTourStorage'

describe('product tour', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('keeps the concise overview and offers all supported topics', () => {
    const desktop = getProductTourSteps('overview', false)
    const web = getProductTourSteps('overview', true)
    expect(desktop).toHaveLength(8)
    expect(desktop.map((step) => step.id)).toEqual([
      'open-file',
      'sidebar',
      'mode-switcher',
      'preview-edit',
      'fullscreen',
      'ai-assistant',
      'reading-artifacts',
      'theme',
    ])
    expect(desktop.at(-1)?.target).toBe('[data-product-tour="settings-appearance"]')
    expect(web.map((step) => step.id)).not.toContain('reading-artifacts')
    expect(getProductTourSteps('annotations', true)).toEqual([])
    expect(PRODUCT_TOUR_TOPICS.map((topic) => topic.id)).toEqual(['files', 'fullscreen', 'annotations', 'ai', 'appearance'])
    const fullscreenSteps = getProductTourSteps('fullscreen', false)
    expect(fullscreenSteps.map((step) => step.id)).toEqual(['fullscreen-controls', 'fullscreen-ai', 'fullscreen-padding', 'fullscreen-files'])
    expect(fullscreenSteps.every((step) => step.surface === 'fullscreen')).toBe(true)
    expect(getProductTourSteps('fullscreen', true)).toEqual(fullscreenSteps)
    expect(getProductTourSteps('annotations', false).every((step) => step.desktopOnly)).toBe(true)
    const aiSteps = getProductTourSteps('ai', false)
    expect(aiSteps.map((step) => step.id)).toEqual(['ai-entry', 'ai-chat', 'ai-save', 'ai-model'])
    expect(aiSteps[1].content).toContain('添加到上下文')
    expect(aiSteps[1].content).toContain('右键')
    expect(aiSteps[0].target).toBe('[data-product-tour="ai-assistant"]')
    expect(aiSteps[2].content).toContain('摘要')
    expect(aiSteps[3].target).toBe('[data-product-tour="ai-settings-content"]')
    expect(getProductTourSteps('ai', true).map((step) => step.id)).toEqual(['ai-entry', 'ai-chat', 'ai-model'])
    expect(getProductTourSteps('overview', false).find((step) => step.id === 'reading-artifacts')?.content).toContain('右下角')
    expect(getProductTourSteps('annotations', false).find((step) => step.id === 'artifact-entry')?.content).toContain('右下角')
    expect(getProductTourSteps('appearance', false)[2].target).toBe('[data-product-tour="settings-appearance"]')
  })

  it('anchors the arrow to the measured card edge after changing placement', () => {
    const anchor = { left: 260, top: 200, right: 300, bottom: 240, width: 40, height: 40 }
    const right = chooseTourPosition(anchor, 'right', 360, 260, 1000, 700)
    expect(right.placement).toBe('right')
    expect(right.startX).toBe(right.left)
    expect(right.endX).toBe(anchor.right + 5)
    const top = chooseTourPosition({ ...anchor, top: 320, bottom: 360 }, 'top', 360, 260, 700, 700)
    expect(top.left).toBeGreaterThanOrEqual(16)
    expect(top.top).toBeGreaterThanOrEqual(16)
    expect(top.startY).toBe(top.top + 260)
    const bottom = chooseTourPosition({ ...anchor, top: 80, bottom: 120 }, 'bottom', 360, 220, 800, 700)
    expect(bottom.placement).toBe('bottom')
    expect(bottom.startY).toBe(bottom.top)
    const left = chooseTourPosition({ ...anchor, left: 620, right: 660 }, 'left', 360, 220, 800, 700)
    expect(left.placement).toBe('left')
    expect(left.startX).toBe(left.left + 360)
  })

  it('scrolls an offscreen tour target into view before measuring it', () => {
    const target = document.createElement('div')
    target.dataset.productTour = 'ai-settings-content'
    const scrollIntoView = vi.fn()
    Object.defineProperty(target, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ top: 720, left: 80, right: 320, bottom: 780, width: 240, height: 60 }),
    })
    Object.defineProperty(target, 'scrollIntoView', { configurable: true, value: scrollIntoView })
    document.body.appendChild(target)

    expect(scrollTourTargetIntoView('[data-product-tour="ai-settings-content"]')).toBe(true)
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'auto', block: 'center', inline: 'nearest' })
    target.remove()
  })

  it('keeps a settings spotlight inside the visible settings viewport', () => {
    expect(clipTourRectToViewport(
      { left: 100, top: 0, right: 500, bottom: 900, width: 400, height: 900 },
      { left: 20, top: 40, right: 620, bottom: 640, width: 600, height: 600 },
    )).toEqual({ left: 100, top: 40, right: 500, bottom: 640, width: 400, height: 600 })
  })

  it('marks the first-run invite as shown without affecting replay', () => {
    expect(hasShownProductTourInvite()).toBe(false)
    markProductTourInviteShown()
    expect(localStorage.getItem(PRODUCT_TOUR_INVITE_KEY)).toBe('1')
    expect(hasShownProductTourInvite()).toBe(true)
  })
})
