import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { EditorView } from '@codemirror/view'
import { useAppStore } from '@/stores/appStore'
import { useEditorStore } from '@/stores/editorStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { AiShortcutMenuItems } from './AiShortcutMenuItems'
import { useFileOperations } from '@/hooks/useFileOperations'
import { useActiveHeading, type ActiveHeadingGeometry } from '@/hooks/useActiveHeading'
import { saveFile, saveFileAs } from '@/services/fileSystem'
import { scheduleMarkdownDocumentIndex } from '@/services/rag/indexer'
import { extractToc, type TocItem } from '@/services/markdownToc'
import { toggleMarkdownTaskAtLine } from '@/services/markdownTasks'
import { saveExternalImageForMarkdown, saveImageFileForMarkdown } from '@/services/markdownImages'
import { toast } from '@/services/toast'
import { describeFileOperationError } from '@/services/fileOperationErrors'
import { openFileDialog } from '@/hooks/useTauri'
import { eventMarker } from '@/services/eventMarker'
import { markStartupPoint } from '@/services/startupPerformance'
import { hasBootSnapshotContent } from '@/services/bootSnapshot'
import { OPEN_EDITOR_SEARCH_EVENT } from '@/services/editorEvents'
import { startHeadingScroll } from '@/services/headingScroll'
import { EditorContextMenu } from './EditorContextMenu'
import { MarkdownToc } from './MarkdownToc'
import type { MarkdownBlockCommitRequest, MarkdownPreviewHandle } from './markdownPreviewTypes'
import type { PreviewSelectionSnapshot } from './markdownPreviewTypes'
import { readingDocumentId, type ReadingMark, type ReadingMarkColor } from '@/services/readingMarks'
import { useReadingMarksStore } from '@/stores/readingMarksStore'
import { CodeMirrorEditor } from './CodeMirrorEditor'
import { SearchOverlay } from './SearchOverlay'
import { TabBar } from './TabBar'
import { useScheduledPreviewContent } from './useScheduledPreviewContent'
import { useEditorResourceLifecycle } from './useEditorResourceLifecycle'
import { getPreviewTopForLine, useReadingPositionBridge } from './useReadingPositionBridge'
import { usePreviewSelectionBridge } from './usePreviewSelectionBridge'
import { AnnotationHoverOverlay, type AnnotationHoverOverlayHandle } from './AnnotationHoverOverlay'
import { isSameFilePath } from '@/services/pathIdentity'
import { ContextMenu, ContextMenuGroupTitle, ContextMenuItem, ContextMenuSeparator } from '@/components/common/ContextMenu'
import { getRuntimeCapabilities } from '@/services/runtimeCapabilities'
import {
  ScrollSyncSession,
  mapPerformancePolicy,
  type PrewarmTargetMode,
} from '@/services/editorSession'

const LazyMarkdownPreview = lazy(() => import('./MarkdownPreview').then(({ MarkdownPreview }) => ({ default: MarkdownPreview })))
const LazyMarkdownDiffView = lazy(() => import('./MarkdownDiffView').then(({ MarkdownDiffView }) => ({ default: MarkdownDiffView })))

function PreviewSuspenseFallback() {
  return <div className="h-full min-h-0 w-full bg-gm-surface" aria-hidden="true" />
}

/** 编辑器被动平滑跟随状态（预览滚动驱动编辑器）。独立于源端 scroll 事件节流 ref。 */
interface EditorScrollFollowerState {
  frameId: number | null
  active: boolean
  /** 同步 effect 生命周期代数：effect 重挂载 / cleanup 后旧帧在下一帧自杀 */
  generation: number
  view: EditorView | null
  /** 目标行起始 offset：每帧动态读取 lineBlockAt(pos).top，避免固化估算高度 */
  pos: number | null
  /** 上一次实际写入后读回的 scrollTop（兼容浏览器夹取与像素舍入） */
  lastWrite: number | null
  lastTime: number | null
  lastTarget: number | null
  stableFrames: number
}

/** 预览被动平滑跟随状态（编辑器滚动驱动预览）。 */
interface PreviewScrollFollowerState {
  frameId: number | null
  active: boolean
  generation: number
  container: HTMLElement | null
  /** 静态目标：每次同步事件只更新目标，不重启动画 */
  target: number | null
  lastWrite: number | null
  lastTime: number | null
  lastTarget: number | null
  stableFrames: number
}

const DROP_IMAGES_EVENT = 'guanmo:drop-image-paths'
const SCROLL_SYNC_TOP_OFFSET = 32
const SCROLL_SYNC_INPUT_PAUSE_MS = 700
/** 预览→编辑器反向滚动同步只接受“用户主动滚动预览”产生的 scroll 事件；
 *  渲染补偿（内容更新锚点补偿、scrollTop 夹取、位置恢复、异步图片/KaTeX 高度变化）
 *  产生的 scroll 事件一律不得反向移动编辑器。该窗口覆盖滚轮惯性滚动与平滑滚动时长。 */
const PREVIEW_SYNC_GESTURE_WINDOW_MS = 800
/** 同步滚动平滑跟随时间常数：每帧按 1 - exp(-dt / τ) 向目标插值 */
const SCROLL_SYNC_FOLLOW_TAU_MS = 80
/** 单帧 dt 上限：窗口后台恢复后避免单帧跨越 */
const SCROLL_SYNC_FOLLOW_MAX_DT_MS = 40
/** 收敛阈值：实际 scrollTop 与目标误差小于该值视为已收敛 */
const SCROLL_SYNC_FOLLOW_EPSILON_PX = 0.5
/** 目标连续稳定帧数要求：动态测量刚变化时不提前退出 */
const SCROLL_SYNC_FOLLOW_STABLE_FRAMES = 2
/** 实际 scrollTop 与上一次写入值偏差超过该值视为外部修改（渲染补偿 / CodeMirror 测量校正） */
const SCROLL_SYNC_EXTERNAL_DRIFT_PX = 1
const PREVIEW_SWITCH_MARK_PREFIX = 'guanmo:preview-switch'
const EMPTY_READING_MARKS: ReadingMark[] = []

