import { useCallback, useEffect, useLayoutEffect, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'
import { EditorView } from '@codemirror/view'
import { useEditorStore, type ViewMode } from '@/stores/editorStore'
import { useSettingsStore } from '@/stores/settingsStore'
import {
  ReadingPositionSession,
  runtimeFileReadingPositions,
  type ReadingPosition,
  type ScrollSyncSession,
} from '@/services/editorSession'
import type { MarkdownPreviewHandle } from './markdownPreviewTypes'

interface UseReadingPositionBridgeOptions {
  activeTabId: string | null | undefined
  viewMode: ViewMode
  viewModeRef: MutableRefObject<ViewMode>
  editorViewRef: MutableRefObject<EditorView | null>
  leftPreviewContainerRef: MutableRefObject<HTMLElement | null>
  rightPreviewContainerRef: MutableRefObject<HTMLElement | null>
  leftMarkdownPreviewRef: MutableRefObject<MarkdownPreviewHandle | null>
  rightMarkdownPreviewRef: MutableRefObject<MarkdownPreviewHandle | null>
  restoredPreviewKeysRef: MutableRefObject<{ left: string | null; right: string | null }>
  scrollSyncSessionRef: MutableRefObject<ScrollSyncSession>
  clearPreviewSwitching: (tabId?: string) => void
  setPreviewRestoreTick: Dispatch<SetStateAction<number>>
  flushReadingPositions: (positions: Record<string, ReadingPosition>) => void
  updateEditorHeading: (view: EditorView) => void
  setTocFocus: Dispatch<SetStateAction<'editor' | 'preview'>>
}

const SCROLL_SYNC_TOP_OFFSET = 32
const PREVIEW_SAVE_DEBOUNCE_MS = 150

type PendingPreviewSave = {
  tabId: string
  container: HTMLElement | null
  previewHandle: MarkdownPreviewHandle | null
}

function seedReadingPositionsFromStore(): ReadingPositionSession {
  const session = new ReadingPositionSession()
  const stored = useEditorStore.getState().readingPositions
  for (const [key, pos] of Object.entries(stored)) {
    if (key.includes(':')) {
      const [tabId, pane] = key.split(':') as [string, 'left' | 'right']
      session.saveForPane(tabId, pane, pos)
    } else {
      session.save(key, pos)
    }
  }
  return session
}

type EditorSnapshot = ReturnType<typeof useEditorStore.getState>

function getFilePositionLayoutKey(mode: ViewMode, width: number): string {
  if (width <= 0) return ''
  const { fontSize, lineHeight, fontFamily, wordWrap, lineNumbers } = useSettingsStore.getState().editor
  return [mode, width, fontSize, lineHeight, fontFamily, wordWrap, lineNumbers].join(':')
}

export function useReadingPositionBridge({
  activeTabId,
  viewMode,
  viewModeRef,
  editorViewRef,
  leftPreviewContainerRef,
  rightPreviewContainerRef,
  leftMarkdownPreviewRef,
  rightMarkdownPreviewRef,
  restoredPreviewKeysRef,
  scrollSyncSessionRef,
  clearPreviewSwitching,
  setPreviewRestoreTick,
  flushReadingPositions,
  updateEditorHeading,
  setTocFocus,
}: UseReadingPositionBridgeOptions) {
  const readingPositionsRef = useRef<ReadingPositionSession | null>(null)
  if (!readingPositionsRef.current) {
    readingPositionsRef.current = seedReadingPositionsFromStore()
  }

  const isRestoringScrollRef = useRef(false)
  const restoreScrollFrameRef = useRef<number | null>(null)
  const previewRestoreFramesRef = useRef<{ left: number | null; right: number | null }>({ left: null, right: null })
  const previewRestoreTimersRef = useRef<{ left: number | null; right: number | null }>({ left: null, right: null })
  const restoringPreviewTabsRef = useRef<{ left: string | null; right: string | null }>({ left: null, right: null })
  const previewRestoreContainersRef = useRef<{ left: HTMLElement | null; right: HTMLElement | null }>({ left: null, right: null })
  const previewSaveTimersRef = useRef<{ left: number | null; right: number | null }>({ left: null, right: null })
  const pendingPreviewSavesRef = useRef<{ left: PendingPreviewSave | null; right: PendingPreviewSave | null }>({ left: null, right: null })
  const editorRestoreFrameRef = useRef<number | null>(null)
  const editorTocFrameRef = useRef<number | null>(null)
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const previousActiveTabIdRef = useRef<string | null>(activeTabId ?? null)
  const previousViewModeRef = useRef<ViewMode>(viewMode)
  const rightPaneUserSelected = useEditorStore((state) => state.rightPaneUserSelected)
  const getStoredPreviewTop = useCallback((tabId: string | null | undefined, pane: 'left' | 'right' = 'left') => {
    if (!tabId || !readingPositionsRef.current) return 0
    const position = useEditorStore.getState().viewMode === 'dual-preview'
      ? readingPositionsRef.current.getForPane(tabId, pane)
      : readingPositionsRef.current.get(tabId)
    return position?.previewScrollTop ?? 0
  }, [])

  const getStoredPreviewPosition = useCallback((tabId: string | null | undefined, pane: 'left' | 'right' = 'left') => {
    if (!tabId || !readingPositionsRef.current) return undefined
    return useEditorStore.getState().viewMode === 'dual-preview'
      ? readingPositionsRef.current.getForPane(tabId, pane)
      : readingPositionsRef.current.get(tabId)
  }, [])

  const getStoredEditorTop = useCallback((tabId: string | null | undefined) => {
    if (!tabId || !readingPositionsRef.current) return 0
    return readingPositionsRef.current.get(tabId)?.editorScrollTop ?? 0
  }, [])

  const saveEditorPositionForTab = useCallback((tabId: string | null | undefined, snapshotView?: EditorView | null) => {
    const view = snapshotView ?? editorViewRef.current
    if (!tabId || !view || !readingPositionsRef.current) return
    const mode = useEditorStore.getState().viewMode
    // Explicit snapshots must survive mode changes and pending restore frames before destruction.
    if (!snapshotView && ((mode !== 'edit' && mode !== 'edit-preview') || editorRestoreFrameRef.current !== null)) return
    const topLine = getEditorTopLine(view)
    const mainIndex = view.state.selection.ranges.indexOf(view.state.selection.main)
    const ranges = view.state.selection.ranges.map((range) => ({
      anchor: range.anchor,
      head: range.head,
    }))
    // A cached editor can be destroyed after the user has moved the preview.
    const preservePreviewPosition = snapshotView
      && typeof readingPositionsRef.current.get(tabId)?.previewScrollTop === 'number'
    readingPositionsRef.current.save(tabId, {
      ...(!preservePreviewPosition ? {
        editorScrollTop: view.scrollDOM.scrollTop,
        ...(typeof topLine === 'number' ? { topLine } : {}),
      } : {}),
      cursor: view.state.selection.main.head,
      selection: { anchor: view.state.selection.main.anchor, head: view.state.selection.main.head },
      ranges: ranges.length > 1 ? ranges : undefined,
      mainIndex: ranges.length > 1 ? mainIndex : undefined,
    })
  }, [editorViewRef])

  const savePreviewReadingPosition = useCallback((
    tabId: string,
    container: HTMLElement | null,
    previewHandle: MarkdownPreviewHandle | null,
    pane: 'left' | 'right' = 'left',
  ) => {
    const pending = pendingPreviewSavesRef.current[pane]
    if (previewSaveTimersRef.current[pane] !== null && (!pending || pending.tabId === tabId)) {
      window.clearTimeout(previewSaveTimersRef.current[pane]!)
      previewSaveTimersRef.current[pane] = null
      pendingPreviewSavesRef.current[pane] = null
    }
    const skipped = !readingPositionsRef.current ? '会话未就绪'
      : isRestoringScrollRef.current ? '正在恢复滚动'
        : restoringPreviewTabsRef.current[pane] === tabId ? '正在恢复预览'
          : !container ? '容器未就绪'
            : !previewHandle ? '预览未就绪' : null
    if (skipped === '正在恢复滚动' || skipped === '正在恢复预览') return
    if (skipped || !readingPositionsRef.current || !container || !previewHandle) {
      console.info('[阅读位置][预览保存]', {
        tabId, pane, success: false, reason: skipped, scrollTop: container?.scrollTop,
        position: readingPositionsRef.current?.getForPane(tabId, pane) ?? readingPositionsRef.current?.get(tabId),
      })
      return
    }
    const topLine = previewHandle.getLineForTop(container.scrollTop + SCROLL_SYNC_TOP_OFFSET)
    const lineTop = typeof topLine === 'number' ? previewHandle.getTopForLine(topLine) : undefined
    const position = {
      previewScrollTop: container.scrollTop,
      ...(typeof topLine === 'number' ? { topLine } : {}),
      previewLineOffset: typeof lineTop === 'number'
        ? Math.max(0, container.scrollTop + SCROLL_SYNC_TOP_OFFSET - lineTop) : undefined,
    }
    if (viewModeRef.current === 'dual-preview') {
      readingPositionsRef.current.saveForPane(tabId, pane, position)
    } else {
      readingPositionsRef.current.save(tabId, position)
    }
    console.info('[阅读位置][预览保存]', { tabId, pane, success: true, position })
  }, [viewModeRef])

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

  const collectPositions = useCallback((tabId: string | null | undefined) => {
    if (!tabId || !readingPositionsRef.current) return {}
    const positions: Record<string, ReadingPosition> = {}
    const editorPosition = readingPositionsRef.current.get(tabId)
    if (editorPosition) positions[tabId] = editorPosition
    const leftPosition = readingPositionsRef.current.getForPane(tabId, 'left')
    if (leftPosition) positions[`${tabId}:left`] = leftPosition
    const rightPosition = readingPositionsRef.current.getForPane(tabId, 'right')
    if (rightPosition) positions[`${tabId}:right`] = rightPosition
    return positions
  }, [])

  const scheduleFlush = useCallback(() => {
    if (isRestoringScrollRef.current) return
    if (flushTimerRef.current !== null) clearTimeout(flushTimerRef.current)
    flushTimerRef.current = setTimeout(() => {
      flushTimerRef.current = null
      if (isRestoringScrollRef.current) return
      const positions = collectPositions(activeTabId)
      if (Object.keys(positions).length > 0) flushReadingPositions(positions)
    }, 500)
  }, [activeTabId, collectPositions, flushReadingPositions])

  const flushPendingPreviewSaves = useCallback(() => {
    for (const pane of ['left', 'right'] as const) {
      const pending = pendingPreviewSavesRef.current[pane]
      if (previewSaveTimersRef.current[pane] !== null) window.clearTimeout(previewSaveTimersRef.current[pane]!)
      previewSaveTimersRef.current[pane] = null
      pendingPreviewSavesRef.current[pane] = null
      if (pending) savePreviewReadingPosition(pending.tabId, pending.container, pending.previewHandle, pane)
    }
  }, [savePreviewReadingPosition])

  const schedulePreviewReadingPositionSave = useCallback((
    tabId: string,
    container: HTMLElement | null,
    previewHandle: MarkdownPreviewHandle | null,
    pane: 'left' | 'right',
  ) => {
    if (isRestoringScrollRef.current || restoringPreviewTabsRef.current[pane] === tabId) return
    if (previewSaveTimersRef.current[pane] !== null) {
      window.clearTimeout(previewSaveTimersRef.current[pane]!)
    }
    pendingPreviewSavesRef.current[pane] = { tabId, container, previewHandle }
    scheduleFlush()
    previewSaveTimersRef.current[pane] = window.setTimeout(() => {
      previewSaveTimersRef.current[pane] = null
      const pending = pendingPreviewSavesRef.current[pane]
      pendingPreviewSavesRef.current[pane] = null
      if (pending) {
        savePreviewReadingPosition(pending.tabId, pending.container, pending.previewHandle, pane)
      }
    }, PREVIEW_SAVE_DEBOUNCE_MS)
  }, [savePreviewReadingPosition, scheduleFlush])

  // Zustand subscribers run before React replaces the old document surfaces.
  // Capture their final viewport here, then seed a newly opened tab before its first render.
  useLayoutEffect(() => {
    const session = readingPositionsRef.current
    if (!session) return
    const getLayoutKeys = (mode: ViewMode) => ({
      sharedEditor: getFilePositionLayoutKey(mode, editorViewRef.current?.scrollDOM.clientWidth ?? 0),
      sharedPreview: getFilePositionLayoutKey(mode, leftPreviewContainerRef.current?.clientWidth ?? 0),
      left: getFilePositionLayoutKey(mode, leftPreviewContainerRef.current?.clientWidth ?? 0),
      right: getFilePositionLayoutKey(mode, rightPreviewContainerRef.current?.clientWidth ?? 0),
    })
    const rememberTab = (state: EditorSnapshot, tabId: string | null | undefined) => {
      const tab = state.tabs.find((item) => item.id === tabId)
      if (!tab?.filePath) return
      const shared = session.get(tab.id)
      const left = session.getForPane(tab.id, 'left')
      const right = session.getForPane(tab.id, 'right')
      const keys = getLayoutKeys(state.viewMode)
      const sharedPosition: ReadingPosition | undefined = state.viewMode === 'dual-preview'
        ? { topLine: tab.id === state.activeTabId ? left?.topLine : right?.topLine }
        : shared
      if (sharedPosition && (typeof sharedPosition.topLine === 'number'
        || typeof sharedPosition.editorScrollTop === 'number'
        || typeof sharedPosition.previewScrollTop === 'number')) {
        runtimeFileReadingPositions.remember(tab.filePath, tab.content, 'shared', sharedPosition,
          typeof sharedPosition.previewScrollTop === 'number' ? keys.sharedPreview : keys.sharedEditor)
      }
      if (left) runtimeFileReadingPositions.remember(tab.filePath, tab.content, 'left', left, keys.left)
      if (right) runtimeFileReadingPositions.remember(tab.filePath, tab.content, 'right', right, keys.right)
    }
    const seedTab = (state: EditorSnapshot, tabId: string | null | undefined) => {
      const tab = state.tabs.find((item) => item.id === tabId)
      if (!tab?.filePath || session.get(tab.id) || session.getForPane(tab.id, 'left') || session.getForPane(tab.id, 'right')) return
      const positions = runtimeFileReadingPositions.restore(tab.filePath, tab.content, getLayoutKeys(state.viewMode))
      if (positions.shared) session.save(tab.id, positions.shared)
      if (positions.left) session.saveForPane(tab.id, 'left', positions.left)
      if (positions.right) session.saveForPane(tab.id, 'right', positions.right)
    }
    return useEditorStore.subscribe((state, previous) => {
      const previousRightId = previous.rightPaneUserSelected ? previous.rightPaneTabId : previous.activeTabId
      const nextRightId = state.rightPaneUserSelected ? state.rightPaneTabId : state.activeTabId
      const activeChanged = previous.activeTabId !== state.activeTabId
      const rightChanged = previousRightId !== nextRightId
      if (!activeChanged && !rightChanged && previous.tabs === state.tabs) return
      const nextTabsById = new Map(state.tabs.map((tab) => [tab.id, tab]))
      const changedPathIds = previous.tabs.filter((tab) => {
        const nextTab = nextTabsById.get(tab.id)
        return nextTab && nextTab.filePath !== tab.filePath
      }).map((tab) => tab.id)
      if (!activeChanged && !rightChanged && changedPathIds.length === 0
        && (!previous.activeTabId || nextTabsById.has(previous.activeTabId))) return

      if (previous.activeTabId) {
        const latestShared = session.get(previous.activeTabId)
        if (previous.viewMode === 'edit'
          || (previous.viewMode === 'edit-preview' && typeof latestShared?.previewScrollTop !== 'number')) {
          saveEditorPositionForTab(previous.activeTabId)
        }
        if (previous.viewMode === 'preview'
          || (previous.viewMode === 'edit-preview' && typeof latestShared?.previewScrollTop === 'number')
          || previous.viewMode === 'dual-preview') {
          savePreviewReadingPosition(previous.activeTabId, leftPreviewContainerRef.current, leftMarkdownPreviewRef.current)
        }
        rememberTab(previous, previous.activeTabId)
      }
      if (previous.viewMode === 'dual-preview' && previousRightId) {
        savePreviewReadingPosition(previousRightId, rightPreviewContainerRef.current, rightMarkdownPreviewRef.current, 'right')
        rememberTab(previous, previousRightId)
      }
      for (const tabId of changedPathIds) {
        rememberTab(previous, tabId)
        const oldPath = previous.tabs.find((tab) => tab.id === tabId)?.filePath
        const newTab = state.tabs.find((tab) => tab.id === tabId)
        if (!runtimeFileReadingPositions.copyPath(oldPath, newTab?.filePath)) rememberTab(state, tabId)
      }
      seedTab(state, state.activeTabId)
      if (state.viewMode === 'dual-preview') seedTab(state, nextRightId)
    })
  }, [editorViewRef, leftMarkdownPreviewRef, leftPreviewContainerRef, rightMarkdownPreviewRef, rightPreviewContainerRef, saveEditorPositionForTab, savePreviewReadingPosition])

  const schedulePreviewReveal = useCallback((tabId?: string) => {
    if (tabId) clearPreviewSwitching(tabId)
    setPreviewRestoreTick((tick) => tick + 1)
  }, [clearPreviewSwitching, setPreviewRestoreTick])

  const allowPreviewPositionUpdates = useCallback((tabId: string | null | undefined, pane: 'left' | 'right') => {
    if (!tabId || restoringPreviewTabsRef.current[pane] !== tabId) return
    if (previewRestoreFramesRef.current[pane] !== null || previewRestoreTimersRef.current[pane] !== null) {
      console.info('[阅读位置][预览恢复]', {
        tabId, pane, phase: '结束', success: false, reason: '用户操作取消自动对齐',
        position: useEditorStore.getState().viewMode === 'dual-preview'
          ? readingPositionsRef.current?.getForPane(tabId, pane) : readingPositionsRef.current?.get(tabId),
      })
    }
    // The first user gesture can happen in the same frame as the initial
    // programmatic restore. Release both restore guards before the resulting
    // scroll event is handled, otherwise the user's first position is lost.
    if (restoreScrollFrameRef.current !== null) {
      window.cancelAnimationFrame(restoreScrollFrameRef.current)
      restoreScrollFrameRef.current = null
    }
    isRestoringScrollRef.current = false
    if (previewRestoreFramesRef.current[pane] !== null) {
      window.cancelAnimationFrame(previewRestoreFramesRef.current[pane]!)
      previewRestoreFramesRef.current[pane] = null
    }
    if (previewRestoreTimersRef.current[pane] !== null) {
      window.clearTimeout(previewRestoreTimersRef.current[pane]!)
      previewRestoreTimersRef.current[pane] = null
    }
    restoringPreviewTabsRef.current[pane] = null
    restoredPreviewKeysRef.current[pane] = `${tabId}:${useEditorStore.getState().viewMode}`
    schedulePreviewReveal(tabId)
  }, [restoredPreviewKeysRef, schedulePreviewReveal])

  useLayoutEffect(() => () => {
    // A mode change needs its own restore, even when the tab and container are reused.
    for (const pane of ['left', 'right'] as const) {
      if (previewRestoreFramesRef.current[pane] !== null) {
        window.cancelAnimationFrame(previewRestoreFramesRef.current[pane]!)
        previewRestoreFramesRef.current[pane] = null
      }
      if (previewRestoreTimersRef.current[pane] !== null) {
        window.clearTimeout(previewRestoreTimersRef.current[pane]!)
        previewRestoreTimersRef.current[pane] = null
      }
      restoringPreviewTabsRef.current[pane] = null
      restoredPreviewKeysRef.current[pane] = null
    }
    setPreviewRestoreTick((tick) => tick + 1)
  }, [restoredPreviewKeysRef, setPreviewRestoreTick, viewMode])

  useLayoutEffect(() => {
    const previousViewMode = previousViewModeRef.current
    previousViewModeRef.current = viewMode
    if (viewMode !== 'dual-preview' || previousViewMode === 'dual-preview' || !activeTabId || !readingPositionsRef.current) return

    readingPositionsRef.current.seedPaneFromSharedPosition(activeTabId, 'left')
    if (!rightPaneUserSelected) {
      readingPositionsRef.current.seedPaneFromSharedPosition(activeTabId, 'right')
    }
    const positions = collectPositions(activeTabId)
    if (Object.keys(positions).length > 0) flushReadingPositions(positions)
  }, [activeTabId, collectPositions, flushReadingPositions, rightPaneUserSelected, viewMode])

  const restoreEditorReadingPosition = useCallback((tabId: string) => {
    const view = editorViewRef.current
    const position = readingPositionsRef.current?.get(tabId)
    if (!view || !position) return

    if (editorRestoreFrameRef.current !== null) {
      window.cancelAnimationFrame(editorRestoreFrameRef.current)
    }
    editorRestoreFrameRef.current = window.requestAnimationFrame(() => {
      editorRestoreFrameRef.current = null
      const currentView = editorViewRef.current
      const currentMode = useEditorStore.getState().viewMode
      if (
        !currentView
        || useEditorStore.getState().activeTabId !== tabId
        || (currentMode !== 'edit' && currentMode !== 'edit-preview')
      ) return
      if (typeof position.editorScrollTop === 'number') {
        currentView.scrollDOM.scrollTop = position.editorScrollTop
      } else if (typeof position.topLine === 'number' && position.topLine <= currentView.state.doc.lines) {
        const pos = currentView.state.doc.line(position.topLine).from
        currentView.dispatch({ effects: EditorView.scrollIntoView(pos, { y: 'start', yMargin: SCROLL_SYNC_TOP_OFFSET }) })
      }
    })
  }, [editorViewRef])

  const restorePreviewReadingPosition = useCallback((
    tabId: string,
    container: HTMLElement | null,
    pane: 'left' | 'right',
  ) => {
    const position = useEditorStore.getState().viewMode === 'dual-preview'
      ? readingPositionsRef.current?.getForPane(tabId, pane)
      : readingPositionsRef.current?.get(tabId)
    if (!container) {
      console.info('[阅读位置][预览恢复]', { tabId, pane, phase: '结束', success: false, reason: '容器未就绪', position })
      return
    }
    if (restoringPreviewTabsRef.current[pane] === tabId
      && previewRestoreContainersRef.current[pane] === container
      && (previewRestoreFramesRef.current[pane] !== null || previewRestoreTimersRef.current[pane] !== null)) {
      console.info('[阅读位置][预览恢复]', { tabId, pane, phase: '重复请求跳过', success: null, position })
      return
    }
    const previousTabId = restoringPreviewTabsRef.current[pane]
    if (previousTabId && (previewRestoreFramesRef.current[pane] !== null
      || previewRestoreTimersRef.current[pane] !== null)) {
      console.info('[阅读位置][预览恢复]', {
        tabId: previousTabId, pane, phase: '结束', success: false, reason: '被新一轮恢复取消',
        position: readingPositionsRef.current?.getForPane(previousTabId, pane)
          ?? readingPositionsRef.current?.get(previousTabId),
      })
    }
    if (previewRestoreFramesRef.current[pane] !== null) {
      window.cancelAnimationFrame(previewRestoreFramesRef.current[pane]!)
      previewRestoreFramesRef.current[pane] = null
    }
    if (previewRestoreTimersRef.current[pane] !== null) {
      window.clearTimeout(previewRestoreTimersRef.current[pane]!)
      previewRestoreTimersRef.current[pane] = null
    }
    restoringPreviewTabsRef.current[pane] = typeof position?.previewScrollTop === 'number'
      || typeof position?.topLine === 'number' ? tabId : null
    previewRestoreContainersRef.current[pane] = container
    const previewHandle = pane === 'left' ? leftMarkdownPreviewRef.current : rightMarkdownPreviewRef.current
    const lineTop = position?.previewScrollTop == null && position?.topLine != null
      ? getPreviewTopForLine(container, position.topLine, previewHandle?.getTopForLine(position.topLine))
      : undefined
    const nextTop = position?.previewScrollTop
      ?? (typeof lineTop === 'number' ? Math.max(0, lineTop - SCROLL_SYNC_TOP_OFFSET + (position?.previewLineOffset ?? 0)) : 0)
    withRestoreLock(() => {
      container.scrollTop = nextTop
    })
    console.info('[阅读位置][预览恢复]', {
      tabId, pane, phase: '初始定位', success: null, position, targetScrollTop: nextTop, actualScrollTop: container.scrollTop,
      restoreSource: typeof position?.previewScrollTop === 'number' ? 'previewScrollTop'
        : typeof position?.topLine === 'number' ? 'topLine' : 'none',
      reason: position ? '等待布局校验' : '无保存位置',
    })
    const logRestoreResult = (reason: string, cancelled = false) => {
      const handle = pane === 'left' ? leftMarkdownPreviewRef.current : rightMarkdownPreviewRef.current
      const actualLine = handle?.getLineForTop(container.scrollTop + SCROLL_SYNC_TOP_OFFSET)
      const lineTop = typeof position?.topLine === 'number' ? handle?.getTopForLine(position.topLine) : undefined
      const targetScrollTop = typeof lineTop === 'number'
        ? Math.max(0, lineTop - SCROLL_SYNC_TOP_OFFSET + (position?.previewLineOffset ?? 0))
        : position?.previewScrollTop
      const success = Boolean(!cancelled && position && (typeof position.topLine !== 'number' || actualLine === position.topLine)
        && typeof targetScrollTop === 'number' && Math.abs(container.scrollTop - targetScrollTop) <= 2)
      console.info('[阅读位置][预览恢复]', {
        tabId, pane, phase: '结束', success, reason, position, targetScrollTop,
        actualScrollTop: container.scrollTop, actualLine,
      })
    }
    const reveal = () => {
      restoredPreviewKeysRef.current[pane] = `${tabId}:${viewMode}`
      schedulePreviewReveal(tabId)
    }
    if (position?.topLine == null || container.clientHeight <= 0) {
      reveal()
      logRestoreResult(position ? '无需逐帧对齐' : '无保存位置')
      return
    }
    // A remounted virtual preview starts with estimated block heights; align its saved line after measurement.
    let attempts = 0
    let stableFrames = 0
    let lateChecks = 0
    const targetTopFor = (handle: MarkdownPreviewHandle) => {
      const lineTop = getPreviewTopForLine(container, position.topLine!, handle.getTopForLine(position.topLine!))
      return typeof lineTop === 'number'
        ? Math.max(0, lineTop - SCROLL_SYNC_TOP_OFFSET + (position.previewLineOffset ?? 0))
        : undefined
    }
    const checkLateLayout = () => {
      previewRestoreTimersRef.current[pane] = null
      if (restoringPreviewTabsRef.current[pane] !== tabId) return
      const state = useEditorStore.getState()
      if (state.viewMode === 'edit' || (pane === 'right' && state.viewMode !== 'dual-preview')) {
        logRestoreResult('预览模式已离开', true)
        return
      }
      const currentTabId = pane === 'right' && state.viewMode === 'dual-preview'
        ? state.rightPaneUserSelected ? state.rightPaneTabId : state.activeTabId
        : state.activeTabId
      const currentContainer = pane === 'left' ? leftPreviewContainerRef.current : rightPreviewContainerRef.current
      if (currentTabId !== tabId || currentContainer !== container) {
        logRestoreResult('文件或容器已切换', true)
        return
      }
      const handle = pane === 'left' ? leftMarkdownPreviewRef.current : rightMarkdownPreviewRef.current
      if (handle) {
        const targetTop = targetTopFor(handle)
        if (typeof targetTop === 'number' && (handle.getLineForTop(container.scrollTop + SCROLL_SYNC_TOP_OFFSET) !== position.topLine
          || Math.abs(container.scrollTop - targetTop) > 2)) {
          container.scrollTop = targetTop
        }
      }
      lateChecks += 1
      if (lateChecks < 2) previewRestoreTimersRef.current[pane] = window.setTimeout(checkLateLayout, 750)
      else logRestoreResult('布局校验完成')
    }
    const alignToLine = () => {
      previewRestoreFramesRef.current[pane] = null
      const state = useEditorStore.getState()
      const currentTabId = pane === 'right' && state.viewMode === 'dual-preview'
        ? state.rightPaneUserSelected ? state.rightPaneTabId : state.activeTabId
        : state.activeTabId
      const currentContainer = pane === 'left' ? leftPreviewContainerRef.current : rightPreviewContainerRef.current
      if (currentTabId !== tabId || currentContainer !== container) {
        restoringPreviewTabsRef.current[pane] = null
        logRestoreResult('文件或容器已切换', true)
        return
      }
      const handle = pane === 'left' ? leftMarkdownPreviewRef.current : rightMarkdownPreviewRef.current
      if (handle && state.tabs.find((tab) => tab.id === tabId)?.content.trim() === '') {
        restoringPreviewTabsRef.current[pane] = null
        reveal()
        logRestoreResult('空白文档无需逐帧对齐')
        return
      }
      let layoutReady = false
      if (handle) {
        const currentLine = handle.getLineForTop(container.scrollTop + SCROLL_SYNC_TOP_OFFSET)
        const targetTop = targetTopFor(handle)
        layoutReady = typeof currentLine === 'number' && typeof targetTop === 'number'
        if (currentLine === position.topLine && typeof targetTop === 'number'
          && Math.abs(container.scrollTop - targetTop) <= 2) {
          stableFrames += 1
        } else {
          if (typeof targetTop === 'number') container.scrollTop = targetTop
          stableFrames = 0
        }
      }
      attempts = layoutReady ? attempts + 1 : 0
      if (stableFrames >= 2 || (attempts >= 12 && layoutReady)) {
        reveal()
        previewRestoreTimersRef.current[pane] = window.setTimeout(checkLateLayout, 250)
      } else {
        previewRestoreFramesRef.current[pane] = window.requestAnimationFrame(alignToLine)
      }
    }
    previewRestoreFramesRef.current[pane] = window.requestAnimationFrame(alignToLine)
  }, [leftMarkdownPreviewRef, leftPreviewContainerRef, restoredPreviewKeysRef, rightMarkdownPreviewRef, rightPreviewContainerRef, schedulePreviewReveal, viewMode, withRestoreLock])

  useEffect(() => {
    if (!activeTabId || (viewMode !== 'edit' && viewMode !== 'edit-preview')) return
    let view: EditorView | null = null
    const handleScroll = () => {
      const currentMode = useEditorStore.getState().viewMode
      if (currentMode !== 'edit' && currentMode !== 'edit-preview') return
      if (scrollSyncSessionRef.current.source !== 'preview') {
        saveEditorPositionForTab(activeTabId)
        scheduleFlush()
        setTocFocus('editor')
      }
      if (editorTocFrameRef.current !== null || !view) return
      editorTocFrameRef.current = window.requestAnimationFrame(() => {
        editorTocFrameRef.current = null
        if (view) updateEditorHeading(view)
      })
    }
    const frame = window.requestAnimationFrame(() => {
      view = editorViewRef.current
      if (!view) return
      updateEditorHeading(view)
      view.scrollDOM.addEventListener('scroll', handleScroll, { passive: true })
    })

    return () => {
      window.cancelAnimationFrame(frame)
      if (view) view.scrollDOM.removeEventListener('scroll', handleScroll)
      if (editorTocFrameRef.current !== null) {
        window.cancelAnimationFrame(editorTocFrameRef.current)
        editorTocFrameRef.current = null
      }
    }
  }, [activeTabId, editorViewRef, scheduleFlush, saveEditorPositionForTab, scrollSyncSessionRef, setTocFocus, updateEditorHeading, viewMode])

  useEffect(() => {
    const prevId = previousActiveTabIdRef.current
    previousActiveTabIdRef.current = activeTabId ?? null
    if (!prevId || prevId === activeTabId) return
    if (flushTimerRef.current !== null) {
      clearTimeout(flushTimerRef.current)
      flushTimerRef.current = null
    }
    const positions = collectPositions(prevId)
    if (Object.keys(positions).length > 0) flushReadingPositions(positions)
  }, [activeTabId, collectPositions, flushReadingPositions])

  useEffect(() => {
    const flushCurrentPositions = () => {
      flushPendingPreviewSaves()
      if (flushTimerRef.current !== null) {
        clearTimeout(flushTimerRef.current)
        flushTimerRef.current = null
      }
      const positions = collectPositions(activeTabId)
      if (Object.keys(positions).length > 0) flushReadingPositions(positions)
    }
    window.addEventListener('beforeunload', flushCurrentPositions)
    const handleVisibility = () => {
      if (document.visibilityState === 'hidden') flushCurrentPositions()
    }
    document.addEventListener('visibilitychange', handleVisibility)
    return () => {
      window.removeEventListener('beforeunload', flushCurrentPositions)
      document.removeEventListener('visibilitychange', handleVisibility)
    }
  }, [activeTabId, collectPositions, flushPendingPreviewSaves, flushReadingPositions])

  useEffect(() => () => {
    flushPendingPreviewSaves()
    if (flushTimerRef.current !== null) {
      clearTimeout(flushTimerRef.current)
      flushTimerRef.current = null
    }
    if (restoreScrollFrameRef.current !== null) {
      window.cancelAnimationFrame(restoreScrollFrameRef.current)
      restoreScrollFrameRef.current = null
    }
    for (const pane of ['left', 'right'] as const) {
      if (previewSaveTimersRef.current[pane] !== null) {
        window.clearTimeout(previewSaveTimersRef.current[pane]!)
        previewSaveTimersRef.current[pane] = null
      }
      pendingPreviewSavesRef.current[pane] = null
      if (previewRestoreFramesRef.current[pane] !== null) {
        window.cancelAnimationFrame(previewRestoreFramesRef.current[pane]!)
        previewRestoreFramesRef.current[pane] = null
      }
      if (previewRestoreTimersRef.current[pane] !== null) {
        window.clearTimeout(previewRestoreTimersRef.current[pane]!)
        previewRestoreTimersRef.current[pane] = null
      }
      restoringPreviewTabsRef.current[pane] = null
      previewRestoreContainersRef.current[pane] = null
    }
    if (editorRestoreFrameRef.current !== null) {
      window.cancelAnimationFrame(editorRestoreFrameRef.current)
      editorRestoreFrameRef.current = null
    }
    if (editorTocFrameRef.current !== null) {
      window.cancelAnimationFrame(editorTocFrameRef.current)
      editorTocFrameRef.current = null
    }
  }, [flushPendingPreviewSaves])

  return {
    readingPositionsRef: readingPositionsRef as MutableRefObject<ReadingPositionSession>,
    isRestoringScrollRef,
    getStoredPreviewTop,
    getStoredPreviewPosition,
    getStoredEditorTop,
    saveEditorPositionForTab,
    savePreviewReadingPosition,
    schedulePreviewReadingPositionSave,
    allowPreviewPositionUpdates,
    scheduleFlush,
    restoreEditorReadingPosition,
    restorePreviewReadingPosition,
  }
}

function getEditorTopLine(view: EditorView): number | undefined {
  const block = view.lineBlockAtHeight(view.scrollDOM.scrollTop + SCROLL_SYNC_TOP_OFFSET)
  if (!block) return undefined
  return view.state.doc.lineAt(block.from).number
}

export function getPreviewTopForLine(
  container: HTMLElement,
  line: number,
  estimatedTop?: number,
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
  if (!anchorElement) return estimatedTop
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

  return estimatedTop ?? anchorTop
}
