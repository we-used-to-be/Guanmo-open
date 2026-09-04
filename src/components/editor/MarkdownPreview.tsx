import ReactMarkdown, { type Components, type Options } from 'react-markdown'
import 'katex/dist/katex.min.css'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeHighlight from 'rehype-highlight'
import rehypeKatex from 'rehype-katex'
import { Highlighter } from 'lucide-react'
import { motion } from 'motion/react'
import { createContext, forwardRef, isValidElement, lazy, memo, Suspense, useCallback, useContext, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { convertFileSrc } from '@tauri-apps/api/core'
import { isTauri } from '@/hooks/useTauri'
import { createHeadingId } from '@/services/markdownToc'
import { remarkStandaloneDisplayMath } from '@/services/markdownMath'
import { useSettingsStore } from '@/stores/settingsStore'
import { createMarkdownPreviewModel, computeVisibleRange, findAnchorTarget, findBlockIndexByLine, findBlockIndexByOffset, getEstimatedPreviewLineForTop, getEstimatedPreviewTopForLine, getSourceOffsetForLine, searchVisibleText, type MarkdownPreviewModel, type PreviewBlock } from '@/services/markdownPreviewModel'
import {
  buildDocumentRangeInfo,
  buildDomRangesForSourceRange,
  createReadingMarkHitRegionAnnotator,
  createSourceOffsetAnnotator,
  domPointToSourceOffset,
  findWordRangeAt,
  getTextForSourceRange,
  previewHighlightRegistry,
} from '@/services/previewHighlight'
import { buildReadingMarkRangeIndex, findReadingMarkConflict, type CreateReadingMarkResult, type ReadingMark, type ReadingMarkColor } from '@/services/readingMarks'
import { eventMarker } from '@/services/eventMarker'
import { startHeadingScroll } from '@/services/headingScroll'
import type {
  MarkdownPreviewHandle,
  MarkdownPreviewProps,
  MarkdownPreviewSourceRevealRequest,
  PreviewSearchState,
  PreviewSelectionSnapshot,
} from './markdownPreviewTypes'
import type { AnnotationHoverAnchor } from './AnnotationHoverOverlay'
import { ReadingMarkToolbarContent } from './ReadingMarkToolbarContent'
import { ReadingMarkToolbarShell, READING_MARK_TOOLBAR_CLOSE_DELAY } from './ReadingMarkToolbarShell'
export type {
  MarkdownBlockCommitRequest,
  MarkdownBlockCommitResult,
  MarkdownPreviewHandle,
  MarkdownPreviewProps,
  MarkdownPreviewSourceRevealRequest,
  PreviewSearchState,
  PreviewSelectionSnapshot,
} from './markdownPreviewTypes'

const LazyInlineMarkdownBlockEditor = lazy(() => import('./InlineMarkdownBlockEditor').then(({ InlineMarkdownBlockEditor }) => ({ default: InlineMarkdownBlockEditor })))
const LazyEChartsBlock = lazy(() => import('./EChartsBlock').then(({ EChartsBlock }) => ({ default: EChartsBlock })))

function InlineMarkdownEditorSuspenseFallback() {
  return <div className="gm-inline-markdown-editor min-h-12" aria-hidden="true" />
}

const MARKDOWN_REMARK_PLUGINS = [remarkGfm, remarkMath, remarkStandaloneDisplayMath]
const SOURCE_REVEAL_DURATION_MS = 1600
const MARKDOWN_REHYPE_PLUGINS = [rehypeKatex, rehypeHighlight]
type RehypePlugins = NonNullable<Options['rehypePlugins']>
let markdownHtmlPluginsPromise: Promise<RehypePlugins> | null = null

const BlockLineBaseContext = createContext<number>(0)
const FootnoteSectionContext = createContext(true)
const FootnoteReferenceSuffixContext = createContext<string | null>(null)
function useBlockLineBase(): number {
  return useContext(BlockLineBaseContext)
}

function loadMarkdownHtmlPlugins(): Promise<RehypePlugins> {
  markdownHtmlPluginsPromise ??= import('@/services/markdownHtml')
    .then(({ MARKDOWN_HTML_REHYPE_PLUGINS }) => MARKDOWN_HTML_REHYPE_PLUGINS)
  return markdownHtmlPluginsPromise
}

interface ActiveBlockEdit {
  block: PreviewBlock
  documentKey: string
  documentVersion: number | string
  contentSnapshot: string
  initialCursor: number
  conflict: boolean
}

interface AltPointerIntent {
  pointerId: number
  startX: number
  startY: number
  blockIndex: number
  target: Element
  moved: boolean
}

interface OptimisticPreviewContent {
  content: string
  acceptedContents: string[]
}

interface PreviewViewportAnchor {
  blockId: string
  blockIndex: number
  sourceOffset?: number
  viewportOffset: number
  fallbackScrollTop: number
}

interface PendingPreviewAnchorRestore extends PreviewViewportAnchor {
  container: HTMLElement
  documentKey: string
  generation: number
}

interface PendingPreviewPatch {
  previousModel: MarkdownPreviewModel
  nextContent: string
  documentKey: string
  editedBlockId: string
  replacementStart: number
  replacementEnd: number
  replacementLength: number
  anchor: PreviewViewportAnchor | null
  generation: number
}

const ALT_CLICK_MOVE_THRESHOLD = 6
const USER_SCROLL_ACTIVITY_MS = 240

function normalizeMeasuredBlockHeight(height: number): number {
  const deviceScale = Math.max(1, window.devicePixelRatio || 1)
  return Math.round(height * deviceScale) / deviceScale
}

/** 最近一次鼠标按下的预览实例（Ctrl+A / Ctrl+C 仅作用于该实例） */
let activePreviewRoot: HTMLElement | null = null
const DRAG_AUTOSCROLL_EDGE = 48
const DRAG_AUTOSCROLL_MAX_STEP = 14

interface PreviewDragSelection {
  anchorOffset: number
  focusOffset: number
  rafId: number
  clientX: number
  clientY: number
}

interface FloatingAnchorRect {
  top: number
  right: number
  bottom: number
  left: number
  triggerPoint?: { x: number; y: number }
}

interface PendingSelectionUi {
  selection: PreviewSelectionSnapshot
  anchorRect: FloatingAnchorRect
  expanded: boolean
  mode: 'colors' | 'text'
  color: ReadingMarkColor
  textDraft: string
  creatingText: boolean
  savingText: boolean
  conflict?: { mark: ReadingMark; kind: 'exact' | 'overlap' }
}

function getRangeClientRects(range: globalThis.Range): FloatingAnchorRect[] {
  const rangeWithGeometry = range as globalThis.Range & {
    getClientRects?: () => DOMRectList
    getBoundingClientRect?: () => DOMRect
  }
  const clientRects = rangeWithGeometry.getClientRects?.() ?? []
  const rects = Array.from(clientRects).map((rect) => ({
    top: rect.top,
    right: rect.right,
    bottom: rect.bottom,
    left: rect.left,
  }))
  if (rects.length > 0) return rects
  const rect = rangeWithGeometry.getBoundingClientRect?.()
  return rect
    ? [{ top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left }]
    : []
}

function getSourceRangeClientRects(root: Element, from: number, to: number): FloatingAnchorRect[] {
  return buildDomRangesForSourceRange(root, from, to)
    .flatMap(getRangeClientRects)
    .filter((rect) => rect.right > rect.left || rect.bottom > rect.top)
}

function getSourceRangeAnchorRect(root: Element | null, from: number, to: number, fallback: FloatingAnchorRect): FloatingAnchorRect {
  if (!root) return fallback
  const rects = getSourceRangeClientRects(root, from, to)
  if (rects.length === 0) return fallback
  return {
    top: Math.min(...rects.map((rect) => rect.top)),
    right: Math.max(...rects.map((rect) => rect.right)),
    bottom: Math.max(...rects.map((rect) => rect.bottom)),
    left: Math.min(...rects.map((rect) => rect.left)),
    triggerPoint: fallback.triggerPoint,
  }
}

function countLineBreaks(text: string): number {
  let n = 0
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i)
    if (c === 10) n += 1
    else if (c === 13) {
      n += 1
      if (text.charCodeAt(i + 1) === 10) i += 1
    }
  }
  return n
}

function samePreviewBlock(left: PreviewBlock | undefined, right: PreviewBlock | undefined): boolean {
  return Boolean(left && right && left.type === right.type && left.rawSource === right.rawSource)
}

function sameRawSources(left: Array<{ rawSource: string }>, right: Array<{ rawSource: string }>): boolean {
  return left.length === right.length && left.every((item, index) => item.rawSource === right[index]?.rawSource)
}

function mapSourceOffsetThroughReplacement(
  offset: number,
  replacementStart: number,
  replacementEnd: number,
  replacementLength: number,
): number {
  if (offset <= replacementStart) return offset
  const delta = replacementLength - (replacementEnd - replacementStart)
  if (offset >= replacementEnd) return offset + delta
  return replacementStart + Math.min(offset - replacementStart, replacementLength)
}

/**
 * 找出一次块编辑后仍可复用的前缀/后缀区块。
 * 中间区域可能发生拆分、合并或语义变化，必须让虚拟列表重新测量。
 */
function buildIncrementalBlockMapping(
  previousModel: MarkdownPreviewModel,
  nextModel: MarkdownPreviewModel,
  editedBlockId: string,
): Map<number, number> | null {
  if (
    previousModel.requiresWholeDocumentRender
    || nextModel.requiresWholeDocumentRender
    || !sameRawSources(previousModel.definitions, nextModel.definitions)
    || !sameRawSources(previousModel.footnoteDefinitions, nextModel.footnoteDefinitions)
  ) return null

  const oldBlocks = previousModel.blocks
  const newBlocks = nextModel.blocks
  const editedIndex = oldBlocks.findIndex((block) => block.blockId === editedBlockId)
  if (editedIndex < 0) return null

  const mapping = new Map<number, number>()
  let oldIndex = 0
  let newIndex = 0
  while (oldIndex < editedIndex) {
    if (!samePreviewBlock(oldBlocks[oldIndex], newBlocks[newIndex])) return null
    mapping.set(oldIndex, newIndex)
    oldIndex += 1
    newIndex += 1
  }

  let oldTail = oldBlocks.length - 1
  let newTail = newBlocks.length - 1
  while (oldTail > editedIndex && newTail >= newIndex && samePreviewBlock(oldBlocks[oldTail], newBlocks[newTail])) {
    mapping.set(oldTail, newTail)
    oldTail -= 1
    newTail -= 1
  }
  return mapping
}

interface StableMarkdownContentProps {
  markdown: string
  skipHtml: boolean
  rehypePlugins: Options['rehypePlugins']
  components: Partial<Components>
  baseLine: number
  renderFootnoteSection?: boolean
  footnoteReferenceSuffix?: string
  readingMarkRanges?: Array<{ id: string; from: number; to: number }>
}

const StableMarkdownContent = memo(function StableMarkdownContent({
  markdown,
  skipHtml,
  rehypePlugins,
  components,
  baseLine,
  renderFootnoteSection = true,
  footnoteReferenceSuffix,
}: StableMarkdownContentProps) {
  return (
    <BlockLineBaseContext.Provider value={baseLine}>
      <FootnoteSectionContext.Provider value={renderFootnoteSection}>
        <FootnoteReferenceSuffixContext.Provider value={footnoteReferenceSuffix ?? null}>
          <ReactMarkdown
            skipHtml={skipHtml}
            remarkPlugins={MARKDOWN_REMARK_PLUGINS}
            rehypePlugins={rehypePlugins}
            components={components}
          >
            {markdown}
          </ReactMarkdown>
        </FootnoteReferenceSuffixContext.Provider>
      </FootnoteSectionContext.Provider>
    </BlockLineBaseContext.Provider>
  )
})

interface StableMarkdownBlockProps extends StableMarkdownContentProps {
  block: PreviewBlock
  globalIndex: number
  top: number
  onElement: (index: number, element: HTMLDivElement | null) => void
}

const StableMarkdownBlock = memo(function StableMarkdownBlock({
  block,
  globalIndex,
  top,
  onElement,
  rehypePlugins,
  readingMarkRanges,
  ...contentProps
}: StableMarkdownBlockProps) {
  const setElement = useCallback((element: HTMLDivElement | null) => {
    onElement(globalIndex, element)
  }, [globalIndex, onElement])
  // 按块注入源码 offset 标注：DOM ↔ 文档模型映射的数据来源
  const blockRehypePlugins = useMemo(
    () => [
      ...(rehypePlugins ?? []),
      createSourceOffsetAnnotator(block.startOffset, contentProps.markdown),
      createReadingMarkHitRegionAnnotator(readingMarkRanges ?? []),
    ],
    [contentProps.markdown, readingMarkRanges, rehypePlugins, block.startOffset],
  )

  return (
    <div
      ref={setElement}
      data-md-block-index={globalIndex}
      data-md-block-key={block.blockId}
      data-md-block-type={block.type}
      data-md-line={block.startLine}
      data-md-end-line={block.endLine}
      style={{ position: 'absolute', top, width: '100%' }}
    >
      <StableMarkdownContent {...contentProps} rehypePlugins={blockRehypePlugins} />
    </div>
  )
})