export function EditorArea() {
  const tabs = useEditorStore((s) => s.tabs)
  const activeTabId = useEditorStore((s) => s.activeTabId)
  const updateTabContent = useEditorStore((s) => s.updateTabContent)
  const viewMode = useEditorStore((s) => s.viewMode)
  const setViewMode = useEditorStore((s) => s.setViewMode)
  const rightPaneTabId = useEditorStore((s) => s.rightPaneTabId)
  const rightPaneUserSelected = useEditorStore((s) => s.rightPaneUserSelected)
  const setRightPaneTabId = useEditorStore((s) => s.setRightPaneTabId)
  const previewSwitchingTabId = useEditorStore((s) => s.previewSwitchingTabId)
  const clearPreviewSwitching = useEditorStore((s) => s.clearPreviewSwitching)
  const pendingReveal = useEditorStore((s) => s.pendingReveal)
  const clearPendingReveal = useEditorStore((s) => s.clearPendingReveal)
  const flushReadingPositions = useEditorStore((s) => s.flushReadingPositions)
  const editorFontSize = useSettingsStore((s) => s.editor.fontSize)
  const editorLineHeight = useSettingsStore((s) => s.editor.lineHeight)
  const editorFontFamily = useSettingsStore((s) => s.editor.fontFamily)
  const editorWordWrap = useSettingsStore((s) => s.editor.wordWrap)
  const editorLineNumbers = useSettingsStore((s) => s.editor.lineNumbers)
  const syncScroll = useSettingsStore((s) => s.editor.syncScroll)
  const inlinePreviewEdit = useSettingsStore((s) => s.editor.inlinePreviewEdit)
  const modePerformancePolicy = useSettingsStore((s) => s.editor.modePerformancePolicy)
  const { prewarm: modePrewarm, resource: modeResourcePolicy } = useMemo(
    () => mapPerformancePolicy(modePerformancePolicy),
    [modePerformancePolicy],
  )
  const fullscreenContentPadding = useSettingsStore((s) => s.editor.fullscreenContentPadding)
  const viewModeUsage = useEditorStore((s) => s.viewModeUsage)
  const isFullscreen = useAppStore((s) => s.isFullscreen)
  const editorViewRef = useRef<EditorView | null>(null)
  const leftPreviewRef = useRef<HTMLDivElement>(null)
  const rightPreviewRef = useRef<HTMLDivElement>(null)
  const leftMarkdownPreviewRef = useRef<MarkdownPreviewHandle>(null)
  const rightMarkdownPreviewRef = useRef<MarkdownPreviewHandle>(null)
  const annotationOverlayRef = useRef<AnnotationHoverOverlayHandle>(null)
  const restoredPreviewKeysRef = useRef<{ left: string | null; right: string | null }>({ left: null, right: null })

  const scrollSyncSessionRef = useRef(new ScrollSyncSession())
  const editorScrollFrameRef = useRef<number | null>(null)
  const editorHeadingJumpCancelRef = useRef<(() => void) | null>(null)
  const previewScrollFrameRef = useRef<number | null>(null)
  const lastEditorInputAtRef = useRef(0)
  /** 预览 pane 上最近一次用户滚动手势（wheel / pointerdown）时间戳 */
  const previewGestureAtRef = useRef(0)
  /** 指针当前是否按在预览 pane 上（覆盖滚动条拖拽、触控拖拽的长时滚动） */
  const previewPointerDownRef = useRef(false)
  /** 同步滚动 follower 生命周期代数（独立于源端 scroll 节流的 editorScrollFrameRef / previewScrollFrameRef） */
  const scrollFollowerGenerationRef = useRef(0)
  const editorFollowerRef = useRef<EditorScrollFollowerState>({
    frameId: null,
    active: false,
    generation: 0,
    view: null,
    pos: null,
    lastWrite: null,
    lastTime: null,
    lastTarget: null,
    stableFrames: 0,
  })
  const previewFollowerRef = useRef<PreviewScrollFollowerState>({
    frameId: null,
    active: false,
    generation: 0,
    container: null,
    target: null,
    lastWrite: null,
    lastTime: null,
    lastTarget: null,
    stableFrames: 0,
  })
  const [, setPreviewRestoreTick] = useState(0)
  const [searchOpen, setSearchOpen] = useState(false)
  const [rightPaneDragOver, setRightPaneDragOver] = useState(false)
  const [tocCollapsed, setTocCollapsed] = useState(false)
  const [activeEditorHeading, setActiveEditorHeading] = useState<string | null>(null)
  const [tocFocus, setTocFocus] = useState<'editor' | 'preview'>('editor')
  const [activeDocumentFirstScreenReady, setActiveDocumentFirstScreenReady] = useState(false)
  const activeDocumentFirstScreenReadyRef = useRef(false)
  const firstScreenDocumentIdRef = useRef<string | null>(activeTabId)

  useEffect(() => {
    if (isFullscreen) setTocCollapsed(true)
  }, [isFullscreen])

  const activeTab = tabs.find((t) => t.id === activeTabId)
  const selectedRightTab = rightPaneTabId ? tabs.find((t) => t.id === rightPaneTabId) : null
  const dualRightTab = !rightPaneUserSelected
    ? activeTab
    : selectedRightTab
  const retainedRightTabRef = useRef<(typeof tabs)[number] | null>(null)
  const leftPreviewDraftRef = useRef(false)
  const rightPreviewDraftRef = useRef(false)
  if (viewMode === 'dual-preview') {
    if (!rightPreviewDraftRef.current || retainedRightTabRef.current?.id === dualRightTab?.id) {
      retainedRightTabRef.current = dualRightTab ?? null
    }
  }
  const rightTab = retainedRightTabRef.current
  const activeReadingMarks = useReadingMarksStore((state) => activeTab?.filePath ? state.byDocumentId[readingDocumentId(activeTab.filePath)] ?? EMPTY_READING_MARKS : EMPTY_READING_MARKS)
  const rightReadingMarks = useReadingMarksStore((state) => rightTab?.filePath ? state.byDocumentId[readingDocumentId(rightTab.filePath)] ?? EMPTY_READING_MARKS : EMPTY_READING_MARKS)
  const loadReadingMarksForDocument = useReadingMarksStore((state) => state.load)
  const createReadingMarkInStore = useReadingMarksStore((state) => state.create)
  const updateReadingMarkInStore = useReadingMarksStore((state) => state.update)
  const removeReadingMarkInStore = useReadingMarksStore((state) => state.remove)
  const pendingMarkNavigation = useReadingMarksStore((state) => state.pendingNavigation)
  const clearMarkNavigation = useReadingMarksStore((state) => state.clearNavigation)
  const readingMarksEnabled = getRuntimeCapabilities().database
  const leftPreviewVisible = viewMode === 'preview' || viewMode === 'edit-preview' || viewMode === 'dual-preview'
  const editorVisible = viewMode === 'edit' || viewMode === 'edit-preview'
  const previewContentReady = Boolean(activeTab && (
    !activeTab.filePath || activeTab.modified || activeTab.content.length > 0 || hasBootSnapshotContent(activeTab)
  ))

  useEffect(() => {
    if (!readingMarksEnabled || !leftPreviewVisible || !activeTab?.filePath) return
    void loadReadingMarksForDocument(activeTab.filePath)
  }, [activeTab?.filePath, leftPreviewVisible, loadReadingMarksForDocument, readingMarksEnabled])

  useEffect(() => {
    if (!readingMarksEnabled || viewMode !== 'dual-preview' || !rightTab?.filePath) return
    void loadReadingMarksForDocument(rightTab.filePath)
  }, [loadReadingMarksForDocument, readingMarksEnabled, rightTab?.filePath, viewMode])

  const handleCreateReadingMark = useCallback(async (selection: PreviewSelectionSnapshot, color: ReadingMarkColor, note: string | undefined, model: import('@/services/markdownPreviewModel').MarkdownPreviewModel) => {
    if (!activeTab?.filePath) throw new Error('批注仅支持已保存的 Markdown 文件')
    return createReadingMarkInStore({ documentPath: activeTab.filePath, selection, color, note }, model)
  }, [activeTab?.filePath, createReadingMarkInStore])

  const handleUpdateReadingMark = useCallback((id: string, patch: import('@/services/readingMarks').UpdateReadingMarkPatch) => {
    if (!activeTab?.filePath) return Promise.reject(new Error('文档路径不存在'))
    return updateReadingMarkInStore(id, activeTab.filePath, patch)
  }, [activeTab?.filePath, updateReadingMarkInStore])

  const handleDeleteReadingMark = useCallback((id: string) => {
    if (!activeTab?.filePath) return Promise.reject(new Error('文档路径不存在'))
    return removeReadingMarkInStore(id, activeTab.filePath)
  }, [activeTab?.filePath, removeReadingMarkInStore])

  const handleCreateRightReadingMark = useCallback(async (selection: PreviewSelectionSnapshot, color: ReadingMarkColor, note: string | undefined, model: import('@/services/markdownPreviewModel').MarkdownPreviewModel) => {
    if (!rightTab?.filePath) throw new Error('批注仅支持已保存的 Markdown 文件')
    return createReadingMarkInStore({ documentPath: rightTab.filePath, selection, color, note }, model)
  }, [createReadingMarkInStore, rightTab?.filePath])
  const handleUpdateRightReadingMark = useCallback((id: string, patch: import('@/services/readingMarks').UpdateReadingMarkPatch) => {
    if (!rightTab?.filePath) return Promise.reject(new Error('文档路径不存在'))
    return updateReadingMarkInStore(id, rightTab.filePath, patch)
  }, [rightTab?.filePath, updateReadingMarkInStore])
  const handleDeleteRightReadingMark = useCallback((id: string) => {
    if (!rightTab?.filePath) return Promise.reject(new Error('文档路径不存在'))
    return removeReadingMarkInStore(id, rightTab.filePath)
  }, [removeReadingMarkInStore, rightTab?.filePath])

  const handleOverlayUpdate = useCallback((mark: ReadingMark, patch: import('@/services/readingMarks').UpdateReadingMarkPatch) => (
    updateReadingMarkInStore(mark.id, mark.documentPath, patch)
  ), [updateReadingMarkInStore])
  const handleOverlayDelete = useCallback((mark: ReadingMark) => (
    removeReadingMarkInStore(mark.id, mark.documentPath)
  ), [removeReadingMarkInStore])

  const [leftPreviewMounted, setLeftPreviewMounted] = useState(false)
  const [rightPreviewMounted, setRightPreviewMounted] = useState(false)
  const [editorMounted, setEditorMounted] = useState(false)
  const [diffMounted, setDiffMounted] = useState(false)
  const [draftDecisionVersion, setDraftDecisionVersion] = useState(0)
  const viewModeRef = useRef(viewMode)
  viewModeRef.current = viewMode
  const activeTabIdRef = useRef(activeTabId)
  activeTabIdRef.current = activeTabId

  const handlePreviewDraftStateChange = useCallback((pane: 'left' | 'right', hasDraft: boolean) => {
    const draftRef = pane === 'left' ? leftPreviewDraftRef : rightPreviewDraftRef
    draftRef.current = hasDraft
    if (hasDraft) {
      if (pane === 'right') {
        retainedRightTabRef.current = !useEditorStore.getState().rightPaneUserSelected
          ? useEditorStore.getState().tabs.find((tab) => tab.id === activeTabIdRef.current) ?? null
          : useEditorStore.getState().tabs.find((tab) => tab.id === useEditorStore.getState().rightPaneTabId) ?? null
      }
    } else {
      if (pane === 'right' && viewModeRef.current === 'dual-preview') {
        retainedRightTabRef.current = !useEditorStore.getState().rightPaneUserSelected
          ? useEditorStore.getState().tabs.find((tab) => tab.id === activeTabIdRef.current) ?? null
          : useEditorStore.getState().tabs.find((tab) => tab.id === useEditorStore.getState().rightPaneTabId) ?? null
      }
      setDraftDecisionVersion((version) => version + 1)
    }
  }, [])

  const handleLeftDraftStateChange = useCallback(
    (hasDraft: boolean) => handlePreviewDraftStateChange('left', hasDraft),
    [handlePreviewDraftStateChange],
  )
  const handleRightDraftStateChange = useCallback(
    (hasDraft: boolean) => handlePreviewDraftStateChange('right', hasDraft),
    [handlePreviewDraftStateChange],
  )

  // Emit first-visible events after DOM commit (requestAnimationFrame)
  const editorBecameVisibleRef = useRef(false)
  const markActiveDocumentFirstScreenReady = useCallback((documentId: string) => {
    if (activeTabIdRef.current !== documentId) return false
    if (firstScreenDocumentIdRef.current !== documentId) {
      firstScreenDocumentIdRef.current = documentId
      activeDocumentFirstScreenReadyRef.current = false
    }
    if (activeDocumentFirstScreenReadyRef.current) return true
    activeDocumentFirstScreenReadyRef.current = true
    setActiveDocumentFirstScreenReady(true)
    return true
  }, [])

  useEffect(() => {
    if (firstScreenDocumentIdRef.current === activeTabId) return
    firstScreenDocumentIdRef.current = activeTabId
    activeDocumentFirstScreenReadyRef.current = false
    editorBecameVisibleRef.current = false
    setActiveDocumentFirstScreenReady(false)
  }, [activeTabId])

  useEffect(() => {
    const contentReady = activeTab && (
      !activeTab.filePath || activeTab.modified || activeTab.content.length > 0 || hasBootSnapshotContent(activeTab)
    )
    if (editorVisible && editorMounted && !editorBecameVisibleRef.current && activeTab?.id && contentReady) {
      editorBecameVisibleRef.current = true
      const documentId = activeTab.id
      const raf = requestAnimationFrame(() => {
        if (!markActiveDocumentFirstScreenReady(documentId)) return
        markStartupPoint('active-document-first-visible', {
          surface: 'editor',
          charCount: activeTab.content.length,
        })
        markStartupPoint('editor-first-visible', {
          charCount: activeTab.content.length,
          mode: viewMode,
          policy: modePerformancePolicy,
        })
        if (import.meta.env.DEV) {
          eventMarker.mark('editor-first-visible', {
            charCount: activeTab.content.length,
            mode: viewMode,
            policy: modePerformancePolicy,
          })
        }
      })
      return () => cancelAnimationFrame(raf)
    }
    if (!editorVisible && !editorMounted) {
      editorBecameVisibleRef.current = false
    }
  }, [activeTab?.content.length, activeTab?.id, editorMounted, editorVisible, markActiveDocumentFirstScreenReady, modePerformancePolicy, viewMode])

  const leftPreviewWorkEnabled = leftPreviewVisible || leftPreviewMounted
  const rightPreviewWorkEnabled = viewMode === 'dual-preview' || rightPreviewMounted
  const activePreview = useScheduledPreviewContent(activeTab?.content || '', activeTab?.id, leftPreviewWorkEnabled)
  const rightPreview = useScheduledPreviewContent(rightTab?.content || '', rightTab?.id, rightPreviewWorkEnabled)
  const leftPreviewRenderRef = useRef({
    content: activePreview.content,
    filePath: activeTab?.filePath,
  })
  if (leftPreviewWorkEnabled) {
    leftPreviewRenderRef.current = {
      content: activePreview.content,
      filePath: activeTab?.filePath,
    }
  }

  useEffect(() => {
    if (!leftPreviewMounted && !leftPreviewVisible) {
      leftPreviewRenderRef.current = { content: '', filePath: undefined }
    }
  }, [leftPreviewMounted, leftPreviewVisible])

  // 编辑模式的 TOC 直接从编辑器内容提取：预览实例未挂载（预热失败或尚未预热）时
  // activePreview.content 为空，若统一走预览管道会导致编辑模式目录永不出现。
  const editorToc = useMemo(() => extractToc(activeTab?.content || ''), [activeTab?.content])
  const previewToc = useMemo(() => extractToc(activePreview.content), [activePreview.content])
  const toc = viewMode === 'edit' ? editorToc : previewToc
  const rightToc = useMemo(() => extractToc(rightPreview.content), [rightPreview.content])
  const modeDerivationsEnabled = viewMode !== 'edit'
  const activeContentSignature = useMemo(
    () => modeDerivationsEnabled ? getContentSignature(activePreview.content) : 'edit',
    [activePreview.content, modeDerivationsEnabled]
  )
  const activeOriginalSignature = useMemo(
    () => modeDerivationsEnabled ? getContentSignature(activeTab?.originalContent || '') : 'edit',
    [activeTab?.originalContent, modeDerivationsEnabled]
  )
  const activeDiffLineCount = useMemo(
    () => modeDerivationsEnabled ? Math.max(
      countMarkdownLines(activeTab?.originalContent || ''),
      countMarkdownLines(activePreview.content)
    ) : 1,
    [activePreview.content, activeTab?.originalContent, modeDerivationsEnabled]
  )

  const getModeRenderKey = useCallback((mode: PrewarmTargetMode) => {
    if (!activeTab?.id) return null
    const base = `${activeTab.id}:${activeContentSignature}`
    return mode === 'diff-preview'
      ? `${mode}:${base}:${activeOriginalSignature}`
      : `${mode}:${base}`
  }, [activeContentSignature, activeOriginalSignature, activeTab?.id])

  const warmScope = modeDerivationsEnabled && activeTab?.id
    ? `${activeTab.id}:${activeContentSignature}:${activeOriginalSignature}`
    : null

  useEditorResourceLifecycle({
    activeTab,
    activeTabId: activeTabId ?? null,
    dualRightTab,
    rightTab,
    viewMode,
    editorVisible,
    leftPreviewVisible,
    activeDocumentFirstScreenReady,
    activeDocumentFirstScreenReadyRef,
    activePreviewPending: activePreview.pending,
    rightPreviewPending: rightPreview.pending,
    activeDiffLineCount,
    modePrewarm,
    modePerformancePolicy,
    modeResourcePolicy,
    viewModeUsage,
    getModeRenderKey,
    warmScope,
    leftPreviewMounted,
    rightPreviewMounted,
    editorMounted,
    diffMounted,
    draftDecisionVersion,
    setLeftPreviewMounted,
    setRightPreviewMounted,
    setEditorMounted,
    setDiffMounted,
    retainedRightTabRef,
    leftPreviewDraftRef,
    rightPreviewDraftRef,
    leftPreviewRenderRef,
    restoredPreviewKeysRef,
  })
  const previewRevealTimerRef = useRef<number | null>(null)
  const activePreviewPendingRef = useRef(activePreview.pending)
  activePreviewPendingRef.current = activePreview.pending

  const updateEditorHeading = useCallback((view: EditorView) => {
    const line = getEditorTopLine(view)
    if (typeof line !== 'number') return
    const headingId = getHeadingIdAtLine(toc, line)
    setActiveEditorHeading((current) => current === headingId ? current : headingId)
  }, [toc])

  // 目录当前项按"滚动位置之前最后一个标题"计算：由预览实例的全文行号映射
  // （getLineForTop：模型 + 实测高度）驱动，不依赖标题 DOM 是否仍在虚拟窗口内，
  // 长章节中标题块卸载后目录项不再变空；左右预览各自绑定自身的 handle 与 toc。
  const resolveLeftActiveHeading = useCallback(({ scrollTop, viewportHeight }: ActiveHeadingGeometry): string | null => {
    const handle = leftMarkdownPreviewRef.current
    if (!handle) return null
    return resolveActiveHeadingByScroll(handle, previewToc, scrollTop, viewportHeight)
  }, [previewToc])

  const resolveRightActiveHeading = useCallback(({ scrollTop, viewportHeight }: ActiveHeadingGeometry): string | null => {
    const handle = rightMarkdownPreviewRef.current
    if (!handle) return null
    return resolveActiveHeadingByScroll(handle, rightToc, scrollTop, viewportHeight)
  }, [rightToc])

  const activeHeading = useActiveHeading(
    leftPreviewRef,
    resolveLeftActiveHeading,
    `${viewMode}:${activeTab?.id ?? ''}:${activePreview.version}`,
    leftPreviewVisible,
    SCROLL_SYNC_TOP_OFFSET,
  )
  const activeRightHeading = useActiveHeading(
    rightPreviewRef,
    resolveRightActiveHeading,
    `${viewMode}:${rightTab?.id ?? ''}:${rightPreview.version}`,
    viewMode === 'dual-preview',
    SCROLL_SYNC_TOP_OFFSET,
  )

  const readingPositionBridge = useReadingPositionBridge({
    activeTabId,
    viewMode,
    viewModeRef,
    editorViewRef,
    leftMarkdownPreviewRef,
    rightMarkdownPreviewRef,
    restoredPreviewKeysRef,
    scrollSyncSessionRef,
    clearPreviewSwitching,
    setPreviewRestoreTick,
    flushReadingPositions,
    updateEditorHeading,
    setTocFocus,
  })
  const {
    readingPositionsRef,
    isRestoringScrollRef,
    getStoredPreviewTop,
    getStoredEditorTop,
    saveEditorPositionForTab,
    savePreviewReadingPosition,
    scheduleFlush,
    restoreEditorReadingPosition,
    restorePreviewReadingPosition,
  } = readingPositionBridge
  const previewSelectionBridge = usePreviewSelectionBridge({
    activeTab,
    rightTab,
    leftPreviewRef,
    rightPreviewRef,
    leftMarkdownPreviewRef,
    rightMarkdownPreviewRef,
  })
  const {
    previewMenu,
    closePreviewMenu,
    handlePreviewContextMenu,
    handleCopyPreviewSelection,
    handleSelectAllPreview,
    handleAddPreviewSelectionToAi,
    handlePreviewAiAction,
  } = previewSelectionBridge

  const leftPreviewMasked = Boolean(
    activeTab?.id
    && (
      previewSwitchingTabId === activeTab.id
      || (
        restoredPreviewKeysRef.current.left !== activeTab.id
        && getStoredPreviewTop(activeTab.id) > 0
      )
    )
  )

  const rightPreviewMasked = Boolean(
    rightTab?.id
    && restoredPreviewKeysRef.current.right !== rightTab.id
    && getStoredPreviewTop(rightTab.id, 'right') > 0
  )

  // 预览内容更新（版本变化）只恢复预览自身位置，保证右侧渲染稳定；
  // 绝不在内容更新时反向恢复编辑器位置——否则右侧渲染会把左侧视口拉走
  // （编辑左侧时每次预览刷新都可能导致左侧跳动）。
  useLayoutEffect(() => {
    if (!activeTab?.id) return
    const restoreStartedAt = import.meta.env.DEV ? performance.now() : 0
    if (viewMode === 'preview' || viewMode === 'edit-preview' || viewMode === 'dual-preview') {
      restorePreviewReadingPosition(activeTab.id, leftPreviewRef.current, 'left')
    }
    if (viewMode === 'dual-preview' && rightTab?.id) {
      restorePreviewReadingPosition(rightTab.id, rightPreviewRef.current, 'right')
    }
    if (leftPreviewVisible) {
      reportPreviewSwitchPerformance(activeTab.id, restoreStartedAt)
    }
  }, [
    activePreview.version,
    activeTab?.id,
    restorePreviewReadingPosition,
    rightPreview.version,
    rightTab?.id,
    viewMode,
  ])

  // 编辑器阅读位置只在模式切换 / 标签页切换（进入编辑器或换文档）时恢复，
  // 不随预览内容版本变化重放：编辑过程中右侧渲染不得影响左侧位置。
  useLayoutEffect(() => {
    if (!activeTab?.id) return
    if (viewMode !== 'edit' && viewMode !== 'edit-preview') return
    restoreEditorReadingPosition(activeTab.id)
  }, [activeTab?.id, restoreEditorReadingPosition, viewMode])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f' && !e.altKey) {
        setSearchOpen(true)
      }
    }
    const openSearch = () => setSearchOpen(true)
    window.addEventListener('keydown', handler, true)
    window.addEventListener(OPEN_EDITOR_SEARCH_EVENT, openSearch)
    return () => {
      window.removeEventListener('keydown', handler, true)
      window.removeEventListener(OPEN_EDITOR_SEARCH_EVENT, openSearch)
    }
  }, [])

  // Ctrl + 滚轮快捷调节字号
  useEffect(() => {
    const handler = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return
      e.preventDefault()
      const delta = e.deltaY < 0 ? 1 : -1
      const current = useSettingsStore.getState().editor.fontSize
      const next = Math.max(10, Math.min(24, current + delta))
      if (next !== current) {
        useSettingsStore.getState().updateEditorSettings({ fontSize: next })
      }
    }
    window.addEventListener('wheel', handler, { passive: false, capture: true })
    return () => window.removeEventListener('wheel', handler, { capture: true })
  }, [])

  /** 取消正在写编辑器 scrollTop 的 follower（预览滚动驱动方向） */
  const cancelEditorFollower = useCallback(() => {
    const f = editorFollowerRef.current
    if (f.frameId !== null) {
      window.cancelAnimationFrame(f.frameId)
      f.frameId = null
    }
    f.active = false
    f.pos = null
    f.lastTarget = null
    f.stableFrames = 0
  }, [])

  /** 取消正在写预览 scrollTop 的 follower（编辑器滚动驱动方向） */
  const cancelPreviewFollower = useCallback(() => {
    const f = previewFollowerRef.current
    if (f.frameId !== null) {
      window.cancelAnimationFrame(f.frameId)
      f.frameId = null
    }
    f.active = false
    f.target = null
    f.lastTarget = null
    f.stableFrames = 0
  }, [])

  const cancelEditorHeadingJump = useCallback(() => {
    const cancel = editorHeadingJumpCancelRef.current
    editorHeadingJumpCancelRef.current = null
    cancel?.()
  }, [])

  useEffect(() => () => {
    scrollSyncSessionRef.current.dispose()
    cancelEditorFollower()
    cancelPreviewFollower()
    cancelEditorHeadingJump()
    scrollFollowerGenerationRef.current += 1
    if (editorScrollFrameRef.current !== null) {
      window.cancelAnimationFrame(editorScrollFrameRef.current)
      editorScrollFrameRef.current = null
    }
    if (previewScrollFrameRef.current !== null) {
      window.cancelAnimationFrame(previewScrollFrameRef.current)
      previewScrollFrameRef.current = null
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const handleEditorChange = useCallback(
    (content: string) => {
      lastEditorInputAtRef.current = Date.now()
      if (activeTabId) updateTabContent(activeTabId, content)
    },
    [activeTabId, updateTabContent]
  )

  const setScrollSyncSource = useCallback((source: 'editor' | 'preview') => {
    scrollSyncSessionRef.current.lock(source)
  }, [])

  // ---- 同步滚动平滑跟随（rAF lerp follower）----
  // 只把被动方从瞬时跳转改为平滑跟随；映射计算、方向判断、手势守卫、
  // 输入暂停、restore 隔离与阅读位置逻辑全部保持原语义。
  // 不使用 scrollTo({ behavior: 'smooth' })：同步目标约 60Hz 更新，
  // 浏览器 smooth 每次都会重新启动并互相打断。

  /** 编辑器被动动画帧：预览滚动驱动编辑器平滑逼近目标行 */
  const stepEditorFollower = useCallback((now: number) => {
    const f = editorFollowerRef.current
    f.frameId = null
    if (!f.active || f.pos === null) return
    const view = f.view
    const pos = f.pos
    if (!view || editorViewRef.current !== view
      || f.generation !== scrollFollowerGenerationRef.current
      || pos > view.state.doc.length) {
      cancelEditorFollower()
      return
    }

    // 每帧续锁原始 source：动画写编辑器产生的 scroll 事件不得反向同步预览
    setScrollSyncSource('preview')

    // 动态目标：长行、表格未进入视口时 lineBlockAt 可能是估算值，逐帧重读。
    // 写入前把目标限制在合法滚动范围（0 ... scrollHeight - clientHeight），
    // 与原生 scrollTo 的夹取行为等价，保证文档底部/顶部也能收敛。
    const scrollDOM = view.scrollDOM
    const editorMaxTop = Math.max(0, scrollDOM.scrollHeight - scrollDOM.clientHeight)
    const target = Math.min(
      Math.max(0, view.lineBlockAt(pos).top - SCROLL_SYNC_TOP_OFFSET),
      editorMaxTop,
    )

    const actualTop = scrollDOM.scrollTop
    // CodeMirror 自己的测量校正也可能修改编辑器 scrollTop：吸收为新的 current
    // 继续收敛，不视为取消；用户接管通过明确的 wheel / pointer 事件取消。
    const current = f.lastWrite === null || Math.abs(actualTop - f.lastWrite) > SCROLL_SYNC_EXTERNAL_DRIFT_PX
      ? actualTop
      : f.lastWrite

    const dt = f.lastTime === null ? 16 : Math.min(now - f.lastTime, SCROLL_SYNC_FOLLOW_MAX_DT_MS)
    f.lastTime = now
    const alpha = 1 - Math.exp(-dt / SCROLL_SYNC_FOLLOW_TAU_MS)
    const next = current + (target - current) * alpha

    scrollDOM.scrollTop = Math.max(0, Math.min(next, editorMaxTop))
    f.lastWrite = scrollDOM.scrollTop

    const settled = Math.abs(target - f.lastWrite) < SCROLL_SYNC_FOLLOW_EPSILON_PX
    const targetStable = f.lastTarget !== null && Math.abs(target - f.lastTarget) < SCROLL_SYNC_FOLLOW_EPSILON_PX
    f.lastTarget = target
    f.stableFrames = settled && targetStable ? f.stableFrames + 1 : 0

    if (f.stableFrames >= SCROLL_SYNC_FOLLOW_STABLE_FRAMES) {
      // 收敛后仅执行一次 CodeMirror 精确测量校正（不能在连续同步事件中反复调用）。
      // 到达这里时已确认：仍是同一个 EditorView、同一同步 effect 生命周期（generation）、
      // 动画未被用户取消（active）、当前 pos 未被后续 retarget 替换（retarget 会重置 stableFrames）。
      f.active = false
      f.pos = null
      view.dispatch({
        effects: EditorView.scrollIntoView(pos, { y: 'start', yMargin: SCROLL_SYNC_TOP_OFFSET }),
      })
      return
    }

    f.frameId = window.requestAnimationFrame(stepEditorFollower)
  }, [cancelEditorFollower, setScrollSyncSource])

  /** 预览被动动画帧：编辑器滚动驱动预览平滑逼近静态目标 */
  const stepPreviewFollower = useCallback((now: number) => {
    const f = previewFollowerRef.current
    f.frameId = null
    if (!f.active || f.target === null) return
    const container = f.container
    if (!container || leftPreviewRef.current !== container
      || f.generation !== scrollFollowerGenerationRef.current) {
      cancelPreviewFollower()
      return
    }

    // 每帧续锁原始 source：动画写预览产生的 scroll 事件不得反向同步编辑器
    setScrollSyncSource('editor')

    // 写入前把目标限制在合法滚动范围（0 ... scrollHeight - clientHeight）；
    // 预览虚拟化下容器几何逐帧变化，需每帧重取
    const previewMaxTop = Math.max(0, container.scrollHeight - container.clientHeight)
    const target = Math.min(f.target, previewMaxTop)
    if (f.lastWrite !== null && Math.abs(container.scrollTop - f.lastWrite) > SCROLL_SYNC_EXTERNAL_DRIFT_PX) {
      // 预览虚拟化、图片、KaTeX 等渲染补偿修改了 scrollTop：停止预览 follower，
      // 让外部补偿或用户操作接管
      cancelPreviewFollower()
      return
    }
    const current = f.lastWrite ?? container.scrollTop

    const dt = f.lastTime === null ? 16 : Math.min(now - f.lastTime, SCROLL_SYNC_FOLLOW_MAX_DT_MS)
    f.lastTime = now
    const alpha = 1 - Math.exp(-dt / SCROLL_SYNC_FOLLOW_TAU_MS)
    const next = current + (target - current) * alpha

    container.scrollTop = Math.max(0, Math.min(next, previewMaxTop))
    f.lastWrite = container.scrollTop

    const settled = Math.abs(target - f.lastWrite) < SCROLL_SYNC_FOLLOW_EPSILON_PX
    const targetStable = f.lastTarget !== null && Math.abs(target - f.lastTarget) < SCROLL_SYNC_FOLLOW_EPSILON_PX
    f.lastTarget = target
    f.stableFrames = settled && targetStable ? f.stableFrames + 1 : 0

    if (f.stableFrames >= SCROLL_SYNC_FOLLOW_STABLE_FRAMES) {
      f.active = false
      f.target = null
      return
    }

    f.frameId = window.requestAnimationFrame(stepPreviewFollower)
  }, [cancelPreviewFollower, setScrollSyncSource])

  const startEditorFollower = useCallback((view: EditorView, pos: number) => {
    const f = editorFollowerRef.current
    f.pos = pos
    f.stableFrames = 0
    if (f.active && f.frameId !== null) {
      // 连续同步事件只更新目标，不取消并重新启动 rAF
      f.view = view
      return
    }
    f.active = true
    f.view = view
    f.lastWrite = view.scrollDOM.scrollTop
    f.lastTime = null
    f.lastTarget = null
    if (f.frameId !== null) window.cancelAnimationFrame(f.frameId)
    f.frameId = window.requestAnimationFrame(stepEditorFollower)
  }, [stepEditorFollower])

  const startPreviewFollower = useCallback((container: HTMLElement, target: number) => {
    const f = previewFollowerRef.current
    f.target = target
    f.stableFrames = 0
    if (f.active && f.frameId !== null) {
      f.container = container
      return
    }
    f.active = true
    f.container = container
    f.lastWrite = container.scrollTop
    f.lastTime = null
    f.lastTarget = null
    if (f.frameId !== null) window.cancelAnimationFrame(f.frameId)
    f.frameId = window.requestAnimationFrame(stepPreviewFollower)
  }, [stepPreviewFollower])

  const syncPreviewToEditorLine = useCallback((line: number) => {
    const container = leftPreviewRef.current
    if (!container) return

    const targetTop = getPreviewTopForLine(container, line, leftMarkdownPreviewRef.current?.getTopForLine(line))
    if (typeof targetTop !== 'number') return

    setScrollSyncSource('editor')
    // 映射计算保持不变：只把瞬时写入改成更新预览 follower 的静态目标
    startPreviewFollower(container, Math.max(0, targetTop - SCROLL_SYNC_TOP_OFFSET))
  }, [activePreview.version, setScrollSyncSource, startPreviewFollower])

  const syncEditorToPreviewLine = useCallback((line: number) => {
    const view = editorViewRef.current
    if (!view || line < 1 || line > view.state.doc.lines) return

    const pos = view.state.doc.line(line).from
    setScrollSyncSource('preview')
    // 长行、表格等内容尚未进入视口时，CodeMirror 的高度映射可能仍是估算值。
    // 动画期间每帧动态读取 lineBlockAt(pos).top 平滑逼近，收敛后仅执行一次
    // scrollIntoView 精确测量校正，避免把瞬时估算固化为 scrollTop。
    startEditorFollower(view, pos)
  }, [setScrollSyncSource, startEditorFollower])

  useEffect(() => {
    if (viewMode !== 'edit-preview' || !syncScroll) return
    const view = editorViewRef.current
    const preview = leftPreviewRef.current
    if (!view || !preview) return

    // 新生命周期代数：上一个生命周期的 follower 帧即使漏取消也会在下一帧自杀
    const generation = ++scrollFollowerGenerationRef.current
    editorFollowerRef.current.generation = generation
    previewFollowerRef.current.generation = generation

    const handleEditorScroll = () => {
      if (scrollSyncSessionRef.current.source === 'preview') return
      if (editorScrollFrameRef.current !== null) return
      editorScrollFrameRef.current = window.requestAnimationFrame(() => {
        editorScrollFrameRef.current = null
        const line = getEditorTopLine(view)
        if (typeof line === 'number') {
          syncPreviewToEditorLine(line)
        }
      })
    }

    const handlePreviewScroll = () => {
      if (isRestoringScrollRef.current) return
      // 反向同步只接受用户主动滚动预览（滚轮 / 按住拖拽滚动条 / 触控）产生的
      // scroll 事件；渲染补偿（内容更新锚点补偿、scrollTop 夹取、预览位置恢复、
      // 异步图片/KaTeX 高度变化）产生的 scroll 事件一律不得反向移动编辑器。
      if (!previewPointerDownRef.current
        && Date.now() - previewGestureAtRef.current > PREVIEW_SYNC_GESTURE_WINDOW_MS) return
      if (scrollSyncSessionRef.current.source === 'editor') return
      if (Date.now() - lastEditorInputAtRef.current < SCROLL_SYNC_INPUT_PAUSE_MS) return
      if (previewScrollFrameRef.current !== null) return
      previewScrollFrameRef.current = window.requestAnimationFrame(() => {
        previewScrollFrameRef.current = null
        const line = leftMarkdownPreviewRef.current?.getLineForTop(
          preview.scrollTop + SCROLL_SYNC_TOP_OFFSET,
        )
        if (typeof line === 'number') {
          syncEditorToPreviewLine(line)
        }
      })
    }

    const handleEditorWheel = () => {
      // 用户接管被动面：立即取消正在写编辑器 scrollTop 的动画，最迟下一帧让路
      cancelEditorFollower()
      setScrollSyncSource('editor')
    }
    const handlePreviewWheel = () => {
      cancelPreviewFollower()
      previewGestureAtRef.current = Date.now()
      setScrollSyncSource('preview')
    }
    const handleEditorPointerDown = () => {
      // 仅用于取消编辑器 follower（覆盖拖动编辑器滚动条）
      cancelEditorFollower()
    }
    const handlePreviewPointerDown = () => {
      cancelPreviewFollower()
      previewPointerDownRef.current = true
      previewGestureAtRef.current = Date.now()
    }
    const handlePreviewPointerUp = () => {
      previewPointerDownRef.current = false
    }

    view.scrollDOM.addEventListener('scroll', handleEditorScroll, { passive: true })
    preview.addEventListener('scroll', handlePreviewScroll, { passive: true })
    view.scrollDOM.addEventListener('wheel', handleEditorWheel, { passive: true })
    preview.addEventListener('wheel', handlePreviewWheel, { passive: true })
    view.scrollDOM.addEventListener('pointerdown', handleEditorPointerDown, { passive: true })
    preview.addEventListener('pointerdown', handlePreviewPointerDown, { passive: true })
    window.addEventListener('pointerup', handlePreviewPointerUp, true)
    window.addEventListener('pointercancel', handlePreviewPointerUp, true)

    return () => {
      view.scrollDOM.removeEventListener('scroll', handleEditorScroll)
      preview.removeEventListener('scroll', handlePreviewScroll)
      view.scrollDOM.removeEventListener('wheel', handleEditorWheel)
      preview.removeEventListener('wheel', handlePreviewWheel)
      view.scrollDOM.removeEventListener('pointerdown', handleEditorPointerDown)
      preview.removeEventListener('pointerdown', handlePreviewPointerDown)
      window.removeEventListener('pointerup', handlePreviewPointerUp, true)
      window.removeEventListener('pointercancel', handlePreviewPointerUp, true)
      cancelEditorFollower()
      cancelPreviewFollower()
      scrollFollowerGenerationRef.current += 1
      if (editorScrollFrameRef.current !== null) {
        window.cancelAnimationFrame(editorScrollFrameRef.current)
        editorScrollFrameRef.current = null
      }
      if (previewScrollFrameRef.current !== null) {
        window.cancelAnimationFrame(previewScrollFrameRef.current)
        previewScrollFrameRef.current = null
      }
    }
  }, [activeTab?.id, activePreview.version, cancelEditorFollower, cancelPreviewFollower, setScrollSyncSource, syncEditorToPreviewLine, syncPreviewToEditorLine, syncScroll, viewMode])

  const handleSave = useCallback(async () => {
    const state = useEditorStore.getState()
    const tab = state.tabs.find((item) => item.id === state.activeTabId)
    if (!tab) return
    try {
      if (tab.filePath) {
        await saveFile(tab.filePath, tab.content)
        scheduleMarkdownDocumentIndex(tab.filePath, tab.title, tab.content)
        useEditorStore.getState().markTabSaved(tab.id, tab.content)
        toast.success('已保存')
      } else {
        const result = await saveFileAs(tab.content)
        if (result) {
          scheduleMarkdownDocumentIndex(result.path, result.name, result.content)
          useEditorStore.getState().saveTabAs(tab.id, result.path, result.name, result.content)
          toast.success('已保存')
        }
      }
    } catch (err) {
      console.error('Save failed:', err)
      toast.error(describeFileOperationError(err, '保存失败'))
    }
  }, [])

  const persistTabContent = useCallback(async (tabId: string, nextContent: string) => {
    const targetTab = useEditorStore.getState().tabs.find((tab) => tab.id === tabId)
    if (!targetTab) return

    updateTabContent(tabId, nextContent)

    if (!targetTab.filePath) return

    try {
      await saveFile(targetTab.filePath, nextContent)
      scheduleMarkdownDocumentIndex(targetTab.filePath, targetTab.title, nextContent)
      useEditorStore.getState().replaceTabContentWithSaved(tabId, nextContent)
    } catch (err) {
      console.error('Auto-save markdown task failed:', err)
      toast.error(describeFileOperationError(err, '任务勾选保存失败'))
    }
  }, [updateTabContent])

  const handleTaskToggle = useCallback(async (tabId: string, content: string, line: number, checked: boolean) => {
    const nextContent = toggleMarkdownTaskAtLine(content, line, checked)
    if (!nextContent || nextContent === content) return
    await persistTabContent(tabId, nextContent)
  }, [persistTabContent])

  const handleActiveTaskToggle = useCallback((line: number, checked: boolean) => {
    const state = useEditorStore.getState()
    if (!state.activeTabId) return
    const tab = state.tabs.find((item) => item.id === state.activeTabId)
    if (tab) void handleTaskToggle(tab.id, tab.content, line, checked)
  }, [handleTaskToggle])

  const handlePreviewBlockCommit = useCallback(async (request: MarkdownBlockCommitRequest) => {
    const tab = useEditorStore.getState().tabs.find((item) => item.id === request.documentKey)
    if (!tab) {
      toast.warning('文档已关闭，块修改未写入；可复制修改内容后重新打开文档。')
      return { status: 'conflict' as const, currentSource: '' }
    }
    // 动态导入：markdownBlocks 仅在块提交时需要，避免进入入口 chunk（阶段 4 定位重构后 bundle budget）
    const { replaceMarkdownBlock } = await import('@/services/markdownBlocks')
    const result = await replaceMarkdownBlock(tab.content, request.block, request.draft)
    if (result.status === 'conflict') {
      toast.warning('该 Markdown 块已被其他操作修改，当前草稿未覆盖原文。')
      return result
    }
    if (result.content !== tab.content) updateTabContent(tab.id, result.content)
    return { status: 'applied' as const, content: result.content }
  }, [updateTabContent])

  const handleRightTaskToggle = useCallback((line: number, checked: boolean) => {
    if (!rightTab?.id) return
    const tab = useEditorStore.getState().tabs.find((item) => item.id === rightTab.id)
    if (tab) void handleTaskToggle(tab.id, tab.content, line, checked)
  }, [handleTaskToggle, rightTab?.id])

  const handleLeftPreviewScroll = useCallback(() => {
    if (!activeTab?.id) return
    if (viewModeRef.current === 'edit-preview' && scrollSyncSessionRef.current.source === 'editor') return
    if (isRestoringScrollRef.current) return
    if (viewModeRef.current === 'edit-preview') setTocFocus('preview')
    savePreviewReadingPosition(activeTab.id, leftPreviewRef.current, leftMarkdownPreviewRef.current, 'left')
    scheduleFlush()
  }, [activeTab?.id, savePreviewReadingPosition, scheduleFlush])

  const handleRightPreviewScroll = useCallback(() => {
    if (!rightTab?.id) return
    if (isRestoringScrollRef.current) return
    savePreviewReadingPosition(rightTab.id, rightPreviewRef.current, rightMarkdownPreviewRef.current, 'right')
    scheduleFlush()
  }, [rightTab?.id, savePreviewReadingPosition, scheduleFlush])

  const jumpToLine = useCallback((line: number) => {
    const view = editorViewRef.current
    if (!view || line < 1 || line > view.state.doc.lines) return
    // 目录/标题跳转属于程序性接管编辑器滚动：先取消正在写编辑器 scrollTop 的
    // follower，避免其每帧覆写压制本次跳转、收敛后还把编辑器拉回旧目标
    cancelEditorFollower()
    cancelEditorHeadingJump()
    const pos = view.state.doc.line(line).from
    const initialTargetTop = view.lineBlockAt(pos).top - SCROLL_SYNC_TOP_OFFSET
    view.dispatch({ selection: { anchor: pos } })
    let useInitialTarget = true
    let cleanup: (() => void) | null = null
    cleanup = startHeadingScroll({
      container: view.scrollDOM,
      fadeElement: view.scrollDOM,
      getTargetTop: () => {
        if (editorViewRef.current !== view || pos > view.state.doc.length) return undefined
        if (useInitialTarget) {
          useInitialTarget = false
          return initialTargetTop
        }
        return view.lineBlockAt(pos).top - SCROLL_SYNC_TOP_OFFSET
      },
      onBeforeReveal: () => {
        if (editorViewRef.current !== view || pos > view.state.doc.length) return
        view.dispatch({
          effects: EditorView.scrollIntoView(pos, { y: 'start', yMargin: SCROLL_SYNC_TOP_OFFSET }),
        })
      },
      onSettled: () => {
        if (cleanup && editorHeadingJumpCancelRef.current === cleanup) editorHeadingJumpCancelRef.current = null
      },
    })
    editorHeadingJumpCancelRef.current = cleanup
    view.focus()
  }, [cancelEditorFollower, cancelEditorHeadingJump])

  const handleLeftPreviewHeadingClick = useCallback((line: number) => {
    if (viewModeRef.current !== 'edit-preview') return
    jumpToLine(line)
  }, [jumpToLine])

  const jumpToEditorHeading = useCallback((item: TocItem) => {
    jumpToLine(item.line)
  }, [jumpToLine])

  const insertMarkdownAtCursor = useCallback((markdown: string, insertAt?: number) => {
    const view = editorViewRef.current
    if (!view || !activeTabId) return false
    const selection = view.state.selection.main
    const from = typeof insertAt === 'number' ? insertAt : selection.from
    const to = typeof insertAt === 'number' ? insertAt : selection.to
    view.dispatch({
      changes: { from, to, insert: markdown },
      selection: { anchor: from + markdown.length },
      scrollIntoView: true,
    })
    view.focus()
    return true
  }, [activeTabId])

  const handleChooseImage = useCallback(async () => {
    if (!activeTab) return
    if (!activeTab.filePath) {
      toast.info('请先保存当前 Markdown 文件，再插入图片')
      return
    }

    try {
      const selected = await openFileDialog([
        { name: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'] },
      ])
      const imagePath = Array.isArray(selected) ? selected[0] : selected
      if (!imagePath) return

      const relativePath = await saveExternalImageForMarkdown(activeTab.filePath, imagePath)
      if (insertMarkdownAtCursor(`![图片描述](${relativePath})`)) {
        toast.success('图片已插入')
      }
    } catch (err) {
      console.error('Insert image failed:', err)
      toast.error(describeFileOperationError(err, '插入图片失败'))
    }
  }, [activeTab, insertMarkdownAtCursor])

  const handleInsertImageFiles = useCallback(async (files: File[], insertAt?: number) => {
    if (!activeTab) return
    if (!activeTab.filePath) {
      toast.info('请先保存当前 Markdown 文件，再插入图片')
      return
    }

    try {
      const snippets: string[] = []
      for (const file of files) {
        const relativePath = await saveImageFileForMarkdown(activeTab.filePath, file)
        snippets.push(`![图片描述](${relativePath})`)
      }
      if (snippets.length > 0 && insertMarkdownAtCursor(snippets.join('\n'), insertAt)) {
        toast.success(snippets.length > 1 ? `已插入 ${snippets.length} 张图片` : '图片已插入')
      }
    } catch (err) {
      console.error('Insert dropped/pasted image failed:', err)
      toast.error(describeFileOperationError(err, '插入图片失败'))
    }
  }, [activeTab, insertMarkdownAtCursor])

  const handleInsertImagePaths = useCallback(async (paths: string[]) => {
    if (!activeTab) return
    if (!activeTab.filePath) {
      toast.info('请先保存当前 Markdown 文件，再插入图片')
      return
    }

    try {
      const snippets: string[] = []
      for (const path of paths) {
        const relativePath = await saveExternalImageForMarkdown(activeTab.filePath, path)
        snippets.push(`![图片描述](${relativePath})`)
      }
      if (snippets.length > 0 && insertMarkdownAtCursor(snippets.join('\n'))) {
        toast.success(snippets.length > 1 ? `已插入 ${snippets.length} 张图片` : '图片已插入')
      }
    } catch (err) {
      console.error('Insert dragged image path failed:', err)
      toast.error(describeFileOperationError(err, '插入图片失败'))
    }
  }, [activeTab, insertMarkdownAtCursor])

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ paths?: string[] }>).detail
      if (detail?.paths?.length) {
        void handleInsertImagePaths(detail.paths)
      }
    }
    window.addEventListener(DROP_IMAGES_EVENT, handler)
    return () => window.removeEventListener(DROP_IMAGES_EVENT, handler)
  }, [handleInsertImagePaths])

  const jumpToPreviewHeading = useCallback((item: TocItem) => {
    // 目录跳转属于用户在预览侧的主动导航：先取消正在写预览 scrollTop 的 follower
    // （其每帧覆写会压制 scrollToLine 的平滑步进，导致目录点击无响应），
    // 并标记手势，使预览平滑滚动期间的 scroll 事件可继续反向同步编辑器
    // （与用户滚轮滚动预览一致）。
    cancelPreviewFollower()
    previewGestureAtRef.current = Date.now()
    leftMarkdownPreviewRef.current?.scrollToLine(item.line)
  }, [cancelPreviewFollower])

  const jumpToRightPreviewHeading = useCallback((item: TocItem) => {
    rightMarkdownPreviewRef.current?.scrollToLine(item.line)
  }, [])

  const dualPreviewTocSections = useMemo(() => {
    const sections = activeTab
      ? [{
          key: `left-${activeTab.id}`,
          title: activeTab.title ? `左栏 · ${activeTab.title}` : '左栏目录',
          toc,
          onHeadingClick: jumpToPreviewHeading,
          activeHeading,
        }]
      : []

    if (rightTab) {
      sections.push({
        key: `right-${rightTab.id}`,
        title: rightTab.title ? `右栏 · ${rightTab.title}` : '右栏目录',
        toc: rightToc,
        onHeadingClick: jumpToRightPreviewHeading,
        activeHeading: activeRightHeading,
      })
    }

    return sections.slice(0, 2)
  }, [activeTab, activeHeading, activeRightHeading, jumpToPreviewHeading, jumpToRightPreviewHeading, rightTab, rightToc, toc])

  const fullscreenTocExpanded = isFullscreen && !tocCollapsed && (
    viewMode === 'dual-preview' ? dualPreviewTocSections.length > 0 : toc.length > 1
  )
  const fullscreenTocWidthClass = viewMode === 'dual-preview' ? 'gm-fullscreen-toc-adjacent--dual' : ''

  // Drag & drop for dual-preview right pane
  const handleRightPaneDragOver = useCallback((e: React.DragEvent) => {
    const hasTab = e.dataTransfer.types.includes('application/x-guanmo-tab')
    if (hasTab) {
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
      setRightPaneDragOver(true)
    }
  }, [])

  const handleRightPaneDragLeave = useCallback(() => {
    setRightPaneDragOver(false)
  }, [])

  const handleRightPaneDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setRightPaneDragOver(false)
    const tabData = e.dataTransfer.getData('application/x-guanmo-tab')
    let tabId: string | undefined
    try {
      tabId = tabData ? JSON.parse(tabData).tabId as string | undefined : undefined
    } catch {
      tabId = undefined
    }
    if (tabId) {
      setRightPaneTabId(tabId)
      if (viewMode !== 'dual-preview') {
        setViewMode('dual-preview')
      }
    }
  }, [setRightPaneTabId, viewMode, setViewMode])

  const getSearchProps = () => {
    if (viewMode === 'edit' || viewMode === 'edit-preview') return { editorViewRef }
    const previewSources = []
    if (leftPreviewVisible && leftPreviewRef.current) {
      previewSources.push({
        content: leftPreviewRenderRef.current.content,
        paneRef: leftPreviewRef,
        previewRef: leftMarkdownPreviewRef,
      })
    }
    if (viewMode === 'dual-preview' && rightPreviewRef.current && rightTab) {
      previewSources.push({
        content: rightPreview.content,
        paneRef: rightPreviewRef,
        previewRef: rightMarkdownPreviewRef,
      })
    }
    return { previewSources }
  }

  const handlePreviewFirstVisible = useCallback((documentId: string | null) => {
    if (!documentId || !activeTab || !previewContentReady) return
    if (!markActiveDocumentFirstScreenReady(documentId)) return
    markStartupPoint('active-document-first-visible', {
      surface: 'preview',
      charCount: activeTab.content.length,
    })
    markStartupPoint('preview-first-visible', {
      charCount: activeTab.content.length,
      mode: viewMode,
      policy: modePerformancePolicy,
    })
    if (import.meta.env.DEV) {
      eventMarker.mark('preview-first-visible', {
        charCount: activeTab.content.length,
        mode: viewMode,
        policy: modePerformancePolicy,
      })
    }
  }, [activeTab?.content.length, activeTab?.id, markActiveDocumentFirstScreenReady, modePerformancePolicy, previewContentReady, viewMode])

  const schedulePendingPreviewReveal = useCallback(() => {
    if (previewRevealTimerRef.current !== null) window.clearTimeout(previewRevealTimerRef.current)
    previewRevealTimerRef.current = window.setTimeout(() => {
      previewRevealTimerRef.current = null
      const editorState = useEditorStore.getState()
      const reveal = editorState.pendingReveal
      const tab = editorState.tabs.find((item) => item.id === editorState.activeTabId)
      if (
        reveal?.surface !== 'preview'
        || !tab
        || reveal.tabId !== editorState.activeTabId
        || editorState.viewMode === 'edit'
        || activePreviewPendingRef.current
      ) return
      leftMarkdownPreviewRef.current?.revealSourceLines({
        documentKey: tab.id,
        documentVersion: getContentSignature(tab.content),
        startLine: reveal.startLine,
        endLine: reveal.endLine,
        onApplied: () => {
          if (useEditorStore.getState().pendingReveal === reveal) clearPendingReveal()
        },
      })
    }, 0)
  }, [clearPendingReveal])

  const handlePreviewRenderComplete = useCallback(() => {
    markStartupPoint('preview-render-complete', { mode: viewMode })
    eventMarker.mark('preview-render-complete', { mode: viewMode })
    const pending = useReadingMarksStore.getState().pendingNavigation
    if (pending && activeTab?.filePath && isSameFilePath(activeTab.filePath, pending.documentPath)) {
      if (leftMarkdownPreviewRef.current?.navigateToReadingMark(pending.markId)) clearMarkNavigation()
    }
    schedulePendingPreviewReveal()
  }, [activeTab?.filePath, clearMarkNavigation, schedulePendingPreviewReveal, viewMode])

  useEffect(() => {
    if (pendingReveal?.surface !== 'preview' || pendingReveal.tabId !== activeTab?.id || viewMode === 'edit') return
    schedulePendingPreviewReveal()
  }, [activeTab?.id, pendingReveal, previewContentReady, schedulePendingPreviewReveal, viewMode])

  useEffect(() => () => {
    if (previewRevealTimerRef.current !== null) window.clearTimeout(previewRevealTimerRef.current)
  }, [])

  useEffect(() => {
    const pending = pendingMarkNavigation
    if (!pending || viewMode === 'edit' || !activeTab?.filePath || !isSameFilePath(activeTab.filePath, pending.documentPath)) return
    const timer = window.setTimeout(() => {
      if (leftMarkdownPreviewRef.current?.navigateToReadingMark(pending.markId)) clearMarkNavigation()
    }, 0)
    return () => window.clearTimeout(timer)
  }, [activeReadingMarks, activeTab?.filePath, clearMarkNavigation, pendingMarkNavigation, previewContentReady, viewMode])

  return (
    <div
      className="flex-1 flex flex-col overflow-hidden bg-gm-canvas"
      style={isFullscreen ? { '--gm-fullscreen-content-padding': `${fullscreenContentPadding}px` } as CSSProperties : undefined}
    >
      {!isFullscreen && <TabBar />}
      <AnnotationHoverOverlay ref={annotationOverlayRef} onUpdate={handleOverlayUpdate} onDelete={handleOverlayDelete} />

      <div className="flex-1 flex overflow-hidden relative">
        {tabs.length === 0 ? (
          <WelcomeScreen />
        ) : (
          <>
            {(viewMode === 'diff-preview' || diffMounted) && (
              <div className={viewMode === 'diff-preview' ? 'flex min-w-0 flex-1' : 'hidden'}>
                <Suspense fallback={<PreviewSuspenseFallback />}>
                  <LazyMarkdownDiffView
                    original={activeTab?.originalContent || ''}
                    current={activeTab?.content || ''}
                    fontSize={editorFontSize}
                    lineHeight={editorLineHeight}
                    fontFamily={editorFontFamily}
                    wordWrap={editorWordWrap}
                    lineNumbers={editorLineNumbers}
                    documentKey={activeTab?.id}
                    resource="diff"
                  />
                </Suspense>
              </div>
            )}
            <div className={`${viewMode === 'diff-preview' ? 'hidden' : 'flex'} flex-1 overflow-hidden bg-gm-surface`}>
            {(editorMounted || editorVisible) && (
            <div className={`${editorVisible ? (viewMode === 'edit-preview' ? 'min-w-0 flex-1 border-r border-gm-border-subtle' : 'flex-1') : 'hidden'} ${isFullscreen ? 'gm-fullscreen-editor-content' : ''} ${isFullscreen && viewMode === 'edit-preview' ? 'gm-fullscreen-content-split-left' : ''} ${fullscreenTocExpanded && viewMode === 'edit' ? `gm-fullscreen-toc-adjacent ${fullscreenTocWidthClass}` : ''} overflow-hidden relative`}>
              {activeTab && (
                <CodeMirrorEditor
                  content={activeTab.content}
                  onChange={handleEditorChange}
                  onSave={handleSave}
                  onImageFiles={(files, insertAt) => void handleInsertImageFiles(files, insertAt)}
                  viewRef={editorViewRef}
                  documentKey={activeTab.id}
                  tabId={activeTab.id}
                  initialScrollTop={getStoredEditorTop(activeTab.id)}
                  initialCursor={readingPositionsRef.current.get(activeTab.id)?.cursor}
                  initialSelection={readingPositionsRef.current.get(activeTab.id)?.selection}
                  initialRanges={readingPositionsRef.current.get(activeTab.id)?.ranges}
                  initialMainIndex={readingPositionsRef.current.get(activeTab.id)?.mainIndex}
                  onBeforeDestroy={saveEditorPositionForTab}
                  resource="editor"
                />
              )}
              {activeTab && (
                <button
                  type="button"
                  onClick={() => void handleChooseImage()}
                  className="absolute right-3 top-3 z-10 flex h-8 w-8 items-center justify-center rounded-lg border border-gm-border bg-gm-surface/90 text-gm-text-secondary shadow-sm hover:border-gm-primary/50 hover:text-gm-primary"
                  title="选择图片插入"
                >
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                    <circle cx="8.5" cy="8.5" r="1.5" />
                    <path d="M21 15l-5-5L5 21" />
                  </svg>
                </button>
              )}
              <EditorContextMenu viewRef={editorViewRef} />
            </div>
            )}

            {(leftPreviewMounted || leftPreviewVisible) && (
              <div
                key={`left-${activeTab?.id ?? 'none'}`}
                ref={leftPreviewRef}
                data-product-tour="preview-area"
                className={`${leftPreviewVisible ? 'min-w-0 flex-1' : 'hidden'} ${viewMode === 'dual-preview' ? 'border-r border-gm-border-subtle' : ''} ${viewMode === 'edit-preview' ? 'gm-preview-heading-clickable' : ''} ${isFullscreen ? 'gm-fullscreen-preview-content py-6' : 'p-6'} ${isFullscreen && viewMode === 'edit-preview' ? 'gm-fullscreen-content-split-right' : isFullscreen && viewMode === 'dual-preview' ? 'gm-fullscreen-content-split-left' : ''} ${fullscreenTocExpanded && viewMode !== 'dual-preview' ? `gm-fullscreen-toc-adjacent ${fullscreenTocWidthClass}` : ''} overflow-y-auto overflow-x-hidden select-text bg-gm-surface relative`}
                style={{ overflowAnchor: 'none', ...(leftPreviewMasked ? { visibility: 'hidden' } : {}) }}
                aria-hidden={!leftPreviewVisible}
                onScroll={handleLeftPreviewScroll}
                onContextMenu={(e) => handlePreviewContextMenu(e, 'left')}
              >
                {viewMode === 'dual-preview' && <PaneHeader title={activeTab?.title || ''} />}
                <Suspense fallback={<PreviewSuspenseFallback />}>
                  <LazyMarkdownPreview
                    ref={leftMarkdownPreviewRef}
                    content={leftPreviewRenderRef.current.content}
                    filePath={leftPreviewRenderRef.current.filePath}
                    fontSize={editorFontSize}
                    lineHeight={editorLineHeight}
                    fontFamily={editorFontFamily}
                    wordWrap={editorWordWrap}
                    documentKey={activeTab?.id}
                    documentVersion={getContentSignature(activeTab?.content || '')}
                    inlineEditEnabled={inlinePreviewEdit}
                    onBlockCommit={handlePreviewBlockCommit}
                    onHeadingClick={handleLeftPreviewHeadingClick}
                    onTaskToggle={activeTab ? handleActiveTaskToggle : undefined}
                    onDraftStateChange={handleLeftDraftStateChange}
                    isVisible={leftPreviewVisible && previewContentReady}
                    onFirstVisible={() => handlePreviewFirstVisible(activeTab?.id ?? null)}
                    onRenderComplete={handlePreviewRenderComplete}
                    resource="left-preview"
                    readingMarks={activeReadingMarks}
                    onCreateReadingMark={readingMarksEnabled ? handleCreateReadingMark : undefined}
                    onUpdateReadingMark={readingMarksEnabled ? handleUpdateReadingMark : undefined}
                    onDeleteReadingMark={readingMarksEnabled ? handleDeleteReadingMark : undefined}
                    annotationOverlayRef={readingMarksEnabled ? annotationOverlayRef : undefined}
                  />
                </Suspense>
              </div>
            )}

            {(rightPreviewMounted || viewMode === 'dual-preview') && (
            <div
              key={`right-${rightTab?.id ?? 'none'}`}
              ref={rightPreviewRef}
              className={`${viewMode === 'dual-preview' ? 'min-w-0 flex-1' : 'hidden'} ${isFullscreen ? 'gm-fullscreen-preview-content py-6' : 'p-6'} ${isFullscreen && viewMode === 'dual-preview' ? 'gm-fullscreen-content-split-right' : ''} ${fullscreenTocExpanded && viewMode === 'dual-preview' ? `gm-fullscreen-toc-adjacent ${fullscreenTocWidthClass}` : ''} overflow-y-auto overflow-x-hidden select-text bg-gm-surface relative ${rightPaneDragOver ? 'ring-2 ring-inset ring-gm-primary/40' : ''}`}
              style={{ overflowAnchor: 'none', ...(rightPreviewMasked ? { visibility: 'hidden' } : {}) }}
              aria-hidden={viewMode !== 'dual-preview'}
              onScroll={handleRightPreviewScroll}
              onDragOver={handleRightPaneDragOver}
              onDragLeave={handleRightPaneDragLeave}
              onDrop={handleRightPaneDrop}
              onContextMenu={(e) => handlePreviewContextMenu(e, 'right')}
            >
              {rightPaneDragOver && (
                <div className="absolute inset-0 z-10 flex items-center justify-center bg-gm-primary/5 border-2 border-dashed border-gm-primary/50 rounded-lg pointer-events-none">
                  <span className="text-caption text-gm-primary font-bold">{'释放以在右栏打开'}</span>
                </div>
              )}
              <PaneHeader
                title={rightTab?.title || '选择文件'}
                onClose={() => {
                  setRightPaneTabId(null)
                  useEditorStore.getState().setViewMode('edit')
                }}
              />
              {rightTab ? (
                <Suspense fallback={<PreviewSuspenseFallback />}>
                  <LazyMarkdownPreview
                    ref={rightMarkdownPreviewRef}
                    content={rightPreview.content}
                    filePath={rightTab.filePath}
                    fontSize={editorFontSize}
                    lineHeight={editorLineHeight}
                    fontFamily={editorFontFamily}
                    wordWrap={editorWordWrap}
                    documentKey={rightTab.id}
                    documentVersion={getContentSignature(rightTab.content)}
                    inlineEditEnabled={inlinePreviewEdit}
                    onBlockCommit={handlePreviewBlockCommit}
                    onTaskToggle={handleRightTaskToggle}
                    onDraftStateChange={handleRightDraftStateChange}
                    isVisible={viewMode === 'dual-preview'}
                    resource="right-preview"
                    readingMarks={rightReadingMarks}
                    onCreateReadingMark={readingMarksEnabled ? handleCreateRightReadingMark : undefined}
                    onUpdateReadingMark={readingMarksEnabled ? handleUpdateRightReadingMark : undefined}
                    onDeleteReadingMark={readingMarksEnabled ? handleDeleteRightReadingMark : undefined}
                    annotationOverlayRef={readingMarksEnabled ? annotationOverlayRef : undefined}
                  />
                </Suspense>
              ) : (
                <div className="flex items-center justify-center h-full text-gm-text-tertiary text-caption">
                  {'拖拽标签页到此处，或右键选择"在右栏打开"'}
                </div>
              )}
            </div>
            )}
            {viewMode === 'dual-preview' && (
            <MarkdownToc
              collapsed={tocCollapsed}
              onToggle={() => setTocCollapsed((collapsed) => !collapsed)}
              sections={dualPreviewTocSections}
            />
            )}

            {viewMode !== 'dual-preview' && (
              <MarkdownToc
                toc={toc}
                collapsed={tocCollapsed}
                onToggle={() => setTocCollapsed((collapsed) => !collapsed)}
                onHeadingClick={leftPreviewVisible ? jumpToPreviewHeading : jumpToEditorHeading}
                activeHeading={viewMode === 'edit' || (viewMode === 'edit-preview' && tocFocus === 'editor')
                  ? activeEditorHeading
                  : activeHeading}
              />
            )}
            </div>
          </>
        )}

        {searchOpen && tabs.length > 0 && (
          <SearchOverlay onClose={() => setSearchOpen(false)} {...getSearchProps()} />
        )}
        {previewMenu && (
          <ContextMenu position={previewMenu} onClose={closePreviewMenu} minWidth={176} maxWidth={176}>
            <ContextMenuGroupTitle>预览操作</ContextMenuGroupTitle>
            <ContextMenuItem onClick={handleCopyPreviewSelection} disabled={!previewMenu.selectedText}>
              复制
            </ContextMenuItem>
            <ContextMenuItem onClick={handleSelectAllPreview}>
              全选
            </ContextMenuItem>
            {previewMenu.selectedText && (
              <>
                <ContextMenuSeparator />
                <ContextMenuGroupTitle>AI 助手</ContextMenuGroupTitle>
                <ContextMenuItem onClick={handleAddPreviewSelectionToAi}>
                  添加到 AI 上下文
                </ContextMenuItem>
                <AiShortcutMenuItems onAction={handlePreviewAiAction} />
              </>
            )}
          </ContextMenu>
        )}
      </div>
    </div>
  )
}

