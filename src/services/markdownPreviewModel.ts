/**
 * Markdown 预览单次解析文档模型
 *
 * 设计目标：
 * 1. 全文只执行一次 remark 解析，产出稳定的顶层块描述
 * 2. 每个块保留原始 startOffset/endOffset、startLine/endLine，供预览内编辑使用
 * 3. 模型一次性产出 reference definitions、footnote definitions、heading IDs 等全局信息，
 *    避免可视区块渲染时丢失跨块上下文
 * 4. 同时供隔离原型和生产 MarkdownPreview 使用，不引入 Worker 或新增依赖
 */

import { remark } from 'remark'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import { createHeadingId, type TocItem } from '@/services/markdownToc'

export type PreviewBlockType =
  | 'frontmatter'
  | 'heading'
  | 'thematicBreak'
  | 'paragraph'
  | 'image'
  | 'list'
  | 'blockquote'
  | 'code'
  | 'mermaid'
  | 'echarts'
  | 'math'
  | 'table'
  | 'html'
  | 'definition'
  | 'footnoteDefinition'
  | 'unknown'

/**
 * 块内"渲染可见文本 ↔ 源码 offset"的最小映射单元。
 * from/to 为全文源码 offset；text 为该 text 节点渲染后的可见文本
 * （不含 Markdown 标记，如 `**bold**` 的 segment text 为 `bold`，
 * 但 from/to 精确指向源码中 bold 的位置）。
 * inlineCode / code 的 value 不含定界符；segment 会收窄到源码中的实际
 * value 区间，多行 code 按源码行拆分，避免把围栏或缩进算入字符映射。
 * math / inlineMath 以去除定界符后的 LaTeX 源码作为确定回退文本，
 * from/to 精确指向 value 源码位置（与源码逐字符对齐）。
 * html 节点按标签切分文本 run；源码实体等导致可见文本与源码长度不一致时，
 * 额外保留可见文本边界到源码 offset 的映射；script / style / foreignObject
 * （rehype-sanitize strip 列表）内部文本不产生 segment。
 */
export interface PreviewTextSegment {
  from: number
  to: number
  text: string
  /** 非等长渲染文本的可见字符边界 → 源码 offset；长度为 text.length + 1。 */
  sourceBoundaries?: number[]
}

interface CodePointSlice {
  value: string
  length: number
}

function readCodePointAt(text: string, index: number): CodePointSlice {
  const codePoint = text.codePointAt(index)
  if (codePoint === undefined) return { value: '', length: 0 }
  const value = String.fromCodePoint(codePoint)
  return { value, length: value.length }
}

function isMarkdownEscapable(char: string): boolean {
  return /^[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]$/.test(char)
}

function decodeSourceCharacterReference(token: string): string | null {
  const numeric = /^&#(x[\da-f]+|\d+);$/i.exec(token)?.[1]
  if (numeric) {
    const codePoint = numeric[0].toLowerCase() === 'x'
      ? Number.parseInt(numeric.slice(1), 16)
      : Number.parseInt(numeric, 10)
    if (!Number.isInteger(codePoint) || codePoint <= 0 || codePoint > 0x10ffff || codePoint >= 0xd800 && codePoint <= 0xdfff) return null
    return String.fromCodePoint(codePoint)
  }
  if (typeof document === 'undefined') return null
  const textarea = document.createElement('textarea')
  textarea.innerHTML = token
  return textarea.value === token ? null : textarea.value
}

