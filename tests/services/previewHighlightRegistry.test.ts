/**
 * 预览高亮注册表生命周期契约测试
 *
 * 验证 docs/architecture/state-ownership.md 第 5 节 Invariants：
 * - 虚拟块卸载只移除对应 DOM Range（removeBlock / removeBlocksNotIn），不影响其他块
 *   与其他文档实例；块重新挂载（syncBlock）后高亮按新 DOM Range 自动恢复。
 * - 文档切换（clearResource）只清空对应实例；搜索关闭（clearKind）不破坏选区高亮。
 * - 同块增量更新只替换指定 kind 的 Range，未指定的 kind 保留。
 *
 * JSDOM 不支持 CSS Highlight API，这里用最小 polyfill（CSS.highlights + Highlight）
 * 让注册表行为可观测：断言全部基于 Highlight 实例中实际注册的 DOM Range。
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { previewHighlightRegistry, type PreviewHighlightKind } from '@/services/previewHighlight'

/** 与 src/services/previewHighlight.ts 的 HIGHLIGHT_NAMES 一致（CSS ::highlight() 公开名称） */
const HIGHLIGHT_NAME: Record<PreviewHighlightKind, string> = {
  search: 'search-highlight',
  searchActive: 'search-highlight-active',
  selection: 'preview-selection',
  sourceReveal: 'source-reveal-highlight',
  markYellow: 'reading-mark-yellow',
  markGreen: 'reading-mark-green',
  markBlue: 'reading-mark-blue',
  markPink: 'reading-mark-pink',
  markFocus: 'reading-mark-focus',
}

class FakeHighlight {
  readonly ranges = new Set<globalThis.Range>()
  add(range: globalThis.Range): void { this.ranges.add(range) }
  delete(range: globalThis.Range): void { this.ranges.delete(range) }
}

const highlightStore = new Map<string, FakeHighlight>()

function ranges(kind: PreviewHighlightKind): ReadonlySet<globalThis.Range> {
  const highlight = highlightStore.get(HIGHLIGHT_NAME[kind])
  if (!highlight) throw new Error(`Highlight ${HIGHLIGHT_NAME[kind]} 未注册`)
  return highlight.ranges
}

beforeAll(() => {
  const cssAny = globalThis as unknown as { CSS?: Record<string, unknown> }
  if (cssAny.CSS) {
    cssAny.CSS.highlights = highlightStore
  } else {
    Object.defineProperty(globalThis, 'CSS', {
      value: { highlights: highlightStore },
      configurable: true,
      writable: true,
    })
  }
  Object.defineProperty(globalThis, 'Highlight', {
    value: FakeHighlight,
    configurable: true,
    writable: true,
  })
})

beforeEach(() => {
  // 注册表是模块级单例：清空全部实例的三类高亮，保证测试间隔离
  previewHighlightRegistry.clearKind('search')
  previewHighlightRegistry.clearKind('searchActive')
  previewHighlightRegistry.clearKind('selection')
  previewHighlightRegistry.clearKind('sourceReveal')
})

describe('previewHighlightRegistry 生命周期契约（invariants 见 docs/architecture/state-ownership.md）', () => {
  it('虚拟块卸载只移除该块 DOM Range，重新挂载后高亮自动恢复', () => {
    const mounted = document.createRange()
    const neighbor = document.createRange()
    const remounted = document.createRange()

    previewHighlightRegistry.syncBlock('doc-1', 'block-a', { search: [mounted] })
    previewHighlightRegistry.syncBlock('doc-1', 'block-b', { search: [neighbor] })
    expect(ranges('search').has(mounted)).toBe(true)

    // 卸载 block-a：只移除其 Range，block-b 的高亮不受影响
    previewHighlightRegistry.removeBlock('doc-1', 'block-a')
    expect(ranges('search').has(mounted)).toBe(false)
    expect(ranges('search').has(neighbor)).toBe(true)

    // 重新挂载：基于新 DOM 元素产生的新 Range 恢复高亮
    previewHighlightRegistry.syncBlock('doc-1', 'block-a', { search: [remounted] })
    expect(ranges('search').has(remounted)).toBe(true)
    expect(ranges('search').has(mounted)).toBe(false)
  })

  it('同块增量更新：只替换指定 kind 的 Range，未指定 kind 的高亮保留', () => {
    const searchOld = document.createRange()
    const selection = document.createRange()
    const searchNew = document.createRange()

    previewHighlightRegistry.syncBlock('doc-1', 'block-a', { search: [searchOld], selection: [selection] })
    previewHighlightRegistry.syncBlock('doc-1', 'block-a', { search: [searchNew] })

    expect(ranges('search').has(searchOld)).toBe(false)
    expect(ranges('search').has(searchNew)).toBe(true)
    expect(ranges('selection').has(selection)).toBe(true)
  })

  it('removeBlocksNotIn 只清理指定文档实例的过期块（虚拟化批量卸载）', () => {
    const keep = document.createRange()
    const stale = document.createRange()
    const otherDoc = document.createRange()

    previewHighlightRegistry.syncBlock('doc-1', 'block-a', { search: [keep] })
    previewHighlightRegistry.syncBlock('doc-1', 'block-b', { search: [stale] })
    previewHighlightRegistry.syncBlock('doc-2', 'block-a', { search: [otherDoc] })

    previewHighlightRegistry.removeBlocksNotIn('doc-1', new Set(['block-a']))

    expect(ranges('search').has(stale)).toBe(false)
    expect(ranges('search').has(keep)).toBe(true)
    expect(ranges('search').has(otherDoc)).toBe(true)
  })

  it('clearResource 只清空对应文档实例（文档切换互不影响）', () => {
    const docOne = document.createRange()
    const docTwo = document.createRange()

    previewHighlightRegistry.syncBlock('doc-1', 'block-a', { search: [docOne] })
    previewHighlightRegistry.syncBlock('doc-2', 'block-a', { search: [docTwo] })

    previewHighlightRegistry.clearResource('doc-1')

    expect(ranges('search').has(docOne)).toBe(false)
    expect(ranges('search').has(docTwo)).toBe(true)
  })

  it('clearKind(search) 清除搜索高亮但保留选区高亮（搜索关闭不影响选区）', () => {
    const search = document.createRange()
    const selection = document.createRange()

    previewHighlightRegistry.syncBlock('doc-1', 'block-a', { search: [search], selection: [selection] })
    previewHighlightRegistry.clearKind('search')

    expect(ranges('search').has(search)).toBe(false)
    expect(ranges('selection').has(selection)).toBe(true)
  })

  it('来源跳转高亮独立于搜索和选区，并可单独清除', () => {
    const sourceReveal = document.createRange()
    const selection = document.createRange()

    previewHighlightRegistry.syncBlock('doc-1', 'block-a', { sourceReveal: [sourceReveal], selection: [selection] })
    previewHighlightRegistry.clearKind('sourceReveal', 'doc-1')

    expect(ranges('sourceReveal').has(sourceReveal)).toBe(false)
    expect(ranges('selection').has(selection)).toBe(true)
  })
})