function getEditorTopLine(view: EditorView): number | undefined {
  const block = view.lineBlockAtHeight(view.scrollDOM.scrollTop + SCROLL_SYNC_TOP_OFFSET)
  if (!block) return undefined
  return view.state.doc.lineAt(block.from).number
}

function getHeadingIdAtLine(toc: TocItem[], line: number): string | null {
  let activeId: string | null = null
  for (const item of toc) {
    if (item.line > line) break
    activeId = item.id
  }
  return activeId
}

/**
 * 滚动几何 → 活跃目录项：取"滚动位置之前最后一个标题"。
 * 行号映射来自预览实例的全文模型 + 实测高度，与标题块是否挂载无关；
 * 尚未越过任何标题时（文档顶部），回落到视口上半区可见的首个标题，
 * 与原 IntersectionObserver（rootMargin -50%）的顶部行为保持一致。
 */
function resolveActiveHeadingByScroll(
  handle: Pick<MarkdownPreviewHandle, 'getLineForTop'>,
  toc: TocItem[],
  scrollTop: number,
  viewportHeight: number
): string | null {
  const topLine = handle.getLineForTop(scrollTop)
  if (typeof topLine === 'number') {
    const passed = getHeadingIdAtLine(toc, topLine)
    if (passed) return passed
  }
  const halfLine = handle.getLineForTop(scrollTop + viewportHeight / 2)
  if (typeof halfLine === 'number') {
    return toc.find((item) => item.line <= halfLine)?.id ?? null
  }
  return null
}

