import { render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ProductTourOverlay } from '@/features/productTour/ProductTourOverlay'
import type { ProductTourStep } from '@/features/productTour/productTourContent'

describe('共享产品导览遮罩', () => {
  const step: ProductTourStep = { id: 'test', target: '[data-tour-fixture]', title: '测试功能', content: '说明', placement: 'bottom', surface: 'fullscreen' }

  it('普通导览和紧凑引导复用目标挖空遮罩，紧凑引导省略箭头', () => {
    const target = document.createElement('button')
    target.dataset.tourFixture = ''
    target.getBoundingClientRect = () => ({ left: 300, top: 80, right: 332, bottom: 104, width: 32, height: 24, x: 300, y: 80, toJSON() {} })
    document.body.appendChild(target)
    const props = { open: true, topic: 'fullscreen' as const, steps: [step], stepIndex: 0, onStepChange: vi.fn(), onTopicChange: vi.fn(), onClose: vi.fn() }
    const { rerender, unmount } = render(<ProductTourOverlay {...props} />)
    const mask = document.querySelector('mask')!
    expect(mask.querySelector('rect[fill="black"]')).toHaveAttribute('x', '294')
    expect(mask.querySelector('rect[fill="black"]')).toHaveAttribute('width', '44')
    expect(document.querySelector('.gm-product-tour__card')).not.toHaveClass('gm-product-tour__card--compact')
    rerender(<ProductTourOverlay {...props} compact />)
    expect(document.querySelector('.gm-product-tour__connector')).toBeNull()
    expect(document.querySelector('mask rect[fill="black"]')).toHaveAttribute('width', '44')
    unmount()
    target.remove()
  })

  it('两个导览交接时，旧实例退出不会移除新实例使用的共享样式', () => {
    const props = { open: true, topic: 'fullscreen' as const, steps: [step], stepIndex: 0, onStepChange: vi.fn(), onTopicChange: vi.fn(), onClose: vi.fn() }
    const first = render(<ProductTourOverlay {...props} compact />)
    const second = render(<ProductTourOverlay {...props} />)
    first.unmount()
    expect(document.getElementById('guanmo-product-tour-styles')).not.toBeNull()
    second.unmount()
    expect(document.getElementById('guanmo-product-tour-styles')).toBeNull()
  })
})
