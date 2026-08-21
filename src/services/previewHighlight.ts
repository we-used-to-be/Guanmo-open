/**
 * 预览统一 DocumentRange 基础设施
 *
 * 设计原则：DOM 只负责显示与获取用户交互位置；搜索高亮、文本选区、
 * 复制与 AI 上下文等全文能力统一基于完整文档模型中的源码 offset Range。
 *
 * 1. DocumentRange 使用原始 Markdown 源码 offset（与块模型、全文搜索、
 *    预览内编辑、scrollToOffset 保持同一坐标系）。
 * 2. DOM ↔ 源码 offset 的映射通过渲染时注入的 `<span data-gm-src-from/to>`
 *    标注实现（数据来自 mdast/HAST 节点的 position），不做文本长度推测。
 * 3. KaTeX / 代码高亮 / Mermaid 等渲染后子树不携带精确 text position 的区域
 *    不注入标注（避免错位映射）；该区域选区/高亮降级为不可字符级接管，
 *    模型层 getTextForSourceRange 仍基于 textSegments 精确提取。
 * 4. 高亮视觉统一走 CSS Highlight API，按 (resource, blockId) 注册与注销，
 *    虚拟块卸载时仅移除对应 DOM Range，文档级状态不丢失。
 */

import { findBlockIndexByOffset, type MarkdownPreviewModel } from '@/services/markdownPreviewModel'

/** 统一文档 Range：块 ID + 块内局部源码 offset（相对块 startOffset） */
export interface DocumentRange {
  startBlockId: string
  startOffset: number
  endBlockId: string
  endOffset: number
}

export interface DocumentRangeInfo {
  range: DocumentRange
  /** 起点块起始行 */
  startLine: number
  /** 终点块结束行 */
  endLine: number
}

/* ------------------------- 全局 offset ↔ DocumentRange ------------------------- */

/** 全局源码 offset → 块索引；gap（块间空行）归属前一块末尾 */
function findBlockIndexByOffsetClamped(model: MarkdownPreviewModel, offset: number): number {
  const direct = findBlockIndexByOffset(model, offset)
  if (direct >= 0) return direct
  const blocks = model.blocks
  if (blocks.length === 0) return -1
  if (offset < blocks[0].startOffset) return 0
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    if (offset >= blocks[i].endOffset) return i
  }
  return 0
}

export function buildDocumentRangeInfo(model: MarkdownPreviewModel, from: number, to: number): DocumentRangeInfo | null {
  if (to <= from || model.blocks.length === 0) return null
  const fromIndex = findBlockIndexByOffsetClamped(model, from)
  const toIndex = findBlockIndexByOffsetClamped(model, to)
  if (fromIndex < 0 || toIndex < 0) return null
  const fromBlock = model.blocks[fromIndex]
  const toBlock = model.blocks[toIndex]
  const startLocal = Math.max(0, Math.min(from - fromBlock.startOffset, fromBlock.endOffset - fromBlock.startOffset))
  const endLocal = Math.max(0, Math.min(to - toBlock.startOffset, toBlock.endOffset - toBlock.startOffset))
  return {
    range: {
      startBlockId: fromBlock.blockId,
      startOffset: startLocal,
      endBlockId: toBlock.blockId,
      endOffset: endLocal,
    },
    startLine: fromBlock.startLine,
    endLine: toBlock.endLine,
  }
}

/* ------------------------------ 渲染文本提取 ------------------------------ */

/**
 * 基于文档模型的 textSegments 提取 Range 内的渲染可见文本（块间以空行分隔）。
 * 与 DOM 是否挂载无关，虚拟化下可提取任意超长选区或全文。
 */
export function getTextForSourceRange(model: MarkdownPreviewModel, from: number, to: number): string {
  if (to <= from) return ''
  const parts: string[] = []
  for (const block of model.blocks) {
    if (block.endOffset <= from) continue
    if (block.startOffset >= to) break
    const blockParts: string[] = []
    for (const segment of block.textSegments) {
      if (segment.to <= from || segment.from >= to) continue
      const localStart = Math.max(0, from - segment.from)
      const localEnd = Math.min(segment.text.length, to - segment.from)
      if (localEnd > localStart) blockParts.push(segment.text.slice(localStart, localEnd))
    }
    parts.push(blockParts.join(''))
  }
  return parts.join('\n\n')
}

/** 双击选词：在 offset 所在 text segment 内按 Unicode 词边界扩展 */
export function findWordRangeAt(model: MarkdownPreviewModel, offset: number): { from: number; to: number } | null {
  for (const block of model.blocks) {
    if (offset < block.startOffset || offset > block.endOffset) continue
    for (const segment of block.textSegments) {
      if (offset < segment.from || offset > segment.to) continue
      const local = Math.max(0, Math.min(offset - segment.from, segment.text.length))
      const before = /[\p{L}\p{N}_]*$/u.exec(segment.text.slice(0, local))?.[0].length ?? 0
      const after = /^[\p{L}\p{N}_]*/u.exec(segment.text.slice(local))?.[0].length ?? 0
      return { from: segment.from + local - before, to: segment.from + local + after }
    }
    return null
  }
  return null
}