function reportPreviewSwitchPerformance(tabId: string, restoreStartedAt: number) {
  if (!import.meta.env.DEV) return
  const startMark = `${PREVIEW_SWITCH_MARK_PREFIX}:${tabId}:start`
  const entries = performance.getEntriesByName(startMark, 'mark')
  const start = entries[entries.length - 1]
  if (!start) return

  const committedAt = performance.now()
  window.requestAnimationFrame(() => {
    const firstFrameAt = performance.now()
    console.debug('[预览切换性能]', {
      tabId,
      commitMs: Number((committedAt - start.startTime).toFixed(1)),
      restoreMs: Number((committedAt - restoreStartedAt).toFixed(1)),
      firstFrameMs: Number((firstFrameAt - start.startTime).toFixed(1)),
    })
    performance.clearMarks(startMark)
  })
}

function getContentSignature(content: string) {
  let hash = 2166136261
  for (let i = 0; i < content.length; i++) {
    hash ^= content.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return `${content.length}:${hash >>> 0}`
}

function countMarkdownLines(content: string) {
  if (!content) return 1
  let lines = 1
  for (let i = 0; i < content.length; i++) {
    if (content.charCodeAt(i) === 10) lines += 1
  }
  return lines
}

function PaneHeader({ title, onClose }: { title: string; onClose?: () => void }) {
  return (
    <div className="flex items-center justify-between mb-4 pb-2 border-b border-gm-border-subtle">
      <div className="flex items-center gap-2">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--gm-primary)" strokeWidth="1.5">
          <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
          <path d="M14 2v6h6" />
        </svg>
        <span className="text-caption font-bold text-gm-text truncate">{title}</span>
      </div>
      {onClose && (
        <button
          onClick={onClose}
          className="p-1 rounded-lg text-gm-text-tertiary hover:text-gm-text hover:bg-gm-surface-hover"
          title="关闭右栏"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>
      )}
    </div>
  )
}