function readSourceCharacterReference(raw: string, index: number): { token: string; value: string } | null {
  const token = /^&(?:#x[\da-f]+|#\d+|[A-Za-z][A-Za-z0-9]+);/i.exec(raw.slice(index))?.[0]
  if (!token) return null
  const value = decodeSourceCharacterReference(token)
  return value ? { token, value } : null
}

/**
 * 计算渲染可见文本的字符边界对应的源码 offset。
 * 返回 null 表示源码与可见文本等长或无法可靠对齐；只有识别出转义、实体、
 * 行尾规范化等确定转换时才返回非线性边界映射。
 */
export function buildSourceTextBoundaries(source: string, from: number, to: number, text: string): number[] | null {
  const raw = source.slice(from, to)
  if (raw === text) return null

  const boundaries = [from]
  let sourceIndex = 0
  let textIndex = 0
  const appendBoundaries = (sourceStart: number, sourceEnd: number, textLength: number, linear: boolean) => {
    for (let index = 1; index <= textLength; index += 1) {
      boundaries.push(from + (linear
        ? sourceStart + index
        : index === textLength ? sourceEnd : sourceStart))
    }
  }

  while (sourceIndex < raw.length && textIndex < text.length) {
    const sourceChar = readCodePointAt(raw, sourceIndex)
    const textChar = readCodePointAt(text, textIndex)
    if (!sourceChar.length || !textChar.length) return null
    const reference = raw[sourceIndex] === '&' ? readSourceCharacterReference(raw, sourceIndex) : null
    if (reference && text.startsWith(reference.value, textIndex)) {
      appendBoundaries(sourceIndex, sourceIndex + reference.token.length, reference.value.length, false)
      sourceIndex += reference.token.length
      textIndex += reference.value.length
      continue
    }
    if (sourceChar.value === textChar.value) {
      appendBoundaries(sourceIndex, sourceIndex + sourceChar.length, textChar.length, true)
      sourceIndex += sourceChar.length
      textIndex += textChar.length
      continue
    }

    if (raw[sourceIndex] === '\\' && sourceIndex + 1 < raw.length) {
      const escaped = readCodePointAt(raw, sourceIndex + 1)
      if (isMarkdownEscapable(escaped.value) && escaped.value === textChar.value) {
        appendBoundaries(sourceIndex, sourceIndex + 1 + escaped.length, textChar.length, false)
        sourceIndex += 1 + escaped.length
        textIndex += textChar.length
        continue
      }
    }

    const newline = raw.startsWith('\r\n', sourceIndex) ? '\r\n' : raw[sourceIndex] === '\r' || raw[sourceIndex] === '\n' ? raw[sourceIndex] : ''
    if (newline && text[textIndex] === ' ') {
      appendBoundaries(sourceIndex, sourceIndex + newline.length, 1, false)
      sourceIndex += newline.length
      textIndex += 1
      continue
    }

    return null
  }

  if (sourceIndex !== raw.length || textIndex !== text.length || boundaries.length !== text.length + 1) return null
  return boundaries
}

export interface PreviewBlock {
  /** 稳定、不可变的块 ID，基于块在全文的索引 + 类型签名；可用于 React key 与缓存键 */
  blockId: string
  type: PreviewBlockType
  startLine: number
  endLine: number
  /** 原始 Markdown 中的 offset；用于预览内编辑与冲突检测 */
  startOffset: number
  endOffset: number
  /** LaTeX 规范化后内容中的 offset；用于 ReactMarkdown 按块切片渲染 */
  normalizedStartOffset: number
  normalizedEndOffset: number
  /** 原始 Markdown 切片；用于预览内编辑与冲突检测 */
  rawSource: string
  /**
   * 块内节点的源码 offset ↔ 渲染可见文本映射，按文档顺序排列。
   * 供统一 DocumentRange 的 getText 与 DOM span 标注共用同一数据源。
   * math / html 使用确定回退文本（见 PreviewTextSegment 契约注释）。
   */
  textSegments: PreviewTextSegment[]
  /**
   * 当块为 heading 时填充，用于目录跳转与 heading ID 去重；
   * 其他块保持 undefined，避免额外开销。
   */
  heading?: {
    id: string
    text: string
    level: number
  }
  /** 当块为 list 时记录顶层项数，用于粗略高度估计 */
  listItemCount?: number
  /** 当块为 code/mermaid/echarts 时记录语言与行数，用于粗略高度估计 */
  codeMeta?: {
    lang?: string
    lines: number
  }
  /** 当块为 table 时记录行/列数，用于粗略高度估计 */
  tableMeta?: {
    rows: number
    cols: number
  }
}

export interface ReferenceDefinition {
  identifier: string
  label?: string
  url: string
  title?: string
  rawSource: string
}

export interface FootnoteDefinition {
  identifier: string
  label?: string
  startLine: number
  endLine: number
  startOffset: number
  endOffset: number
  rawSource: string
}

export interface MarkdownPreviewModel {
  /** 原始全文内容（未规范化 LaTeX），供预览内编辑写回 */
  rawContent: string
  /** LaTeX 规范化后的内容，用于统一交给 ReactMarkdown 渲染单个块 */
  normalizedContent: string
  blocks: PreviewBlock[]
  /** 全文 reference definitions；跨块引用链接需要共享同一张表 */
  definitions: ReferenceDefinition[]
  /** 全文 footnote definitions */
  footnoteDefinitions: FootnoteDefinition[]
  /** AST 中是否存在可渲染的原始 HTML 节点 */
  hasEmbeddedHtml: boolean
  /** 是否有 HTML 标签跨越顶层 Markdown 块，必须保留整篇渲染语义 */
  requiresWholeDocumentRender: boolean
  /** 目录，按出现顺序，ID 已去重 */
  toc: TocItem[]
  /** 用于按 startOffset 二分查找块的辅助数组；不作为对外 API */
  _blockStartOffsets: number[]
}

interface MdastPositioned {
  type: string
  lang?: string | null
  children?: MdastPositioned[]
  value?: string
  identifier?: string
  label?: string
  url?: string
  title?: string
  position?: {
    start?: { line?: number; offset?: number; column?: number }
    end?: { line?: number; offset?: number; column?: number }
  }
}

const remarkParser = remark().use(remarkGfm).use(remarkMath)

const HTML_VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'])

interface HtmlTagToken {
  name: string
  closing: boolean
  selfClosing: boolean
}

interface HtmlCompatibility {
  hasEmbeddedHtml: boolean
  requiresWholeDocumentRender: boolean
}

/**
 * 只从 remark 已识别的 html 节点读取标签，避免把 code/inlineCode/普通文本中的
 * 泛型、比较表达式或示例字符串误当成 HTML。标签扫描只负责判断跨块边界，
 * 不承担 HTML 解析或安全过滤职责。
 */
function analyzeHtmlCompatibility(children: MdastPositioned[]): HtmlCompatibility {
  const openTags: string[] = []
  let hasEmbeddedHtml = false
  let requiresWholeDocumentRender = false

  for (let childIndex = 0; childIndex < children.length; childIndex += 1) {
    const tags = collectHtmlTags(children[childIndex])
    if (tags.length > 0) hasEmbeddedHtml = true

    for (const tag of tags) {
      if (tag.closing) {
        const matchingIndex = openTags.lastIndexOf(tag.name)
        if (matchingIndex < 0) {
          // 保持原有保守兼容策略：无法证明 HTML 语义自洽时不切块。
          requiresWholeDocumentRender = true
          continue
        }
        if (matchingIndex !== openTags.length - 1) {
          requiresWholeDocumentRender = true
        }
        openTags.splice(matchingIndex, 1)
        continue
      }
      if (!tag.selfClosing && !HTML_VOID_TAGS.has(tag.name)) {
        openTags.push(tag.name)
      }
    }

    // 标签栈在顶层块边界仍非空，说明下一个块依赖前一个块的 HTML 上下文。
    if (openTags.length > 0 && childIndex < children.length - 1) {
      requiresWholeDocumentRender = true
    }
  }

  // 未闭合 HTML 仍沿用整篇同步兼容路径，避免静默改变浏览器容错语义。
  if (openTags.length > 0) requiresWholeDocumentRender = true

  return { hasEmbeddedHtml, requiresWholeDocumentRender }
}

function collectHtmlTags(node: MdastPositioned): HtmlTagToken[] {
  const tags: HtmlTagToken[] = []
  if (node.type === 'html' && node.value) {
    tags.push(...tokenizeHtmlTags(node.value))
  }
  for (const child of node.children ?? []) {
    tags.push(...collectHtmlTags(child))
  }
  return tags
}

function tokenizeHtmlTags(value: string): HtmlTagToken[] {
  const tags: HtmlTagToken[] = []
  let cursor = 0
  while (cursor < value.length) {
    const start = value.indexOf('<', cursor)
    if (start < 0) break
    if (value.startsWith('<!--', start)) {
      const commentEnd = value.indexOf('-->', start + 4)
      cursor = commentEnd >= 0 ? commentEnd + 3 : value.length
      continue
    }

    const match = /^<\s*(\/?)\s*([A-Za-z][A-Za-z0-9-]*)/.exec(value.slice(start))
    if (!match) {
      cursor = start + 1
      continue
    }
    const closing = match[1] === '/'
    const name = match[2].toLowerCase()
    let end = start + match[0].length
    let quote: string | null = null
    while (end < value.length) {
      const character = value[end]
      if (quote) {
        if (character === quote) quote = null
      } else if (character === '"' || character === "'") {
        quote = character
      } else if (character === '>') {
        break
      }
      end += 1
    }
    if (end >= value.length) {
      cursor = value.length
      continue
    }
    const body = value.slice(start, end + 1)
    tags.push({ name, closing, selfClosing: /\/\s*>$/.test(body) })
    cursor = end + 1
  }
  return tags
}

export function createMarkdownPreviewModel(rawContent: string): MarkdownPreviewModel {
  const normalizedContent = normalizeLatexForModel(rawContent)
  const root = remarkParser.parse(normalizedContent) as unknown as {
    children: MdastPositioned[]
  }

  const frontmatter = extractFrontmatterRange(normalizedContent)
  const blocks: PreviewBlock[] = []
  const definitions: ReferenceDefinition[] = []
  const footnoteDefinitions: FootnoteDefinition[] = []
  const toc: TocItem[] = []
  const headingIds = new Map<string, number>()
  const htmlCompatibility = analyzeHtmlCompatibility(root.children ?? [])

  if (frontmatter) {
    blocks.push({
      blockId: makeBlockId('frontmatter', 0, normalizedContent.slice(0, frontmatter.endOffset)),
      type: 'frontmatter',
      startLine: 1,
      endLine: frontmatter.endLine,
      startOffset: 0,
      endOffset: frontmatter.endOffset,
      normalizedStartOffset: 0,
      normalizedEndOffset: frontmatter.endOffset,
      rawSource: rawContent.slice(0, frontmatter.endOffset),
      textSegments: [],
    })
  }

  let blockIndex = blocks.length
  const children = root.children ?? []
  for (const node of children) {
    const startOffset = node.position?.start?.offset
    const endOffset = node.position?.end?.offset
    const startLine = node.position?.start?.line
    const endLine = node.position?.end?.line
    if (
      typeof startOffset !== 'number'
      || typeof endOffset !== 'number'
      || typeof startLine !== 'number'
      || typeof endLine !== 'number'
    ) continue
    if (frontmatter && endOffset <= frontmatter.endOffset) continue

    const type = classifyBlockType(node)
    if (type === 'definition') {
      if (node.identifier && node.url) {
        definitions.push({
          identifier: node.identifier.toLowerCase(),
          label: node.label,
          url: node.url,
          title: node.title,
          rawSource: rawContent.slice(startOffset, endOffset),
        })
      }
      continue
    }
    if (type === 'footnoteDefinition') {
      if (node.identifier) {
        footnoteDefinitions.push({
          identifier: node.identifier.toLowerCase(),
          label: node.label,
          startLine,
          endLine,
          startOffset,
          endOffset,
          rawSource: rawContent.slice(startOffset, endOffset),
        })
      }
      // footnote definition 仍然作为可见块保留，但放入 definitions 表中供引用解析
    }

    // LaTeX 规范化只做等长定界符替换，原文与规范化内容的 offset 始终一致。
    const rawStart = startOffset
    const rawEnd = endOffset
    const rawSource = rawContent.slice(rawStart, rawEnd)
    const block: PreviewBlock = {
      blockId: makeBlockId(type, blockIndex, normalizedContent.slice(startOffset, Math.min(startOffset + 120, endOffset))),
      type,
      startLine,
      endLine,
      startOffset: rawStart,
      endOffset: rawEnd,
      normalizedStartOffset: startOffset,
      normalizedEndOffset: endOffset,
      rawSource,
      textSegments: collectTextSegments(node, normalizedContent),
    }

    if (type === 'heading') {
      const text = extractHeadingText(node)
      if (text) {
        const id = createHeadingId(text, headingIds)
        block.heading = { id, text, level: extractHeadingLevel(node) }
        toc.push({ id, text, level: block.heading.level, line: startLine })
      }
    } else if (type === 'list') {
      block.listItemCount = countDirectChildren(node, 'listItem')
    } else if (type === 'code' || type === 'mermaid' || type === 'echarts') {
      const value = node.value ?? normalizedContent.slice(startOffset, endOffset)
      block.codeMeta = {
        lang: type === 'mermaid' || type === 'echarts' ? type : node.lang ?? undefined,
        lines: countLines(value),
      }
    } else if (type === 'table') {
      block.tableMeta = estimateTableMeta(node)
    }

    blocks.push(block)
    blockIndex += 1
  }

  const _blockStartOffsets = blocks.map((b) => b.startOffset)
  return {
    rawContent,
    normalizedContent,
    blocks,
    definitions,
    footnoteDefinitions,
    ...htmlCompatibility,
    toc,
    _blockStartOffsets,
  }
}

/**
 * 返回一个块的 [startIndex, endIndex) 可见范围。
 * viewportStart/viewportEnd 使用像素高度；estimateBlockHeight 提供块高估计。
 * overscanBlocks 控制可视区上下额外挂载的块数量，默认 5。
 */
export function computeVisibleRange(
  model: MarkdownPreviewModel,
  viewportStart: number,
  viewportEnd: number,
  measuredHeights: Map<string, number>,
  estimateBlockHeight: (block: PreviewBlock, index: number) => number,
  overscanBlocks = 5,
): { startIndex: number; endIndex: number; blockTops: number[]; totalHeight: number } {
  const { blocks } = model
  const blockTops: number[] = []
  let cursor = 0
  for (let i = 0; i < blocks.length; i += 1) {
    blockTops.push(cursor)
    const measured = measuredHeights.get(blocks[i].blockId)
    cursor += measured ?? estimateBlockHeight(blocks[i], i)
  }
  const totalHeight = cursor

  let startIndex = 0
  for (let i = 0; i < blocks.length; i += 1) {
    const bottom = i + 1 < blocks.length ? blockTops[i + 1] : totalHeight
    if (bottom >= viewportStart) {
      startIndex = i
      break
    }
    if (i === blocks.length - 1) startIndex = i
  }

  let endIndex = blocks.length
  for (let i = startIndex; i < blocks.length; i += 1) {
    const top = blockTops[i]
    if (top > viewportEnd) {
      endIndex = i
      break
    }
  }

  startIndex = Math.max(0, startIndex - overscanBlocks)
  endIndex = Math.min(blocks.length, endIndex + overscanBlocks)
  return { startIndex, endIndex, blockTops, totalHeight }
}

/** 根据原始 Markdown offset 二分查找所属块索引；未命中返回 -1 */
export function findBlockIndexByOffset(model: MarkdownPreviewModel, rawOffset: number): number {
  const starts = model._blockStartOffsets
  let lo = 0
  let hi = starts.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const blk = model.blocks[mid]
    if (rawOffset < blk.startOffset) hi = mid - 1
    else if (rawOffset >= blk.endOffset) lo = mid + 1
    else return mid
  }
  return -1
}

