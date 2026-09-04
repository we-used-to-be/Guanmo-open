import type { MarkdownPreviewModel, PreviewBlock } from '@/services/markdownPreviewModel'
import type { DocumentRange } from '@/services/previewHighlight'
import type { CreateReadingMarkResult, ReadingMark, ReadingMarkColor, UpdateReadingMarkPatch } from '@/services/readingMarks'
import type { RefObject } from 'react'
import type { AnnotationHoverOverlayHandle } from './AnnotationHoverOverlay'

export interface MarkdownBlockCommitRequest {
  block: PreviewBlock
  draft: string
  documentKey: string
  documentVersion: number | string
}

export type MarkdownBlockCommitResult =
  | { status: 'applied'; content?: string }
  | { status: 'conflict'; currentSource: string }

/** 预览全文搜索状态：SearchOverlay 通过模型驱动各实例的高亮与 active 项 */
export interface PreviewSearchState {
  query: string
  /** 当前 active 匹配的全局源码 offset（起点） */
  activeOffset?: number
}

/** 统一 Range 选区快照：供右键菜单、复制、AI 上下文等消费 */
export interface PreviewSelectionSnapshot {
  range: DocumentRange
  from: number
  to: number
  text: string
  startLine: number
  endLine: number
}

export interface MarkdownPreviewSourceRevealRequest {
  documentKey: string
  documentVersion?: number | string
  startLine: number
  endLine?: number
  onApplied?: () => void
}

export interface MarkdownPreviewHandle {
  scrollToLine: (line: number) => void
  revealSourceLines: (request: MarkdownPreviewSourceRevealRequest) => boolean
  scrollToOffset: (offset: number) => void
  getTopForLine: (line: number) => number | undefined
  getLineForTop: (top: number) => number | undefined
  /** 当前视口顶部对应的源码 offset（供搜索锚点定位最近匹配）；无容器/未挂载时返回 undefined */
  getViewportOffset: () => number | undefined
  setSearchState: (state: PreviewSearchState | null) => void
  /** 基于可见文本投影搜索全文，返回源码 offset 匹配（供 SearchOverlay 统一计数语义） */
  searchVisible: (query: string) => Array<{ from: number; to: number }>
  getSelection: () => PreviewSelectionSnapshot | null
  selectAll: () => void
  clearSelection: () => void
  navigateToReadingMark: (markId: string) => boolean
}

export interface MarkdownPreviewProps {
  content: string
  filePath?: string | null
  fontSize?: number
  lineHeight?: number
  fontFamily?: string
  wordWrap?: boolean
  skipHtml?: boolean
  documentKey?: string
  documentVersion?: number | string
  inlineEditEnabled?: boolean
  onBlockCommit?: (request: MarkdownBlockCommitRequest) => Promise<MarkdownBlockCommitResult> | MarkdownBlockCommitResult
  onTaskToggle?: (line: number, checked: boolean) => void
  onHeadingClick?: (line: number) => void
  onDraftStateChange?: (hasDraft: boolean) => void
  /** 父级预览 surface 是否已真实可见；隐藏预热实例必须传 false。 */
  isVisible?: boolean
  onFirstVisible?: () => void
  onRenderComplete?: () => void
  resource?: 'preview' | 'left-preview' | 'right-preview'
  readingMarks?: ReadingMark[]
  onCreateReadingMark?: (selection: PreviewSelectionSnapshot, color: ReadingMarkColor, note: string | undefined, model: MarkdownPreviewModel) => Promise<CreateReadingMarkResult>
  onUpdateReadingMark?: (id: string, patch: UpdateReadingMarkPatch) => Promise<ReadingMark>
  onDeleteReadingMark?: (id: string) => Promise<void>
  annotationOverlayRef?: RefObject<AnnotationHoverOverlayHandle | null>
}