export const MarkdownPreview = memo(forwardRef(function MarkdownPreview({
  content,
  filePath,
  fontSize = 14,
  lineHeight = 1.65,
  fontFamily = "'JetBrains Mono', 'Cascadia Code', monospace",
  wordWrap = true,
  skipHtml = false,
  documentKey,
  documentVersion = 0,
  inlineEditEnabled = false,
  onBlockCommit,
  onTaskToggle,
  onHeadingClick,
  onDraftStateChange,
  isVisible = true,
  onFirstVisible,
  onRenderComplete,
  resource = 'preview',
  readingMarks = [],
  onCreateReadingMark,
  annotationOverlayRef,
}: MarkdownPreviewProps, ref: React.ForwardedRef<MarkdownPreviewHandle>) {
  const rootRef = useRef<HTMLDivElement>(null)
  const [activeEdit, setActiveEdit] = useState<ActiveBlockEdit | null>(null)
  const [overlayRect, setOverlayRect] = useState<{ top: number; left: number; width: number } | null>(null)
  const overlayRef = useRef<HTMLDivElement>(null)
  const [optimisticContent, setOptimisticContent] = useState<OptimisticPreviewContent | null>(null)
  const activeEditRef = useRef<ActiveBlockEdit | null>(null)
  const optimisticContentRef = useRef<OptimisticPreviewContent | null>(null)
  const submitPromiseRef = useRef<Promise<boolean> | null>(null)
  const documentVersionRef = useRef(documentVersion)
  const draftRef = useRef('')
  const altPointerRef = useRef<AltPointerIntent | null>(null)
  const handledAltClickRef = useRef(false)
  const mountedRef = useRef(true)
  const onBlockCommitRef = useRef(onBlockCommit)
  const onFirstVisibleRef = useRef(onFirstVisible)
  const onRenderCompleteRef = useRef(onRenderComplete)
  const firstVisibleRef = useRef(false)
  const lifecycleMetadataRef = useRef({ documentKey, resource })
  const previousDisplayedContentRef = useRef<string | null>(null)
  const previousModelRef = useRef<MarkdownPreviewModel | null>(null)
  const pendingPreviewPatchRef = useRef<PendingPreviewPatch | null>(null)
  const pendingAnchorRestoreRef = useRef<PendingPreviewAnchorRestore | null>(null)
  const displayedContent = activeEdit?.contentSnapshot ?? optimisticContent?.content ?? content
  const model = useMemo(() => createMarkdownPreviewModel(displayedContent), [displayedContent])
  const normalizedContent = model.normalizedContent
  const referenceDefinitionSource = useMemo(
    () => model.definitions.map((definition) => definition.rawSource).join('\n'),
    [model.definitions],
  )
  const footnoteDefinitionSource = useMemo(
    () => model.footnoteDefinitions.map((definition) => definition.rawSource).join('\n\n'),
    [model.footnoteDefinitions],
  )
  const footnoteReferences = useMemo(() => {
    const references: Array<{ source: string; identifier: string; startLine: number }> = []
    const re = /\[\^[^\]]+\]/g
    for (const block of model.blocks) {
      if (block.type === 'footnoteDefinition') continue
      let match: RegExpExecArray | null
      while ((match = re.exec(block.rawSource)) !== null) {
        references.push({
          source: match[0],
          identifier: match[0].slice(2, -1).trim().toLowerCase(),
          startLine: block.startLine,
        })
      }
    }
    return references
  }, [model.blocks])
  const standaloneFootnoteMarkdown = useMemo(() => {
    if (!footnoteDefinitionSource || footnoteReferences.length === 0) return ''
    return `${footnoteReferences.map((reference) => reference.source).join(' ')}\n\n${footnoteDefinitionSource}`
  }, [footnoteDefinitionSource, footnoteReferences])
  const { hasEmbeddedHtml, requiresWholeDocumentRender } = model
  const [htmlRehypePlugins, setHtmlRehypePlugins] = useState<RehypePlugins | null>(null)
  const [zoomImage, setZoomImage] = useState<{ src: string; alt: string } | null>(null)
  const [pendingSelectionUi, setPendingSelectionUi] = useState<PendingSelectionUi | null>(null)
  const textInputRef = useRef<HTMLTextAreaElement | null>(null)
  const colorActionRef = useRef<HTMLButtonElement | null>(null)
  const markActionRef = useRef<Promise<void> | null>(null)
  const readingMarkCloseTimerRef = useRef<number | null>(null)
  const readingMarkReducedMotionRef = useRef(false)
  const themeId = useSettingsStore((state) => state.appearance.themeId)
  // Virtual scrolling state
  const scrollContainerRef = useRef<HTMLElement | null>(null)
  const measuredHeightsRef = useRef<Map<string, number>>(new Map())
  const pendingObservedHeightsRef = useRef<Map<number, { blockId: string; height: number }>>(new Map())
  const lastObservedScrollTopRef = useRef(0)
  const userScrollRef = useRef<{ direction: 'up' | 'down' | null; activeUntil: number }>({ direction: null, activeUntil: 0 })
  const scrollAnchorGenerationRef = useRef(0)
  const headingScrollCancelRef = useRef<(() => void) | null>(null)
  const sourceRevealTimerRef = useRef<number | null>(null)
  /** 未挂载搜索目标的精确定位校正任务：目标 Range 挂载后执行一次即清空 */
  const pendingSearchCorrectionRef = useRef<{ from: number; to: number; blockId: string; appliedTop?: number; onApplied?: () => void } | null>(null)
  const blockRefs = useRef<Map<number, HTMLDivElement | null>>(new Map())
  const blockResizeObserverRef = useRef<ResizeObserver | null>(null)
  const measurementKeyRef = useRef<{
    content: string
    fontSize: number
    lineHeight: number
    fontFamily: string
    wordWrap: boolean
    theme: string
  } | null>(null)
  const [scrollState, setScrollState] = useState<{ scrollTop: number; viewportHeight: number; viewportWidth: number }>({ scrollTop: 0, viewportHeight: 800, viewportWidth: 0 })
  const [measurementRevision, setMeasurementRevision] = useState(0)
  const scrollStateRef = useRef(scrollState)
  const overscanBlocks = 5

  const cancelPendingAnchorRestore = useCallback(() => {
    scrollAnchorGenerationRef.current += 1
    pendingAnchorRestoreRef.current = null
  }, [])

  const cancelProgrammaticScroll = useCallback(() => {
    const cancel = headingScrollCancelRef.current
    headingScrollCancelRef.current = null
    cancel?.()
  }, [])

  const cancelUserScroll = useCallback(() => {
    cancelProgrammaticScroll()
  }, [cancelProgrammaticScroll])

  const markUserScroll = useCallback((deltaY: number | null) => {
    userScrollRef.current = {
      direction: deltaY === null ? null : deltaY > 0 ? 'down' : deltaY < 0 ? 'up' : null,
      activeUntil: performance.now() + USER_SCROLL_ACTIVITY_MS,
    }
  }, [])

  const handleWheelCapture = useCallback((event: React.WheelEvent<HTMLDivElement>) => {
    cancelUserScroll()
    markUserScroll(event.deltaY)
  }, [cancelUserScroll, markUserScroll])

  const handleWheel = useCallback((event: WheelEvent) => {
    cancelUserScroll()
    markUserScroll(event.deltaY)
  }, [cancelUserScroll, markUserScroll])

  const handlePointerDown = useCallback(() => {
    cancelUserScroll()
    markUserScroll(null)
  }, [cancelUserScroll, markUserScroll])

  scrollStateRef.current = scrollState

  // ---- 统一 Range 基础设施：搜索 / 选区状态全部 ref 驱动，不触发 React 重渲染 ----
  const modelRef = useRef(model)
  modelRef.current = model
  const searchStateRef = useRef<PreviewSearchState | null>(null)
  /** 搜索结果按 blockId 建立的索引（查询 O(1)，避免块渲染时扫描全部匹配） */
  const searchMatchesByBlockRef = useRef<Map<string, Array<{ from: number; to: number }>> | null>(null)
  /** 归一化选区（from < to，全文源码 offset）；DOM 卸载不影响其存活 */
  const selectionRangeRef = useRef<{ from: number; to: number } | null>(null)
  /** 来源跳转的瞬时高亮（全文源码 offset）；与搜索、选区和 ReadingMark 分层。 */
  const sourceRevealRangeRef = useRef<{ from: number; to: number } | null>(null)
  const selectionAnchorRef = useRef<number | null>(null)
  const dragStateRef = useRef<PreviewDragSelection | null>(null)
  /** 受支持交互 HTML（details 展开/折叠）的瞬时状态：块 ID + 块内序号 → 用户态；仅存本组件实例 ref，不写 Tab、不持久化 */
  const interactiveHtmlStateRef = useRef<Map<string, boolean>>(new Map())
  const interactiveStateKeyRef = useRef<string | null>(null)
  const readingMarksRef = useRef(readingMarks)
  readingMarksRef.current = readingMarks
  const readingMarkIndex = useMemo(() => buildReadingMarkRangeIndex(model, readingMarks), [model, readingMarks])
  const resolvedReadingMarks = readingMarkIndex.byId
  const readingMarkIndexRef = useRef(readingMarkIndex)
  readingMarkIndexRef.current = readingMarkIndex
  const readingMarksById = useMemo(() => new Map(readingMarks.map((mark) => [mark.id, mark])), [readingMarks])
  const readingMarksByIdRef = useRef(readingMarksById)
  readingMarksByIdRef.current = readingMarksById
  const readingMarkHitRangesByBlock = useMemo(() => {
    const result = new Map<string, Array<{ id: string; from: number; to: number }>>()
    for (const [blockId, entries] of readingMarkIndex.byBlockId) {
      result.set(blockId, entries.map(({ mark, from, to }) => ({ id: mark.id, from, to })))
    }
    return result
  }, [readingMarkIndex])
  const readingMarkHitRanges = useMemo(
    () => readingMarkIndex.sorted.map(({ mark, from, to }) => ({ id: mark.id, from, to })),
    [readingMarkIndex],
  )
  const pendingSelectionRef = useRef<PendingSelectionUi | null>(null)
  pendingSelectionRef.current = pendingSelectionUi
  const focusedMarkIdRef = useRef<string | null>(null)

  const measurementKey = measurementKeyRef.current
  const layoutChanged = Boolean(
    !measurementKey
    || measurementKey.fontSize !== fontSize
    || measurementKey.lineHeight !== lineHeight
    || measurementKey.fontFamily !== fontFamily
    || measurementKey.wordWrap !== wordWrap
    || measurementKey.theme !== themeId,
  )
  const contentChanged = measurementKey?.content !== displayedContent
  if (layoutChanged) {
    measuredHeightsRef.current = new Map()
    pendingObservedHeightsRef.current.clear()
    pendingAnchorRestoreRef.current = null
    pendingPreviewPatchRef.current = null
  } else if (contentChanged) {
    pendingObservedHeightsRef.current.clear()
    const previousModel = previousModelRef.current
    const patch = pendingPreviewPatchRef.current
    const mapping = previousModel && patch
      && patch.documentKey === documentKey
      && patch.nextContent === displayedContent
      && patch.previousModel.rawContent === previousModel.rawContent
      ? buildIncrementalBlockMapping(previousModel, model, patch.editedBlockId)
      : null
    if (mapping && patch && previousModel) {
      const nextHeights = new Map<string, number>()
      for (const [oldIndex, newIndex] of mapping) {
        const oldBlock = previousModel.blocks[oldIndex]
        const newBlock = model.blocks[newIndex]
        const height = oldBlock ? measuredHeightsRef.current.get(oldBlock.blockId) : undefined
        if (newBlock && typeof height === 'number') nextHeights.set(newBlock.blockId, height)
      }
      measuredHeightsRef.current = nextHeights
      const anchor = patch.anchor
      const anchorNewIndex = anchor
        ? mapping.get(anchor.blockIndex)
          ?? [...mapping.entries()].find(([oldIndex]) => oldIndex > anchor.blockIndex)?.[1]
          ?? [...mapping.entries()].reverse().find(([oldIndex]) => oldIndex < anchor.blockIndex)?.[1]
        : undefined
      const anchorBlock = typeof anchorNewIndex === 'number' ? model.blocks[anchorNewIndex] : undefined
      const anchorContainer = scrollContainerRef.current
      const mappedSourceOffset = anchor
        && typeof anchor.sourceOffset === 'number'
        && anchorNewIndex === mapping.get(anchor.blockIndex)
        ? mapSourceOffsetThroughReplacement(
            anchor.sourceOffset,
            patch.replacementStart,
            patch.replacementEnd,
            patch.replacementLength,
          )
        : undefined
      pendingAnchorRestoreRef.current = anchor
        && typeof anchorNewIndex === 'number'
        && anchorBlock
        && anchorContainer
        && patch.generation === scrollAnchorGenerationRef.current
        ? {
            ...anchor,
            blockId: anchorBlock.blockId,
            blockIndex: anchorNewIndex,
            sourceOffset: mappedSourceOffset,
            container: anchorContainer,
            documentKey: patch.documentKey,
            generation: patch.generation,
          }
        : null
    } else {
      measuredHeightsRef.current = new Map()
      pendingAnchorRestoreRef.current = null
    }
    pendingPreviewPatchRef.current = null
  }
  measurementKeyRef.current = { content: displayedContent, fontSize, lineHeight, fontFamily, wordWrap, theme: themeId }
  previousModelRef.current = model

  // 交互 HTML 瞬时状态失效：文档内容或文档身份变化即整体清除（渲染期执行，
  // 早于本帧块挂载 ref callback，避免"先恢复旧状态、又被清空"的时序倒置）
  const interactiveStateKey = `${documentKey ?? ''}\u0000${displayedContent}`
  if (interactiveStateKeyRef.current !== interactiveStateKey) {
    interactiveStateKeyRef.current = interactiveStateKey
    interactiveHtmlStateRef.current.clear()
  }

  activeEditRef.current = activeEdit
  optimisticContentRef.current = optimisticContent
  documentVersionRef.current = documentVersion
  onBlockCommitRef.current = onBlockCommit
  onFirstVisibleRef.current = onFirstVisible
  onRenderCompleteRef.current = onRenderComplete

  useLayoutEffect(() => {
    if (!isVisible || firstVisibleRef.current || !rootRef.current) return
    firstVisibleRef.current = true
    onFirstVisibleRef.current?.()
  }, [documentKey, isVisible, resource])

  useLayoutEffect(() => {
    if (!isVisible || !rootRef.current) return
    onRenderCompleteRef.current?.()
  }, [displayedContent, documentKey, documentVersion, isVisible, resource])

  useEffect(() => {
    onDraftStateChange?.(activeEdit !== null)
  }, [activeEdit, onDraftStateChange])

  useEffect(() => {
    if (skipHtml || !hasEmbeddedHtml || htmlRehypePlugins) return
    let active = true
    void loadMarkdownHtmlPlugins()
      .then((plugins) => {
        if (active) setHtmlRehypePlugins(plugins)
      })
      .catch(() => {
        // 加载失败时继续跳过原始 HTML，避免退回未过滤渲染。
      })
    return () => {
      active = false
    }
  }, [hasEmbeddedHtml, htmlRehypePlugins, skipHtml])

  useEffect(() => {
    const lifecycleMetadata = lifecycleMetadataRef.current
    const root = rootRef.current
    const overlay = annotationOverlayRef?.current
    mountedRef.current = true
    eventMarker.mark('model-create', lifecycleMetadata)
    return () => {
      cancelProgrammaticScroll()
      if (sourceRevealTimerRef.current !== null) window.clearTimeout(sourceRevealTimerRef.current)
      overlay?.hide()
      eventMarker.mark('model-dispose', lifecycleMetadata)
      previewHighlightRegistry.clearResource(lifecycleMetadata.resource)
      if (activePreviewRoot === root) activePreviewRoot = null
      const edit = activeEditRef.current
      const commit = onBlockCommitRef.current
      if (edit && commit && !submitPromiseRef.current) {
        void commit({
          block: edit.block,
          draft: draftRef.current,
          documentKey: edit.documentKey,
          documentVersion: edit.documentVersion,
        })
      }
      mountedRef.current = false
    }
  }, [annotationOverlayRef, cancelProgrammaticScroll])

  /* ---------------- 统一 Range：块级高亮同步（挂载/卸载时自动恢复） ---------------- */

  const syncBlockHighlights = useCallback((
    index: number,
    element: HTMLElement,
    kinds: { search?: boolean; selection?: boolean; sourceReveal?: boolean; readingMarks?: boolean } = {},
  ) => {
    const block = modelRef.current.blocks[index]
    if (!block) return
    const hasExplicitKinds = kinds.search !== undefined || kinds.selection !== undefined || kinds.sourceReveal !== undefined || kinds.readingMarks !== undefined
    if (!hasExplicitKinds && !searchStateRef.current && !selectionRangeRef.current && !sourceRevealRangeRef.current && readingMarksRef.current.length === 0) return
    const next: { search?: globalThis.Range[]; searchActive?: globalThis.Range[]; selection?: globalThis.Range[]; sourceReveal?: globalThis.Range[]; markYellow?: globalThis.Range[]; markGreen?: globalThis.Range[]; markBlue?: globalThis.Range[]; markPink?: globalThis.Range[]; markFocus?: globalThis.Range[] } = {}
    if (kinds.search !== false) {
      const searchState = searchStateRef.current
      const matches = searchState ? searchMatchesByBlockRef.current?.get(block.blockId) : undefined
      const searchRanges: globalThis.Range[] = []
      let activeRanges: globalThis.Range[] = []
      if (matches && matches.length > 0) {
        const activeOffset = searchState?.activeOffset
        for (const match of matches) {
          const ranges = buildDomRangesForSourceRange(element, match.from, match.to)
          if (activeOffset !== undefined && match.from <= activeOffset && activeOffset < match.to) {
            activeRanges = ranges
          } else {
            searchRanges.push(...ranges)
          }
        }
      }
      next.search = searchRanges
      next.searchActive = activeRanges
    }
    if (kinds.selection !== false) {
      const selection = selectionRangeRef.current
      const from = Math.max(selection?.from ?? 0, block.startOffset)
      const to = Math.min(selection?.to ?? 0, block.endOffset)
      next.selection = selection && to > from
        ? buildDomRangesForSourceRange(element, from, to)
        : []
    }
    if (kinds.sourceReveal !== false) {
      const reveal = sourceRevealRangeRef.current
      const from = Math.max(reveal?.from ?? 0, block.startOffset)
      const to = Math.min(reveal?.to ?? 0, block.endOffset)
      next.sourceReveal = reveal && to > from
        ? buildDomRangesForSourceRange(element, from, to)
        : []
    }
    if (kinds.readingMarks !== false) {
      next.markYellow = []
      next.markGreen = []
      next.markBlue = []
      next.markPink = []
      next.markFocus = []
      for (const entry of readingMarkIndex.byBlockId.get(block.blockId) ?? []) {
        const { mark, from, to } = entry
        const domRanges = buildDomRangesForSourceRange(element, Math.max(from, block.startOffset), Math.min(to, block.endOffset))
        const kind = mark.color === 'green' ? 'markGreen' : mark.color === 'blue' ? 'markBlue' : mark.color === 'pink' ? 'markPink' : 'markYellow'
        next[kind]!.push(...domRanges)
        if (focusedMarkIdRef.current === mark.id) next.markFocus.push(...domRanges)
      }
    }
    previewHighlightRegistry.syncBlock(resource, block.blockId, next)
  }, [readingMarkIndex, resource])

  const syncAllMountedBlocks = useCallback((kinds: { search?: boolean; selection?: boolean; sourceReveal?: boolean; readingMarks?: boolean }) => {
    if (requiresWholeDocumentRender) {
      // 整篇渲染模式无虚拟块 ref 追踪，直接按 DOM 标记同步
      const root = rootRef.current
      if (!root) return
      for (const element of root.querySelectorAll<HTMLElement>('[data-md-block-index]')) {
        const index = Number(element.dataset.mdBlockIndex)
        if (Number.isInteger(index)) syncBlockHighlights(index, element, kinds)
      }
      return
    }
    for (const [index, element] of blockRefs.current) {
      if (element) syncBlockHighlights(index, element, kinds)
    }
  }, [syncBlockHighlights, requiresWholeDocumentRender])

  const applySelection = useCallback((range: { from: number; to: number } | null) => {
    const prev = selectionRangeRef.current
    if (range === null || range.from === range.to) {
      if (prev === null) return
      selectionRangeRef.current = null
    } else {
      const normalized = range.from <= range.to ? range : { from: range.to, to: range.from }
      if (prev && prev.from === normalized.from && prev.to === normalized.to) return
      selectionRangeRef.current = normalized
    }
    // 只同步选区高亮：ref 驱动 + 块级增量，不触发任何 React 重渲染
    syncAllMountedBlocks({ search: false, selection: true })
  }, [syncAllMountedBlocks])

  const getSelectionSnapshot = useCallback((): PreviewSelectionSnapshot | null => {
    const selection = selectionRangeRef.current
    if (!selection) return null
    const currentModel = modelRef.current
    const info = buildDocumentRangeInfo(currentModel, selection.from, selection.to)
    if (!info) return null
    return {
      range: info.range,
      from: selection.from,
      to: selection.to,
      text: getTextForSourceRange(currentModel, selection.from, selection.to),
      startLine: 1 + countLineBreaks(currentModel.rawContent.slice(0, selection.from)),
      endLine: 1 + countLineBreaks(currentModel.rawContent.slice(0, selection.to)),
    }
  }, [])

  const cancelReadingMarkClose = useCallback(() => {
    if (readingMarkCloseTimerRef.current !== null) {
      window.clearTimeout(readingMarkCloseTimerRef.current)
      readingMarkCloseTimerRef.current = null
    }
  }, [])

  const dismissReadingMarkUi = useCallback(() => {
    cancelReadingMarkClose()
    pendingSelectionRef.current = null
    setPendingSelectionUi(null)
    annotationOverlayRef?.current?.hide()
  }, [annotationOverlayRef, cancelReadingMarkClose])

  const closeReadingMarkUiAfterSave = useCallback(() => {
    cancelReadingMarkClose()
    const current = pendingSelectionRef.current
    if (!current) return
    if (readingMarkReducedMotionRef.current) {
      dismissReadingMarkUi()
      applySelection(null)
      return
    }
    const next = { ...current, mode: 'colors' as const, expanded: false, creatingText: false, savingText: false }
    pendingSelectionRef.current = next
    setPendingSelectionUi(next)
    readingMarkCloseTimerRef.current = window.setTimeout(() => {
      readingMarkCloseTimerRef.current = null
      dismissReadingMarkUi()
      applySelection(null)
    }, READING_MARK_TOOLBAR_CLOSE_DELAY)
  }, [applySelection, cancelReadingMarkClose, dismissReadingMarkUi])

  const updatePendingSelection = useCallback((updater: (current: PendingSelectionUi) => PendingSelectionUi) => {
    const current = pendingSelectionRef.current
    if (!current) return null
    const next = updater(current)
    pendingSelectionRef.current = next
    setPendingSelectionUi(next)
    return next
  }, [])

  const openTextEditor = useCallback((pending: PendingSelectionUi) => {
    const next = { ...pending, mode: 'text' as const, expanded: true, creatingText: false, savingText: false }
    pendingSelectionRef.current = next
    setPendingSelectionUi(next)
    applySelection(null)
  }, [applySelection])

  const createMarkFromSelection = useCallback(async (color: ReadingMarkColor) => {
    if (markActionRef.current) return
    const action = (async () => {
      const pending = pendingSelectionRef.current
      if (!pending || pending.mode === 'text' || !onCreateReadingMark) return
      try {
        const result: CreateReadingMarkResult = await onCreateReadingMark(pending.selection, color, undefined, modelRef.current)
        if (result.status === 'conflict') {
          const next = { ...pending, mode: 'colors' as const, expanded: false, creatingText: false, conflict: { mark: result.mark, kind: result.kind } }
          pendingSelectionRef.current = next
          setPendingSelectionUi(next)
          return
        }
        dismissReadingMarkUi()
        applySelection(null)
      } catch {
        // 父级 Store 会回滚乐观状态并提供错误提示；浮钮保留以便重试。
      }
    })()
    markActionRef.current = action
    try {
      await action
    } finally {
      if (markActionRef.current === action) markActionRef.current = null
    }
  }, [applySelection, dismissReadingMarkUi, onCreateReadingMark])

  const enterTextMode = useCallback(() => {
    const pending = pendingSelectionRef.current
    if (!pending || pending.conflict || pending.mode === 'text' || markActionRef.current) return
    openTextEditor(pending)
  }, [openTextEditor])

  const returnToColorMode = useCallback(() => {
    updatePendingSelection((current) => ({ ...current, mode: 'colors', expanded: true, savingText: false }))
  }, [updatePendingSelection])

  const submitText = useCallback(async () => {
    if (markActionRef.current) return
    const action = (async () => {
      const pending = pendingSelectionRef.current
      if (!pending || pending.mode !== 'text' || !onCreateReadingMark) return
      const draft = pending.textDraft
      if (!draft.trim()) {
        closeReadingMarkUiAfterSave()
        return
      }
      const savingState = { ...pending, creatingText: true, savingText: true }
      pendingSelectionRef.current = savingState
      setPendingSelectionUi(savingState)
      const promise = Promise.resolve().then(() => onCreateReadingMark(pending.selection, pending.color, draft, modelRef.current))
      try {
        const result = await promise
        const current = pendingSelectionRef.current
        if (!current || current.selection !== pending.selection || current.mode !== 'text') return
        if (result.status === 'conflict') {
          const conflictState = { ...current, mode: 'colors' as const, expanded: false, creatingText: false, savingText: false, conflict: { mark: result.mark, kind: result.kind } }
          pendingSelectionRef.current = conflictState
          setPendingSelectionUi(conflictState)
          return
        }
        closeReadingMarkUiAfterSave()
      } catch {
        const current = pendingSelectionRef.current
        if (current?.mode === 'text') {
          const failedState = { ...current, creatingText: false, savingText: false }
          pendingSelectionRef.current = failedState
          setPendingSelectionUi(failedState)
        }
      }
    })()
    markActionRef.current = action
    try {
      await action
    } finally {
      if (markActionRef.current === action) markActionRef.current = null
    }
  }, [closeReadingMarkUiAfterSave, onCreateReadingMark])

  /** SearchOverlay 入口：基于可见文本投影全文搜索一次并按 blockId 建立匹配索引（O(1) 查询） */
  const setSearchStateImpl = useCallback((state: PreviewSearchState | null) => {
    searchStateRef.current = state && state.query ? state : null
    const query = searchStateRef.current?.query
    const map = new Map<string, Array<{ from: number; to: number }>>()
    if (query) {
      const currentModel = modelRef.current
      for (const hit of searchVisibleText(currentModel, query)) {
        const block = currentModel.blocks[hit.blockIndex]
        if (!block) continue
        const list = map.get(block.blockId)
        if (list) list.push({ from: hit.from, to: hit.to })
        else map.set(block.blockId, [{ from: hit.from, to: hit.to }])
      }
    }
    searchMatchesByBlockRef.current = query ? map : null
    syncAllMountedBlocks({ search: true, selection: false })
  }, [syncAllMountedBlocks])

  // 文档内容变化：旧 offset 全部失效，清除搜索索引与选区状态
  useEffect(() => {
    const contentChanged = previousDisplayedContentRef.current !== displayedContent
    previousDisplayedContentRef.current = displayedContent
    if (!contentChanged) return
    cancelProgrammaticScroll()
    pendingSearchCorrectionRef.current = null
    searchMatchesByBlockRef.current = null
    const hadSearch = searchStateRef.current !== null
    const hadSelection = selectionRangeRef.current !== null
    const hadSourceReveal = sourceRevealRangeRef.current !== null
    searchStateRef.current = null
    selectionRangeRef.current = null
    sourceRevealRangeRef.current = null
    if (sourceRevealTimerRef.current !== null) {
      window.clearTimeout(sourceRevealTimerRef.current)
      sourceRevealTimerRef.current = null
    }
    selectionAnchorRef.current = null
    if (hadSearch) syncAllMountedBlocks({ search: true, selection: false })
    if (hadSelection) syncAllMountedBlocks({ search: false, selection: true })
    if (hadSourceReveal) syncAllMountedBlocks({ search: false, selection: false, sourceReveal: true, readingMarks: false })
    syncAllMountedBlocks({ search: false, selection: false, readingMarks: true })
  }, [cancelProgrammaticScroll, displayedContent, syncAllMountedBlocks])

  useEffect(() => {
    syncAllMountedBlocks({ search: false, selection: false, readingMarks: true })
  }, [readingMarks, resolvedReadingMarks, syncAllMountedBlocks])

  useEffect(() => {
    if (!optimisticContent) return
    if (content !== optimisticContent.content && optimisticContent.acceptedContents.includes(content)) return
    optimisticContentRef.current = null
    setOptimisticContent(null)
  }, [content, optimisticContent])

  useLayoutEffect(() => {
    if (activeEdit || !pendingAnchorRestoreRef.current) return
    const pending = pendingAnchorRestoreRef.current
    const container = scrollContainerRef.current
    if (
      !container
      || container !== pending.container
      || documentKey !== pending.documentKey
      || pending.generation !== scrollAnchorGenerationRef.current
    ) {
      pendingAnchorRestoreRef.current = null
      return
    }

    const block = model.blocks[pending.blockIndex]
    if (!block || block.blockId !== pending.blockId) {
      pendingAnchorRestoreRef.current = null
      return
    }

    const nextHeights = new Map(measuredHeightsRef.current)
    let measuredChanged = false
    for (const [index, element] of blockRefs.current) {
      const mountedBlock = model.blocks[index]
      if (!element || !mountedBlock) continue
      const height = element.getBoundingClientRect().height
      if (height > 0 && nextHeights.get(mountedBlock.blockId) !== height) {
        nextHeights.set(mountedBlock.blockId, height)
        measuredChanged = true
      }
    }
    if (measuredChanged) measuredHeightsRef.current = nextHeights
    const projected = computeVisibleRange(
      model,
      container.scrollTop,
      container.scrollTop + container.clientHeight,
      nextHeights,
      (candidate) => estimatePreviewBlockHeight(candidate, fontSize, lineHeight),
      0,
    )
    const element = blockRefs.current.get(pending.blockIndex)
    const domBlockTop = element
      ? element.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop
      : undefined
    const blockTop = projected.blockTops[pending.blockIndex]
      ?? domBlockTop
      ?? getEstimatedPreviewTopForLine(
          model,
          block.startLine,
          (candidate) => estimatePreviewBlockHeight(candidate, fontSize, lineHeight),
          nextHeights,
        )
    const exactTop = element && typeof pending.sourceOffset === 'number'
      ? getMountedSourceRangeTop(
          element,
          container,
          pending.sourceOffset,
          Math.min(block.endOffset, pending.sourceOffset + 1),
        )
      : undefined
    const localOffset = typeof exactTop === 'number' && typeof domBlockTop === 'number'
      ? exactTop - domBlockTop
      : 0
    const anchorTop = typeof blockTop === 'number'
      ? blockTop + localOffset
      : exactTop
    const desired = typeof anchorTop === 'number'
      ? anchorTop + pending.viewportOffset
      : pending.fallbackScrollTop
    const maxScrollTop = container.scrollHeight > container.clientHeight
      ? container.scrollHeight - container.clientHeight
      : Number.POSITIVE_INFINITY
    const nextScrollTop = Math.max(0, Math.min(desired, maxScrollTop))
    pendingAnchorRestoreRef.current = null
    if (Math.abs(container.scrollTop - nextScrollTop) < 1) {
      if (measuredChanged) setScrollState((state) => ({ ...state }))
      return
    }
    container.scrollTop = nextScrollTop
    setScrollState((state) => ({ ...state, scrollTop: nextScrollTop }))
  }, [activeEdit, documentKey, fontSize, lineHeight, model])

  const remeasureMountedBlocks = useCallback(() => {
    const nextHeights = new Map<string, number>()
    for (const [index, element] of blockRefs.current) {
      const block = model.blocks[index]
      if (!element || !block) continue
      const height = normalizeMeasuredBlockHeight(element.getBoundingClientRect().height)
      if (height > 0) nextHeights.set(block.blockId, height)
    }
    measuredHeightsRef.current = nextHeights
  }, [model.blocks])

  // Observe parent scroll container
  useEffect(() => {
    const el = rootRef.current?.parentElement
    if (!el) return
    const pendingObservedHeights = pendingObservedHeightsRef.current
    scrollContainerRef.current = el
    lastObservedScrollTopRef.current = el.scrollTop
    const update = () => {
      const previousScrollTop = lastObservedScrollTopRef.current
      lastObservedScrollTopRef.current = el.scrollTop
      const userScroll = userScrollRef.current
      const now = performance.now()
      if (userScroll.activeUntil > now && el.scrollTop !== previousScrollTop) {
        if (userScroll.direction === null) {
          userScroll.direction = el.scrollTop > previousScrollTop ? 'down' : 'up'
        }
        userScroll.activeUntil = now + USER_SCROLL_ACTIVITY_MS
      }
      const nextState = { scrollTop: el.scrollTop, viewportHeight: el.clientHeight, viewportWidth: el.clientWidth }
      const currentWidth = scrollStateRef.current.viewportWidth
      if (currentWidth !== 0 && currentWidth !== el.clientWidth) {
        cancelProgrammaticScroll()
        const estimateForResize = (block: PreviewBlock) => estimatePreviewBlockHeight(block, fontSize, lineHeight)
        const before = computeVisibleRange(
          model,
          el.scrollTop,
          el.scrollTop + el.clientHeight,
          measuredHeightsRef.current,
          estimateForResize,
          0,
        )
        const anchorIndex = before.startIndex
        const anchorOffset = el.scrollTop - (before.blockTops[anchorIndex] ?? 0)
        remeasureMountedBlocks()
        const after = computeVisibleRange(
          model,
          el.scrollTop,
          el.scrollTop + el.clientHeight,
          measuredHeightsRef.current,
          estimateForResize,
          0,
        )
        const anchoredScrollTop = Math.max(0, (after.blockTops[anchorIndex] ?? 0) + anchorOffset)
        el.scrollTop = anchoredScrollTop
        flushSync(() => setScrollState({ ...nextState, scrollTop: anchoredScrollTop }))
        return
      }
      setScrollState(nextState)
    }
    update()
    const ro = new ResizeObserver(update)
    let disposed = false
    let measurementFlushQueued = false
    const queueMeasurementFlush = () => {
      if (measurementFlushQueued) return
      measurementFlushQueued = true
      queueMicrotask(() => {
        measurementFlushQueued = false
        if (disposed || pendingObservedHeights.size === 0) return
        flushSync(() => setMeasurementRevision((revision) => revision + 1))
      })
    }
    const blockRo = new ResizeObserver((entries) => {
      if (scrollStateRef.current.viewportWidth !== 0 && scrollStateRef.current.viewportWidth !== el.clientWidth) {
        pendingObservedHeights.clear()
        update()
        return
      }
      let changed = false
      for (const entry of entries) {
        const element = entry.target as HTMLElement
        const index = Number(element.dataset.mdBlockIndex)
        const block = model.blocks[index]
        const height = normalizeMeasuredBlockHeight(
          entry.borderBoxSize?.[0]?.blockSize ?? element.getBoundingClientRect().height,
        )
        const pending = pendingObservedHeights.get(index)
        const previousHeight = pending?.blockId === block?.blockId
          ? pending.height
          : block
            ? measuredHeightsRef.current.get(block.blockId)
            : undefined
        if (block && height > 0 && previousHeight !== height) {
          pendingObservedHeights.set(index, { blockId: block.blockId, height })
          changed = true
        }
      }
      if (changed) queueMeasurementFlush()
    })
    blockResizeObserverRef.current = blockRo
    for (const blockElement of blockRefs.current.values()) {
      if (blockElement) blockRo.observe(blockElement)
    }
    ro.observe(el)
    el.addEventListener('scroll', update, { passive: true })
    el.addEventListener('wheel', handleWheel, { passive: true })
    el.addEventListener('pointerdown', handlePointerDown)
    el.addEventListener('touchstart', handlePointerDown, { passive: true })
    return () => {
      disposed = true
      pendingObservedHeights.clear()
      cancelProgrammaticScroll()
      ro.disconnect()
      blockRo.disconnect()
      blockResizeObserverRef.current = null
      el.removeEventListener('scroll', update)
      el.removeEventListener('wheel', handleWheel)
      el.removeEventListener('pointerdown', handlePointerDown)
      el.removeEventListener('touchstart', handlePointerDown)
    }
  }, [cancelProgrammaticScroll, fontSize, handlePointerDown, handleWheel, lineHeight, model, remeasureMountedBlocks])

  /** 虚拟块（重新）挂载时恢复 details 展开/折叠等受支持交互 HTML 的用户瞬时状态 */
  const restoreInteractiveHtmlState = useCallback((element: HTMLElement) => {
    const state = interactiveHtmlStateRef.current
    if (state.size === 0) return
    const blockKey = element.dataset.mdBlockKey
    if (!blockKey) return
    element.querySelectorAll('details').forEach((details, index) => {
      const open = state.get(`${blockKey}#${index}`)
      if (open !== undefined) details.open = open
    })
  }, [])

  const setBlockElement = useCallback((index: number, element: HTMLDivElement | null) => {
    const previous = blockRefs.current.get(index)
    if (previous && previous !== element) {
      blockResizeObserverRef.current?.unobserve(previous)
      // 虚拟块卸载：仅移除该块的 DOM Range，文档级搜索/选区状态保留
      const previousKey = previous.dataset.mdBlockKey
      if (previousKey) previewHighlightRegistry.removeBlock(resource, previousKey)
    }
    if (element) {
      blockRefs.current.set(index, element)
      blockResizeObserverRef.current?.observe(element)
      // 块（重新）挂载：根据当前搜索/选区状态自动恢复高亮
      syncBlockHighlights(index, element)
      restoreInteractiveHtmlState(element)
    } else {
      blockRefs.current.delete(index)
    }
  }, [resource, syncBlockHighlights, restoreInteractiveHtmlState])

  // details 的 toggle 事件不冒泡，在捕获阶段委托监听；状态仅写入本实例 ref，
  // 块卸载不丢失，重挂载由 restoreInteractiveHtmlState 恢复
  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    const handleToggle = (event: Event) => {
      const target = event.target
      if (!(target instanceof HTMLDetailsElement)) return
      const blockWrapper = target.closest<HTMLElement>('[data-md-block-key]')
      const blockKey = blockWrapper?.dataset.mdBlockKey
      if (!blockWrapper || !blockKey) return
      let index = -1
      blockWrapper.querySelectorAll('details').forEach((details, i) => {
        if (details === target) index = i
      })
      if (index < 0) return
      interactiveHtmlStateRef.current.set(`${blockKey}#${index}`, target.open)
    }
    root.addEventListener('toggle', handleToggle, true)
    return () => root.removeEventListener('toggle', handleToggle, true)
  }, [])

  // 批注 Hover 仅在 Preview Root 做事件委托：高亮片段本身是渲染派生数据，
  // 不为每条 ReadingMark 注册监听器，也不通过 pointermove 跟踪鼠标。
  useEffect(() => {
    const root = rootRef.current
    if (!root || !annotationOverlayRef) return
    const handlePointerOver = (event: PointerEvent) => {
      if (pendingSelectionRef.current || selectionRangeRef.current) return
      const target = event.target
      if (!(target instanceof Element)) return
      const hit = target.closest<HTMLElement>('[data-gm-reading-mark-id]')
      if (!hit || !root.contains(hit)) return
      const related = event.relatedTarget
      if (related instanceof Node && hit.contains(related)) return
      const markId = hit.dataset.gmReadingMarkId?.split(',')[0]
      const mark = markId ? readingMarksByIdRef.current.get(markId) : undefined
      if (!mark) return
      const rect = hit.getBoundingClientRect()
      const anchor: AnnotationHoverAnchor = { top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left, triggerPoint: { x: event.clientX, y: event.clientY } }
      annotationOverlayRef.current?.show(mark, anchor)
    }
    const handlePointerOut = (event: PointerEvent) => {
      const target = event.target
      if (!(target instanceof Element)) return
      const hit = target.closest<HTMLElement>('[data-gm-reading-mark-id]')
      if (!hit || !root.contains(hit)) return
      const related = event.relatedTarget
      if (related instanceof Node && (hit.contains(related) || (related instanceof Element && related.closest('[data-annotation-hover-overlay="true"]')))) return
      annotationOverlayRef.current?.scheduleHide()
    }
    root.addEventListener('pointerover', handlePointerOver)
    root.addEventListener('pointerout', handlePointerOut)
    return () => {
      root.removeEventListener('pointerover', handlePointerOver)
      root.removeEventListener('pointerout', handlePointerOut)
    }
  }, [annotationOverlayRef])

  // Height estimation
  const estimateBlockHeight = useCallback(
    (block: PreviewBlock): number => estimatePreviewBlockHeight(block, fontSize, lineHeight),
    [fontSize, lineHeight],
  )

  const captureViewportAnchor = useCallback((): PreviewViewportAnchor | null => {
    const container = scrollContainerRef.current
    if (!container || model.blocks.length === 0) return null
    const fallbackScrollTop = container.scrollTop
    const visibleAtTop = computeVisibleRange(
      model,
      fallbackScrollTop,
      fallbackScrollTop + container.clientHeight,
      measuredHeightsRef.current,
      estimateBlockHeight,
      0,
    )
    const blockIndex = visibleAtTop.startIndex
    const block = model.blocks[blockIndex]
    if (!block) return null
    const element = blockRefs.current.get(blockIndex)
    const blockTop = element
      ? element.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop
      : visibleAtTop.blockTops[blockIndex]
    const line = getMountedPreviewLineForTop(model, rootRef.current, container, fallbackScrollTop)
    const sourceOffset = typeof line === 'number' ? getSourceOffsetForLine(model, line) : undefined
    const exactTop = element && typeof sourceOffset === 'number'
      ? getMountedSourceRangeTop(element, container, sourceOffset, Math.min(block.endOffset, sourceOffset + 1))
      : undefined
    const anchorTop = typeof exactTop === 'number' ? exactTop : blockTop
    return {
      blockId: block.blockId,
      blockIndex,
      sourceOffset,
      viewportOffset: fallbackScrollTop - anchorTop,
      fallbackScrollTop,
    }
  }, [estimateBlockHeight, model])

  // 编辑与预览共用同一套目录滚动：短距离平滑滚动，长距离渐隐后瞬移并在渐显前校正。
  // 未挂载标题始终由全文模型提供位置，挂载后自动切换为真实 DOM 几何。
  const scrollToLineInternal = useCallback((line: number): boolean => {
    const container = scrollContainerRef.current
    if (!container) return false
    cancelProgrammaticScroll()
    const getTargetTop = () => {
      if (!mountedRef.current || scrollContainerRef.current !== container) return undefined
      const target = rootRef.current?.querySelector<HTMLElement>(`[data-md-line="${line}"]`)
      const top = target
        ? target.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop
        : getEstimatedPreviewTopForLine(model, line, estimateBlockHeight, measuredHeightsRef.current)
      return typeof top === 'number' ? top - 24 : undefined
    }
    if (typeof getTargetTop() !== 'number') return false
    let cleanup: (() => void) | null = null
    cleanup = startHeadingScroll({
      container,
      fadeElement: container,
      getTargetTop,
      onSettled: () => {
        if (cleanup && headingScrollCancelRef.current === cleanup) headingScrollCancelRef.current = null
      },
    })
    if (cleanup) {
      headingScrollCancelRef.current = cleanup
    }
    return true
  }, [cancelProgrammaticScroll, estimateBlockHeight, model])

  const navigateToReadingMarkInternal = useCallback((markId: string): boolean => {
    const range = resolvedReadingMarks.get(markId)
    if (!range) return false
    focusedMarkIdRef.current = markId
    syncAllMountedBlocks({ search: false, selection: false, readingMarks: true })
    const index = findBlockIndexByOffset(model, range.from)
    if (index < 0) return false
    const container = scrollContainerRef.current
    if (!container) return false
    cancelProgrammaticScroll()
    const element = blockRefs.current.get(index)
    const exactTop = element ? getMountedSourceRangeTop(element, container, range.from, range.to) : undefined
    if (typeof exactTop === 'number') {
      container.scrollTo({ top: Math.max(0, exactTop - 24) })
    } else {
      const block = model.blocks[index]
      const line = block.startLine + countLineBreaks(model.rawContent.slice(block.startOffset, range.from))
      const top = getEstimatedPreviewTopForLine(model, line, estimateBlockHeight, measuredHeightsRef.current)
      if (typeof top !== 'number') return false
      pendingSearchCorrectionRef.current = { from: range.from, to: range.to, blockId: model.blocks[index].blockId }
      container.scrollTo({ top: Math.max(0, top - 24) })
    }
    window.setTimeout(() => {
      if (focusedMarkIdRef.current !== markId) return
      focusedMarkIdRef.current = null
      syncAllMountedBlocks({ search: false, selection: false, readingMarks: true })
    }, 1600)
    return true
  }, [cancelProgrammaticScroll, estimateBlockHeight, model, resolvedReadingMarks, syncAllMountedBlocks])

  const scrollToSourceRangeDirect = useCallback((
    from: number,
    to: number,
    onApplied?: () => void,
  ): boolean => {
    const container = scrollContainerRef.current
    if (!container) return false
    cancelProgrammaticScroll()
    pendingSearchCorrectionRef.current = null
    const index = findBlockIndexByOffset(model, from)
    const block = index >= 0 ? model.blocks[index] : undefined
    if (!block) return false
    const getTargetTop = () => {
      if (!mountedRef.current || scrollContainerRef.current !== container) return undefined
      const element = blockRefs.current.get(index)
      const rangeElement = element ?? (requiresWholeDocumentRender ? rootRef.current : null)
      const exactTop = rangeElement
        ? getMountedSourceRangeTop(rangeElement, container, from, Math.min(block.endOffset, Math.max(from + 1, to)))
        : undefined
      if (typeof exactTop === 'number') return Math.max(0, exactTop - 24)
      if (element) {
        const blockTop = element.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop
        return Math.max(0, blockTop - 24)
      }
      const localSource = model.rawContent.slice(block.startOffset, Math.max(block.startOffset, from))
      const line = block.startLine + (localSource.match(/\r\n|\r|\n/g)?.length ?? 0)
      const top = getEstimatedPreviewTopForLine(model, line, estimateBlockHeight, measuredHeightsRef.current)
      return typeof top === 'number' ? Math.max(0, top - 24) : undefined
    }
    if (typeof getTargetTop() !== 'number') return false

    const initiallyMounted = Boolean(blockRefs.current.get(index) || (requiresWholeDocumentRender && rootRef.current))
    let transitionSettled = false
    let correctionReady = initiallyMounted
    let applied = false
    const applyOnce = () => {
      if (applied) return
      if (!transitionSettled) {
        correctionReady = true
        return
      }
      applied = true
      onApplied?.()
    }
    if (!initiallyMounted) {
      pendingSearchCorrectionRef.current = {
        from,
        to,
        blockId: block.blockId,
        onApplied: () => {
          correctionReady = true
          applyOnce()
        },
      }
    }

    let cleanup: (() => void) | null = null
    cleanup = startHeadingScroll({
      container,
      fadeElement: container,
      forceDirect: true,
      getTargetTop,
      onSettled: () => {
        transitionSettled = true
        if (initiallyMounted || correctionReady) applyOnce()
        if (cleanup && headingScrollCancelRef.current === cleanup) headingScrollCancelRef.current = null
      },
    })
    if (cleanup) headingScrollCancelRef.current = cleanup
    return true
  }, [cancelProgrammaticScroll, estimateBlockHeight, model, requiresWholeDocumentRender])

  const revealSourceLinesInternal = useCallback((request: MarkdownPreviewSourceRevealRequest): boolean => {
    if (request.documentKey !== documentKey) return false
    if (request.documentVersion !== undefined && request.documentVersion !== documentVersion) return false
    const { startLine, endLine = startLine } = request
    const currentModel = modelRef.current
    const normalizedStartLine = Math.max(1, Math.min(startLine, endLine))
    const normalizedEndLine = Math.max(normalizedStartLine, Math.max(startLine, endLine))
    const startBlockIndex = findBlockIndexByLine(currentModel, normalizedStartLine)
    const endBlockIndex = findBlockIndexByLine(currentModel, normalizedEndLine)
    if (startBlockIndex < 0 || endBlockIndex < 0) return false
    const from = getSourceOffsetForLine(currentModel, normalizedStartLine)
      ?? currentModel.blocks[startBlockIndex].startOffset
    const to = getSourceOffsetForLine(currentModel, normalizedEndLine + 1)
      ?? currentModel.blocks[endBlockIndex].endOffset
    if (to <= from) return false

    const reveal = { from, to }
    sourceRevealRangeRef.current = reveal
    syncAllMountedBlocks({ search: false, selection: false, sourceReveal: true, readingMarks: false })
    const finishReveal = () => {
      if (sourceRevealRangeRef.current !== reveal) return
      if (sourceRevealTimerRef.current !== null) window.clearTimeout(sourceRevealTimerRef.current)
      sourceRevealTimerRef.current = window.setTimeout(() => {
        sourceRevealTimerRef.current = null
        if (sourceRevealRangeRef.current !== reveal) return
        sourceRevealRangeRef.current = null
        syncAllMountedBlocks({ search: false, selection: false, sourceReveal: true, readingMarks: false })
      }, SOURCE_REVEAL_DURATION_MS)
      request.onApplied?.()
    }
    const applied = scrollToSourceRangeDirect(from, to, finishReveal)
    if (!applied) {
      sourceRevealRangeRef.current = null
      syncAllMountedBlocks({ search: false, selection: false, sourceReveal: true, readingMarks: false })
    }
    return applied
  }, [documentKey, documentVersion, scrollToSourceRangeDirect, syncAllMountedBlocks])

  // Expose scrollToLine for EditorArea to use with TOC jumps
  useImperativeHandle(ref, () => ({
    getTopForLine(line: number) {
      const container = scrollContainerRef.current
      const target = rootRef.current?.querySelector<HTMLElement>(`[data-md-line="${line}"]`)
      if (container && target) {
        return target.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop
      }
      return getEstimatedPreviewTopForLine(
        model, line, estimateBlockHeight, measuredHeightsRef.current,
      )
    },
    getLineForTop(top: number) {
      const container = scrollContainerRef.current
      if (container) {
        const mountedLine = getMountedPreviewLineForTop(model, rootRef.current, container, top)
        if (typeof mountedLine === 'number') return mountedLine
      }
      return getEstimatedPreviewLineForTop(
        model, top, estimateBlockHeight, measuredHeightsRef.current,
      )
    },
    getViewportOffset() {
      const container = scrollContainerRef.current
      if (!container) return undefined
      const top = container.scrollTop
      const mountedLine = getMountedPreviewLineForTop(model, rootRef.current, container, top)
      const line = typeof mountedLine === 'number'
        ? mountedLine
        : getEstimatedPreviewLineForTop(model, top, estimateBlockHeight, measuredHeightsRef.current)
      if (typeof line !== 'number') return undefined
      return getSourceOffsetForLine(model, line)
    },
    scrollToLine(line: number) {
      cancelPendingAnchorRestore()
      scrollToLineInternal(line)
    },
    revealSourceLines: revealSourceLinesInternal,
    scrollToOffset(offset: number) {
      cancelPendingAnchorRestore()
      cancelProgrammaticScroll()
      const index = findBlockIndexByOffset(model, offset)
      const block = index >= 0 ? model.blocks[index] : undefined
      if (!block) return
      const container = scrollContainerRef.current
      if (!container) return
      const match = searchMatchesByBlockRef.current?.get(block.blockId)?.find((item) => item.from === offset)
      const to = match?.to ?? Math.min(block.endOffset, offset + 1)
      const element = blockRefs.current.get(index)
      const rangeElement = element ?? (requiresWholeDocumentRender ? rootRef.current : null)
      const exactTop = rangeElement
        ? getMountedSourceRangeTop(rangeElement, container, offset, to)
        : undefined
      if (typeof exactTop === 'number') {
        pendingSearchCorrectionRef.current = null
        container.scrollTo({ top: Math.max(0, exactTop - 24) })
        return
      }
      if (element) {
        pendingSearchCorrectionRef.current = null
        const blockTop = element.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop
        container.scrollTo({ top: Math.max(0, blockTop - 24) })
        return
      }
      const localSource = model.rawContent.slice(block.startOffset, Math.max(block.startOffset, offset))
      const line = block.startLine + (localSource.match(/\r\n|\r|\n/g)?.length ?? 0)
      pendingSearchCorrectionRef.current = { from: offset, to, blockId: block.blockId }
      const top = getEstimatedPreviewTopForLine(model, line, estimateBlockHeight, measuredHeightsRef.current)
      if (typeof top === 'number') container.scrollTo({ top: Math.max(0, top - 24) })
    },
    setSearchState: setSearchStateImpl,
    searchVisible(query: string) {
      return searchVisibleText(modelRef.current, query).map((hit) => ({ from: hit.from, to: hit.to }))
    },
    getSelection() {
      const selection = selectionRangeRef.current
      if (!selection) return null
      const currentModel = modelRef.current
      const info = buildDocumentRangeInfo(currentModel, selection.from, selection.to)
      if (!info) return null
      return {
        range: info.range,
        from: selection.from,
        to: selection.to,
        text: getTextForSourceRange(currentModel, selection.from, selection.to),
        startLine: 1 + countLineBreaks(currentModel.rawContent.slice(0, selection.from)),
        endLine: 1 + countLineBreaks(currentModel.rawContent.slice(0, selection.to)),
      }
    },
    selectAll() {
      const currentModel = modelRef.current
      if (currentModel.blocks.length === 0) return
      const from = currentModel.blocks[0].startOffset
      const to = currentModel.blocks[currentModel.blocks.length - 1].endOffset
      selectionAnchorRef.current = from
      applySelection({ from, to })
    },
    clearSelection() {
      selectionAnchorRef.current = null
      applySelection(null)
    },
    navigateToReadingMark: navigateToReadingMarkInternal,
  }), [cancelProgrammaticScroll, cancelPendingAnchorRestore, model, estimateBlockHeight, requiresWholeDocumentRender, scrollToLineInternal, revealSourceLinesInternal, setSearchStateImpl, applySelection, navigateToReadingMarkInternal])

  // Visible range
  const visible = useMemo(
    () => requiresWholeDocumentRender
      ? { startIndex: 0, endIndex: 0, blockTops: [] as number[], totalHeight: 0 }
      : computeVisibleRange(
          model, scrollState.scrollTop, scrollState.scrollTop + scrollState.viewportHeight,
          measuredHeightsRef.current, estimateBlockHeight, overscanBlocks,
        ),
    [model, scrollState, estimateBlockHeight, requiresWholeDocumentRender],
  )

  // Measure real heights of mounted blocks
  useLayoutEffect(() => {
    const container = scrollContainerRef.current
    const before = container
      ? computeVisibleRange(
          model,
          container.scrollTop,
          container.scrollTop + container.clientHeight,
          measuredHeightsRef.current,
          estimateBlockHeight,
          0,
        )
      : null
    const anchorIndex = before?.startIndex ?? visible.startIndex
    const anchorElement = blockRefs.current.get(anchorIndex)
    const anchorTopBefore = anchorElement && container
      ? anchorElement.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop
      : before?.blockTops[anchorIndex] ?? 0
    const previousHeights = measuredHeightsRef.current
    const nextHeights = new Map(previousHeights)
    const candidateIndices = new Set<number>()
    for (const [index, pending] of pendingObservedHeightsRef.current) {
      const block = model.blocks[index]
      if (!block || block.blockId !== pending.blockId) continue
      nextHeights.set(block.blockId, pending.height)
      candidateIndices.add(index)
    }
    pendingObservedHeightsRef.current.clear()
    for (let i = visible.startIndex; i < visible.endIndex; i += 1) {
      const el = blockRefs.current.get(i)
      const blk = model.blocks[i]
      if (!el || !blk) continue
      const h = normalizeMeasuredBlockHeight(el.getBoundingClientRect().height)
      if (h > 0 && nextHeights.get(blk.blockId) !== h) {
        nextHeights.set(blk.blockId, h)
        candidateIndices.add(i)
      }
    }
    const changedIndices = Array.from(candidateIndices).filter((index) => {
      const block = model.blocks[index]
      return block && previousHeights.get(block.blockId) !== nextHeights.get(block.blockId)
    })
    if (changedIndices.length === 0) return
    measuredHeightsRef.current = nextHeights
    if (container && before) {
      const after = computeVisibleRange(
        model,
        container.scrollTop,
        container.scrollTop + container.clientHeight,
        nextHeights,
        estimateBlockHeight,
        0,
      )
      const anchorDelta = (after.blockTops[anchorIndex] ?? anchorTopBefore) - anchorTopBefore
      const changedBeforeAnchor = changedIndices.some((index) => index < anchorIndex)
      const userScrollingDown = userScrollRef.current.direction === 'down'
        && userScrollRef.current.activeUntil > performance.now()
      if (changedBeforeAnchor && !headingScrollCancelRef.current && !pendingSearchCorrectionRef.current && !userScrollingDown && anchorDelta !== 0) {
        container.scrollTop = Math.max(0, container.scrollTop + anchorDelta)
      }
      setScrollState({ scrollTop: container.scrollTop, viewportHeight: container.clientHeight, viewportWidth: container.clientWidth })
      return
    }
    setScrollState((state) => ({ ...state }))
  }, [estimateBlockHeight, measurementRevision, model, visible.startIndex, visible.endIndex, scrollState.viewportWidth])

  // 未挂载搜索目标的单次幂等校正：目标块进入虚拟窗口后，优先按真实 DOM Range
  // 对齐关键词；无精确标注时退回块顶部，不重新计算全文估算位置。
  useLayoutEffect(() => {
    const pending = pendingSearchCorrectionRef.current
    if (!pending) return
    const container = scrollContainerRef.current
    if (!container) return
    const index = model.blocks.findIndex((block) => block.blockId === pending.blockId)
    const element = index >= 0 ? blockRefs.current.get(index) : undefined
    if (!element) return
    const exactTop = getMountedSourceRangeTop(element, container, pending.from, pending.to)
    const targetTop = typeof exactTop === 'number'
      ? exactTop
      : element.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop
    if (pending.appliedTop !== undefined && Math.abs(pending.appliedTop - targetTop) < 1) {
      pendingSearchCorrectionRef.current = null
      pending.onApplied?.()
      return
    }
    const appliedPending = { ...pending, appliedTop: targetTop, onApplied: undefined }
    pendingSearchCorrectionRef.current = appliedPending
    const desired = Math.max(0, targetTop - 24)
    if (Math.abs(container.scrollTop - desired) >= 1) container.scrollTop = desired
    pending.onApplied?.()
  }, [model, scrollState.scrollTop, visible.blockTops, visible.startIndex, visible.endIndex])

  useEffect(() => {
    if (pendingSelectionUi?.mode !== 'text') return
    const frame = window.requestAnimationFrame(() => textInputRef.current?.focus())
    return () => window.cancelAnimationFrame(frame)
  }, [pendingSelectionUi?.mode])

  const overlayRectRef = useRef<{ top: number; left: number; width: number } | null>(null)

  // 编辑标记与浮层定位：除 activeEdit 变化外，虚拟挂载窗口变化也需重跑——
  // 编辑中的块滚出 overscan 卸载再滚回重挂载后，新 DOM 需要恢复 data-md-editing
  // （否则原正文重新显示，与仍存在的编辑浮层形成双层内容）并按新位置重算浮层矩形
  useLayoutEffect(() => {
    if (!activeEdit) return
    const target = rootRef.current?.querySelector<HTMLElement>(
      `[data-md-block-key="${activeEdit.block.blockId}"]`,
    )
    if (!target) return
    if (!target.hasAttribute('data-md-editing')) {
      target.setAttribute('data-md-editing', '')
    }
    const rootRect = rootRef.current?.getBoundingClientRect()
    if (!rootRect) return
    const bcr = target.getBoundingClientRect()
    const next = {
      top: bcr.top - rootRect.top,
      left: bcr.left - rootRect.left,
      width: bcr.width,
    }
    const prev = overlayRectRef.current
    if (prev && prev.top === next.top && prev.left === next.left && prev.width === next.width) return
    overlayRectRef.current = next
    setOverlayRect(next)
  }, [activeEdit, visible.startIndex, visible.endIndex])

  const closeActiveEdit = useCallback((edit: ActiveBlockEdit) => {
    if (!mountedRef.current) return
    if (activeEditRef.current?.documentKey === edit.documentKey && activeEditRef.current.block.blockId === edit.block.blockId) {
      activeEditRef.current = null
    }
    const prevTarget = rootRef.current?.querySelector<HTMLElement>(
      `[data-md-block-key="${edit.block.blockId}"]`,
    )
    prevTarget?.removeAttribute('data-md-editing')
    setOverlayRect(null)
    setActiveEdit((current) => (
      current?.documentKey === edit.documentKey && current.block.blockId === edit.block.blockId
        ? null
        : current
    ))
  }, [])

  const submitEdit = useCallback(async (edit: ActiveBlockEdit): Promise<boolean> => {
    const draft = draftRef.current
    const viewportAnchor = captureViewportAnchor()
    const scrollAnchorGeneration = scrollAnchorGenerationRef.current
    if (!onBlockCommit) {
      closeActiveEdit(edit)
      return true
    }
    const result = await onBlockCommit({
      block: edit.block,
      draft,
      documentKey: edit.documentKey,
      documentVersion: edit.documentVersion,
    })
    if (result.status === 'conflict') {
      if (mountedRef.current) {
        setActiveEdit((current) => (
          current?.documentKey === edit.documentKey && current.block.blockId === edit.block.blockId
            ? { ...current, conflict: true }
            : current
        ))
      }
      return false
    }
    const nextContent = result.content ?? (
      edit.contentSnapshot.slice(0, edit.block.startOffset)
      + draft
      + edit.contentSnapshot.slice(edit.block.endOffset)
    )
    if (
      nextContent !== edit.contentSnapshot
      && modelRef.current.rawContent === edit.contentSnapshot
    ) {
      const originalBlockLength = edit.block.endOffset - edit.block.startOffset
      const replacementLength = Math.max(0, nextContent.length - (edit.contentSnapshot.length - originalBlockLength))
      pendingPreviewPatchRef.current = {
        previousModel: modelRef.current,
        nextContent,
        documentKey: edit.documentKey,
        editedBlockId: edit.block.blockId,
        replacementStart: edit.block.startOffset,
        replacementEnd: edit.block.endOffset,
        replacementLength,
        anchor: viewportAnchor,
        generation: scrollAnchorGeneration,
      }
    }
    const pending = optimisticContentRef.current
    const nextOptimisticContent: OptimisticPreviewContent = {
      content: nextContent,
      acceptedContents: pending?.content === edit.contentSnapshot
        ? [...pending.acceptedContents, edit.contentSnapshot]
        : [edit.contentSnapshot],
    }
    optimisticContentRef.current = nextOptimisticContent
    setOptimisticContent(nextOptimisticContent)
    closeActiveEdit(edit)
    return true
  }, [captureViewportAnchor, closeActiveEdit, onBlockCommit])

  const submitEditRef = useRef(submitEdit)
  submitEditRef.current = submitEdit

  const submitActiveEdit = useCallback(() => {
    if (submitPromiseRef.current) return submitPromiseRef.current
    const edit = activeEditRef.current
    if (!edit) return Promise.resolve(true)
    const promise = submitEditRef.current(edit).finally(() => {
      if (submitPromiseRef.current === promise) submitPromiseRef.current = null
    })
    submitPromiseRef.current = promise
    return promise
  }, [])

  useEffect(() => {
    const edit = activeEditRef.current
    if (edit && documentKey && edit.documentKey !== documentKey) void submitEdit(edit)
  }, [documentKey, submitEdit])

  useEffect(() => {
    if (!activeEdit) return
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target
      if (!(target instanceof Element)) return
      if (target.closest('.gm-inline-markdown-editor')) return
      if (target.closest('.cm-tooltip, [role="dialog"], [role="menu"], [data-context-menu="true"]')) return
      if (event.altKey && rootRef.current?.contains(target.closest('[data-md-block-index]'))) return
      void submitActiveEdit()
    }
    document.addEventListener('pointerdown', handlePointerDown, true)
    return () => document.removeEventListener('pointerdown', handlePointerDown, true)
  }, [activeEdit, submitActiveEdit])

  const beginEditing = useCallback(async (blockIndex: number, target: Element) => {
    if (!inlineEditEnabled || !documentKey || !onBlockCommit) return
    const requestedBlock = model.blocks[blockIndex]
    if (!requestedBlock) return
    const current = activeEditRef.current
    const lineElement = target.closest<HTMLElement>('[data-md-line]')
    const clickedLine = Number(lineElement?.dataset.mdLine)
    if (current?.block.blockId === requestedBlock.blockId && current.documentKey === documentKey) return

    const blockWrapper = target.closest<HTMLElement>('[data-md-block-index]')
    let contentSnapshot = displayedContent
    let block = requestedBlock
    if (current) {
      const currentDraftLength = draftRef.current.length
      if (!(await submitActiveEdit())) return
      contentSnapshot = optimisticContentRef.current?.content ?? content
      const adjustedStartOffset = requestedBlock.startOffset + (
        current.block.endOffset <= requestedBlock.startOffset
          ? currentDraftLength - current.block.rawSource.length
          : 0
      )
      const snapshotModel = createMarkdownPreviewModel(contentSnapshot)
      const adjustedIdx = findBlockIndexByOffset(snapshotModel, adjustedStartOffset)
      block = adjustedIdx >= 0 ? snapshotModel.blocks[adjustedIdx] : requestedBlock
    }
    cancelPendingAnchorRestore()

    const mappedClickedLine = Number.isFinite(clickedLine)
      ? block.startLine + (clickedLine - requestedBlock.startLine)
      : Number.NaN
    const initialCursor = Number.isFinite(mappedClickedLine)
      ? getBlockOffsetForLine(block, mappedClickedLine)
      : block.rawSource.length
    const edit: ActiveBlockEdit = {
      block,
      documentKey,
      documentVersion: documentVersionRef.current,
      contentSnapshot,
      initialCursor,
      conflict: false,
    }
    draftRef.current = block.rawSource
    activeEditRef.current = edit
    setActiveEdit(edit)

    if (blockWrapper) {
      blockWrapper.setAttribute('data-md-editing', '')
      const rootRect = rootRef.current?.getBoundingClientRect()
      if (rootRect) {
        const bcr = blockWrapper.getBoundingClientRect()
        setOverlayRect({
          top: bcr.top - rootRect.top,
          left: bcr.left - rootRect.left,
          width: bcr.width,
        })
      }
    }
  }, [cancelPendingAnchorRestore, model.blocks, content, displayedContent, documentKey, inlineEditEnabled, onBlockCommit, submitActiveEdit])

  const handlePointerDownCapture = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    cancelProgrammaticScroll()
    cancelPendingAnchorRestore()
    if (!event.altKey || !inlineEditEnabled || activeEditRef.current && (event.target as Element).closest('.gm-inline-markdown-editor')) return
    const target = event.target
    if (!(target instanceof Element)) return
    const wrapper = target.closest<HTMLElement>('[data-md-block-index]')
    if (!wrapper || !rootRef.current?.contains(wrapper)) return
    const blockIndex = Number(wrapper.dataset.mdBlockIndex)
    if (!Number.isInteger(blockIndex)) return
    altPointerRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      blockIndex,
      target,
      moved: false,
    }
  }, [cancelPendingAnchorRestore, cancelProgrammaticScroll, inlineEditEnabled])

  const handlePointerMoveCapture = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const intent = altPointerRef.current
    if (!intent || intent.pointerId !== event.pointerId) return
    if (Math.hypot(event.clientX - intent.startX, event.clientY - intent.startY) > ALT_CLICK_MOVE_THRESHOLD) {
      intent.moved = true
    }
  }, [])

  const handlePointerUpCapture = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const intent = altPointerRef.current
    altPointerRef.current = null
    if (!intent || intent.pointerId !== event.pointerId || intent.moved || !event.altKey) return
    event.preventDefault()
    event.stopPropagation()
    handledAltClickRef.current = true
    void beginEditing(intent.blockIndex, intent.target)
  }, [beginEditing])

  const handleClickCapture = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if (!event.altKey || !handledAltClickRef.current) return
    handledAltClickRef.current = false
    event.preventDefault()
    event.stopPropagation()
  }, [])

  /* ---------------- 统一 Range：拖选引擎 + 键盘（Ctrl+A/C、双击选词、Shift+点击） ---------------- */

  const resolveCaretOffsetRef = useRef<(clientX: number, clientY: number) => number | null>(() => null)
  resolveCaretOffsetRef.current = (clientX: number, clientY: number) => {
    const doc = document as Document & {
      caretRangeFromPoint?: (x: number, y: number) => Range | null
      caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null
    }
    let node: Node | null = null
    let offset = 0
    if (typeof doc.caretRangeFromPoint === 'function') {
      const hit = doc.caretRangeFromPoint(clientX, clientY)
      if (hit) {
        node = hit.startContainer
        offset = hit.startOffset
      }
    } else if (typeof doc.caretPositionFromPoint === 'function') {
      const hit = doc.caretPositionFromPoint(clientX, clientY)
      if (hit) {
        node = hit.offsetNode
        offset = hit.offset
      }
    }
    if (!node || !rootRef.current?.contains(node)) return null
    return domPointToSourceOffset(node, offset)
  }

  const runDragFrameRef = useRef<() => void>(() => {})
  runDragFrameRef.current = () => {
    const drag = dragStateRef.current
    if (!drag) return
    drag.rafId = 0
    // 边缘自动滚动：长距离拖选跨屏（滚动驱动虚拟化挂载新块，选区自动延伸）
    const container = scrollContainerRef.current
    if (container) {
      const rect = container.getBoundingClientRect()
      let dy = 0
      if (drag.clientY < rect.top + DRAG_AUTOSCROLL_EDGE) {
        dy = -Math.ceil(Math.min(DRAG_AUTOSCROLL_MAX_STEP, (rect.top + DRAG_AUTOSCROLL_EDGE - drag.clientY) / 3))
      } else if (drag.clientY > rect.bottom - DRAG_AUTOSCROLL_EDGE) {
        dy = Math.ceil(Math.min(DRAG_AUTOSCROLL_MAX_STEP, (drag.clientY - rect.bottom + DRAG_AUTOSCROLL_EDGE) / 3))
      }
      if (dy !== 0) container.scrollTop += dy
    }
    // 每帧最多更新一次终点，且只有 offset 真正变化时才写入选区
    const offset = resolveCaretOffsetRef.current(drag.clientX, drag.clientY)
    if (offset !== null && offset !== drag.focusOffset) {
      drag.focusOffset = offset
      applySelection({ from: drag.anchorOffset, to: offset })
    }
    drag.rafId = requestAnimationFrame(runDragFrameRef.current)
  }

  useEffect(() => {
    const root = rootRef.current
    if (!root) return

    const handleMouseDown = (event: MouseEvent) => {
      if (event.button !== 0 || event.altKey) return
      annotationOverlayRef?.current?.hide()
      activePreviewRoot = root
      const offset = resolveCaretOffsetRef.current(event.clientX, event.clientY)
      if (offset === null) return
      // 命中标注文本：接管选区（阻止原生 DOM Selection 启动）
      event.preventDefault()
      const current = selectionRangeRef.current
      const anchor = event.shiftKey && current
        ? (selectionAnchorRef.current ?? current.from)
        : offset
      dragStateRef.current = {
        anchorOffset: anchor,
        focusOffset: offset,
        rafId: requestAnimationFrame(runDragFrameRef.current),
        clientX: event.clientX,
        clientY: event.clientY,
      }
      applySelection(anchor === offset ? null : { from: anchor, to: offset })
    }

    const cancelDragOnSecondaryMouseDown = (event: MouseEvent) => {
      if (event.button === 0) return
      const drag = dragStateRef.current
      if (!drag || (event.buttons & 1) === 0) return
      event.preventDefault()
      dragStateRef.current = null
      if (drag.rafId !== 0) cancelAnimationFrame(drag.rafId)
      selectionAnchorRef.current = null
      applySelection(null)
      window.getSelection()?.removeAllRanges()
    }

    const handleMouseMove = (event: MouseEvent) => {
      const drag = dragStateRef.current
      if (!drag || (event.buttons & 1) === 0) return
      drag.clientX = event.clientX
      drag.clientY = event.clientY
    }

    const handleMouseUp = (event: MouseEvent) => {
      const drag = dragStateRef.current
      if (!drag) return
      if (event.button !== 0 && (event.buttons & 1) !== 0) return
      dragStateRef.current = null
      if (drag.rafId !== 0) cancelAnimationFrame(drag.rafId)
      const offset = resolveCaretOffsetRef.current(event.clientX, event.clientY)
      const focus = offset ?? drag.focusOffset
      selectionAnchorRef.current = drag.anchorOffset
      const normalized = drag.anchorOffset === focus ? null : (drag.anchorOffset <= focus ? { from: drag.anchorOffset, to: focus } : { from: focus, to: drag.anchorOffset })
      applySelection(normalized)
      if (normalized) {
        const selection = getSelectionSnapshot()
        if (selection && selection.text) {
          const fallback = { top: event.clientY, right: event.clientX, bottom: event.clientY, left: event.clientX, triggerPoint: { x: event.clientX, y: event.clientY } }
          const anchorRect = getSourceRangeAnchorRect(root, selection.from, selection.to, fallback)
          const conflict = findReadingMarkConflict(readingMarkIndexRef.current, selection.from, selection.to) ?? undefined
          const next = { selection, anchorRect, expanded: false, mode: 'colors' as const, color: 'yellow' as const, textDraft: '', creatingText: false, savingText: false, conflict }
          pendingSelectionRef.current = next
          setPendingSelectionUi(next)
        }
      } else {
        pendingSelectionRef.current = null
        setPendingSelectionUi(null)
      }
    }

    const handleDoubleClick = (event: MouseEvent) => {
      const offset = resolveCaretOffsetRef.current(event.clientX, event.clientY)
      if (offset === null) return
      const word = findWordRangeAt(modelRef.current, offset)
      if (word) {
        selectionAnchorRef.current = word.from
        applySelection(word)
        const selection = getSelectionSnapshot()
        if (selection && selection.text) {
          const fallback = { top: event.clientY, right: event.clientX, bottom: event.clientY, left: event.clientX, triggerPoint: { x: event.clientX, y: event.clientY } }
          const anchorRect = getSourceRangeAnchorRect(root, selection.from, selection.to, fallback)
          const conflict = findReadingMarkConflict(readingMarkIndexRef.current, selection.from, selection.to) ?? undefined
          const next = { selection, anchorRect, expanded: false, mode: 'colors' as const, color: 'yellow' as const, textDraft: '', creatingText: false, savingText: false, conflict }
          pendingSelectionRef.current = next
          setPendingSelectionUi(next)
        }
      }
    }

    root.addEventListener('mousedown', handleMouseDown)
    document.addEventListener('mousedown', cancelDragOnSecondaryMouseDown, true)
    document.addEventListener('mousemove', handleMouseMove, true)
    document.addEventListener('mouseup', handleMouseUp, true)
    root.addEventListener('dblclick', handleDoubleClick)
    return () => {
      root.removeEventListener('mousedown', handleMouseDown)
      document.removeEventListener('mousedown', cancelDragOnSecondaryMouseDown, true)
      document.removeEventListener('mousemove', handleMouseMove, true)
      document.removeEventListener('mouseup', handleMouseUp, true)
      root.removeEventListener('dblclick', handleDoubleClick)
      const drag = dragStateRef.current
      if (drag && drag.rafId !== 0) cancelAnimationFrame(drag.rafId)
      dragStateRef.current = null
    }
  }, [annotationOverlayRef, applySelection, getSelectionSnapshot])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (activePreviewRoot !== rootRef.current) return
      const target = event.target
      if (target instanceof Element && target.closest('input, textarea, select, [contenteditable="true"], .cm-editor, .gm-inline-markdown-editor')) return
      if (!(event.ctrlKey || event.metaKey)) {
        if (event.key === 'Escape' && selectionRangeRef.current) applySelection(null)
        return
      }
      const key = event.key.toLowerCase()
      if (key === 'a') {
        // 逻辑全文选择：selectionRange = 文档开始 → 文档结束，不依赖 DOM
        event.preventDefault()
        const currentModel = modelRef.current
        if (currentModel.blocks.length === 0) return
        const from = currentModel.blocks[0].startOffset
        const to = currentModel.blocks[currentModel.blocks.length - 1].endOffset
        selectionAnchorRef.current = from
        applySelection({ from, to })
      } else if (key === 'c') {
        const selection = selectionRangeRef.current
        if (!selection) return
        // 复制统一走 selectionRange → 文档模型 → 剪贴板，虚拟化下可复制任意超长选区
        event.preventDefault()
        void navigator.clipboard.writeText(getTextForSourceRange(modelRef.current, selection.from, selection.to))
      }
    }
    document.addEventListener('keydown', handleKeyDown, true)
    return () => document.removeEventListener('keydown', handleKeyDown, true)
  }, [applySelection])

  useEffect(() => {
    const closeOnOutside = (event: MouseEvent) => {
      if (event.button !== 0) return
      const target = event.target
      if (target instanceof Element && target.closest('.gm-reading-mark-toolbar, .gm-reading-mark-popover, [data-annotation-hover-overlay="true"]')) return
      const hadPendingSelection = pendingSelectionRef.current !== null
      dismissReadingMarkUi()
      if (hadPendingSelection) {
        selectionAnchorRef.current = null
        applySelection(null)
      }
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      const pending = pendingSelectionRef.current
      if (pending?.mode === 'text') {
        event.preventDefault()
        if (!pending.creatingText && !pending.savingText) returnToColorMode()
      } else {
        dismissReadingMarkUi()
      }
    }
    document.addEventListener('mousedown', closeOnOutside, true)
    document.addEventListener('keydown', closeOnEscape, true)
    return () => {
      document.removeEventListener('mousedown', closeOnOutside, true)
      document.removeEventListener('keydown', closeOnEscape, true)
    }
  }, [applySelection, dismissReadingMarkUi, returnToColorMode])

  useEffect(() => () => cancelReadingMarkClose(), [cancelReadingMarkClose])

  useEffect(() => {
    dismissReadingMarkUi()
  }, [dismissReadingMarkUi, documentKey, displayedContent, resource])

  useEffect(() => {
    const container = scrollContainerRef.current
    if (!container) return
    const close = () => dismissReadingMarkUi()
    container.addEventListener('scroll', close, { passive: true })
    return () => container.removeEventListener('scroll', close)
  }, [dismissReadingMarkUi, scrollState.viewportHeight])

  const rehypePlugins = useMemo(
    () => [
      ...(!skipHtml && hasEmbeddedHtml && htmlRehypePlugins ? htmlRehypePlugins : []),
      ...MARKDOWN_REHYPE_PLUGINS,
    ],
    [hasEmbeddedHtml, htmlRehypePlugins, skipHtml],
  )
  const wholeDocumentRehypePlugins = useMemo(
    () => [
      ...rehypePlugins,
      createSourceOffsetAnnotator(0, normalizedContent),
      createReadingMarkHitRegionAnnotator(readingMarkHitRanges),
      createMarkdownBlockWrapperPlugin(model.blocks),
    ],
    [model.blocks, normalizedContent, readingMarkHitRanges, rehypePlugins],
  )

  const components = useMemo<Partial<Components>>(() => {
    const headingIds = new Map<string, number>()
    const handleAnchorClick = (href?: string, isFootnoteBackref?: boolean) => (event: React.MouseEvent<HTMLAnchorElement>) => {
      if (!href?.startsWith('#')) return
      event.preventDefault()
      cancelProgrammaticScroll()
      const id = href.slice(1)
      // 仅在预览实例自身范围内查找已挂载目标；不回退 document.getElementById，
      // 避免双栏预览等实例间同 id（如 heading-N）造成的跨实例滚动串扰
      let target: HTMLElement | null | undefined
      let navigated = false
      if (isFootnoteBackref) {
        const footnoteItem = event.currentTarget.closest('li[id]')
        const footnoteItems = footnoteItem?.closest('section[data-footnotes]')?.querySelectorAll('li[id]')
        const footnoteIndex = footnoteItem && footnoteItems ? [...footnoteItems].indexOf(footnoteItem) : -1
        const identifierOrder = [...new Set(footnoteReferences.map((reference) => reference.identifier))]
        const identifier = footnoteIndex >= 0 ? identifierOrder[footnoteIndex] : undefined
        const backrefs = footnoteItem?.querySelectorAll('a[data-footnote-backref]')
        const backrefIndex = backrefs ? [...backrefs].indexOf(event.currentTarget) : -1
        const reference = identifier && backrefIndex >= 0
          ? footnoteReferences.filter((item) => item.identifier === identifier)[backrefIndex]
          : undefined
        const container = scrollContainerRef.current
        const top = reference
          ? getEstimatedPreviewTopForLine(model, reference.startLine, estimateBlockHeight, measuredHeightsRef.current)
          : undefined
        if (container && typeof top === 'number') {
          container.scrollTo({ top: Math.max(0, top - 24), behavior: 'smooth' })
          navigated = true
        }
      } else {
        target ??= rootRef.current?.querySelector<HTMLElement>(`#${CSS.escape(id)}`)
        if (target instanceof HTMLElement) {
          target.scrollIntoView({ behavior: 'smooth', block: 'start' })
          target.focus({ preventScroll: true })
          navigated = true
        } else {
          // 模型驱动回退：目标未挂载（虚拟窗口外）或为标题 slug / HTML id 锚点时按全文模型定位
          const anchorTarget = findAnchorTarget(model, id)
          navigated = anchorTarget ? scrollToLineInternal(anchorTarget.line) : false
        }
      }
      // 锚点不存在：安全 no-op——不修改滚动位置，也不更新 URL hash
      if (!navigated) return
      if (typeof history !== 'undefined' && history.replaceState) {
        history.replaceState(null, '', href)
      }
    }

    return {
          section: ({ children, node, ...props }) => {
            // eslint-disable-next-line react-hooks/rules-of-hooks
            const renderFootnotes = useContext(FootnoteSectionContext)
            if ('data-footnotes' in props && !renderFootnotes) return null
            void node
            return <section {...props}>{children}</section>
          },
          div: ({ children, node, ...props }) => {
            void node
            return <div {...props}>{children}</div>
          },
          h1: ({ children, node }) => {
            // eslint-disable-next-line react-hooks/rules-of-hooks
            const base = useBlockLineBase()
            const line = getNodeStartLine(node, base)
            const id = line ? `heading-${line}` : createHeadingId(getText(children), headingIds)
            return (
              <h1 id={id} data-heading-id={id} data-md-line={line} onClick={() => handleHeadingClick(line, onHeadingClick)} className="scroll-mt-6 font-bold mt-8 mb-4 text-gm-text border-b border-gm-border pb-3" style={{ fontSize: '2em' }}>
                {children}
              </h1>
            )
          },
          h2: ({ children, node }) => {
            // eslint-disable-next-line react-hooks/rules-of-hooks
            const base = useBlockLineBase()
            const line = getNodeStartLine(node, base)
            const id = line ? `heading-${line}` : createHeadingId(getText(children), headingIds)
            return (
              <h2 id={id} data-heading-id={id} data-md-line={line} onClick={() => handleHeadingClick(line, onHeadingClick)} className="scroll-mt-6 font-bold mt-8 mb-4 text-gm-text" style={{ fontSize: '1.5em' }}>
                {children}
              </h2>
            )
          },
          h3: ({ children, node }) => {
            // eslint-disable-next-line react-hooks/rules-of-hooks
            const base = useBlockLineBase()
            const line = getNodeStartLine(node, base)
            const id = line ? `heading-${line}` : createHeadingId(getText(children), headingIds)
            return (
              <h3 id={id} data-heading-id={id} data-md-line={line} onClick={() => handleHeadingClick(line, onHeadingClick)} className="scroll-mt-6 font-bold mt-6 mb-3 text-gm-text" style={{ fontSize: '1.25em' }}>
                {children}
              </h3>
            )
          },
          h4: ({ children, node }) => {
            // eslint-disable-next-line react-hooks/rules-of-hooks
            const base = useBlockLineBase()
            const line = getNodeStartLine(node, base)
            const id = line ? `heading-${line}` : createHeadingId(getText(children), headingIds)
            return (
              <h4 id={id} data-heading-id={id} data-md-line={line} onClick={() => handleHeadingClick(line, onHeadingClick)} className="scroll-mt-6 font-bold mt-4 mb-2 text-gm-text" style={{ fontSize: '1.1em' }}>
                {children}
              </h4>
            )
          },
          p: ({ children, node, ...props }) => {
            // eslint-disable-next-line react-hooks/rules-of-hooks
            const base = useBlockLineBase()
            const align = (props as { align?: string }).align
            return (
              <p
                {...props}
                className={['my-3', align === 'center' && 'gm-markdown-paragraph--align-center'].filter(Boolean).join(' ')}
                data-md-line={getNodeStartLine(node, base)}
                data-md-end-line={getNodeEndLine(node, base)}
              >
                {children}
              </p>
            )
          },
          strong: ({ children }) => (
            <strong className="font-bold text-gm-text">{children}</strong>
          ),
          em: ({ children }) => (
            <em className="text-gm-text italic">{children}</em>
          ),
          code: ({ children, className, node }) => {
            // eslint-disable-next-line react-hooks/rules-of-hooks
            const base = useBlockLineBase()
            const code = String(children)
            const language = className?.match(/language-([\w-]+)/)?.[1]
            const isBlock = Boolean(language) || code.endsWith('\n')
            if (isBlock && language === 'mermaid') {
              return <MermaidBlock code={code.replace(/\n$/, '')} startLine={getNodeStartLine(node, base)} endLine={getNodeEndLine(node, base)} />
            }
            if (isBlock && language === 'echarts') {
              const startLine = getNodeStartLine(node, base)
              const endLine = getNodeEndLine(node, base)
              return (
                <Suspense fallback={<div className="my-4 rounded-xl border border-gm-border bg-gm-surface-elevated p-4 text-caption text-gm-text-tertiary" style={{ height: 392 }} data-md-line={startLine} data-md-end-line={endLine}>正在加载 ECharts…</div>}>
                  <LazyEChartsBlock code={code.replace(/\n$/, '')} startLine={startLine} endLine={endLine} />
                </Suspense>
              )
            }
            if (isBlock) {
              return (
                <CodeBlock code={code.replace(/\n$/, '')} language={language} fontSize={fontSize} startLine={getNodeStartLine(node, base)} endLine={getNodeEndLine(node, base)}>
                  {language && (
                    <div className="px-4 py-1.5 border-b border-gm-border text-micro text-gm-text-secondary font-mono">
                      {language}
                    </div>
                  )}
                  <pre className="p-4 overflow-x-auto m-0">
                    <code className={['font-mono', className].filter(Boolean).join(' ')} style={{ fontSize: '0.9em' }}>
                      {children}
                    </code>
                  </pre>
                </CodeBlock>
              )
            }
            return (
              <code className="px-2 py-0.5 rounded-lg bg-gm-surface-elevated text-gm-accent font-mono" style={{ fontSize: '0.9em' }}>
                {children}
              </code>
            )
          },
          blockquote: ({ children, node }) => {
            // eslint-disable-next-line react-hooks/rules-of-hooks
            const base = useBlockLineBase()
            return (
              <blockquote className="pl-4 border-l-4 border-gm-primary rounded-r-lg py-3 text-gm-text-secondary italic my-4" data-md-line={getNodeStartLine(node, base)} data-md-end-line={getNodeEndLine(node, base)}>
                {children}
              </blockquote>
            )
          },
          a: ({ href, children, node: _node, ...props }) => {
            // eslint-disable-next-line react-hooks/rules-of-hooks
            const footnoteSuffix = useContext(FootnoteReferenceSuffixContext)
            const isHashLink = href?.startsWith('#')
            const isFootnoteBackref = 'data-footnote-backref' in props
            const isFootnoteReference = 'data-footnote-ref' in props
            const anchorId = isFootnoteReference && footnoteSuffix && typeof props.id === 'string'
              ? `${props.id}-${footnoteSuffix}`
              : props.id
            // 背向跳转（backref→正文）：保持原始 href，由 handleAnchorClick 查找首个匹配的 data-footnote-ref 元素
            return (
              <a
                {...props}
                id={anchorId}
                href={href}
                className="text-gm-primary hover:underline font-bold transition-colors hover:text-gm-primary-hover"
                target={isHashLink ? undefined : '_blank'}
                rel={isHashLink ? undefined : 'noopener noreferrer'}
                onClick={handleAnchorClick(href, isFootnoteBackref)}
              >
                {isFootnoteBackref ? (children && String(children).trim() ? children : '↩ 返回正文') : children}
              </a>
            )
          },
          ul: ({ children }) => (
            <ul className="my-3 pl-6 space-y-1 list-disc">{children}</ul>
          ),
          ol: ({ children }) => (
            <ol className="my-3 pl-6 space-y-1 list-decimal">{children}</ol>
          ),
          li: ({ children, node, ...liProps }) => {
            // eslint-disable-next-line react-hooks/rules-of-hooks
            const base = useBlockLineBase()
            const localLine = node?.position?.start?.line
            const line = typeof localLine === 'number' ? localLine + base : undefined
            return (
              <li data-md-line={line} {...liProps}>
                {children}
              </li>
            )
          },
          hr: ({ node }) => {
            // eslint-disable-next-line react-hooks/rules-of-hooks
            const base = useBlockLineBase()
            return <hr className="my-6 border-gm-border" data-md-line={getNodeStartLine(node, base)} />
          },
          table: ({ children, node, ...props }) => {
            // eslint-disable-next-line react-hooks/rules-of-hooks
            const base = useBlockLineBase()
            return (
              <div className="my-4 overflow-x-auto rounded-xl border border-gm-border" data-md-line={getNodeStartLine(node, base)}>
                <table {...props} className="w-full border-collapse">
                  {children}
                </table>
              </div>
            )
          },
          thead: ({ children }) => (
            <thead className="bg-gm-surface-elevated">{children}</thead>
          ),
          th: ({ children, node: _node, style: _style, ...props }) => (
            <th {...props} className={`px-4 py-2.5 font-bold text-gm-text border-b border-gm-border${props.align ? '' : ' text-left'}`}>
              {children}
            </th>
          ),
          td: ({ children, node: _node, style: _style, ...props }) => (
            <td {...props} className="px-4 py-2 border-b border-gm-border-subtle">
              {children}
            </td>
          ),
          img: ({ src, alt, title, width, height, node }) => {
            // eslint-disable-next-line react-hooks/rules-of-hooks
            const base = useBlockLineBase()
            const resolvedSrc = resolveImageSrc(src, filePath)
            const altText = alt || ''
            return (
              <button
                type="button"
                className="gm-markdown-image my-4 block max-w-full cursor-zoom-in rounded-xl border border-gm-border bg-transparent p-0 text-left"
                onClick={() => setZoomImage({ src: resolvedSrc, alt: altText })}
                title="点击放大图片"
                data-md-line={getNodeStartLine(node, base)}
              >
                <img
                  src={resolvedSrc}
                  alt={altText}
                  title={title}
                  width={width}
                  height={height}
                  referrerPolicy="no-referrer"
                  loading="lazy"
                  decoding="async"
                  className="max-w-full rounded-xl"
                />
              </button>
            )
          },
          del: ({ children }) => (
            <del className="text-gm-text-tertiary line-through">{children}</del>
          ),
          input: ({ checked, node: _node, ...props }) => {
            // 只处理task list的checkbox
            if (props.type !== 'checkbox') {
              return <input {...props} />
            }
            const isChecked = Boolean(checked)
            return (
              <input
                type="checkbox"
                checked={isChecked}
                readOnly={!onTaskToggle}
                disabled={!onTaskToggle}
                onChange={(e) => {
                  e.stopPropagation()
                  if (!onTaskToggle) return
                  // input 节点的 position 在 HAST 中是 undefined，从父级 li 的 data-md-line 获取行号
                  const li = e.currentTarget.closest('[data-md-line]')
                  const lineStr = li?.getAttribute('data-md-line')
                  const line = lineStr ? Number(lineStr) : undefined
                  if (typeof line === 'number' && !Number.isNaN(line)) {
                    onTaskToggle(line, !isChecked)
                  }
                }}
                className={`mr-2 accent-gm-primary ${onTaskToggle ? 'cursor-pointer select-none' : ''}`}
                style={onTaskToggle ? { cursor: 'pointer' } : undefined}
              />
            )
          },
        }
  }, [cancelProgrammaticScroll, estimateBlockHeight, filePath, fontSize, footnoteReferences, model, onHeadingClick, onTaskToggle, scrollToLineInternal])

  return (
    <div
      ref={rootRef}
      data-md-render-mode={requiresWholeDocumentRender ? 'whole' : 'virtual'}
      className="prose gm-markdown-preview max-w-none min-w-0 text-gm-text"
      style={{ fontSize: `${fontSize}px`, lineHeight, position: 'relative' }}
      onPointerDownCapture={handlePointerDownCapture}
      onPointerMoveCapture={handlePointerMoveCapture}
      onPointerUpCapture={handlePointerUpCapture}
      onClickCapture={handleClickCapture}
      onWheelCapture={handleWheelCapture}
    >
      {requiresWholeDocumentRender ? (
          <StableMarkdownContent
            baseLine={0}
            markdown={normalizedContent}
            readingMarkRanges={readingMarkHitRanges}
          skipHtml={skipHtml || (hasEmbeddedHtml && !htmlRehypePlugins)}
          rehypePlugins={wholeDocumentRehypePlugins}
          components={components}
        />
      ) : (
        <div style={{ position: 'relative', height: visible.totalHeight, minHeight: visible.totalHeight > 0 ? undefined : '100%' }}>
          {model.blocks.slice(visible.startIndex, visible.endIndex).map((block, index) => {
            const globalIndex = visible.startIndex + index
            const isFootnoteDefinition = block.type === 'footnoteDefinition'
            const footnoteContext = footnoteDefinitionSource
              ? `${footnoteDefinitionSource}\n\n<!-- guanmo-footnote-context -->`
              : ''
            return (
              <StableMarkdownBlock
                key={block.blockId}
                block={block}
                globalIndex={globalIndex}
                top={visible.blockTops[globalIndex]}
                onElement={setBlockElement}
                readingMarkRanges={readingMarkHitRangesByBlock.get(block.blockId)}
                baseLine={block.startLine - 1}
                renderFootnoteSection={false}
                footnoteReferenceSuffix={`block-${globalIndex}`}
                markdown={`${isFootnoteDefinition ? '' : normalizedContent.slice(block.normalizedStartOffset, block.normalizedEndOffset)}${referenceDefinitionSource ? `\n\n${referenceDefinitionSource}` : ''}${footnoteContext ? `\n\n${footnoteContext}` : ''}`}
                skipHtml={skipHtml || (hasEmbeddedHtml && !htmlRehypePlugins)}
                rehypePlugins={rehypePlugins}
                components={components}
              />
            )
          })}
        </div>
      )}
      {!requiresWholeDocumentRender && standaloneFootnoteMarkdown && (
        <div className="gm-footnote-section" data-md-footnote-section>
          <StableMarkdownContent
            baseLine={0}
            renderFootnoteSection={true}
            footnoteReferenceSuffix="footnote-section"
            markdown={standaloneFootnoteMarkdown}
            skipHtml={skipHtml || (hasEmbeddedHtml && !htmlRehypePlugins)}
            rehypePlugins={rehypePlugins}
            components={components}
          />
        </div>
      )}
      {pendingSelectionUi && filePath && onCreateReadingMark && (
        <ReadingMarkToolbarShell
          anchor={pendingSelectionUi.anchorRect}
          variant="create"
          mode={pendingSelectionUi.mode}
          expanded={pendingSelectionUi.expanded}
          layoutDeleteConfirm={Boolean(pendingSelectionUi.conflict && pendingSelectionUi.expanded)}
          className={pendingSelectionUi.conflict ? 'is-conflict' : undefined}
          expandOnHover
          onExpandedChange={(expanded) => updatePendingSelection((state) => ({ ...state, expanded }))}
          onReducedMotionChange={(reducedMotion) => { readingMarkReducedMotionRef.current = reducedMotion }}
          renderContent={({ textContentMotion, colorContentMotion, triggerMotion, actionsMotion }) => pendingSelectionUi.conflict ? (
            <motion.div
              className="gm-reading-mark-toolbar-view"
              {...colorContentMotion}
            >
              <motion.button
                type="button"
                className="gm-reading-mark-toolbar-trigger"
                {...triggerMotion}
                style={{ color: 'var(--gm-primary)' }}
                title="添加批注"
                aria-label="添加批注"
                aria-expanded={pendingSelectionUi.expanded}
                aria-hidden={pendingSelectionUi.expanded}
                tabIndex={pendingSelectionUi.expanded ? -1 : 0}
                onClick={() => updatePendingSelection((state) => ({ ...state, expanded: !state.expanded }))}
              >
                <Highlighter aria-hidden="true" size={16} strokeWidth={2} />
              </motion.button>
              <motion.div className={`gm-reading-mark-toolbar-actions ${pendingSelectionUi.expanded ? 'is-expanded' : ''} is-conflict`} {...actionsMotion} aria-hidden={!pendingSelectionUi.expanded}>
                <div className="gm-reading-mark-conflict" role="alert">
                  <span>与已有标记重叠</span>
                  <button
                    type="button"
                    style={{ color: 'var(--gm-primary)' }}
                    tabIndex={pendingSelectionUi.expanded ? 0 : -1}
                    onClick={() => {
                      const conflict = pendingSelectionUi.conflict
                      if (!conflict) return
                      pendingSelectionRef.current = null
                      setPendingSelectionUi(null)
                      applySelection(null)
                      annotationOverlayRef?.current?.open(conflict.mark, pendingSelectionUi.anchorRect)
                    }}
                  >
                    查看已有标记
                  </button>
                </div>
              </motion.div>
            </motion.div>
          ) : (
            <ReadingMarkToolbarContent
              variant="create"
              mode={pendingSelectionUi.mode}
              expanded={pendingSelectionUi.expanded}
              color={pendingSelectionUi.color}
              textDraft={pendingSelectionUi.textDraft}
              saving={pendingSelectionUi.creatingText || pendingSelectionUi.savingText}
              deleteConfirm={false}
              hasNote={false}
              textInputRef={textInputRef}
              colorActionRef={colorActionRef}
              textContentMotion={textContentMotion}
              colorContentMotion={colorContentMotion}
              triggerMotion={triggerMotion}
              actionsMotion={actionsMotion}
              onTriggerClick={() => updatePendingSelection((state) => ({ ...state, expanded: !state.expanded }))}
              onEnterText={enterTextMode}
              onReturnToColors={returnToColorMode}
              onSubmitText={() => void submitText()}
              onTextChange={(value) => updatePendingSelection((state) => ({ ...state, textDraft: value }))}
              onSelectColor={(color) => {
                if (pendingSelectionRef.current?.mode === 'text') {
                  updatePendingSelection((state) => ({ ...state, color }))
                } else {
                  void createMarkFromSelection(color)
                }
              }}
              onDelete={() => undefined}
              onConfirmDelete={() => undefined}
              onCancelDelete={() => undefined}
            />
          )}
        />
      )}
      {activeEdit && overlayRect && (
        <div
          ref={overlayRef}
          className="gm-inline-edit-overlay"
          style={{
            position: 'absolute',
            top: overlayRect.top - 12,
            left: overlayRect.left,
            width: overlayRect.width,
            zIndex: 10,
          }}
        >
          <Suspense fallback={<InlineMarkdownEditorSuspenseFallback />}>
            <LazyInlineMarkdownBlockEditor
              block={activeEdit.block}
              initialCursor={activeEdit.initialCursor}
              fontSize={fontSize}
              lineHeight={lineHeight}
              fontFamily={fontFamily}
              wordWrap={wordWrap}
              conflict={activeEdit.conflict}
              onDraftChange={(draft) => { draftRef.current = draft }}
              onSubmit={(draft) => {
                draftRef.current = draft
                return submitActiveEdit()
              }}
              onCopyDraft={(draft) => void navigator.clipboard.writeText(draft)}
            />
          </Suspense>
        </div>
      )}
      {zoomImage && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-8"
          onClick={() => setZoomImage(null)}
        >
          <button
            type="button"
            className="absolute right-5 top-5 flex h-9 w-9 items-center justify-center rounded-full bg-gm-surface text-gm-text shadow-lg"
            onClick={() => setZoomImage(null)}
            title="关闭"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
          <img
            src={zoomImage.src}
            alt={zoomImage.alt}
            referrerPolicy="no-referrer"
            loading="lazy"
            decoding="async"
            className="max-h-full max-w-full rounded-xl bg-gm-surface object-contain shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          />
        </div>
      )}
    </div>
  )
}))