/** 根据源码行号查找块索引；未命中返回 -1 */
export function findBlockIndexByLine(model: MarkdownPreviewModel, line: number): number {
  for (let i = 0; i < model.blocks.length; i += 1) {
    const blk = model.blocks[i]
    if (line >= blk.startLine && line <= blk.endLine) return i
  }
  return -1
}

/**
 * 根据源码行号（1-based）反推该行首字符的源码 offset；未命中返回 undefined。
 * 与 getEstimatedPreviewLineForTop 互逆，供搜索锚点把“视口顶部行”映射回源码 offset。
 * 行号落在块间空行时无法定位，返回 undefined（调用方按现状兜底）。
 */
export function getSourceOffsetForLine(model: MarkdownPreviewModel, line: number): number | undefined {
  const blockIndex = findBlockIndexByLine(model, line)
  if (blockIndex < 0) return undefined
  const block = model.blocks[blockIndex]
  if (line <= block.startLine) return block.startOffset
  const linesToSkip = line - block.startLine
  let cursor = 0
  let skipped = 0
  const src = block.rawSource
  while (skipped < linesToSkip && cursor < src.length) {
    const ch = src.charCodeAt(cursor)
    if (ch === 10) {
      skipped += 1
      cursor += 1
    } else if (ch === 13) {
      skipped += 1
      cursor += 1
      if (src.charCodeAt(cursor) === 10) cursor += 1
    } else {
      cursor += 1
    }
  }
  if (skipped < linesToSkip) return undefined
  return block.startOffset + cursor
}

