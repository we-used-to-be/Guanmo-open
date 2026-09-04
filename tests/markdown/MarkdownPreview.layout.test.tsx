import { act, render } from '@testing-library/react'
import { createRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MarkdownPreview } from '@/components/editor/MarkdownPreview'
import type { MarkdownPreviewHandle } from '@/components/editor/markdownPreviewTypes'

const MINIMAL_FRONT_MATTER_DOCUMENT = [
  '---',
  'ai_question: |-',
  '  联网搜索一下广东什么时候才会正式进入秋天',
  '---',
  '',
  '# AI 阅读回复',
  '',
  '> 生成于 2026-08-10',
  '',
  '---',
].join('\n')

class TestResizeObserver {
  static instances: TestResizeObserver[] = []

  readonly targets = new Set<Element>()

  constructor(private readonly callback: ResizeObserverCallback) {
    TestResizeObserver.instances.push(this)
  }

  observe(target: Element) {
    this.targets.add(target)
  }

  unobserve(target: Element) {
    this.targets.delete(target)
  }

  disconnect() {
    this.targets.clear()
  }

  trigger(entries: ResizeObserverEntry[] = []) {
    this.callback(entries, this as unknown as ResizeObserver)
  }
}

const OriginalResizeObserver = globalThis.ResizeObserver

function rect(width: number, height: number, top = 0): DOMRect {
  return {
    x: 0,
    y: top,
    width,
    height,
    top,
    right: width,
    bottom: top + height,
    left: 0,
    toJSON: () => ({}),
  }
}

function createPreviewHost(getWidth: () => number) {
  const host = document.createElement('div')
  Object.defineProperties(host, {
    clientHeight: { configurable: true, get: () => 800 },
    clientWidth: { configurable: true, get: getWidth },
    scrollTop: { configurable: true, value: 0, writable: true },
    scrollTo: {
      configurable: true,
      value: ({ top }: { top: number }) => { host.scrollTop = top },
    },
  })
  return host
}

beforeEach(() => {
  TestResizeObserver.instances = []
  globalThis.ResizeObserver = TestResizeObserver as unknown as typeof ResizeObserver
})

afterEach(() => {
  vi.restoreAllMocks()
  globalThis.ResizeObserver = OriginalResizeObserver
})

