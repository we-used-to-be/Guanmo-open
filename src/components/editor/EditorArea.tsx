import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { EditorView } from '@codemirror/view'
import { useAppStore } from '@/stores/appStore'
import { useEditorStore } from '@/stores/editorStore'
import type { ViewMode, ViewModeUsageStat } from '@/stores/editorStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { useFileOperations } from '@/hooks/useFileOperations'
import { useActiveHeading } from '@/hooks/useActiveHeading'
import { saveFile } from '@/services/fileSystem'
import { scheduleMarkdownDocumentIndex } from '@/services/rag/indexer'
import { extractToc, type TocItem } from '@/services/markdownToc'
import { toggleMarkdownTaskAtLine } from '@/services/markdownTasks'
import { saveExternalImageForMarkdown, saveImageFileForMarkdown } from '@/services/markdownImages'
import { toast } from '@/services/toast'
import { describeFileOperationError } from '@/services/fileOperationErrors'
import { openFileDialog } from '@/hooks/useTauri'
import { addSelectionContextTag, setAiShortcutPrompt } from '@/services/aiContext'
import { CodeMirrorEditor } from './CodeMirrorEditor'
import { EditorContextMenu } from './EditorContextMenu'
import { MarkdownDiffView } from './MarkdownDiffView'
import { MarkdownPreview, MarkdownToc } from './MarkdownPreview'
import { SearchOverlay } from './SearchOverlay'
import { TabBar } from './TabBar'
import { ContextMenu, ContextMenuGroupTitle, ContextMenuItem, ContextMenuSeparator } from '@/components/common/ContextMenu'

export const OPEN_EDITOR_SEARCH_EVENT = 'guanmo:open-editor-search'

interface PreviewMenuState {
  x: number
  y: number
  selectedText: string
  startLine?: number
  endLine?: number
  pane: 'left' | 'right'
}

interface PreviewSelectionSource {
  title: string
  filePath?: string | null
  text: string
  startLine?: number
  endLine?: number
  selectionFrom?: number
  selectionTo?: number
}

const PREVIEW_CONTEXT_HIGHLIGHT = 'preview-context-selection'
const DROP_IMAGES_EVENT = 'guanmo:drop-image-paths'
const PREVIEW_UPDATE_DELAY = 300
const LARGE_PREVIEW_UPDATE_DELAY = 650
const HUGE_PREVIEW_UPDATE_DELAY = 900
const SCROLL_SYNC_TOP_OFFSET = 32
const SCROLL_SYNC_LOCK_MS = 220
const SCROLL_SYNC_INPUT_PAUSE_MS = 700
const PREVIEW_SWITCH_MARK_PREFIX = 'guanmo:preview-switch'
const MODE_PREWARM_IDLE_DELAY = 650
const MODE_PREWARM_ACTIVITY_PAUSE = 1200
const MODE_PREWARM_HUGE_DOC_LENGTH = 100000
const MODE_PREWARM_DIFF_LINE_LIMIT = 900

type PrewarmTargetMode = Exclude<ViewMode, 'edit'>
type PrewarmedModeKeys = Partial<Record<PrewarmTargetMode, string>>

interface ScheduledPreviewContent {
  content: string
  version: number
  pending: boolean
}

interface ReadingPosition {
  editorScrollTop?: number
  previewScrollTop?: number
  topLine?: number
}

function getPreviewUpdateDelay(content: string) {
  if (content.length >= 80000) return HUGE_PREVIEW_UPDATE_DELAY
  if (content.length >= 30000) return LARGE_PREVIEW_UPDATE_DELAY
  return PREVIEW_UPDATE_DELAY
}

