import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { EditorView } from '@codemirror/view'
import { Card } from 'animal-island-ui'
import { useAppStore } from '@/stores/appStore'
import { useEditorStore } from '@/stores/editorStore'
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

interface ScheduledPreviewContent {
  content: string
  version: number
  pending: boolean
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
  const saveReadingPosition = useEditorStore((s) => s.saveReadingPosition)
  const previewSwitchingTabId = useEditorStore((s) => s.previewSwitchingTabId)
  const clearPreviewSwitching = useEditorStore((s) => s.clearPreviewSwitching)
  const editorFontSize = useSettingsStore((s) => s.editor.fontSize)
  const editorLineHeight = useSettingsStore((s) => s.editor.lineHeight)
  const syncScroll = useSettingsStore((s) => s.editor.syncScroll)
  const editorViewRef = useRef<EditorView | null>(null)
  const leftPreviewRef = useRef<HTMLDivElement>(null)
  const rightPreviewRef = useRef<HTMLDivElement>(null)
  const previewAnchorCacheRef = useRef<WeakMap<HTMLElement, { version: number; anchors: PreviewLineAnchor[] }>>(new WeakMap())
  const isRestoringScrollRef = useRef(false)
  const restoreScrollFrameRef = useRef<number | null>(null)

  const restoredPreviewKeysRef = useRef<{ left: string | null; right: string | null }>({ left: null, right: null })
  const scrollSyncSourceRef = useRef<'editor' | 'preview' | null>(null)
  const scrollSyncTimerRef = useRef<number | null>(null)
  const editorScrollFrameRef = useRef<number | null>(null)
  const previewScrollFrameRef = useRef<number | null>(null)
  const lastEditorInputAtRef = useRef(0)
  const [, setPreviewRestoreTick] = useState(0)
  const [searchOpen, setSearchOpen] = useState(false)
  const [rightPaneDragOver, setRightPaneDragOver] = useState(false)
  const [tocCollapsed, setTocCollapsed] = useState(false)
  const [previewMenu, setPreviewMenu] = useState<PreviewMenuState | null>(null)

  const activeTab = tabs.find((t) => t.id === activeTabId)
  const selectedRightTab = rightPaneTabId ? tabs.find((t) => t.id === rightPaneTabId) : null
  const rightTab = viewMode === 'dual-preview' && !rightPaneUserSelected
    ? activeTab
    : selectedRightTab
  const activePreview = useScheduledPreviewContent(activeTab?.content || '', activeTab?.id)
  const rightPreview = useScheduledPreviewContent(rightTab?.content || '', rightTab?.id)
  const toc = useMemo(() => extractToc(activeTab?.content || ''), [activeTab?.content])
  const rightToc = useMemo(() => extractToc(rightTab?.content || ''), [rightTab?.content])

  // 使用 IntersectionObserver 监听当前活跃的标题
  // 传递 viewMode 作为 trigger，当模式切换时重新检查容器
  const activeHeading = useActiveHeading(leftPreviewRef, '[data-heading-id]', viewMode)
  const activeRightHeading = useActiveHeading(rightPreviewRef, '[data-heading-id]', viewMode)

  const getStoredReadingTop = useCallback((tabId: string | null | undefined) => {
    if (!tabId) return 0
    const position = useEditorStore.getState().readingPositions[tabId]
    return position?.previewTop ?? position?.editorTop ?? 0
  }, [])

  const leftPreviewMasked = Boolean(
    activeTab?.id
    && (
      previewSwitchingTabId === activeTab.id
      || (
        restoredPreviewKeysRef.current.left !== activeTab.id
        && getStoredReadingTop(activeTab.id) > 0
      )
    )
  )
  const rightPreviewMasked = Boolean(
    rightTab?.id
    && restoredPreviewKeysRef.current.right !== rightTab.id
    && getStoredReadingTop(rightTab.id) > 0
  )

  const saveEditorReadingPosition = useCallback((tabId: string) => {
    const view = editorViewRef.current
    if (!view) return
    saveReadingPosition(tabId, {
      editorTop: view.scrollDOM.scrollTop,
    })
  }, [saveReadingPosition])