/* --------------------------- HAST 源码标注插件 --------------------------- */

interface AnnotatableHastNode {
  type: string
  tagName?: string
  value?: string
  properties?: Record<string, unknown>
  children?: AnnotatableHastNode[]
  position?: {
    start?: { offset?: number }
    end?: { offset?: number }
  }
}

/**
 * rehype 插件工厂：把 HAST text 节点包裹为带源码 offset 的 span。
 * 只标注携带精确源码 position 的 text 节点；KaTeX / rehype-highlight 等
 * 重建的无 position 子树不标注（避免错位映射），该区域选区/高亮降级。
 * baseOffset 为该块渲染切片在全文中的起始 offset（整篇渲染传 0）。
 */
export function createSourceOffsetAnnotator(baseOffset: number) {
  return function annotator() {
    return function transform(tree: AnnotatableHastNode) {
      const visit = (node: AnnotatableHastNode): void => {
        if (!node.children || node.children.length === 0) return
        for (let i = 0; i < node.children.length; i += 1) {
          const child = node.children[i]
          if (child.type === 'text' && typeof child.value === 'string' && child.value) {
            const from = child.position?.start?.offset
            const to = child.position?.end?.offset
            if (typeof from !== 'number' || typeof to !== 'number') continue
            node.children[i] = {
              type: 'element',
              tagName: 'span',
              properties: {
                dataGmSrcFrom: baseOffset + from,
                dataGmSrcTo: baseOffset + to,
              },
              children: [child],
            }
          } else {
            // SVG 的文字必须保持为 SVG 原生文本节点；HTML `<span>` 会被
            // WebView 当作 SVG 子元素，放在 `<text>`/`<tspan>` 中后不再绘制。
            if (child.type === 'element' && child.tagName === 'svg') continue
            visit(child)
          }
        }
      }
      visit(tree)
    }
  }
}

/* ---------------------------- DOM ↔ 源码 offset ---------------------------- */

export interface AnnotatedTextNode {
  node: Text
  from: number
  to: number
}

/** 收集容器内所有带源码标注的 text 节点（文档顺序） */
export function collectAnnotatedTextNodes(root: Element): AnnotatedTextNode[] {
  const out: AnnotatedTextNode[] = []
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let node: Node | null
  while ((node = walker.nextNode()) !== null) {
    const parent = node.parentElement
    if (!parent) continue
    const from = parent.getAttribute('data-gm-src-from')
    if (from === null) continue
    const to = Number(parent.getAttribute('data-gm-src-to'))
    out.push({ node: node as Text, from: Number(from), to })
  }
  return out
}

/** DOM 文本位置（caret）→ 全局源码 offset；无标注返回 null */
export function domPointToSourceOffset(node: Node, offset: number): number | null {
  if (node instanceof Text) {
    const span = node.parentElement
    const fromAttr = span?.getAttribute('data-gm-src-from')
    if (!span || fromAttr === null) return null
    const from = Number(fromAttr)
    const to = Number(span.getAttribute('data-gm-src-to'))
    const textLength = node.textContent?.length ?? 0
    const local = Math.max(0, Math.min(offset, textLength))
    return Math.max(from, Math.min(from + local, to))
  }
  if (node instanceof Element) {
    // caret 落在元素边界：优先取后一个子节点起点，否则前一个子节点终点
    const next = node.childNodes[offset]
    if (next instanceof Text) {
      const value = domPointToSourceOffset(next, 0)
      if (value !== null) return value
    }
    const prev = offset > 0 ? node.childNodes[offset - 1] : null
    if (prev instanceof Text) {
      const value = domPointToSourceOffset(prev, prev.textContent?.length ?? 0)
      if (value !== null) return value
    }
    if (next instanceof Element) {
      const first = collectAnnotatedTextNodes(next)[0]
      if (first) return first.from
    }
    if (prev instanceof Element) {
      const nodes = collectAnnotatedTextNodes(prev)
      const last = nodes[nodes.length - 1]
      if (last) return last.to
    }
  }
  return null
}

/**
 * 源码区间 → 该容器内的 DOM Range 列表（用于 CSS Highlight）。
 * 只处理与区间相交的标注 text；等长映射并 clamp 到文本长度。
 */
export function buildDomRangesForSourceRange(root: Element, from: number, to: number): globalThis.Range[] {
  if (to <= from) return []
  const ranges: globalThis.Range[] = []
  for (const entry of collectAnnotatedTextNodes(root)) {
    if (entry.to <= from || entry.from >= to) continue
    const textLength = entry.node.textContent?.length ?? 0
    const localStart = Math.max(0, Math.min(from - entry.from, textLength))
    const localEnd = Math.max(localStart, Math.min(to - entry.from, textLength))
    if (localEnd <= localStart) continue
    const range = document.createRange()
    range.setStart(entry.node, localStart)
    range.setEnd(entry.node, localEnd)
    ranges.push(range)
  }
  return ranges
}

