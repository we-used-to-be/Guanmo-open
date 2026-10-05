import { act, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MarkdownPreview } from '@/components/editor/MarkdownPreview'

/**
 * 页内锚点跳转（阶段 2：模型驱动锚点定位）
 *
 * 覆盖：
 * - 目标位于虚拟窗口外（下方远端）：按全文模型估算启动追踪滚动，
 *   实测高度变化后仍持续推进到目标，不需要重复点击；
 * - 锚点不存在：安全 no-op（不改滚动、不改 URL hash）；
 * - 目标已挂载：标题 slug 走平滑滚动；heading-{line} 内部 id 走 scrollIntoView。
 */

const VIEWPORT_HEIGHT = 800
const VIEWPORT_WIDTH = 600

// 与 estimatePreviewBlockHeight（fontSize=14、lineHeight=1.65）的单行段落估算值
// 故意不同：让“估算定位 → 实测校正”路径真实发生，而不是估算恰好等于实测。
const MEASURED_PARAGRAPH_HEIGHT = 60
const MEASURED_HEADING_HEIGHT = 80

function makeRect(top: number, height: number) {
  return {
    x: 0,
    y: top,
    width: VIEWPORT_WIDTH,
    height,
    top,
    right: VIEWPORT_WIDTH,
    bottom: top + height,
    left: 0,
    toJSON: () => ({}),
  }
}

function createScrollHost() {
  const host = document.createElement('div')
  let currentScrollTop = 0
  const scrollTopWrites: number[] = []
  const scrollToCalls: Array<ScrollToOptions | undefined> = []

  Object.defineProperties(host, {
    clientHeight: { configurable: true, get: () => VIEWPORT_HEIGHT },
    clientWidth: { configurable: true, get: () => VIEWPORT_WIDTH },
    scrollTop: {
      configurable: true,
      get: () => currentScrollTop,
      set: (value: number) => {
        currentScrollTop = value
        scrollTopWrites.push(value)
        host.dispatchEvent(new Event('scroll'))
      },
    },
    scrollTo: {
      configurable: true,
      writable: true,
      value: (options?: ScrollToOptions) => {
        scrollToCalls.push(options)
        if (options && typeof options.top === 'number') {
          host.scrollTop = options.top
          host.dispatchEvent(new Event('scroll'))
          host.dispatchEvent(new Event('scrollend'))
        }
      },
    },
  })

  return { host, scrollToCalls, scrollTopWrites }
}

function installRectMock(host: HTMLElement) {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const anchor = this.closest<HTMLElement>('[data-md-block-index]')
    if (!anchor) return makeRect(0, 0)
    const absTop = Number.parseFloat(anchor.style.top) || 0
    const height = anchor.dataset.mdBlockType === 'heading'
      ? MEASURED_HEADING_HEIGHT
      : MEASURED_PARAGRAPH_HEIGHT
    // 模拟真实滚动几何：rect.top 为视口相对坐标
    return makeRect(absTop - host.scrollTop, height)
  })
}

function installScrollIntoViewStub() {
  const scrollIntoView = vi.fn()
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: scrollIntoView,
  })
  return scrollIntoView
}

const flushFrame = () => act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())))

const flushFrames = async (count: number) => {
  for (let i = 0; i < count; i += 1) await flushFrame()
}

beforeEach(() => {
  window.history.replaceState(null, '', '/')
})

afterEach(() => {
  window.history.replaceState(null, '', '/')
})