/* ------------------------- 页内锚点模型定位 ------------------------- */

/** 页内锚点（hash 去掉 # 后的 id）在全文模型中的定位结果 */
export interface PreviewAnchorTarget {
  /** 目标所在源码行（1-based），供预览滚动定位 */
  line: number
  /** 命中方式：内部 heading-{line} 标识 / GitHub 风格标题 slug / HTML id 属性 */
  kind: 'heading-line' | 'heading-slug' | 'html-id'
}

const HTML_ID_ATTRIBUTE_PATTERN = /(?<=^|\s)id\s*=\s*(?:"([^"]*)"|'([^']*)')/gi

function countLineBreaks(value: string): number {
  return (value.match(/\r\n|\r|\n/g) ?? []).length
}

/**
 * 在全文模型中解析页内锚点目标，与目标 DOM 是否挂载无关。
 * 优先级：
 * 1. `heading-{line}`（extractToc / data-heading-id 同源的内部标识，需校验该行确为标题块起始行）；
 * 2. 按文档顺序扫描渲染块：标题块先比对 model.toc 的 slug id（createHeadingId 去重语义），
 *    再扫描块源码中的 HTML id 属性；code / mermaid / echarts / frontmatter 块不渲染 id，跳过。
 * 未命中返回 null，调用方保持安全 no-op。
 * 边界：纯文本书写的 `id="..."`（如讲解 HTML 的文档）可能被识别为锚点目标；
 * 与阶段 1 的确定回退语义一致——只保证确定、可解释，不做 DOM 级精确判定。
 */
export function findAnchorTarget(model: MarkdownPreviewModel, id: string): PreviewAnchorTarget | null {
  if (!id) return null

  const internalLine = /^heading-(\d+)$/.exec(id)
  if (internalLine) {
    const line = Number(internalLine[1])
    if (line >= 1 && model.blocks.some((block) => block.type === 'heading' && block.startLine === line)) {
      return { line, kind: 'heading-line' }
    }
  }

  const headingSlugByLine = new Map(model.toc.map((item) => [item.line, item.id]))
  for (const block of model.blocks) {
    if (block.type === 'code' || block.type === 'mermaid' || block.type === 'echarts' || block.type === 'frontmatter') continue
    if (block.type === 'heading' && headingSlugByLine.get(block.startLine) === id) {
      return { line: block.startLine, kind: 'heading-slug' }
    }
    HTML_ID_ATTRIBUTE_PATTERN.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = HTML_ID_ATTRIBUTE_PATTERN.exec(block.rawSource)) !== null) {
      if ((match[1] ?? match[2]) === id) {
        return { line: block.startLine + countLineBreaks(block.rawSource.slice(0, match.index)), kind: 'html-id' }
      }
    }
  }
  return null
}

/** 基于全文文本搜索，返回命中列表（即使对应块尚未挂载也能定位） */
export interface SearchHit {
  blockIndex: number
  startOffset: number
  endOffset: number
  line: number
  snippet: string
}