function handleHeadingClick(line: number | undefined, onHeadingClick?: (line: number) => void) {
  if (!onHeadingClick || typeof line !== 'number') return
  onHeadingClick(line)
}

function estimatePreviewBlockHeight(block: PreviewBlock, fontSize: number, lineHeight: number): number {
  const baseLinePx = fontSize * lineHeight
  const lines = Math.max(1, block.endLine - block.startLine + 1)
  switch (block.type) {
    case 'frontmatter':
      return Math.max(48, lines * baseLinePx * 1.15 + 12)
    case 'thematicBreak':
      return 32
    case 'heading': {
      const level = block.heading?.level ?? 2
      const multiplier = level === 1 ? 2 : level === 2 ? 1.6 : level === 3 ? 1.35 : 1.2
      return Math.ceil(baseLinePx * multiplier * 1.4)
    }
    case 'code':
    case 'mermaid': {
      const codeLines = block.codeMeta?.lines ?? lines
      return Math.max(40, codeLines * fontSize * 1.25 + 36)
    }
    case 'echarts':
      return 392
    case 'table': {
      const rows = block.tableMeta?.rows ?? lines
      return Math.max(48, rows * (baseLinePx + 8) + 32)
    }
    case 'list': {
      const items = block.listItemCount ?? Math.max(1, Math.ceil(lines / 2))
      return Math.max(24, items * baseLinePx * 1.2)
    }
    case 'image':
      return 220
    case 'math':
      return Math.max(48, lines * baseLinePx * 1.3 + 24)
    case 'html':
      return Math.max(32, lines * baseLinePx * 1.5)
    case 'definition':
    case 'footnoteDefinition':
      return Math.max(24, lines * baseLinePx * 1.1 + 8)
    case 'blockquote':
    case 'paragraph':
    case 'unknown':
    default:
      return Math.max(20, lines * baseLinePx * 1.15 + 12)
  }
}