  const savePreviewReadingPosition = useCallback((
    tabId: string,
    container: HTMLElement | null
  ) => {
    if (isRestoringScrollRef.current) return
    if (!container) return
    saveReadingPosition(tabId, {
      previewTop: container.scrollTop,
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
    const position = useEditorStore.getState().readingPositions[tabId]
    if (!view || !position) return

    const nextTop = position.editorTop ?? position.previewTop
    if (typeof nextTop === 'number') {
      view.scrollDOM.scrollTop = nextTop
    }
  }, [])

  const restorePreviewReadingPosition = useCallback((
    tabId: string,
    container: HTMLElement | null,
    pane: 'left' | 'right'
  ) => {
    const position = useEditorStore.getState().readingPositions[tabId]
    if (!container) return
    const nextTop = position?.previewTop ?? position?.editorTop ?? 0
    withRestoreLock(() => {
      container.scrollTop = nextTop
    })
    restoredPreviewKeysRef.current[pane] = tabId
    schedulePreviewReveal(tabId)
  }, [schedulePreviewReveal, withRestoreLock])

  useEffect(() => {
    if (!activeTab?.id || (viewMode !== 'edit' && viewMode !== 'edit-preview')) return
    let view: EditorView | null = null
    const handleScroll = () => saveEditorReadingPosition(activeTab.id)
    let frame = window.requestAnimationFrame(() => {
      view = editorViewRef.current
      if (!view) return
      view.scrollDOM.addEventListener('scroll', handleScroll, { passive: true })
    })

    return () => {
      window.cancelAnimationFrame(frame)
      if (view) {
        saveEditorReadingPosition(activeTab.id)
        view.scrollDOM.removeEventListener('scroll', handleScroll)
      }
    }
  }, [activeTab?.id, saveEditorReadingPosition, viewMode])

  useLayoutEffect(() => {
    if (!activeTab?.id) return
    if (viewMode === 'edit' || viewMode === 'edit-preview') {
      restoreEditorReadingPosition(activeTab.id)
    }
    if (viewMode === 'preview' || viewMode === 'edit-preview' || viewMode === 'dual-preview') {
      restorePreviewReadingPosition(activeTab.id, leftPreviewRef.current, 'left')
    }
    if (viewMode === 'dual-preview' && rightTab?.id) {
      restorePreviewReadingPosition(rightTab.id, rightPreviewRef.current, 'right')
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
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
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

    const targetTop = getPreviewTopForLine(container, line, activePreview.version, previewAnchorCacheRef.current)
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
    if (!activeTabId) return
    const tab = useEditorStore.getState().tabs.find((item) => item.id === activeTabId)
    if (tab) void handleTaskToggle(tab.id, tab.content, line, checked)
  }, [activeTabId, handleTaskToggle])

  const handleRightTaskToggle = useCallback((line: number, checked: boolean) => {
    if (!rightTab?.id) return
    const tab = useEditorStore.getState().tabs.find((item) => item.id === rightTab.id)
    if (tab) void handleTaskToggle(tab.id, tab.content, line, checked)
  }, [handleTaskToggle, rightTab?.id])

  const handleLeftPreviewScroll = useCallback(() => {
    if (!activeTab?.id) return
    savePreviewReadingPosition(activeTab.id, leftPreviewRef.current)
  }, [activeTab?.id, savePreviewReadingPosition])

  const handleRightPreviewScroll = useCallback(() => {
    if (!rightTab?.id) return
    savePreviewReadingPosition(rightTab.id, rightPreviewRef.current)
  }, [rightTab?.id, savePreviewReadingPosition])

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

    const anchorNode = selection.anchorNode
    const focusNode = selection.focusNode

    // 向上查找带 data-md-line 的元素
    const findLineElement = (node: Node | null): HTMLElement | null => {
      let current = node instanceof HTMLElement ? node : node?.parentElement
      while (current && current !== container) {
        if (current.hasAttribute?.('data-md-line')) return current
        current = current.parentElement
      }
      return null
    }

    const anchorEl = findLineElement(anchorNode)
    const focusEl = findLineElement(focusNode)

    const startLine = anchorEl ? parseInt(anchorEl.getAttribute('data-md-line')!) : undefined
    const endLineFromFocus = focusEl ? parseInt(focusEl.getAttribute('data-md-line')!) : undefined
    const endLineFromAttr = focusEl ? parseInt(focusEl.getAttribute('data-md-end-line') || '') : undefined

    // 取较大的行号作为结束行
    const endLine = endLineFromFocus !== undefined
      ? Math.max(endLineFromFocus, endLineFromAttr || endLineFromFocus)
      : startLine

    return { startLine, endLine }
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
      const first = source.indexOf(needle)
      if (first < 0) return null
      const second = source.indexOf(needle, first + needle.length)
      if (second >= 0) return null
      return { from: baseOffset + first, to: baseOffset + first + needle.length }
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

    return {
      title: tab.title,
      filePath: tab.filePath,
      text: markdownText || normalizedSelectedText,
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
    if (leftPreviewRef.current) panes.push(leftPreviewRef)
    if (rightPreviewRef.current) panes.push(rightPreviewRef)
    return { previewPanes: panes }
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-gm-canvas">
      <TabBar />

      <div className="flex-1 flex overflow-hidden relative">
        {tabs.length === 0 ? (
          <WelcomeScreen />
        ) : viewMode === 'diff-preview' ? (
          <MarkdownDiffView original={activeTab?.originalContent || ''} current={activeTab?.content || ''} />
        ) : viewMode === 'preview' ? (
          <div className="flex flex-1 overflow-hidden bg-gm-surface">
            <div
              ref={leftPreviewRef}
              className="flex-1 overflow-auto p-6 select-text"
              style={leftPreviewMasked ? { visibility: 'hidden' } : undefined}
              onScroll={handleLeftPreviewScroll}
              onContextMenu={(e) => handlePreviewContextMenu(e, 'left')}
            >
              <MarkdownPreview
                content={activePreview.content}
                filePath={activeTab?.filePath}
                fontSize={editorFontSize}
                lineHeight={editorLineHeight}
                onTaskToggle={activeTab ? handleActiveTaskToggle : undefined}
              />
            </div>
            <MarkdownToc
              toc={toc}
              collapsed={tocCollapsed}
              onToggle={() => setTocCollapsed((collapsed) => !collapsed)}
              onHeadingClick={jumpToPreviewHeading}
              activeHeading={activeHeading}
            />
          </div>
        ) : viewMode === 'dual-preview' ? (
          <>
            <div
              ref={leftPreviewRef}
              className="min-w-0 flex-1 border-r border-gm-border-subtle overflow-auto p-6 select-text bg-gm-surface"
              style={leftPreviewMasked ? { visibility: 'hidden' } : undefined}
              onScroll={handleLeftPreviewScroll}
              onContextMenu={(e) => handlePreviewContextMenu(e, 'left')}
            >
              <PaneHeader title={activeTab?.title || ''} />
              <MarkdownPreview
                content={activePreview.content}
                filePath={activeTab?.filePath}
                fontSize={editorFontSize}
                lineHeight={editorLineHeight}
                onTaskToggle={activeTab ? handleActiveTaskToggle : undefined}
              />
            </div>
            <div
              ref={rightPreviewRef}
              className={`min-w-0 flex-1 overflow-auto p-6 select-text bg-gm-surface relative ${rightPaneDragOver ? 'ring-2 ring-inset ring-gm-primary/40' : ''}`}
              style={rightPreviewMasked ? { visibility: 'hidden' } : undefined}
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
            <MarkdownToc
              collapsed={tocCollapsed}
              onToggle={() => setTocCollapsed((collapsed) => !collapsed)}
              sections={dualPreviewTocSections}
            />
          </>
        ) : (
          <>
            <div className={`${viewMode === 'edit-preview' ? 'min-w-0 flex-1 border-r border-gm-border-subtle' : 'flex-1'} overflow-hidden relative`}>
              {activeTab && (
                <CodeMirrorEditor
                  content={activeTab.content}
                  onChange={handleEditorChange}
                  onSave={handleSave}
                  onImageFiles={(files, insertAt) => void handleInsertImageFiles(files, insertAt)}
                  viewRef={editorViewRef}
                  documentKey={activeTab.id}
                  tabId={activeTab.id}
                  initialScrollTop={getStoredReadingTop(activeTab.id)}
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

            {viewMode === 'edit-preview' && (
              <div
                ref={leftPreviewRef}
                className="min-w-0 flex-1 overflow-auto p-6 select-text bg-gm-surface relative"
                style={leftPreviewMasked ? { visibility: 'hidden' } : undefined}
                onScroll={handleLeftPreviewScroll}
                onContextMenu={(e) => handlePreviewContextMenu(e, 'left')}
              >
                <MarkdownPreview
                  content={activePreview.content}
                  filePath={activeTab?.filePath}
                  fontSize={editorFontSize}
                  lineHeight={editorLineHeight}
                  onHeadingClick={jumpToLine}
                  onTaskToggle={activeTab ? handleActiveTaskToggle : undefined}
                />
              </div>
            )}

            {(viewMode === 'edit' || viewMode === 'edit-preview') && (
              <MarkdownToc
                toc={toc}
                collapsed={tocCollapsed}
                onToggle={() => setTocCollapsed((collapsed) => !collapsed)}
                onHeadingClick={viewMode === 'edit-preview' ? jumpToPreviewHeading : jumpToEditorHeading}
                activeHeading={activeHeading}
              />
            )}
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
                <ContextMenuItem onClick={() => handlePreviewAiAction('请总结这段内容')}>
                  AI 总结这段
                </ContextMenuItem>
                <ContextMenuItem onClick={() => handlePreviewAiAction('请改写这段内容，使其更清晰')}>
                  AI 改写这段
                </ContextMenuItem>
                <ContextMenuItem onClick={() => handlePreviewAiAction('请只把选中文本整理为标准 Markdown 格式：可以调整标题、列表、引用、代码块、表格等 Markdown 标记；不得改变原文内容、语义和顺序，不得新增信息。')}>
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

interface PreviewLineAnchor {
  line: number
  endLine: number | undefined
  top: number
  height: number
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
  cache: WeakMap<HTMLElement, { version: number; anchors: PreviewLineAnchor[] }>
): PreviewLineAnchor[] {
  const cached = cache.get(container)
  if (cached?.version === version) return cached.anchors

  const anchors = getVisiblePreviewAnchors(container)
  cache.set(container, { version, anchors })
  return anchors
}

function getPreviewTopForLine(
  container: HTMLElement,
  line: number,
  version: number,
  cache: WeakMap<HTMLElement, { version: number; anchors: PreviewLineAnchor[] }>
): number | undefined {
  const anchors = getCachedPreviewAnchors(container, version, cache)
  if (anchors.length === 0) return undefined

  let previous = anchors[0]
  let next: PreviewLineAnchor | undefined
  for (const anchor of anchors) {
    if (anchor.line <= line) {
      previous = anchor
      continue
    }
    next = anchor
    break
  }

  if (previous.endLine && previous.endLine > previous.line && line <= previous.endLine) {
    const progress = (line - previous.line) / Math.max(1, previous.endLine - previous.line)
    return previous.top + previous.height * progress
  }

  if (next && next.line !== previous.line) {
    const progress = (line - previous.line) / Math.max(1, next.line - previous.line)
    return previous.top + (next.top - previous.top) * Math.max(0, Math.min(1, progress))
  }

  return previous.top
}

function getPreviewLineAtTop(
  container: HTMLElement,
  version: number,
  cache: WeakMap<HTMLElement, { version: number; anchors: PreviewLineAnchor[] }>
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
      <div className="mb-6 animate-float">
        <svg width="80" height="80" viewBox="0 0 24 24" fill="none" stroke="var(--gm-primary)" strokeWidth="1">
          <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
          <path d="M14 2v6h6M16 13H8M16 17H8M10 9H8" />
        </svg>
      </div>

      <h2 className="text-display text-gm-text mb-2 font-display">观墨</h2>
      <p className="text-body text-gm-text-secondary mb-8">AI 驱动的 Markdown 知识管理</p>

      <div className="grid grid-cols-2 gap-3 max-w-md w-full">
        <ActionCard label="新建文件" shortcut="Ctrl+N" color="app-teal" onClick={handleNewFile}
          icon={<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--gm-primary)" strokeWidth="1.5"><path d="M12 5v14M5 12h14" /></svg>}
        />
        <ActionCard label="打开文件" shortcut="Ctrl+O" color="app-blue" onClick={handleOpenFile}
          icon={<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--gm-primary)" strokeWidth="1.5"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" /></svg>}
        />
        <ActionCard
          label="快速打开"
          shortcut="Ctrl+P"
          color="app-yellow"
          onClick={() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', ctrlKey: true, bubbles: true }))}
          icon={<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--gm-primary)" strokeWidth="1.5"><circle cx="11" cy="11" r="8" /><path d="M21 21l-4.35-4.35" /></svg>}
        />
        <ActionCard label="AI 对话" shortcut="Ctrl+J" color="app-green" onClick={toggleAiPanel}
          icon={<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--gm-primary)" strokeWidth="1.5"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" /></svg>}
        />
      </div>
    </div>
  )
}

function ActionCard({
  icon,
  label,
  shortcut,
  color,
  onClick,
}: {
  icon: React.ReactNode
  label: string
  shortcut: string
  color: 'app-teal' | 'app-blue' | 'app-yellow' | 'app-green'
  onClick: () => void
}) {
  return (
    <Card color={color} className="p-4 cursor-pointer hover:shadow-lg transition-shadow duration-200 group" onClick={onClick}>
      <div className="flex flex-col items-center gap-2">
        <div className="group-hover:scale-110 transition-transform duration-200">{icon}</div>
        <span className="text-body font-bold text-gm-text">{label}</span>
        <kbd className="px-2 py-0.5 rounded-full bg-white/50 text-micro text-gm-text-secondary font-mono">{shortcut}</kbd>
      </div>
    </Card>
  )
}
