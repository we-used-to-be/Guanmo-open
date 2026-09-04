import { useCallback, useEffect, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'
import { EditorView } from '@codemirror/view'
import { useEditorStore, type ViewMode } from '@/stores/editorStore'
import {
  ReadingPositionSession,
  type ReadingPosition,
  type ScrollSyncSession,
} from '@/services/editorSession'
import type { MarkdownPreviewHandle } from './markdownPreviewTypes'

interface UseReadingPositionBridgeOptions {
  activeTabId: string | null | undefined
  viewMode: ViewMode
  viewModeRef: MutableRefObject<ViewMode>
  editorViewRef: MutableRefObject<EditorView | null>
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

export function useReadingPositionBridge({
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
}: UseReadingPositionBridgeOptions) {
  const readingPositionsRef = useRef<ReadingPositionSession | null>(null)
  if (!readingPositionsRef.current) {
    readingPositionsRef.current = seedReadingPositionsFromStore()
  }

  const isRestoringScrollRef = useRef(false)
  const restoreScrollFrameRef = useRef<number | null>(null)
  const editorRestoreFrameRef = useRef<number | null>(null)
  const editorTocFrameRef = useRef<number | null>(null)
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const previousActiveTabIdRef = useRef<string | null>(activeTabId ?? null)
  const getStoredPreviewTop = useCallback((tabId: string | null | undefined, pane: 'left' | 'right' = 'left') => {
    if (!tabId || !readingPositionsRef.current) return 0
    const position = useEditorStore.getState().viewMode === 'dual-preview'
      ? readingPositionsRef.current.getForPane(tabId, pane)
      : readingPositionsRef.current.get(tabId)
    return position?.previewScrollTop ?? 0
  }, [])

  const getStoredEditorTop = useCallback((tabId: string | null | undefined) => {
    if (!tabId || !readingPositionsRef.current) return 0
    return readingPositionsRef.current.get(tabId)?.editorScrollTop ?? 0
  }, [])

  const saveEditorPositionForTab = useCallback((tabId: string | null | undefined, view = editorViewRef.current) => {
    if (!tabId || !view || !readingPositionsRef.current) return
    const mainIndex = view.state.selection.ranges.indexOf(view.state.selection.main)
    const ranges = view.state.selection.ranges.map((range) => ({
      anchor: range.anchor,
      head: range.head,
    }))
    readingPositionsRef.current.save(tabId, {
      editorScrollTop: view.scrollDOM.scrollTop,
      topLine: getEditorTopLine(view),
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
    if (!readingPositionsRef.current || isRestoringScrollRef.current || !container) return
    const position = {
      previewScrollTop: container.scrollTop,
      topLine: previewHandle?.getLineForTop(container.scrollTop + SCROLL_SYNC_TOP_OFFSET),
    }
    if (viewModeRef.current === 'dual-preview') {
      readingPositionsRef.current.saveForPane(tabId, pane, position)
    } else {
      readingPositionsRef.current.save(tabId, position)
    }
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

  const schedulePreviewReveal = useCallback((tabId?: string) => {
    if (tabId) clearPreviewSwitching(tabId)
    setPreviewRestoreTick((tick) => tick + 1)
  }, [clearPreviewSwitching, setPreviewRestoreTick])

  const restoreEditorReadingPosition = useCallback((tabId: string) => {
    const view = editorViewRef.current
    const position = readingPositionsRef.current?.get(tabId)
    if (!view || !position) return

    if (editorRestoreFrameRef.current !== null) {
      window.cancelAnimationFrame(editorRestoreFrameRef.current)
    }
    editorRestoreFrameRef.current = window.requestAnimationFrame(() => {
      editorRestoreFrameRef.current = null
      const currentMode = useEditorStore.getState().viewMode
      if (editorViewRef.current !== view || (currentMode !== 'edit' && currentMode !== 'edit-preview')) return
      if (typeof position.editorScrollTop === 'number') {
        view.scrollDOM.scrollTop = position.editorScrollTop
      } else if (typeof position.topLine === 'number' && position.topLine <= view.state.doc.lines) {
        const pos = view.state.doc.line(position.topLine).from
        view.scrollDOM.scrollTop = Math.max(0, view.lineBlockAt(pos).top - SCROLL_SYNC_TOP_OFFSET)
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
    if (!container) return
    const previewHandle = pane === 'left' ? leftMarkdownPreviewRef.current : rightMarkdownPreviewRef.current
    const lineTop = position?.previewScrollTop == null && position?.topLine != null
      ? getPreviewTopForLine(container, position.topLine, previewHandle?.getTopForLine(position.topLine))
      : undefined
    const nextTop = position?.previewScrollTop
      ?? (typeof lineTop === 'number' ? Math.max(0, lineTop - SCROLL_SYNC_TOP_OFFSET) : 0)
    withRestoreLock(() => {
      container.scrollTop = nextTop
    })
    restoredPreviewKeysRef.current[pane] = tabId
    schedulePreviewReveal(tabId)
  }, [leftMarkdownPreviewRef, restoredPreviewKeysRef, rightMarkdownPreviewRef, schedulePreviewReveal, withRestoreLock])

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
  }, [activeTabId, collectPositions, flushReadingPositions])

  useEffect(() => () => {
    if (flushTimerRef.current !== null) {
      clearTimeout(flushTimerRef.current)
      flushTimerRef.current = null
    }
    if (restoreScrollFrameRef.current !== null) {
      window.cancelAnimationFrame(restoreScrollFrameRef.current)
      restoreScrollFrameRef.current = null
    }
    if (editorRestoreFrameRef.current !== null) {
      window.cancelAnimationFrame(editorRestoreFrameRef.current)
      editorRestoreFrameRef.current = null
    }
    if (editorTocFrameRef.current !== null) {
      window.cancelAnimationFrame(editorTocFrameRef.current)
      editorTocFrameRef.current = null
    }
  }, [])

  return {
    readingPositionsRef: readingPositionsRef as MutableRefObject<ReadingPositionSession>,
    isRestoringScrollRef,
    getStoredPreviewTop,
    getStoredEditorTop,
    saveEditorPositionForTab,
    savePreviewReadingPosition,
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