export function searchContent(model: MarkdownPreviewModel, query: string, limit = 100): SearchHit[] {
  if (!query) return []
  const lower = query.toLowerCase()
  const src = model.rawContent
  const hits: SearchHit[] = []
  let from = 0
  while (hits.length < limit) {
    const idx = src.toLowerCase().indexOf(lower, from)
    if (idx < 0) break
    const line = 1 + countLines(src.slice(0, idx))
    const blockIndex = findBlockIndexByOffset(model, idx)
    const snippetStart = Math.max(0, idx - 30)
    const snippetEnd = Math.min(src.length, idx + query.length + 30)
    hits.push({
      blockIndex,
      startOffset: idx,
      endOffset: idx + query.length,
      line,
      snippet: src.slice(snippetStart, snippetEnd).replace(/\s+/g, ' ').trim(),
    })
    from = idx + Math.max(1, query.length)
  }
  return hits
}

/* ------------------------- 可见文本投影与搜索 ------------------------- */

/** 可见文本投影的分段：段内投影字符与源码 srcFrom 起点逐字符对齐（from-based 语义） */
interface VisibleTextPart {
  /** 该段在投影字符串中的起始位置 */
  projFrom: number
  text: string
  /** 该段首字符对应的源码 offset */
  srcFrom: number
  /** 非等长可见文本的字符边界 → 源码 offset */
  sourceBoundaries?: number[]
  /** 该段归属的块索引（块间分隔符归属前一块） */
  blockIndex: number
}

export interface VisibleTextProjection {
  /** 全文渲染可见文本；块间以 \n\n 分隔（与 getTextForSourceRange 一致） */
  text: string
  /** 按投影位置升序的分段映射索引 */
  parts: VisibleTextPart[]
}

const visibleProjectionCache = new WeakMap<MarkdownPreviewModel, VisibleTextProjection>()

/**
 * 全文"渲染可见文本"投影：所有块 textSegments 顺序拼接，块间以 \n\n 分隔。
 * 与 getTextForSourceRange 的提取语义一致（搜索域 = 复制域）：
 * 数学以去定界符 LaTeX、安全 HTML 以源码对齐文本 run 作为确定回退文本；
 * Markdown 标记、链接 URL、HTML 标签本身不在投影中。
 * 投影随模型实例缓存（WeakMap）；内容变化 → 新模型实例 → 缓存自动失效。
 */
export function getVisibleTextProjection(model: MarkdownPreviewModel): VisibleTextProjection {
  const cached = visibleProjectionCache.get(model)
  if (cached) return cached
  const parts: VisibleTextPart[] = []
  let text = ''
  model.blocks.forEach((block, blockIndex) => {
    if (blockIndex > 0) {
      const prev = model.blocks[blockIndex - 1]
      parts.push({ projFrom: text.length, text: '\n\n', srcFrom: prev.endOffset, blockIndex: blockIndex - 1 })
      text += '\n\n'
    }
    for (const segment of block.textSegments) {
      if (!segment.text) continue
      parts.push({
        projFrom: text.length,
        text: segment.text,
        srcFrom: segment.from,
        sourceBoundaries: segment.sourceBoundaries,
        blockIndex,
      })
      text += segment.text
    }
  })
  const projection: VisibleTextProjection = { text, parts }
  visibleProjectionCache.set(model, projection)
  return projection
}

/** 投影位置 → 源码 offset + 块索引；parts 覆盖整个投影区间，二分查找包含该位置的段 */
function projectionIndexToSource(projection: VisibleTextProjection, index: number): { srcOffset: number; srcEndOffset: number; blockIndex: number } | null {
  const { parts } = projection
  if (index < 0 || index >= projection.text.length || parts.length === 0) return null
  let lo = 0
  let hi = parts.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (parts[mid].projFrom <= index) lo = mid
    else hi = mid - 1
  }
  const part = parts[lo]
  if (!part || index >= part.projFrom + part.text.length) return null
  const local = index - part.projFrom
  const boundaries = part.sourceBoundaries
  return {
    srcOffset: boundaries?.[local] ?? part.srcFrom + local,
    srcEndOffset: boundaries?.[local + 1] ?? part.srcFrom + local + 1,
    blockIndex: part.blockIndex,
  }
}

export interface VisibleTextSearchHit {
  /** 匹配起点源码 offset（from-based 映射，与 getTextForSourceRange 语义一致） */
  from: number
  /** 匹配终点源码 offset */
  to: number
  /** 起点归属块索引 */
  blockIndex: number
}

/**
 * 基于可见文本投影的全文搜索：结果只覆盖渲染可见文本
 * （普通文本 / 代码 / 数学回退文本 / 安全 HTML 文本 run），
 * 不会命中只存在于 Markdown 标记、链接 URL 或 HTML 标签中的源码。
 * 匹配计算一次全文投影扫描（投影随模型缓存），与块是否挂载无关。
 */
export function searchVisibleText(model: MarkdownPreviewModel, query: string): VisibleTextSearchHit[] {
  if (!query) return []
  const projection = getVisibleTextProjection(model)
  if (!projection.text) return []
  const lowerText = projection.text.toLowerCase()
  const lowerQuery = query.toLowerCase()
  const hits: VisibleTextSearchHit[] = []
  let cursor = 0
  for (;;) {
    const idx = lowerText.indexOf(lowerQuery, cursor)
    if (idx < 0) break
    const start = projectionIndexToSource(projection, idx)
    const last = projectionIndexToSource(projection, idx + query.length - 1)
    if (start && last) {
      hits.push({ from: start.srcOffset, to: last.srcEndOffset, blockIndex: start.blockIndex })
    }
    cursor = idx + Math.max(1, query.length)
  }
  return hits
}

/**
 * 根据源码行号估算预览容器中的滚动位置（像素），即使目标块尚未挂载也能返回合理估计。
 * measureHeights 为可选的真实测量高度映射，用于已挂载块的精确校正。
 */