function WelcomeScreen() {
  const { handleNewFile, handleOpenFile } = useFileOperations()
  const toggleAiPanel = useAppStore((s) => s.toggleAiPanel)

  return (
    <div className="flex-1 flex flex-col items-center justify-center p-8 animate-fadeIn">
      <div className="mb-5">
        <svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="var(--gm-primary)" strokeWidth="1.2">
          <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
          <path d="M14 2v6h6M16 13H8M16 17H8M10 9H8" />
        </svg>
      </div>

      <h2 className="text-display text-gm-text mb-2 font-display">观墨</h2>
      <p className="text-body text-gm-text-secondary mb-7">AI 驱动的 Markdown 知识管理</p>

      <div className="grid w-full max-w-sm grid-cols-2 gap-x-5 gap-y-1">
        <ActionItem label="新建文件" shortcut="Ctrl+N" onClick={handleNewFile}
          icon={<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M12 5v14M5 12h14" /></svg>}
        />
        <ActionItem label="打开文件" shortcut="Ctrl+O" onClick={handleOpenFile}
          icon={<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" /></svg>}
        />
        <ActionItem
          label="快速打开"
          shortcut="Ctrl+P"
          onClick={() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', ctrlKey: true, bubbles: true }))}
          icon={<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="11" cy="11" r="8" /><path d="M21 21l-4.35-4.35" /></svg>}
        />
        <ActionItem label="AI 对话" shortcut="Ctrl+J" onClick={toggleAiPanel}
          icon={<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" /></svg>}
        />
      </div>
    </div>
  )
}

function ActionItem({
  icon,
  label,
  shortcut,
  onClick,
}: {
  icon: React.ReactNode
  label: string
  shortcut: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      className="flex min-h-11 items-center gap-2 border-b border-gm-border-subtle px-2 text-left text-gm-text-secondary transition-colors hover:border-gm-border hover:text-gm-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gm-primary/35"
      onClick={onClick}
    >
      <span className="flex-shrink-0 text-gm-primary">{icon}</span>
      <span className="min-w-0 flex-1 text-caption font-bold text-gm-text">{label}</span>
      <kbd className="flex-shrink-0 font-mono text-micro text-gm-text-tertiary">{shortcut}</kbd>
    </button>
  )
}