function getMountedPreviewLineForTop(
  model: ReturnType<typeof createMarkdownPreviewModel>,
  root: HTMLElement | null,
  container: HTMLElement,
  top: number,
): number | undefined {
  if (!root) return undefined
  const targetViewportTop = container.getBoundingClientRect().top + top - container.scrollTop
  for (const element of root.querySelectorAll<HTMLElement>('[data-md-block-index]')) {
    const index = Number(element.dataset.mdBlockIndex)
    if (!Number.isInteger(index)) continue
    const block = model.blocks[index]
    if (!block) continue
    const rect = element.getBoundingClientRect()
    if (rect.height <= 0) continue
    if (targetViewportTop > rect.bottom) continue
    if (targetViewportTop <= rect.top) return block.startLine
    if (block.endLine <= block.startLine) return block.startLine
    const progress = Math.max(0, Math.min(1, (targetViewportTop - rect.top) / rect.height))
    return Math.round(block.startLine + (block.endLine - block.startLine) * progress)
  }
  return undefined
}

function getMountedSourceRangeTop(
  element: HTMLElement,
  container: HTMLElement,
  from: number,
  to: number,
): number | undefined {
  const ranges = buildDomRangesForSourceRange(element, from, to)
  for (const range of ranges) {
    const rangeWithGeometry = range as globalThis.Range & {
      getClientRects?: () => DOMRectList
      getBoundingClientRect?: () => DOMRect
    }
    const rects = rangeWithGeometry.getClientRects?.() ?? []
    const rect = rects.length > 0 ? rects[0] : rangeWithGeometry.getBoundingClientRect?.()
    if (!rect) continue
    if (rect.width <= 0 && rect.height <= 0) continue
    return rect.top - container.getBoundingClientRect().top + container.scrollTop
  }
  return undefined
}