describe('MarkdownPreview 页内锚点（模型驱动定位）', () => {
  it('远距离目标渐隐后直接定位并在渐显前完成校正', async () => {
    const { host, scrollToCalls, scrollTopWrites } = createScrollHost()
    installRectMock(host)
    installScrollIntoViewStub()

    const content = [
      '[跳转远端](#far-target-section)',
      ...Array.from({ length: 140 }, (_, index) => `\n\n远端测试段落 ${index + 1} 的匿名填充内容。`),
      '\n\n## Far Target Section',
    ].join('')
    const view = render(<MarkdownPreview content={content} />, { container: host })

    // 初始虚拟窗口不包含远端标题
    expect(host.querySelector('[data-md-block-type="heading"]')).toBeNull()
    expect(view.container.querySelectorAll('[data-md-block-index]').length).toBeLessThan(40)

    await act(async () => {
      fireEvent.click(view.getByRole('link', { name: '跳转远端' }))
    })

    // 远距离跳转不滚过全文：正文渐隐后直接定位，目标挂载并校正后再渐显。
    const previewRoot = host.querySelector<HTMLElement>('.gm-markdown-preview')!
    expect(previewRoot.style.opacity).toBe('0')
    expect(host.style.opacity).toBe('')
    let heading = host.querySelector<HTMLElement>('[data-md-block-type="heading"]')
    let elapsedFrames = 0
    while (!heading && elapsedFrames < 45) {
      await flushFrame()
      elapsedFrames += 1
      heading = host.querySelector<HTMLElement>('[data-md-block-type="heading"]')
    }
    while (elapsedFrames < 45) {
      await flushFrame()
      elapsedFrames += 1
    }
    expect(scrollToCalls).toHaveLength(0)
    expect(scrollTopWrites.length).toBeGreaterThan(0)

    // 目标块已挂载
    expect(heading).not.toBeNull()
    expect(heading).toHaveTextContent('Far Target Section')

    // URL hash 已同步
    expect(window.location.hash).toBe('#far-target-section')

    // 最终真实标题对齐到预览顶部留白
    expect(host.scrollTop).toBeCloseTo(Number.parseFloat(heading?.style.top ?? '0') - 24, 0)
    expect(previewRoot.style.opacity).toBe('')
    expect(scrollTopWrites.length).toBeLessThanOrEqual(4)

    // 稳定后不再产生滚动写入：无滚动反馈循环
    const writesAfterStabilization = scrollTopWrites.length
    await flushFrames(10)
    expect(scrollTopWrites.length).toBe(writesAfterStabilization)
    expect(scrollToCalls).toHaveLength(0)
  })

  it('锚点不存在时保持安全 no-op：不滚动、不更新 hash', async () => {
    const { host, scrollToCalls, scrollTopWrites } = createScrollHost()
    installRectMock(host)
    const scrollIntoView = installScrollIntoViewStub()

    const view = render(<MarkdownPreview content={'[失效锚点](#does-not-exist)\n\n正文段落内容。'} />, { container: host })

    await act(async () => {
      fireEvent.click(view.getByRole('link', { name: '失效锚点' }))
    })

    expect(scrollToCalls).toHaveLength(0)
    expect(scrollIntoView).not.toHaveBeenCalled()
    expect(scrollTopWrites).toHaveLength(0)
    expect(host.scrollTop).toBe(0)
    expect(window.location.hash).toBe('')
  })

  it('目标已挂载时按实测位置平滑滚动（标题 slug 路径）', async () => {
    const { host, scrollToCalls } = createScrollHost()
    installRectMock(host)
    installScrollIntoViewStub()

    const view = render(<MarkdownPreview content={'[就近跳转](#near-section)\n\n## Near Section'} />, { container: host })

    await act(async () => {
      fireEvent.click(view.getByRole('link', { name: '就近跳转' }))
    })

    // 标题 slug 在 DOM 中不存在（虚拟块标题 id 为 heading-{line}）→ 模型回退 →
    // data-md-line 目标已挂载 → 平滑滚动到实测位置
    expect(scrollToCalls).toHaveLength(1)
    expect(scrollToCalls[0]).toEqual(expect.objectContaining({ behavior: 'smooth' }))
    expect(scrollToCalls[0]?.top).toBeGreaterThanOrEqual(0)
    expect(window.location.hash).toBe('#near-section')
  })

  it('heading-{line} 内部锚点命中已挂载 DOM 时走 scrollIntoView', async () => {
    const { host, scrollToCalls } = createScrollHost()
    installRectMock(host)
    const scrollIntoView = installScrollIntoViewStub()

    const view = render(<MarkdownPreview content={'[内部锚点](#heading-3)\n\n## Near Section'} />, { container: host })

    await act(async () => {
      fireEvent.click(view.getByRole('link', { name: '内部锚点' }))
    })

    expect(scrollIntoView).toHaveBeenCalledTimes(1)
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' })
    expect(scrollToCalls).toHaveLength(0)
    expect(window.location.hash).toBe('#heading-3')
  })
})