/* ------------------------------ Highlight Registry ------------------------------ */

export type PreviewHighlightKind = 'search' | 'searchActive' | 'selection'

const HIGHLIGHT_NAMES: Record<PreviewHighlightKind, string> = {
  search: 'search-highlight',
  searchActive: 'search-highlight-active',
  selection: 'preview-selection',
}

const HIGHLIGHT_KINDS: PreviewHighlightKind[] = ['search', 'searchActive', 'selection']

interface BlockHighlightEntry {
  search: globalThis.Range[]
  searchActive: globalThis.Range[]
  selection: globalThis.Range[]
}

/**
 * 集中管理预览高亮：按 (resource, blockId) 组织 DOM Range，
 * 对应 CSS Highlight 实例常驻，块级更新时增量增删 Range。
 * 虚拟块卸载 → removeBlock；重新挂载 → syncBlock，高亮自动恢复。
 * 环境不支持 CSS Highlight API（如 JSDOM）时所有操作为 no-op。
 */
class PreviewHighlightRegistry {
  private highlights = new Map<PreviewHighlightKind, Highlight>()
  private blocks = new Map<string, BlockHighlightEntry>()

  private ensureHighlight(kind: PreviewHighlightKind): Highlight | null {
    if (typeof CSS === 'undefined' || !CSS.highlights || typeof Highlight === 'undefined') return null
    let highlight = this.highlights.get(kind)
    if (!highlight) {
      highlight = new Highlight()
      CSS.highlights.set(HIGHLIGHT_NAMES[kind], highlight)
      this.highlights.set(kind, highlight)
    }
    return highlight
  }

  syncBlock(resource: string, blockId: string, next: Partial<Record<PreviewHighlightKind, globalThis.Range[]>>): void {
    const key = `${resource}:${blockId}`
    const entry = this.blocks.get(key) ?? { search: [], searchActive: [], selection: [] }
    let hasContent = false
    for (const kind of HIGHLIGHT_KINDS) {
      const oldRanges = entry[kind]
      const newRanges = next[kind] ?? oldRanges
      if (oldRanges === newRanges) {
        hasContent = hasContent || newRanges.length > 0
        continue
      }
      const highlight = this.ensureHighlight(kind)
      if (highlight) {
        for (const range of oldRanges) highlight.delete(range)
        for (const range of newRanges) highlight.add(range)
      }
      entry[kind] = newRanges
      hasContent = hasContent || newRanges.length > 0
    }
    if (hasContent) this.blocks.set(key, entry)
    else this.blocks.delete(key)
  }

  removeBlock(resource: string, blockId: string): void {
    this.syncBlock(resource, blockId, { search: [], searchActive: [], selection: [] })
  }

  /** 移除指定 resource 中不在 blockIds 集合内的块高亮（虚拟化卸载清理） */
  removeBlocksNotIn(resource: string, blockIds: Set<string>): void {
    const stale: string[] = []
    for (const key of this.blocks.keys()) {
      const separator = key.indexOf(':')
      if (key.slice(0, separator) !== resource) continue
      if (!blockIds.has(key.slice(separator + 1))) stale.push(key)
    }
    for (const key of stale) {
      const entry = this.blocks.get(key)
      this.blocks.delete(key)
      if (!entry) continue
      for (const kind of HIGHLIGHT_KINDS) {
        const highlight = this.ensureHighlight(kind)
        if (!highlight) continue
        for (const range of entry[kind]) highlight.delete(range)
      }
    }
  }

  /** 清空指定 resource 的全部高亮（文档切换 / 实例卸载） */
  clearResource(resource: string): void {
    const keys: string[] = []
    for (const key of this.blocks.keys()) {
      const separator = key.indexOf(':')
      if (key.slice(0, separator) === resource) keys.push(key)
    }
    for (const key of keys) {
      const entry = this.blocks.get(key)
      this.blocks.delete(key)
      if (!entry) continue
      for (const kind of HIGHLIGHT_KINDS) {
        const highlight = this.ensureHighlight(kind)
        if (!highlight) continue
        for (const range of entry[kind]) highlight.delete(range)
      }
    }
  }

  /** 清空某种高亮（搜索关闭）；不指定 resource 时清空所有实例 */
  clearKind(kind: PreviewHighlightKind, resource?: string): void {
    const keys: string[] = []
    for (const key of this.blocks.keys()) {
      const separator = key.indexOf(':')
      if (resource && key.slice(0, separator) !== resource) continue
      keys.push(key)
    }
    for (const key of keys) {
      const entry = this.blocks.get(key)
      if (!entry) continue
      const ranges = entry[kind]
      if (ranges.length === 0) continue
      const highlight = this.ensureHighlight(kind)
      if (highlight) {
        for (const range of ranges) highlight.delete(range)
      }
      entry[kind] = []
      const hasContent = HIGHLIGHT_KINDS.some((k) => entry[k].length > 0)
      if (!hasContent) this.blocks.delete(key)
    }
  }
}

export const previewHighlightRegistry = new PreviewHighlightRegistry()