function CodeBlock({
  code,
  language,
  fontSize,
  startLine,
  endLine,
  children,
}: {
  code: string
  language?: string
  fontSize: number
  startLine?: number
  endLine?: number
  children: React.ReactNode
}) {
  const [copied, setCopied] = useState(false)

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1200)
    } catch {
      setCopied(false)
    }
  }

  return (
    <div className="group gm-code-block relative my-4 rounded-xl border border-gm-border overflow-hidden" data-md-line={startLine} data-md-end-line={endLine}>
      <button
        type="button"
        onClick={() => void handleCopy()}
        className="absolute right-2 top-2 z-10 flex h-7 min-w-7 items-center justify-center rounded-md border border-gm-border bg-gm-surface/90 px-2 text-micro text-gm-text-tertiary opacity-0 shadow-sm transition-opacity hover:text-gm-primary group-hover:opacity-100 focus-visible:opacity-100"
        title={language ? `复制 ${language} 代码` : '复制代码'}
      >
        {copied ? '已复制' : (
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
            <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
          </svg>
        )}
      </button>
      <div style={{ fontSize }}>
        {children}
      </div>
    </div>
  )
}

function resolveImageSrc(src: string | undefined, filePath?: string | null): string {
  if (!src) return ''
  if (/^(https?:|data:|blob:|asset:|file:)/i.test(src) || src.startsWith('#')) return src
  if (!filePath || !isTauri()) return src

  const normalizedSrc = decodeLocalImagePath(src).replace(/\\/g, '/')
  const absolutePath = /^[a-zA-Z]:\//.test(normalizedSrc) || normalizedSrc.startsWith('//')
    ? normalizedSrc
    : joinPreviewPath(dirnamePreviewPath(filePath), normalizedSrc)
  return convertFileSrc(absolutePath)
}