export function getEstimatedPreviewTopForLine(
  model: MarkdownPreviewModel,
  line: number,
  estimateBlockHeight: (block: PreviewBlock, index: number) => number,
  measuredHeights?: Map<string, number>,
): number | undefined {
  const { blocks } = model
  let cursor = 0
  for (let i = 0; i < blocks.length; i += 1) {
    const blk = blocks[i]
    const h = measuredHeights?.get(blk.blockId) ?? estimateBlockHeight(blk, i)
    if (line < blk.startLine) return cursor
    if (line >= blk.startLine && line <= blk.endLine) {
      const progress = blk.endLine > blk.startLine
        ? (line - blk.startLine) / (blk.endLine - blk.startLine)
        : 0
      return cursor + h * progress
    }
    cursor += h
  }
  return cursor > 0 ? cursor : undefined
}

/**
 * 根据预览容器内的像素位置反推源码行号。与 getEstimatedPreviewTopForLine
 * 共用全文块模型和高度数据，避免依赖当前虚拟化窗口中挂载的 DOM。
 */
export function getEstimatedPreviewLineForTop(
  model: MarkdownPreviewModel,
  top: number,
  estimateBlockHeight: (block: PreviewBlock, index: number) => number,
  measuredHeights?: Map<string, number>,
): number | undefined {
  const { blocks } = model
  if (blocks.length === 0) return undefined

  const targetTop = Math.max(0, top)
  let cursor = 0
  for (let i = 0; i < blocks.length; i += 1) {
    const block = blocks[i]
    const height = measuredHeights?.get(block.blockId) ?? estimateBlockHeight(block, i)
    const blockHeight = Math.max(1, height)
    const blockBottom = cursor + blockHeight
    if (targetTop < blockBottom || i === blocks.length - 1) {
      if (block.endLine <= block.startLine) return block.startLine
      const progress = Math.max(0, Math.min(1, (targetTop - cursor) / blockHeight))
      return Math.round(block.startLine + (block.endLine - block.startLine) * progress)
    }
    cursor = blockBottom
  }

  return blocks[blocks.length - 1].endLine
}

/* ----------------------------- 内部辅助 ----------------------------- */

/**
 * 收集块内 mdast 节点的 {源码 offset, 渲染可见文本} 序列。
 * - text：渲染后保留纯文本（既有语义不变）；
 * - inlineCode / code：去除定界符与缩进后，映射到源码中的实际 value；
 * - hard break 记为单个换行；
 * - math / inlineMath：以去定界符后的 LaTeX 源码作为确定回退文本，
 *   from/to 精确指向 value 的源码区间（逐字符对齐）；
 * - html：按标签切分渲染可见文本 run；实体等非等长内容同时保留源码边界映射；
 *   script / style / foreignObject（sanitize strip 列表）内部文本不产生 segment，
 *   包括跨 mdast 节点的未闭合不可见元素（内联 html 场景）。
 * source 为与节点 position 同坐标系的全文（normalizedContent；LaTeX 规范化为等长替换）。
 */
function collectTextSegments(node: MdastPositioned, source: string): PreviewTextSegment[] {
  const out: PreviewTextSegment[] = []
  /** 处于不可见元素内部时记录其标签名，等待闭合标签后恢复提取 */
  let pendingInvisibleClose: string | null = null
  const walk = (current: MdastPositioned) => {
    if (current.type === 'break') {
      const from = current.position?.start?.offset
      const to = current.position?.end?.offset
      if (!pendingInvisibleClose && typeof from === 'number' && typeof to === 'number') {
        out.push({ from, to, text: '\n' })
      }
      return
    }
    if (current.type === 'text') {
      const from = current.position?.start?.offset
      const to = current.position?.end?.offset
      if (!pendingInvisibleClose && typeof from === 'number' && typeof to === 'number' && typeof current.value === 'string' && current.value) {
        const sourceBoundaries = buildSourceTextBoundaries(source, from, to, current.value)
        out.push({ from, to, text: current.value, sourceBoundaries: sourceBoundaries ?? undefined })
      }
      return
    }
    if (current.type === 'inlineCode' || current.type === 'code') {
      const from = current.position?.start?.offset
      const to = current.position?.end?.offset
      if (!pendingInvisibleClose && typeof from === 'number' && typeof to === 'number' && typeof current.value === 'string' && current.value) {
        out.push(...collectLiteralValueSegments(source, from, to, current.value, current.type))
      }
      return
    }
    if (current.type === 'math' || current.type === 'inlineMath') {
      const from = current.position?.start?.offset
      const to = current.position?.end?.offset
      if (!pendingInvisibleClose && typeof from === 'number' && typeof to === 'number' && typeof current.value === 'string' && current.value) {
        const valueRange = computeMathValueRange(source, from, to, current.value)
        out.push({ from: valueRange.from, to: valueRange.to, text: current.value })
      }
      return
    }
    if (current.type === 'html') {
      const from = current.position?.start?.offset
      const to = current.position?.end?.offset
      if (typeof from === 'number' && typeof to === 'number' && to > from) {
        const value = source.slice(from, to)
        if (pendingInvisibleClose) {
          // 不可见元素内部：等待闭合标签，闭合后的剩余片段继续切分
          const resume = findHtmlClosingTagEnd(value, pendingInvisibleClose)
          if (resume < 0) return
          pendingInvisibleClose = null
          appendHtmlRuns(out, value.slice(resume), from + resume, (tag) => { pendingInvisibleClose = tag })
          return
        }
        appendHtmlRuns(out, value, from, (tag) => { pendingInvisibleClose = tag })
      }
      return
    }
    for (const child of current.children ?? []) walk(child)
  }
  walk(node)
  return out
}

/**
 * 把 inlineCode / code 的去定界符 value 映射回真实源码区间。
 * 单行内容优先使用精确连续切片；多行 code 在解析器规范化换行时按行拆分，
 * 使投影内每个代码字符仍指向对应的原始源码位置。
 */