function useScheduledPreviewContent(content: string, documentKey: string | null | undefined) {
  const [preview, setPreview] = useState<ScheduledPreviewContent>({
    content,
    version: 0,
    pending: false,
  })
  const previousKeyRef = useRef(documentKey)
  const versionRef = useRef(0)
  const switchedDocument = previousKeyRef.current !== documentKey
  let visiblePreview = preview

  if (switchedDocument) {
    previousKeyRef.current = documentKey
    versionRef.current += 1
    visiblePreview = { content, version: versionRef.current, pending: false }
  }

  useLayoutEffect(() => {
    if (switchedDocument) {
      setPreview({ content, version: versionRef.current, pending: false })
      return
    }

    if (preview.content === content) {
      return
    }

    setPreview((current) => (
      current.content === content
        ? current
        : { ...current, pending: true }
    ))

    const version = versionRef.current + 1
    const timer = setTimeout(() => {
      versionRef.current = version
      setPreview({ content, version, pending: false })
    }, getPreviewUpdateDelay(content))

    return () => clearTimeout(timer)
  }, [content, documentKey, preview.content, switchedDocument])

  return visiblePreview
}

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
  const editorFontSize = useSettingsStore((s) => s.editor.fontSize)
  const editorLineHeight = useSettingsStore((s) => s.editor.lineHeight)
  const editorFontFamily = useSettingsStore((s) => s.editor.fontFamily)
  const editorWordWrap = useSettingsStore((s) => s.editor.wordWrap)
  const editorLineNumbers = useSettingsStore((s) => s.editor.lineNumbers)
  const syncScroll = useSettingsStore((s) => s.editor.syncScroll)
  const modePrewarm = useSettingsStore((s) => s.editor.modePrewarm)
  const viewModeUsage = useEditorStore((s) => s.viewModeUsage)
  const isFullscreen = useAppStore((s) => s.isFullscreen)
  const editorViewRef = useRef<EditorView | null>(null)
  const readingPositionsRef = useRef<Record<string, ReadingPosition>>({})
  const leftPreviewRef = useRef<HTMLDivElement>(null)
  const rightPreviewRef = useRef<HTMLDivElement>(null)
  const previewAnchorCacheRef = useRef<WeakMap<HTMLElement, PreviewAnchorCache>>(new WeakMap())
  const isRestoringScrollRef = useRef(false)
  const restoreScrollFrameRef = useRef<number | null>(null)
  const editorRestoreFrameRef = useRef<number | null>(null)

  const restoredPreviewKeysRef = useRef<{ left: string | null; right: string | null }>({ left: null, right: null })
  const scrollSyncSourceRef = useRef<'editor' | 'preview' | null>(null)
  const scrollSyncTimerRef = useRef<number | null>(null)
  const editorScrollFrameRef = useRef<number | null>(null)
  const editorTocFrameRef = useRef<number | null>(null)
  const previewScrollFrameRef = useRef<number | null>(null)
  const lastEditorInputAtRef = useRef(0)
  const [, setPreviewRestoreTick] = useState(0)
  const [searchOpen, setSearchOpen] = useState(false)
  const [rightPaneDragOver, setRightPaneDragOver] = useState(false)
  const [tocCollapsed, setTocCollapsed] = useState(false)
  const [activeEditorHeading, setActiveEditorHeading] = useState<string | null>(null)
  const [tocFocus, setTocFocus] = useState<'editor' | 'preview'>('editor')
  const [previewMenu, setPreviewMenu] = useState<PreviewMenuState | null>(null)
  const [prewarmedModeKeys, setPrewarmedModeKeys] = useState<PrewarmedModeKeys>({})
  const prewarmedModeKeysRef = useRef<PrewarmedModeKeys>({})
  prewarmedModeKeysRef.current = prewarmedModeKeys
  const warmedModeKeysRef = useRef<Set<string>>(new Set())
  const warmScopeRef = useRef<string | null>(null)
  const prewarmCancelRef = useRef(0)
  const lastUserActivityAtRef = useRef(Date.now())

  useEffect(() => {
    if (isFullscreen) setTocCollapsed(true)
  }, [isFullscreen])

  const activeTab = tabs.find((t) => t.id === activeTabId)
  const selectedRightTab = rightPaneTabId ? tabs.find((t) => t.id === rightPaneTabId) : null
  const dualRightTab = !rightPaneUserSelected
    ? activeTab
    : selectedRightTab
  const prewarmLeftPreview = Boolean(
    prewarmedModeKeys.preview
    || prewarmedModeKeys['edit-preview']
    || prewarmedModeKeys['dual-preview']
  )
  const prewarmRightPreview = Boolean(prewarmedModeKeys['dual-preview'])
  const prewarmDiffPreview = Boolean(prewarmedModeKeys['diff-preview'])
  const retainedRightTabRef = useRef<(typeof tabs)[number] | null>(null)
  if (viewMode === 'dual-preview' || prewarmRightPreview) {
    retainedRightTabRef.current = dualRightTab ?? null
  }
  const rightTab = viewMode === 'dual-preview' || prewarmRightPreview ? dualRightTab : retainedRightTabRef.current
  const leftPreviewVisible = viewMode === 'preview' || viewMode === 'edit-preview' || viewMode === 'dual-preview'
  const editorVisible = viewMode === 'edit' || viewMode === 'edit-preview'
  const leftPreviewMountedRef = useRef(false)
  const rightPreviewMountedRef = useRef(false)
  const viewModeRef = useRef(viewMode)
  viewModeRef.current = viewMode
  if (leftPreviewVisible || prewarmLeftPreview) {
    leftPreviewMountedRef.current = true
  }
  if (viewMode === 'dual-preview' || prewarmRightPreview) {
    rightPreviewMountedRef.current = true
  }
  const activePreview = useScheduledPreviewContent(activeTab?.content || '', activeTab?.id)
  const rightPreview = useScheduledPreviewContent(rightTab?.content || '', rightTab?.id)
  const leftPreviewRenderRef = useRef({
    content: activePreview.content,
    filePath: activeTab?.filePath,
  })
  if (leftPreviewVisible || prewarmLeftPreview) {
    leftPreviewRenderRef.current = {
      content: activePreview.content,
      filePath: activeTab?.filePath,
    }
  }
  const toc = useMemo(() => extractToc(activeTab?.content || ''), [activeTab?.content])
  const rightToc = useMemo(() => extractToc(rightTab?.content || ''), [rightTab?.content])
  const activeContentSignature = useMemo(
    () => getContentSignature(activeTab?.content || ''),
    [activeTab?.content]
  )
  const activeOriginalSignature = useMemo(
    () => getContentSignature(activeTab?.originalContent || ''),
    [activeTab?.originalContent]
  )
  const activeDiffLineCount = useMemo(
    () => Math.max(
      countMarkdownLines(activeTab?.originalContent || ''),
      countMarkdownLines(activeTab?.content || '')
    ),
    [activeTab?.content, activeTab?.originalContent]
  )

  const getModeRenderKey = useCallback((mode: PrewarmTargetMode) => {
    if (!activeTab?.id) return null
    const base = `${activeTab.id}:${activeContentSignature}`
    return mode === 'diff-preview'
      ? `${mode}:${base}:${activeOriginalSignature}`
      : `${mode}:${base}`
  }, [activeContentSignature, activeOriginalSignature, activeTab?.id])

  const warmScope = activeTab?.id
    ? `${activeTab.id}:${activeContentSignature}:${activeOriginalSignature}`
    : null
  if (warmScopeRef.current !== warmScope) {
    warmScopeRef.current = warmScope
    warmedModeKeysRef.current.clear()
  }

  const rememberWarmMode = (mode: PrewarmTargetMode) => {
    const key = getModeRenderKey(mode)
    if (key) warmedModeKeysRef.current.add(key)
  }
  if (leftPreviewVisible) {
    rememberWarmMode('preview')
    if (viewMode === 'edit-preview') rememberWarmMode('edit-preview')
    if (viewMode === 'dual-preview') rememberWarmMode('dual-preview')
  }
  if (viewMode === 'diff-preview') {
    rememberWarmMode('diff-preview')
  }

  const updateEditorHeading = useCallback((view: EditorView) => {
    const line = getEditorTopLine(view)
    if (typeof line !== 'number') return
    const headingId = getHeadingIdAtLine(toc, line)
    setActiveEditorHeading((current) => current === headingId ? current : headingId)
  }, [toc])

  // 使用 IntersectionObserver 监听当前活跃的标题
  // 传递 viewMode 作为 trigger，当模式切换时重新检查容器
  const activeHeading = useActiveHeading(
    leftPreviewRef,
    '[data-heading-id]',
    `${viewMode}:${activeTab?.id ?? ''}:${activePreview.version}`,
    leftPreviewVisible
  )
  const activeRightHeading = useActiveHeading(
    rightPreviewRef,
    '[data-heading-id]',
    `${viewMode}:${rightTab?.id ?? ''}:${rightPreview.version}`,
    viewMode === 'dual-preview'
  )

  const cancelModePrewarm = useCallback(() => {
    prewarmCancelRef.current += 1
    lastUserActivityAtRef.current = Date.now()
  }, [])

  useEffect(() => {
    const handleActivity = () => cancelModePrewarm()
    window.addEventListener('keydown', handleActivity, true)
    window.addEventListener('pointerdown', handleActivity, true)
    window.addEventListener('wheel', handleActivity, { capture: true, passive: true })
    window.addEventListener('scroll', handleActivity, { capture: true, passive: true })
    return () => {
      window.removeEventListener('keydown', handleActivity, true)
      window.removeEventListener('pointerdown', handleActivity, true)
      window.removeEventListener('wheel', handleActivity, { capture: true })
      window.removeEventListener('scroll', handleActivity, { capture: true })
    }
  }, [cancelModePrewarm])

  useEffect(() => {
    cancelModePrewarm()
  }, [viewMode, cancelModePrewarm])

  useEffect(() => {
    if (modePrewarm === 'off') setPrewarmedModeKeys({})
  }, [modePrewarm])

  useEffect(() => {
    cancelModePrewarm()
    setPrewarmedModeKeys({})
  }, [activeTab?.id, activeTab?.content, activeTab?.originalContent, cancelModePrewarm])

  useEffect(() => {
    if (!activeTab?.id || modePrewarm === 'off' || viewMode === 'edit') return
    if (activePreview.pending || rightPreview.pending) return

    const target = getNextPrewarmTarget({
      activeMode: viewMode,
      contentLength: activeTab.content.length,
      diffLineCount: activeDiffLineCount,
      level: modePrewarm,
      resolveKey: getModeRenderKey,
      warmedKeys: new Set([
        ...warmedModeKeysRef.current,
        ...Object.values(prewarmedModeKeysRef.current).filter((key): key is string => Boolean(key)),
      ]),
      usage: viewModeUsage,
    })
    if (!target) return

    const token = prewarmCancelRef.current
    const timer = window.setTimeout(() => {
      const idleSince = Date.now() - lastUserActivityAtRef.current
      if (prewarmCancelRef.current !== token || idleSince < MODE_PREWARM_ACTIVITY_PAUSE) return
      scheduleIdlePrewarm(() => {
        if (prewarmCancelRef.current !== token) return
        const key = getModeRenderKey(target)
        if (!key) return
        setPrewarmedModeKeys((current) => (
          current[target] === key
            ? current
            : { ...current, [target]: key }
        ))
      })
    }, MODE_PREWARM_IDLE_DELAY)

    return () => window.clearTimeout(timer)
  }, [
    activeDiffLineCount,
    activePreview.pending,
    activeTab?.content.length,
    activeTab?.id,
    getModeRenderKey,
    modePrewarm,
    prewarmedModeKeys,
    rightPreview.pending,
    viewMode,
    viewModeUsage,
  ])

  const getStoredPreviewTop = useCallback((tabId: string | null | undefined) => {
    if (!tabId) return 0
    const position = readingPositionsRef.current[tabId]
    return position?.previewScrollTop ?? 0
  }, [])

  const getStoredEditorTop = useCallback((tabId: string | null | undefined) => {
    if (!tabId) return 0
    return readingPositionsRef.current[tabId]?.editorScrollTop ?? 0
  }, [])

  const saveReadingPosition = useCallback((tabId: string, position: ReadingPosition) => {
    readingPositionsRef.current[tabId] = {
      ...readingPositionsRef.current[tabId],
      ...position,
    }
  }, [])

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
    && getStoredPreviewTop(rightTab.id) > 0
  )

  const saveEditorReadingPosition = useCallback((tabId: string) => {
    const view = editorViewRef.current
    if (!view) return
    saveReadingPosition(tabId, {
      editorScrollTop: view.scrollDOM.scrollTop,
      topLine: getEditorTopLine(view),
    })
  }, [saveReadingPosition])

  const savePreviewReadingPosition = useCallback((
    tabId: string,
    container: HTMLElement | null,
    previewVersion: number
  ) => {
    if (isRestoringScrollRef.current) return
    if (!container) return
    saveReadingPosition(tabId, {
      previewScrollTop: container.scrollTop,
      topLine: getPreviewLineAtTop(container, previewVersion, previewAnchorCacheRef.current),
    })
  }, [saveReadingPosition])

  const withRestoreLock = useCallback((restore: () => void) => {
    isRestoringScrollRef.current = true
    restore()
    if (restoreScrollFrameRef.current !== null) {
      window.cancelAnimationFrame(restoreScrollFrameRef.current)
    }
    restoreScrollFrameRef.current = window.requestAnimationFrame(() => {
      isRestoringScrollRef.current = false
      restoreScrollFrameRef.current = null
    })
  }, [])

  const schedulePreviewReveal = useCallback((tabId?: string) => {
    if (tabId) { clearPreviewSwitching(tabId) }
    setPreviewRestoreTick((tick) => tick + 1)
  }, [clearPreviewSwitching])

  const restoreEditorReadingPosition = useCallback((tabId: string) => {
    const view = editorViewRef.current
    const position = readingPositionsRef.current[tabId]
    if (!view || !position) return

    if (editorRestoreFrameRef.current !== null) {
      window.cancelAnimationFrame(editorRestoreFrameRef.current)
    }
    editorRestoreFrameRef.current = window.requestAnimationFrame(() => {
      editorRestoreFrameRef.current = null
      const currentMode = useEditorStore.getState().viewMode
      if (editorViewRef.current !== view || (currentMode !== 'edit' && currentMode !== 'edit-preview')) return
      if (typeof position.topLine === 'number' && position.topLine <= view.state.doc.lines) {
        const pos = view.state.doc.line(position.topLine).from
        view.dispatch({
          effects: EditorView.scrollIntoView(pos, { y: 'start', yMargin: SCROLL_SYNC_TOP_OFFSET }),
        })
      } else if (typeof position.editorScrollTop === 'number') {
        view.scrollDOM.scrollTop = position.editorScrollTop
      }
    })
  }, [])

  const restorePreviewReadingPosition = useCallback((
    tabId: string,
    container: HTMLElement | null,
    pane: 'left' | 'right'
  ) => {
    const position = readingPositionsRef.current[tabId]
    if (!container) return
    const lineTop = position?.previewScrollTop === undefined && position?.topLine
      ? getPreviewTopForLine(container, position.topLine)
      : undefined
    const nextTop = position?.previewScrollTop
      ?? (typeof lineTop === 'number' ? Math.max(0, lineTop - SCROLL_SYNC_TOP_OFFSET) : 0)
    withRestoreLock(() => {
      container.scrollTop = nextTop
    })
    restoredPreviewKeysRef.current[pane] = tabId
    schedulePreviewReveal(tabId)
  }, [schedulePreviewReveal, withRestoreLock])

  useEffect(() => {
    if (!activeTab?.id || (viewMode !== 'edit' && viewMode !== 'edit-preview')) return
    let view: EditorView | null = null
    const handleScroll = () => {
      const currentMode = useEditorStore.getState().viewMode
      if (currentMode !== 'edit' && currentMode !== 'edit-preview') return
      saveEditorReadingPosition(activeTab.id)
      setTocFocus('editor')
      if (editorTocFrameRef.current !== null || !view) return
      editorTocFrameRef.current = window.requestAnimationFrame(() => {
        editorTocFrameRef.current = null
        if (view) updateEditorHeading(view)
      })
    }
    let frame = window.requestAnimationFrame(() => {
      view = editorViewRef.current
      if (!view) return
      updateEditorHeading(view)
      view.scrollDOM.addEventListener('scroll', handleScroll, { passive: true })
    })

    return () => {
      window.cancelAnimationFrame(frame)
      if (view) {
        view.scrollDOM.removeEventListener('scroll', handleScroll)
      }
      if (editorTocFrameRef.current !== null) {
        window.cancelAnimationFrame(editorTocFrameRef.current)
        editorTocFrameRef.current = null
      }
    }
  }, [activeTab?.id, saveEditorReadingPosition, updateEditorHeading, viewMode])

  useLayoutEffect(() => {
    if (!activeTab?.id) return
    const restoreStartedAt = import.meta.env.DEV ? performance.now() : 0
    if (viewMode === 'edit' || viewMode === 'edit-preview') {
      restoreEditorReadingPosition(activeTab.id)
    }
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
    restoreEditorReadingPosition,
    restorePreviewReadingPosition,
    rightPreview.version,
    rightTab?.id,
    viewMode,
  ])

  const clearPreviewContextHighlight = useCallback(() => {
    if (typeof CSS !== 'undefined' && CSS.highlights) {
      CSS.highlights.delete(PREVIEW_CONTEXT_HIGHLIGHT)
    }
  }, [])

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

  useEffect(() => clearPreviewContextHighlight, [clearPreviewContextHighlight])

  useEffect(() => () => {
    if (scrollSyncTimerRef.current !== null) {
      window.clearTimeout(scrollSyncTimerRef.current)
      scrollSyncTimerRef.current = null
    }
    if (restoreScrollFrameRef.current !== null) {
      window.cancelAnimationFrame(restoreScrollFrameRef.current)
      restoreScrollFrameRef.current = null
    }
    if (editorRestoreFrameRef.current !== null) {
      window.cancelAnimationFrame(editorRestoreFrameRef.current)
      editorRestoreFrameRef.current = null
    }
  }, [])

  const handleEditorChange = useCallback(
    (content: string) => {
      lastEditorInputAtRef.current = Date.now()
      if (activeTabId) updateTabContent(activeTabId, content)
    },
    [activeTabId, updateTabContent]
  )

  const setScrollSyncSource = useCallback((source: 'editor' | 'preview') => {
    scrollSyncSourceRef.current = source
    if (scrollSyncTimerRef.current !== null) {
      window.clearTimeout(scrollSyncTimerRef.current)
    }
    scrollSyncTimerRef.current = window.setTimeout(() => {
      scrollSyncSourceRef.current = null
      scrollSyncTimerRef.current = null
    }, SCROLL_SYNC_LOCK_MS)
  }, [])

  const syncPreviewToEditorLine = useCallback((line: number) => {
    const container = leftPreviewRef.current
    if (!container) return

    const targetTop = getPreviewTopForLine(container, line)
    if (typeof targetTop !== 'number') return

    setScrollSyncSource('editor')
    container.scrollTo({ top: Math.max(0, targetTop - SCROLL_SYNC_TOP_OFFSET) })
  }, [activePreview.version, setScrollSyncSource])

  const syncEditorToPreviewLine = useCallback((line: number) => {
    const view = editorViewRef.current
    if (!view || line < 1 || line > view.state.doc.lines) return

    const pos = view.state.doc.line(line).from
    setScrollSyncSource('preview')
    view.dispatch({
      effects: EditorView.scrollIntoView(pos, { y: 'start', yMargin: SCROLL_SYNC_TOP_OFFSET }),
    })
  }, [setScrollSyncSource])

  useEffect(() => {
    if (viewMode !== 'edit-preview' || !syncScroll) return
    const view = editorViewRef.current
    const preview = leftPreviewRef.current
    if (!view || !preview) return

    const handleEditorScroll = () => {
      if (scrollSyncSourceRef.current === 'preview') return
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
      if (scrollSyncSourceRef.current === 'editor') return
      if (Date.now() - lastEditorInputAtRef.current < SCROLL_SYNC_INPUT_PAUSE_MS) return
      if (previewScrollFrameRef.current !== null) return
      previewScrollFrameRef.current = window.requestAnimationFrame(() => {
        previewScrollFrameRef.current = null
        const line = getPreviewLineAtTop(preview, activePreview.version, previewAnchorCacheRef.current)
        if (typeof line === 'number') {
          syncEditorToPreviewLine(line)
        }
      })
    }

    view.scrollDOM.addEventListener('scroll', handleEditorScroll, { passive: true })
    preview.addEventListener('scroll', handlePreviewScroll, { passive: true })

    return () => {
      view.scrollDOM.removeEventListener('scroll', handleEditorScroll)
      preview.removeEventListener('scroll', handlePreviewScroll)
      if (editorScrollFrameRef.current !== null) {
        window.cancelAnimationFrame(editorScrollFrameRef.current)
        editorScrollFrameRef.current = null
      }
      if (previewScrollFrameRef.current !== null) {
        window.cancelAnimationFrame(previewScrollFrameRef.current)
        previewScrollFrameRef.current = null
      }
    }
  }, [activeTab?.id, activePreview.version, syncEditorToPreviewLine, syncPreviewToEditorLine, syncScroll, viewMode])

  const handleSave = useCallback(async () => {
    if (!activeTab) return
    try {
      if (activeTab.filePath) {
        await saveFile(activeTab.filePath, activeTab.content)
        scheduleMarkdownDocumentIndex(activeTab.filePath, activeTab.title, activeTab.content)
        useEditorStore.setState((s) => ({
          tabs: s.tabs.map((t) =>
            t.id === activeTab.id ? { ...t, savedContent: activeTab.content, modified: false } : t
          ),
        }))
        toast.success('已保存')
      } else {
        const { saveFileAs } = await import('@/services/fileSystem')
        const result = await saveFileAs(activeTab.content)
        if (result) {
          scheduleMarkdownDocumentIndex(result.path, result.name, result.content)
          useEditorStore.setState((s) => ({
            tabs: s.tabs.map((t) =>
              t.id === activeTab.id
                ? { ...t, filePath: result.path, title: result.name, savedContent: result.content, modified: false }
                : t
            ),
          }))
          toast.success('已保存')
        }
      }
    } catch (err) {
      console.error('Save failed:', err)
      toast.error(describeFileOperationError(err, '保存失败'))
    }
  }, [activeTab])

  const persistTabContent = useCallback(async (tabId: string, nextContent: string) => {
    const targetTab = useEditorStore.getState().tabs.find((tab) => tab.id === tabId)
    if (!targetTab) return

    updateTabContent(tabId, nextContent)

    if (!targetTab.filePath) return

    try {
      await saveFile(targetTab.filePath, nextContent)
      scheduleMarkdownDocumentIndex(targetTab.filePath, targetTab.title, nextContent)
      useEditorStore.setState((state) => ({
        tabs: state.tabs.map((tab) =>
          tab.id === tabId
            ? { ...tab, content: nextContent, savedContent: nextContent, modified: false }
            : tab
        ),
      }))
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

  const handleRightTaskToggle = useCallback((line: number, checked: boolean) => {
    if (!rightTab?.id) return
    const tab = useEditorStore.getState().tabs.find((item) => item.id === rightTab.id)
    if (tab) void handleTaskToggle(tab.id, tab.content, line, checked)
  }, [handleTaskToggle, rightTab?.id])

  const handleLeftPreviewScroll = useCallback(() => {
    if (!activeTab?.id) return
    if (viewModeRef.current === 'edit-preview') setTocFocus('preview')
    savePreviewReadingPosition(activeTab.id, leftPreviewRef.current, activePreview.version)
  }, [activePreview.version, activeTab?.id, savePreviewReadingPosition])

  const handleRightPreviewScroll = useCallback(() => {
    if (!rightTab?.id) return
    savePreviewReadingPosition(rightTab.id, rightPreviewRef.current, rightPreview.version)
  }, [rightPreview.version, rightTab?.id, savePreviewReadingPosition])

  const jumpToLine = useCallback((line: number) => {
    const view = editorViewRef.current
    if (!view || line < 1 || line > view.state.doc.lines) return
    const pos = view.state.doc.line(line).from
    view.dispatch({
      selection: { anchor: pos },
      effects: EditorView.scrollIntoView(pos, { y: 'start' }),
    })
    view.focus()
  }, [])

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
    const container = leftPreviewRef.current
    const heading = container?.querySelector<HTMLElement>(`[data-md-line="${item.line}"]`)
    if (!container || !heading) return
    const targetTop = heading.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop - 24
    container.scrollTo({ top: Math.max(0, targetTop), behavior: 'smooth' })
  }, [])

  const jumpToRightPreviewHeading = useCallback((item: TocItem) => {
    const container = rightPreviewRef.current
    const heading = container?.querySelector<HTMLElement>(`[data-md-line="${item.line}"]`)
    if (!container || !heading) return
    const targetTop = heading.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop - 24
    container.scrollTo({ top: Math.max(0, targetTop), behavior: 'smooth' })
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

  const getPreviewSelectionLineRange = useCallback((selection: Selection, container: HTMLElement): { startLine?: number, endLine?: number } => {
    if (!selection || selection.rangeCount === 0) return {}

    const range = selection.getRangeAt(0)

    // 向上查找带 data-md-line 的元素
    const findLineElement = (node: Node | null): HTMLElement | null => {
      let current = node instanceof HTMLElement ? node : node?.parentElement
      while (current && current !== container) {
        if (current.hasAttribute?.('data-md-line')) return current
        current = current.parentElement
      }
      return null
    }

    const startEl = findLineElement(range.startContainer)
    const endEl = findLineElement(range.endContainer)
    const readLine = (element: HTMLElement | null, attribute: 'data-md-line' | 'data-md-end-line') => {
      const value = Number(element?.getAttribute(attribute))
      return Number.isFinite(value) && value > 0 ? value : undefined
    }
    const firstLine = readLine(startEl, 'data-md-line')
    const lastLine = readLine(endEl, 'data-md-end-line') ?? readLine(endEl, 'data-md-line')
    if (firstLine === undefined) return { startLine: lastLine, endLine: lastLine }
    if (lastLine === undefined) return { startLine: firstLine, endLine: firstLine }
    return {
      startLine: Math.min(firstLine, lastLine),
      endLine: Math.max(firstLine, lastLine),
    }
  }, [])

  const handlePreviewContextMenu = useCallback((
    e: React.MouseEvent<HTMLDivElement>,
    pane: 'left' | 'right'
  ) => {
    e.preventDefault()
    const container = pane === 'left' ? leftPreviewRef.current : rightPreviewRef.current
    const selection = window.getSelection()
    const selectedText = container && selection && selection.rangeCount > 0
      && container.contains(selection.anchorNode) && container.contains(selection.focusNode)
      ? selection.toString()
      : ''

    // 获取行号范围
    let startLine: number | undefined
    let endLine: number | undefined
    if (selectedText && selection && container) {
      const lineRange = getPreviewSelectionLineRange(selection, container)
      startLine = lineRange.startLine
      endLine = lineRange.endLine
    }

    clearPreviewContextHighlight()
    if (selectedText && selection && typeof CSS !== 'undefined' && CSS.highlights) {
      CSS.highlights.set(PREVIEW_CONTEXT_HIGHLIGHT, new Highlight(selection.getRangeAt(0).cloneRange()))
    }
    setPreviewMenu({ x: e.clientX, y: e.clientY, selectedText, startLine, endLine, pane })
  }, [clearPreviewContextHighlight, getPreviewSelectionLineRange])

  const handleCopyPreviewSelection = useCallback(() => {
    if (previewMenu?.selectedText) {
      void navigator.clipboard.writeText(previewMenu.selectedText)
    }
    clearPreviewContextHighlight()
    setPreviewMenu(null)
  }, [clearPreviewContextHighlight, previewMenu])

  const handleSelectAllPreview = useCallback(() => {
    const container = previewMenu?.pane === 'right' ? rightPreviewRef.current : leftPreviewRef.current
    if (!container) return
    const selection = window.getSelection()
    const range = document.createRange()
    range.selectNodeContents(container)
    selection?.removeAllRanges()
    selection?.addRange(range)
    clearPreviewContextHighlight()
    setPreviewMenu(null)
  }, [clearPreviewContextHighlight, previewMenu])

  const getPreviewSourceSelection = useCallback((): PreviewSelectionSource | null => {
    if (!previewMenu?.selectedText) return null

    const tab = previewMenu.pane === 'right' ? rightTab : activeTab
    if (!tab) return null

    const selectedText = previewMenu.selectedText.trim()
    if (!selectedText) return null

    const content = tab.content
    const normalizedSelectedText = selectedText.replace(/\r\n/g, '\n')
    const lines = content.split('\n')
    const startLine = previewMenu.startLine
    const endLine = previewMenu.endLine

    const findUniqueRange = (source: string, needle: string, baseOffset = 0) => {
      const variants = [...new Set([needle, needle.replace(/\n/g, '\r\n')])]
      const matches = variants.flatMap((variant) => {
        if (!variant) return []
        const indexes: number[] = []
        let index = source.indexOf(variant)
        while (index >= 0 && indexes.length < 2) {
          indexes.push(index)
          index = source.indexOf(variant, index + variant.length)
        }
        return indexes.map((from) => ({ from, to: from + variant.length }))
      })
      const uniqueMatches = matches.filter((match, index) => (
        matches.findIndex((candidate) => candidate.from === match.from && candidate.to === match.to) === index
      ))
      return uniqueMatches.length === 1
        ? { from: baseOffset + uniqueMatches[0].from, to: baseOffset + uniqueMatches[0].to }
        : null
    }

    const offsetForLine = (line: number) => {
      let offset = 0
      for (let i = 0; i < Math.max(0, line - 1); i++) {
        offset += lines[i].length + 1
      }
      return offset
    }

    let range: { from: number; to: number } | null = null
    let markdownText = ''

    if (startLine && endLine) {
      const safeStart = Math.max(1, Math.min(startLine, lines.length))
      const safeEnd = Math.max(safeStart, Math.min(endLine, lines.length))
      const from = offsetForLine(safeStart)
      const to = offsetForLine(safeEnd) + lines[safeEnd - 1].length
      markdownText = content.slice(from, to)
      range = findUniqueRange(markdownText, normalizedSelectedText, from)
      if (!range) {
        range = { from, to }
      }
    }

    range = range || findUniqueRange(content, normalizedSelectedText)

    const sourceText = range ? content.slice(range.from, range.to) : normalizedSelectedText

    return {
      title: tab.title,
      filePath: tab.filePath,
      text: sourceText || markdownText || normalizedSelectedText,
      startLine,
      endLine,
      selectionFrom: range?.from,
      selectionTo: range?.to,
    }
  }, [activeTab, previewMenu, rightTab])

  const handleAddPreviewSelectionToAi = useCallback(() => {
    if (!previewMenu?.selectedText) return
    const sourceSelection = getPreviewSourceSelection()
    if (!sourceSelection) return
    if (typeof sourceSelection.selectionFrom !== 'number' || typeof sourceSelection.selectionTo !== 'number') {
      toast.warning('预览选区无法精确定位，修改文本请切到编辑模式框选。')
    }
    addSelectionContextTag({
      title: sourceSelection.title,
      filePath: sourceSelection.filePath,
      text: sourceSelection.text,
      startLine: sourceSelection.startLine,
      endLine: sourceSelection.endLine,
      selectionFrom: sourceSelection.selectionFrom,
      selectionTo: sourceSelection.selectionTo,
    })
    clearPreviewContextHighlight()
    setPreviewMenu(null)
  }, [previewMenu, clearPreviewContextHighlight, getPreviewSourceSelection])

  const handlePreviewAiAction = useCallback((prompt: string) => {
    if (!previewMenu?.selectedText) return
    const sourceSelection = getPreviewSourceSelection()
    if (!sourceSelection) return
    if (typeof sourceSelection.selectionFrom !== 'number' || typeof sourceSelection.selectionTo !== 'number') {
      toast.warning('预览选区无法精确定位，修改文本请切到编辑模式框选。')
      return
    }
    addSelectionContextTag({
      title: sourceSelection.title,
      filePath: sourceSelection.filePath,
      text: sourceSelection.text,
      startLine: sourceSelection.startLine,
      endLine: sourceSelection.endLine,
      selectionFrom: sourceSelection.selectionFrom,
      selectionTo: sourceSelection.selectionTo,
    })
    setAiShortcutPrompt(prompt)
    clearPreviewContextHighlight()
    setPreviewMenu(null)
  }, [previewMenu, clearPreviewContextHighlight, getPreviewSourceSelection])

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
    const panes: React.RefObject<HTMLDivElement>[] = []
    if (leftPreviewVisible && leftPreviewRef.current) panes.push(leftPreviewRef)
    if (viewMode === 'dual-preview' && rightPreviewRef.current) panes.push(rightPreviewRef)
    return { previewPanes: panes }
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-gm-canvas">
      {!isFullscreen && <TabBar />}

      <div className="flex-1 flex overflow-hidden relative">
        {tabs.length === 0 ? (
          <WelcomeScreen />
        ) : (
          <>
            {(viewMode === 'diff-preview' || prewarmDiffPreview) && (
              <div className={viewMode === 'diff-preview' ? 'flex min-w-0 flex-1' : 'hidden'}>
                <MarkdownDiffView
                  original={activeTab?.originalContent || ''}
                  current={activeTab?.content || ''}
                  fontSize={editorFontSize}
                  lineHeight={editorLineHeight}
                  fontFamily={editorFontFamily}
                  wordWrap={editorWordWrap}
                  lineNumbers={editorLineNumbers}
                />
              </div>
            )}
            <div className={`${viewMode === 'diff-preview' ? 'hidden' : 'flex'} flex-1 overflow-hidden bg-gm-surface`}>
            <div className={`${editorVisible ? (viewMode === 'edit-preview' ? 'min-w-0 flex-1 border-r border-gm-border-subtle' : 'flex-1') : 'hidden'} overflow-hidden relative`}>
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

            {leftPreviewMountedRef.current && (
              <div
                ref={leftPreviewRef}
                className={`${leftPreviewVisible ? 'min-w-0 flex-1' : 'hidden'} ${viewMode === 'dual-preview' ? 'border-r border-gm-border-subtle' : ''} ${viewMode === 'edit-preview' ? 'gm-preview-heading-clickable' : ''} overflow-auto p-6 select-text bg-gm-surface relative`}
                style={leftPreviewMasked ? { visibility: 'hidden' } : undefined}
                aria-hidden={!leftPreviewVisible}
                onScroll={handleLeftPreviewScroll}
                onContextMenu={(e) => handlePreviewContextMenu(e, 'left')}
              >
                {viewMode === 'dual-preview' && <PaneHeader title={activeTab?.title || ''} />}
                <MarkdownPreview
                  content={leftPreviewRenderRef.current.content}
                  filePath={leftPreviewRenderRef.current.filePath}
                  fontSize={editorFontSize}
                  lineHeight={editorLineHeight}
                  onHeadingClick={handleLeftPreviewHeadingClick}
                  onTaskToggle={activeTab ? handleActiveTaskToggle : undefined}
                />
              </div>
            )}

            {rightPreviewMountedRef.current && (
            <div
              ref={rightPreviewRef}
              className={`${viewMode === 'dual-preview' ? 'min-w-0 flex-1' : 'hidden'} overflow-auto p-6 select-text bg-gm-surface relative ${rightPaneDragOver ? 'ring-2 ring-inset ring-gm-primary/40' : ''}`}
              style={rightPreviewMasked ? { visibility: 'hidden' } : undefined}
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
                <MarkdownPreview
                  content={rightPreview.content}
                  filePath={rightTab.filePath}
                  fontSize={editorFontSize}
                  lineHeight={editorLineHeight}
                  onTaskToggle={handleRightTaskToggle}
                />
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
          <ContextMenu position={previewMenu} onClose={() => {
            clearPreviewContextHighlight()
            setPreviewMenu(null)
          }} minWidth={176} maxWidth={176}>
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
                <ContextMenuItem onClick={() => handlePreviewAiAction('请解释这段内容')}>
                  AI 解释这段
                </ContextMenuItem>
                <ContextMenuItem onClick={() => handlePreviewAiAction('请结合上下文解释这段内容，优先读取选区附近内容，不要默认阅读全文')}>
                  AI 结合上下文解释
                </ContextMenuItem>
                <ContextMenuItem onClick={() => handlePreviewAiAction('请总结这段内容')}>
                  AI 总结这段
                </ContextMenuItem>
                <ContextMenuItem onClick={() => handlePreviewAiAction('请改写这段内容，使其更清晰')}>
                  AI 改写这段
                </ContextMenuItem>
                <ContextMenuItem onClick={() => handlePreviewAiAction('请优化选中文本的 Markdown 格式：可以调整标题、列表、引用、代码块、表格等 Markdown 标记；不得改变原文内容、语义和顺序，不得新增信息。')}>
                  AI 优化格式
                </ContextMenuItem>
                <ContextMenuItem onClick={() => handlePreviewAiAction('请翻译这段内容')}>
                  AI 翻译
                </ContextMenuItem>
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

interface PreviewLineAnchor {
  line: number
  endLine: number | undefined
  top: number
  height: number
}

interface PreviewAnchorCache {
  version: number
  clientWidth: number
  scrollHeight: number
  anchors: PreviewLineAnchor[]
}

function getVisiblePreviewAnchors(container: HTMLElement): PreviewLineAnchor[] {
  const containerRect = container.getBoundingClientRect()
  return Array.from(container.querySelectorAll<HTMLElement>('[data-md-line]'))
    .map((element) => {
      const line = Number(element.dataset.mdLine)
      if (!Number.isFinite(line) || line < 1) return null
      const endLine = Number(element.dataset.mdEndLine)
      const rect = element.getBoundingClientRect()
      const style = window.getComputedStyle(element)
      if (
        style.display === 'none'
        || style.visibility === 'hidden'
        || (rect.width === 0 && rect.height === 0)
      ) {
        return null
      }
      return {
        line,
        endLine: Number.isFinite(endLine) && endLine >= line ? endLine : undefined,
        top: rect.top - containerRect.top + container.scrollTop,
        height: rect.height,
      }
    })
    .filter((item): item is PreviewLineAnchor => Boolean(item))
    .sort((a, b) => a.top - b.top || a.line - b.line)
}

function getCachedPreviewAnchors(
  container: HTMLElement,
  version: number,
  cache: WeakMap<HTMLElement, PreviewAnchorCache>
): PreviewLineAnchor[] {
  const cached = cache.get(container)
  if (
    cached?.version === version
    && cached.clientWidth === container.clientWidth
    && cached.scrollHeight === container.scrollHeight
  ) {
    return cached.anchors
  }

  const anchors = getVisiblePreviewAnchors(container)
  cache.set(container, {
    version,
    clientWidth: container.clientWidth,
    scrollHeight: container.scrollHeight,
    anchors,
  })
  return anchors
}

function getPreviewTopForLine(
  container: HTMLElement,
  line: number
): number | undefined {
  let previousElement: HTMLElement | undefined
  let previousLine = -1
  let nextElement: HTMLElement | undefined
  let nextLine = Number.POSITIVE_INFINITY

  for (const element of container.querySelectorAll<HTMLElement>('[data-md-line]')) {
    const elementLine = Number(element.dataset.mdLine)
    if (!Number.isFinite(elementLine) || elementLine < 1) continue
    if (elementLine <= line && elementLine > previousLine) {
      previousElement = element
      previousLine = elementLine
    } else if (elementLine > line && elementLine < nextLine) {
      nextElement = element
      nextLine = elementLine
    }
  }

  const anchorElement = previousElement ?? nextElement
  if (!anchorElement) return undefined
  const containerTop = container.getBoundingClientRect().top
  const anchorRect = anchorElement.getBoundingClientRect()
  const anchorTop = anchorRect.top - containerTop + container.scrollTop
  const endLine = Number(anchorElement.dataset.mdEndLine)
  if (previousElement && Number.isFinite(endLine) && endLine > previousLine && line <= endLine) {
    const progress = (line - previousLine) / (endLine - previousLine)
    return anchorTop + anchorRect.height * progress
  }

  if (previousElement && nextElement && nextLine !== previousLine) {
    const nextTop = nextElement.getBoundingClientRect().top - containerTop + container.scrollTop
    const progress = (line - previousLine) / (nextLine - previousLine)
    return anchorTop + (nextTop - anchorTop) * Math.max(0, Math.min(1, progress))
  }

  return anchorTop
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

function getPreviewLineAtTop(
  container: HTMLElement,
  version: number,
  cache: WeakMap<HTMLElement, PreviewAnchorCache>
): number | undefined {
  const anchors = getCachedPreviewAnchors(container, version, cache)
  if (anchors.length === 0) return undefined

  const targetTop = container.scrollTop + SCROLL_SYNC_TOP_OFFSET
  let previous = anchors[0]
  let next: PreviewLineAnchor | undefined
  for (const anchor of anchors) {
    if (anchor.top <= targetTop) {
      previous = anchor
      continue
    }
    next = anchor
    break
  }

  if (previous.endLine && previous.endLine > previous.line && previous.height > 0) {
    const progress = Math.max(0, Math.min(1, (targetTop - previous.top) / previous.height))
    return Math.round(previous.line + (previous.endLine - previous.line) * progress)
  }

  if (next && next.line !== previous.line) {
    const gap = Math.max(1, next.top - previous.top)
    const progress = Math.max(0, Math.min(1, (targetTop - previous.top) / gap))
    return Math.round(previous.line + (next.line - previous.line) * progress)
  }

  return previous.line
}

function getNextPrewarmTarget({
  activeMode,
  contentLength,
  diffLineCount,
  level,
  resolveKey,
  warmedKeys,
  usage,
}: {
  activeMode: ViewMode
  contentLength: number
  diffLineCount: number
  level: 'smart' | 'turbo'
  resolveKey: (mode: PrewarmTargetMode) => string | null
  warmedKeys: Set<string>
  usage: Partial<Record<PrewarmTargetMode, ViewModeUsageStat>>
}): PrewarmTargetMode | null {
  const extraCount = level === 'smart' ? 1 : 2
  const targets: PrewarmTargetMode[] = ['preview']

  if (contentLength < MODE_PREWARM_HUGE_DOC_LENGTH) {
    targets.push(...getFrequentPrewarmModes(usage).slice(0, extraCount))
  }

  for (const target of targets) {
    if (target === activeMode) continue
    if (target === 'diff-preview' && diffLineCount > MODE_PREWARM_DIFF_LINE_LIMIT) continue
    const key = resolveKey(target)
    if (key && !warmedKeys.has(key)) return target
  }

  return null
}

function getFrequentPrewarmModes(
  usage: Partial<Record<PrewarmTargetMode, ViewModeUsageStat>>
): PrewarmTargetMode[] {
  const fallbackOrder: PrewarmTargetMode[] = ['edit-preview', 'dual-preview', 'diff-preview']
  return fallbackOrder
    .map((mode, index) => ({
      mode,
      index,
      count: usage[mode]?.count ?? 0,
      lastUsedAt: usage[mode]?.lastUsedAt ?? 0,
    }))
    .sort((a, b) => b.count - a.count || b.lastUsedAt - a.lastUsedAt || a.index - b.index)
    .map((item) => item.mode)
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

function scheduleIdlePrewarm(callback: () => void) {
  const idleWindow = window as Window & {
    requestIdleCallback?: (cb: IdleRequestCallback, options?: IdleRequestOptions) => number
  }
  if (idleWindow.requestIdleCallback) {
    idleWindow.requestIdleCallback(callback, { timeout: 900 })
    return
  }
  window.setTimeout(callback, 120)
}

function PaneHeader({ title, onClose }: { title: string; onClose?: () => void }) {
  return (
    <div className="flex items-center justify-between mb-4 pb-2 border-b border-gm-border-subtle">
      <div className="flex items-center gap-2">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#19c8b9" strokeWidth="1.5">
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