function decodeLocalImagePath(path: string): string {
  try {
    return decodeURI(path)
  } catch {
    return path
  }
}

function dirnamePreviewPath(path: string): string {
  const normalized = path.replace(/\\/g, '/')
  const index = normalized.lastIndexOf('/')
  return index >= 0 ? normalized.slice(0, index) : normalized
}

function joinPreviewPath(baseDir: string, relativePath: string): string {
  const cleanRelative = relativePath.replace(/^\.\//, '')
  return `${baseDir.replace(/\/$/, '')}/${cleanRelative}`
}

function getText(node: React.ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(getText).join('')
  if (isValidElement<{ children?: React.ReactNode }>(node)) return getText(node.props.children)
  return ''
}

function getNodeStartLine(node: unknown, base = 0): number | undefined {
  return getNodeLine(node, 'start', base)
}

function getNodeEndLine(node: unknown, base = 0): number | undefined {
  return getNodeLine(node, 'end', base)
}

function getNodeLine(node: unknown, edge: 'start' | 'end', base = 0): number | undefined {
  if (!node || typeof node !== 'object') return undefined
  const position = (node as { position?: { start?: { line?: unknown }; end?: { line?: unknown } } }).position
  const line = position?.[edge]?.line
  return typeof line === 'number' && Number.isFinite(line) ? line + base : undefined
}

interface HastNode {
  type: string
  tagName?: string
  properties?: Record<string, unknown>
  children?: HastNode[]
  position?: {
    start?: { line?: number }
    end?: { line?: number }
  }
}

function createMarkdownBlockWrapperPlugin(blocks: PreviewBlock[]) {
  return () => (tree: HastNode) => {
    if (!tree.children) return
    const output: HastNode[] = []
    let currentIndex: number | null = null
    let currentChildren: HastNode[] = []
    let blockCursor = 0

    const flush = () => {
      if (currentIndex === null || currentChildren.length === 0) return
      const block = blocks[currentIndex]
      output.push({
        type: 'element',
        tagName: 'div',
        properties: {
          className: ['gm-markdown-block'],
          dataMdBlockIndex: currentIndex,
          dataMdBlockKey: block.blockId,
          dataMdBlockType: block.type,
          dataMdLine: block.startLine,
          dataMdEndLine: block.endLine,
        },
        children: currentChildren,
      })
      currentIndex = null
      currentChildren = []
    }

    for (const child of tree.children) {
      const startLine = child.position?.start?.line
      const endLine = child.position?.end?.line
      while (
        typeof startLine === 'number'
        && blockCursor < blocks.length
        && blocks[blockCursor].endLine < startLine
      ) blockCursor += 1
      const candidate = blocks[blockCursor]
      const index = candidate
        && typeof startLine === 'number'
        && typeof endLine === 'number'
        && startLine >= candidate.startLine
        && endLine <= candidate.endLine
        ? blockCursor
        : null
      if (index === null) {
        if (currentIndex !== null && typeof startLine !== 'number' && typeof endLine !== 'number') {
          currentChildren.push(child)
          continue
        }
        flush()
        output.push(child)
        continue
      }
      if (currentIndex !== null && currentIndex !== index) flush()
      currentIndex = index
      currentChildren.push(child)
    }
    flush()
    tree.children = output
  }
}

function getBlockOffsetForLine(block: PreviewBlock, clickedLine: number): number {
  if (clickedLine < block.startLine || clickedLine > block.endLine) return block.rawSource.length
  const localLine = clickedLine - block.startLine
  let offset = 0
  for (let index = 0; index < localLine; index += 1) {
    const match = /\r\n|\r|\n/.exec(block.rawSource.slice(offset))
    if (!match) return block.rawSource.length
    offset += match.index + match[0].length
  }
  return offset
}

function MermaidBlock({ code, startLine, endLine }: { code: string; startLine?: number; endLine?: number }) {
  const [svg, setSvg] = useState('')
  const [error, setError] = useState<string | null>(null)
  const themeId = useSettingsStore((state) => state.appearance.themeId)

  useEffect(() => {
    let cancelled = false
    async function render() {
      try {
        const mermaid = (await import('mermaid')).default
        const styles = getComputedStyle(document.documentElement)
        const token = (name: string) => styles.getPropertyValue(name).trim()
        mermaid.initialize({
          startOnLoad: false,
          theme: 'base',
          securityLevel: 'strict',
          themeVariables: {
            background: token('--gm-surface'),
            primaryColor: token('--gm-surface-overlay'),
            primaryTextColor: token('--gm-text'),
            primaryBorderColor: token('--gm-border-hover'),
            secondaryColor: token('--gm-primary-subtle'),
            secondaryTextColor: token('--gm-text'),
            secondaryBorderColor: token('--gm-primary'),
            tertiaryColor: token('--gm-surface-elevated'),
            tertiaryTextColor: token('--gm-text'),
            tertiaryBorderColor: token('--gm-border'),
            lineColor: token('--gm-text-secondary'),
            textColor: token('--gm-text'),
            edgeLabelBackground: token('--gm-surface'),
          },
        })
        const id = `mermaid-${Date.now()}-${Math.random().toString(36).slice(2)}`
        const result = await mermaid.render(id, code)
        if (!cancelled) {
          setSvg(result.svg)
          setError(null)
        }
      } catch (err) {
        if (!cancelled) {
          setSvg('')
          setError(err instanceof Error ? err.message : String(err))
        }
      }
    }
    render()
    return () => { cancelled = true }
  }, [code, themeId])

  if (error) {
    return (
      <div className="my-4 rounded-xl border border-gm-error/30 bg-gm-error/5 p-3" data-md-line={startLine} data-md-end-line={endLine}>
        <div className="mb-2 text-caption font-bold text-gm-error">Mermaid 渲染失败</div>
        <pre className="overflow-x-auto text-gm-text-secondary" style={{ fontSize: '0.85em' }}>{code}</pre>
      </div>
    )
  }

  return (
    <div className="my-4 overflow-x-auto rounded-xl border border-gm-border bg-gm-surface-elevated p-4" data-md-line={startLine} data-md-end-line={endLine}>
      {svg ? (
        <div className="mermaid-diagram" dangerouslySetInnerHTML={{ __html: svg }} />
      ) : (
        <div className="text-caption text-gm-text-tertiary">正在渲染 Mermaid...</div>
      )}
    </div>
  )
}