function collectLiteralValueSegments(
  source: string,
  from: number,
  to: number,
  value: string,
  type: 'inlineCode' | 'code',
): PreviewTextSegment[] {
  const raw = source.slice(from, to)
  const inlineFence = type === 'inlineCode' ? /^`+/.exec(raw)?.[0] : undefined
  const openingFence = type === 'code'
    ? /^(?: {0,3})(?:`{3,}|~{3,})[^\r\n]*(?:\r\n|\r|\n)/.exec(raw)
    : null
  const contentStart = inlineFence?.length ?? openingFence?.[0].length ?? 0
  const contentEnd = inlineFence && raw.endsWith(inlineFence)
    ? raw.length - inlineFence.length
    : raw.length
  const contentFrom = from + contentStart
  const contentTo = from + contentEnd
  const content = raw.slice(contentStart, contentEnd)
  const exact = content.indexOf(value)
  if (exact >= 0) {
    const valueStart = contentStart + exact
    return [{ from: from + valueStart, to: from + valueStart + value.length, text: value }]
  }
  if (type === 'inlineCode') {
    const sourceBoundaries = buildSourceTextBoundaries(source, contentFrom, contentTo, value)
    if (sourceBoundaries) {
      return [{ from: sourceBoundaries[0], to: sourceBoundaries[sourceBoundaries.length - 1], text: value, sourceBoundaries }]
    }
    // 极端规范化场景保持既有确定性回退；普通 inlineCode 均走精确分支。
    return [{ from, to, text: value }]
  }

  let cursor = openingFence?.[0].length ?? 0
  const segments: PreviewTextSegment[] = []
  const lines = value.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (line) {
      const lineStart = raw.indexOf(line, cursor)
      if (lineStart < 0) return [{ from, to, text: value }]
      segments.push({ from: from + lineStart, to: from + lineStart + line.length, text: line })
      cursor = lineStart + line.length
    }
    if (index >= lines.length - 1) continue
    const newline = /\r\n|\r|\n/.exec(raw.slice(cursor))
    if (!newline || newline.index === undefined) return [{ from, to, text: value }]
    const newlineStart = cursor + newline.index
    if (newline[0] === '\r\n') {
      segments.push({ from: from + newlineStart + 1, to: from + newlineStart + 2, text: '\n' })
    } else {
      segments.push({ from: from + newlineStart, to: from + newlineStart + 1, text: newline[0] })
    }
    cursor = newlineStart + newline[0].length
  }
  return segments
}

/** 计算 math / inlineMath 的 value（去定界符 LaTeX）在源码中的精确区间。
 * 定界符为 $ / $$（LaTeX 规范化已把块级 \[ \] 等长替换为 $$）；
 * 无法精确对齐时回退到整个节点区间（确定性回退，不产生错位映射）。 */
function computeMathValueRange(source: string, from: number, to: number, value: string): { from: number; to: number } {
  const raw = source.slice(from, to)
  let start = 0
  let end = raw.length
  while (start < end && raw.charCodeAt(start) === 36 /* $ */) start += 1
  while (end > start && raw.charCodeAt(end - 1) === 36 /* $ */) end -= 1
  while (start < end && isHtmlWhitespace(raw.charCodeAt(start))) start += 1
  while (end > start && isHtmlWhitespace(raw.charCodeAt(end - 1))) end -= 1
  if (start < end && raw.slice(start, end) === value) return { from: from + start, to: from + end }
  return { from, to }
}

/** rehype-sanitize strip 列表中内容整体不可见的标签（小写） */
const HTML_INVISIBLE_TAG_NAMES = new Set(['script', 'style', 'foreignobject'])

function isHtmlWhitespace(code: number): boolean {
  return code === 32 || code === 9 || code === 10 || code === 13 || code === 12
}

/** 读取 raw[i] 起始的标签名（小写）；非标签语法返回 null */
function readHtmlTagName(raw: string, i: number): string | null {
  let j = i + 1
  if (j < raw.length && raw[j] === '/') j += 1
  const nameStart = j
  while (j < raw.length) {
    const c = raw[j]
    if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c === '-' || c === ':' || c === '_' || c === '.') {
      j += 1
    } else {
      break
    }
  }
  if (j === nameStart) return null
  return raw.slice(nameStart, j).toLowerCase()
}

/** 从 raw[i]（指向 '<'）查找标签结束 '>' 的下一位置；未闭合返回 -1（引号内 '>' 不算结束） */
function findHtmlTagEnd(raw: string, i: number): number {
  let j = i + 1
  let quote = ''
  while (j < raw.length) {
    const c = raw[j]
    if (quote) {
      if (c === quote) quote = ''
    } else if (c === '"' || c === "'") {
      quote = c
    } else if (c === '>') {
      return j + 1
    }
    j += 1
  }
  return -1
}

/** 从 raw 开头查找 tagName 闭合标签（</tagName...>）结束后的下一位置；未找到返回 -1 */
function findHtmlClosingTagEnd(raw: string, tagName: string): number {
  const closeRe = new RegExp(`</${tagName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s]*>`, 'i')
  const m = closeRe.exec(raw)
  return m ? m.index + m[0].length : -1
}

function decodeHtmlText(raw: string): string {
  let text = ''
  let index = 0
  while (index < raw.length) {
    const reference = raw[index] === '&' ? readSourceCharacterReference(raw, index) : null
    if (reference) {
      text += reference.value
      index += reference.token.length
      continue
    }
    const char = readCodePointAt(raw, index)
    text += char.value
    index += char.length || 1
  }
  return text
}

/**
 * 把 html 节点 value（原始 HTML 源码）切分为与源码逐字符对齐的文本 run 并追加到 out。
 * - 标签、注释、doctype/处理指令不产生文本；
 * - script / style / foreignObject 内部文本不产生 run（渲染后被 sanitize 移除）；
 * - 文本 run 使用渲染后的可见文本；实体等非等长内容同时保留源码边界映射；
 * - 未闭合标签等无法识别的 '<' 按普通文本字符处理（确定性回退）；
 * - 不可见元素的闭合标签不在本片段内时，通过 onInvisibleOpen 把标签名
 *   交回调用方继续等待（跨 mdast html 节点的内联场景）。
 */