describe('MarkdownPreview Front Matter 布局', () => {
  it('实测高度暂不可用时仍为 Front Matter 保留非零估算空间', () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(rect(600, 0))
    const host = createPreviewHost(() => 600)

    render(<MarkdownPreview content={MINIMAL_FRONT_MATTER_DOCUMENT} />, { container: host })

    const blocks = Array.from(host.querySelectorAll<HTMLElement>('[data-md-block-index]'))
    expect(blocks.map((block) => block.dataset.mdBlockType)).toEqual([
      'frontmatter',
      'heading',
      'blockquote',
      'thematicBreak',
    ])
    expect(blocks.map((block) => [block.dataset.mdLine, block.dataset.mdEndLine])).toEqual([
      ['1', '5'],
      ['6', '6'],
      ['8', '8'],
      ['10', '10'],
    ])
    expect(Number.parseFloat(blocks[1].style.top)).toBeGreaterThan(0)
  })

  it('宽度连续变化时在布局阶段重新测量已挂载块', () => {
    let viewportWidth = 600
    const heightReads = new Map<string, number>()
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const blockType = this.dataset.mdBlockType
      if (!blockType) return rect(viewportWidth, 0)
      heightReads.set(blockType, (heightReads.get(blockType) ?? 0) + 1)
      const height = blockType === 'frontmatter'
        ? (viewportWidth >= 900 ? 96 : 128)
        : blockType === 'heading'
          ? 52
          : blockType === 'blockquote'
            ? 48
            : 32
      return rect(viewportWidth, height)
    })
    const host = createPreviewHost(() => viewportWidth)

    render(<MarkdownPreview content={MINIMAL_FRONT_MATTER_DOCUMENT} />, { container: host })

    const heading = host.querySelector<HTMLElement>('[data-md-block-type="heading"]')
    expect(heading?.style.top).toBe('128px')
    const readsAtInitialWidth = heightReads.get('frontmatter') ?? 0
    const containerObserver = TestResizeObserver.instances.find((observer) => observer.targets.has(host))
    expect(containerObserver).toBeDefined()

    viewportWidth = 1000
    containerObserver?.trigger()

    expect(heading?.style.top).toBe('96px')
    const readsAtFullWidth = heightReads.get('frontmatter') ?? 0
    expect(readsAtFullWidth).toBeGreaterThan(readsAtInitialWidth)

    viewportWidth = 520
    containerObserver?.trigger()

    expect(heading?.style.top).toBe('128px')
    expect(heightReads.get('frontmatter')).toBeGreaterThan(readsAtFullWidth)
  })

  it('宽度变化后保持原顶部块及其块内偏移', () => {
    let viewportWidth = 600
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const blockType = this.dataset.mdBlockType
      if (!blockType) return rect(viewportWidth, 0)
      const height = blockType === 'frontmatter'
        ? (viewportWidth >= 900 ? 96 : 128)
        : blockType === 'heading'
          ? 52
          : blockType === 'blockquote'
            ? 48
            : 32
      return rect(viewportWidth, height)
    })
    const host = createPreviewHost(() => viewportWidth)

    render(<MarkdownPreview content={MINIMAL_FRONT_MATTER_DOCUMENT} />, { container: host })

    const heading = host.querySelector<HTMLElement>('[data-md-block-type="heading"]')
    const containerObserver = TestResizeObserver.instances.find((observer) => observer.targets.has(host))
    host.scrollTop = 136

    viewportWidth = 1000
    containerObserver?.trigger()

    expect(heading?.style.top).toBe('96px')
    expect(host.scrollTop).toBe(104)
  })

  it('向上滚动挂载新块并完成实测后保持当前视口锚点', async () => {
    const content = Array.from({ length: 140 }, (_, index) => `第 ${index} 段内容`).join('\n\n')
    const hostTop = 100
    const actualBlockHeight = 100
    const host = createPreviewHost(() => 600)

    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this === host) return rect(600, 800, hostTop)
      const blockIndex = this.dataset.mdBlockIndex
      if (blockIndex !== undefined) {
        const top = hostTop + Number.parseFloat(this.style.top || '0') - host.scrollTop
        return rect(600, actualBlockHeight, top)
      }
      return rect(600, 0, hostTop)
    })

    render(<MarkdownPreview content={content} />, { container: host })

    await act(async () => {
      host.scrollTop = 4200
      host.dispatchEvent(new Event('scroll'))
    })

    await act(async () => {
      host.dispatchEvent(new WheelEvent('wheel', { deltaY: -40, bubbles: true }))
      host.scrollTop = 3000
      host.dispatchEvent(new Event('scroll'))
    })

    // 新挂载块的实测高度大于估算值时，锚点补偿应把 scrollTop 向后校正，
    // 而不是停在用户刚设置的目标位置并让视口内容额外跳动。
    expect(host.scrollTop).toBeGreaterThan(3000)
  })

  it('向上滚动时布局测量与 ResizeObserver 不重复校正同一高度', async () => {
    const content = Array.from({ length: 140 }, (_, index) => `第 ${index} 段内容`).join('\n\n')
    const hostTop = 100
    const host = createPreviewHost(() => 600)

    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this === host) return rect(600, 800, hostTop)
      const blockIndex = this.dataset.mdBlockIndex
      if (blockIndex !== undefined) {
        const top = hostTop + Number.parseFloat(this.style.top || '0') - host.scrollTop
        return rect(600, 100, top)
      }
      return rect(600, 0, hostTop)
    })

    render(<MarkdownPreview content={content} />, { container: host })
    await act(async () => {
      host.scrollTop = 4200
      host.dispatchEvent(new Event('scroll'))
    })
    await act(async () => {
      host.dispatchEvent(new WheelEvent('wheel', { deltaY: -80, bubbles: true }))
      host.scrollTop = 3000
      host.dispatchEvent(new Event('scroll'))
    })

    const correctedTop = host.scrollTop
    const blockObserver = TestResizeObserver.instances.find((observer) => (
      Array.from(observer.targets).some((target) => target instanceof HTMLElement && target.dataset.mdBlockIndex !== undefined)
    ))
    const target = Array.from(blockObserver?.targets ?? [])
      .filter((element): element is HTMLElement => element instanceof HTMLElement && element.dataset.mdBlockIndex !== undefined)
      .sort((left, right) => Number(left.dataset.mdBlockIndex) - Number(right.dataset.mdBlockIndex))[0]
    expect(blockObserver).toBeDefined()
    expect(target).toBeDefined()
    if (!target) throw new Error('未找到已挂载的虚拟块')

    await act(async () => {
      blockObserver?.trigger([{
        target,
        borderBoxSize: [{ blockSize: 100.2 }],
      } as unknown as ResizeObserverEntry])
      await Promise.resolve()
    })

    expect(host.scrollTop).toBe(correctedTop)
  })

  it('向下滚动时不让高度校正抵消用户滚动', async () => {
    const content = Array.from({ length: 80 }, (_, index) => `第 ${index} 段内容`).join('\n\n')
    const actualHeights = new Map<number, number>()
    const host = createPreviewHost(() => 600)

    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this === host) return rect(600, 800, 100)
      const blockIndex = this.dataset.mdBlockIndex
      if (blockIndex !== undefined) {
        const index = Number(blockIndex)
        const top = 100 + Number.parseFloat(this.style.top || '0') - host.scrollTop
        return rect(600, actualHeights.get(index) ?? 100, top)
      }
      return rect(600, 0, 100)
    })

    render(<MarkdownPreview content={content} />, { container: host })
    actualHeights.set(0, 120)

    await act(async () => {
      host.dispatchEvent(new WheelEvent('wheel', { deltaY: 40, bubbles: true }))
      host.scrollTop = 150
      host.dispatchEvent(new Event('scroll'))
    })

    // 用户向下滚动期间，高度实测仍更新缓存，但不能把本次滚动抵消回原位置。
    expect(host.scrollTop).toBe(150)
  })

  it('向下滚动时 ResizeObserver 高度变化不回写滚动位置', async () => {
    const content = Array.from({ length: 80 }, (_, index) => `第 ${index} 段内容`).join('\n\n')
    const actualHeights = new Map<number, number>()
    const host = createPreviewHost(() => 600)

    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this === host) return rect(600, 800, 100)
      const blockIndex = this.dataset.mdBlockIndex
      if (blockIndex !== undefined) {
        const index = Number(blockIndex)
        const top = 100 + Number.parseFloat(this.style.top || '0') - host.scrollTop
        return rect(600, actualHeights.get(index) ?? 100, top)
      }
      return rect(600, 0, 100)
    })

    render(<MarkdownPreview content={content} />, { container: host })
    const blockObserver = TestResizeObserver.instances.find((observer) => (
      Array.from(observer.targets).some((target) => target instanceof HTMLElement && target.dataset.mdBlockIndex !== undefined)
    ))
    const target = host.querySelector<HTMLElement>('[data-md-block-index="0"]')
    expect(blockObserver).toBeDefined()
    expect(target).not.toBeNull()

    await act(async () => {
      host.dispatchEvent(new WheelEvent('wheel', { deltaY: 40, bubbles: true }))
      host.scrollTop = 150
      host.dispatchEvent(new Event('scroll'))
    })

    actualHeights.set(0, 120)
    await act(async () => {
      blockObserver?.trigger([{
        target: target as HTMLElement,
        borderBoxSize: [{ blockSize: 120 }],
      } as unknown as ResizeObserverEntry])
    })

    expect(host.scrollTop).toBe(150)
  })

  it('搜索跳转到未挂载块后按真实关键词 Range 单次校正', async () => {
    const targetText = '搜索目标'
    const content = Array.from({ length: 60 }, (_, index) => (
      index === 45 ? `第 ${index} 段 ${targetText}` : `第 ${index} 段普通内容`
    )).join('\n\n')
    const previewRef = createRef<MarkdownPreviewHandle>()
    const host = createPreviewHost(() => 600)
    const hostTop = 100
    const targetRangeOffset = 80

    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this === host) return rect(600, 800, hostTop)
      const blockIndex = this.dataset.mdBlockIndex
      if (blockIndex !== undefined) {
        const top = hostTop + Number.parseFloat(this.style.top || '0') - host.scrollTop
        return rect(600, 100, top)
      }
      return rect(600, 0, hostTop)
    })

    const originalRangeRects = Range.prototype.getClientRects
    Object.defineProperty(Range.prototype, 'getClientRects', {
      configurable: true,
      value(this: Range) {
        const block = (this.startContainer.parentElement ?? undefined)?.closest<HTMLElement>('[data-md-block-index]')
        const blockRect = block?.getBoundingClientRect()
        return blockRect
          ? [rect(120, 20, blockRect.top + targetRangeOffset)] as unknown as DOMRectList
          : []
      },
    })

    try {
      render(<MarkdownPreview ref={previewRef} content={content} />, { container: host })
      const offset = content.indexOf(targetText)

      await act(async () => {
        previewRef.current?.setSearchState({ query: targetText, activeOffset: offset })
        previewRef.current?.scrollToOffset(offset)
        host.dispatchEvent(new Event('scroll'))
      })

      const targetBlock = Array.from(host.querySelectorAll<HTMLElement>('[data-md-block-index]'))
        .find((element) => element.textContent?.includes(targetText))
      expect(targetBlock).toBeDefined()
      expect(host.scrollTop).toBeCloseTo(Number.parseFloat(targetBlock?.style.top ?? '0') + targetRangeOffset - 24)
    } finally {
      if (originalRangeRects) Object.defineProperty(Range.prototype, 'getClientRects', { configurable: true, value: originalRangeRects })
      else delete (Range.prototype as Range & { getClientRects?: () => DOMRectList }).getClientRects
    }
  })
})