function appendHtmlRuns(
  out: PreviewTextSegment[],
  raw: string,
  baseOffset: number,
  onInvisibleOpen: (tagName: string) => void,
): void {
  const len = raw.length
  let i = 0
  let runStart = -1
  const flushRun = (runEnd: number) => {
    if (runStart >= 0 && runEnd > runStart) {
      const rawText = raw.slice(runStart, runEnd)
      const text = decodeHtmlText(rawText)
      const sourceBoundaries = buildSourceTextBoundaries(rawText, 0, rawText.length, text)
      out.push({
        from: baseOffset + runStart,
        to: baseOffset + runEnd,
        text,
        sourceBoundaries: sourceBoundaries?.map((offset) => baseOffset + runStart + offset),
      })
    }
    runStart = -1
  }
  while (i < len) {
    if (raw.charCodeAt(i) === 60 /* < */) {
      if (raw.startsWith('<!--', i)) {
        const close = raw.indexOf('-->', i + 4)
        const next = close < 0 ? len : close + 3
        flushRun(i)
        i = next
        continue
      }
      // doctype / CDATA / 处理指令：跳到 '>'
      if (i + 1 < len && (raw[i + 1] === '!' || raw[i + 1] === '?')) {
        const close = raw.indexOf('>', i + 2)
        const next = close < 0 ? len : close + 1
        flushRun(i)
        i = next
        continue
      }
      const tagName = readHtmlTagName(raw, i)
      const tagEnd = tagName ? findHtmlTagEnd(raw, i) : -1
      if (tagName && tagEnd > 0) {
        flushRun(i)
        const isClosing = raw[i + 1] === '/'
        if (!isClosing && HTML_INVISIBLE_TAG_NAMES.has(tagName)) {
          const close = findHtmlClosingTagEnd(raw.slice(tagEnd), tagName)
          if (close < 0) {
            onInvisibleOpen(tagName)
            return
          }
          i = tagEnd + close
        } else {
          i = tagEnd
        }
        continue
      }
    }
    if (runStart < 0) runStart = i
    i += 1
  }
  flushRun(len)
}

function makeBlockId(type: string, index: number, seed: string): string {
  let hash = 2166136261
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return `pb-${type}-${index}-${(hash >>> 0).toString(36)}`
}

function classifyBlockType(node: MdastPositioned): PreviewBlockType {
  if (node.type === 'paragraph' && node.children?.length === 1 && node.children[0].type === 'image') {
    return 'image'
  }
  if (node.type === 'code') {
    const language = node.lang?.toLowerCase()
    if (language === 'mermaid') return 'mermaid'
    if (language === 'echarts') return 'echarts'
    return 'code'
  }
  switch (node.type) {
    case 'heading':
    case 'thematicBreak':
    case 'paragraph':
    case 'list':
    case 'blockquote':
    case 'math':
    case 'table':
    case 'html':
    case 'definition':
    case 'footnoteDefinition':
      return node.type
    default:
      return 'unknown'
  }
}

function extractHeadingText(node: MdastPositioned): string {
  const out: string[] = []
  const walk = (n: MdastPositioned) => {
    if (typeof n.value === 'string') out.push(n.value)
    for (const c of n.children ?? []) walk(c)
  }
  walk(node)
  return out.join('').trim()
}

function extractHeadingLevel(node: MdastPositioned): number {
  // @ts-expect-error mdast heading node has depth
  const d = node.depth as unknown
  return typeof d === 'number' && d >= 1 && d <= 6 ? d : 2
}

function countDirectChildren(node: MdastPositioned, typeName: string): number {
  let n = 0
  for (const c of node.children ?? []) if (c.type === typeName) n += 1
  return n
}

function estimateTableMeta(node: MdastPositioned): { rows: number; cols: number } {
  let rows = 0
  let cols = 0
  for (const c of node.children ?? []) {
    if (c.type === 'tableRow' || c.type === 'tableHeader') {
      rows += 1
      let cc = 0
      for (const cell of c.children ?? []) if (cell.type === 'tableCell') cc += 1
      cols = Math.max(cols, cc)
    }
  }
  return { rows, cols }
}

function countLines(text: string): number {
  if (!text) return 1
  let n = 1
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charCodeAt(i)
    if (ch === 10) n += 1
    else if (ch === 13) {
      if (text.charCodeAt(i + 1) === 10) i += 1
      n += 1
    }
  }
  return n
}

/**
 * 对模型内部使用的 LaTeX 规范化；保持与生产 MarkdownPreview 中
 * normalizeLatexBlockDelimiters 相同语义，但不引入跨模块副作用缓存。
 */
function normalizeLatexForModel(markdown: string): string {
  const parts = markdown.split(/(\r?\n)/)
  const lines = parts.filter((_, index) => index % 2 === 0)
  const pairedDelimiterLines = new Set<number>()
  let fence: { marker: '`' | '~'; length: number } | null = null
  let openingLine: number | null = null

  lines.forEach((line, index) => {
    const fenceMatch = line.match(/^\s{0,3}(`{3,}|~{3,})/)
    if (fenceMatch) {
      const marker = fenceMatch[1][0] as '`' | '~'
      if (!fence) {
        fence = { marker, length: fenceMatch[1].length }
      } else if (marker === fence.marker && fenceMatch[1].length >= fence.length) {
        fence = null
      }
      return
    }
    if (fence) return
    const trimmed = line.trim()
    if (trimmed === '\\[' && openingLine === null) {
      openingLine = index
      return
    }
    if (trimmed === '\\]' && openingLine !== null) {
      pairedDelimiterLines.add(openingLine)
      pairedDelimiterLines.add(index)
      openingLine = null
    }
  })

  let lineIndex = 0
  return parts
    .map((part, index) => {
      if (index % 2 === 1) return part
      const currentLine = lineIndex++
      if (pairedDelimiterLines.has(currentLine)) {
        return part.replace(/\\(\[|\])/, () => '$$')
      }
      if (/^\s{0,3}\\\[.*\\\]\s*$/.test(part)) {
        return part
          .replace('\\[', () => '$$')
          .replace(/\\\](\s*)$/, (_, trailing: string) => `$$${trailing}`)
      }
      return part
    })
    .join('')
}

function extractFrontmatterRange(content: string): { endOffset: number; endLine: number } | null {
  const match = /^(?:\uFEFF)?---[ \t]*\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)[ \t]*(?=\r?\n|$)/.exec(content)
  if (!match) return null
  return {
    endOffset: match[0].length,
    endLine: 1 + countLines(match[0]),
  }
}
