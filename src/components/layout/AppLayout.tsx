import { lazy, Suspense, useState, useCallback, useRef, useEffect } from 'react'
import { useAppStore } from '@/stores/appStore'
import { useEditorStore } from '@/stores/editorStore'
import { useKeyboardShortcuts } from '@/hooks/useKeyboard'
import { useFileOperations } from '@/hooks/useFileOperations'
import { Modal } from 'animal-island-ui'
import { exportMarkdownAsHtml } from '@/services/markdownExport'
import { Sidebar } from './Sidebar'
import { StatusBar } from './StatusBar'
import { TitleBar } from './TitleBar'
import { EditorArea, OPEN_EDITOR_SEARCH_EVENT } from '../editor/EditorArea'
import { FullscreenControlBar } from '../editor/FullscreenControlBar'
import { FullscreenFileDrawer } from './FullscreenFileDrawer'
import { CommandPalette } from '../common/CommandPalette'
import { toast } from '@/services/toast'
import { useSettingsStore } from '@/stores/settingsStore'
import { useFullscreen } from '@/hooks/useFullscreen'
import { OPEN_SETTINGS_SECTION_EVENT } from '@/services/settingsNavigation'

const AiPanel = lazy(() => import('../ai/AiPanel').then((module) => ({ default: module.AiPanel })))
const SettingsPage = lazy(() => import('@/features/settings/SettingsPage').then((module) => ({ default: module.SettingsPage })))

export function AppLayout() {
  const sidebarCollapsed = useAppStore((s) => s.sidebarCollapsed)
  const aiPanelOpen = useAppStore((s) => s.aiPanelOpen)
  const sidebarWidth = useAppStore((s) => s.sidebarWidth)
  const aiPanelWidth = useAppStore((s) => s.aiPanelWidth)
  const toggleSidebar = useAppStore((s) => s.toggleSidebar)
  const toggleAiPanel = useAppStore((s) => s.toggleAiPanel)
  const setAiPanelWidth = useAppStore((s) => s.setAiPanelWidth)
  const togglePreview = useEditorStore((s) => s.togglePreview)
  const toggleDiffPreview = useEditorStore((s) => s.toggleDiffPreview)
  const setViewMode = useEditorStore((s) => s.setViewMode)
  const { handleNewFile, handleOpenFile, handleSaveFile } = useFileOperations()
  const { isFullscreen, toggleFullscreen, exitFullscreen } = useFullscreen()
  const customCursorEnabled = useSettingsStore((s) => s.appearance.customCursorEnabled)
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false)
  const [commandPaletteMode, setCommandPaletteMode] = useState<'commands' | 'files'>('commands')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsSection, setSettingsSection] = useState<string | null>(null)
  const [fullscreenFileDrawerOpen, setFullscreenFileDrawerOpen] = useState(false)
  const [fullscreenAiPosition, setFullscreenAiPosition] = useState(() => getDefaultFullscreenAiPosition())
  const fullscreenAiDragRef = useRef<{
    pointerId: number
    startX: number
    startY: number
    originX: number
    originY: number
    dragged: boolean
  } | null>(null)
  const fullscreenAiPanelRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (isFullscreen) {
      useAppStore.setState({ aiPanelOpen: false })
      setFullscreenAiPosition(getDefaultFullscreenAiPosition())
      setFullscreenFileDrawerOpen(false)
    } else {
      setFullscreenFileDrawerOpen(false)
    }
  }, [isFullscreen])

  // AI panel resize
  const isResizing = useRef(false)

  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    isResizing.current = true
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }, [])

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizing.current) return
      // Calculate new width from the right edge of the window
      const newWidth = window.innerWidth - e.clientX
      const clamped = Math.max(280, Math.min(600, newWidth))
      setAiPanelWidth(clamped)
    }

    const handleMouseUp = () => {
      if (isResizing.current) {
        isResizing.current = false
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
      }
    }

    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)
    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    }
  }, [setAiPanelWidth])

  useEffect(() => {
    if (!isFullscreen) return
    const handleResize = () => {
      setFullscreenAiPosition((position) => clampFullscreenAiPosition(position.x, position.y))
    }
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [isFullscreen])

  const handleFullscreenAiDragStart = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    fullscreenAiDragRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      originX: fullscreenAiPosition.x,
      originY: fullscreenAiPosition.y,
      dragged: false,
    }
    document.body.style.userSelect = 'none'
  }, [fullscreenAiPosition])

  const handleFullscreenAiDragMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const drag = fullscreenAiDragRef.current
    if (!drag || drag.pointerId !== e.pointerId) return
    const dx = e.clientX - drag.startX
    const dy = e.clientY - drag.startY
    if (Math.abs(dx) + Math.abs(dy) > 3) drag.dragged = true
    setFullscreenAiPosition(clampFullscreenAiPosition(drag.originX + dx, drag.originY + dy))
  }, [])

  const handleFullscreenAiDragEnd = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const drag = fullscreenAiDragRef.current
    if (drag?.pointerId === e.pointerId) {
      fullscreenAiDragRef.current = null
      document.body.style.userSelect = ''
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId)
      }
    }
  }, [])

  useEffect(() => {
    if (!isFullscreen || !aiPanelOpen) return
    const handlePointerDown = (e: PointerEvent) => {
      if (fullscreenAiPanelRef.current?.contains(e.target as Node)) return
      useAppStore.setState({ aiPanelOpen: false })
    }
    document.addEventListener('pointerdown', handlePointerDown, true)
    return () => document.removeEventListener('pointerdown', handlePointerDown, true)
  }, [aiPanelOpen, isFullscreen])

  const handleOpenSearch = useCallback(() => {
    window.dispatchEvent(new Event(OPEN_EDITOR_SEARCH_EVENT))
  }, [])

  const toggleFullscreenFileDrawer = useCallback(() => {
    setFullscreenFileDrawerOpen((open) => !open)
  }, [])

  const closeFullscreenFileDrawer = useCallback(() => {
    setFullscreenFileDrawerOpen(false)
  }, [])

  const handleExportHtml = useCallback(async () => {
    const state = useEditorStore.getState()
    const tab = state.tabs.find((t) => t.id === state.activeTabId)
    if (!tab) return
    try {
      await exportMarkdownAsHtml(tab.content, tab.title.replace(/\.(md|markdown|mdx)$/i, ''), tab.filePath)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'HTML export failed')
    }
  }, [])

  const toggleTheme = useCallback(() => {
    const theme = useSettingsStore.getState().appearance.theme
    useSettingsStore.getState().updateAppearanceSettings({ theme: theme === 'dark' ? 'light' : 'dark' })
  }, [])

  const runAfterNormalLayout = useCallback(async (action: () => void | Promise<void>) => {
    if (useAppStore.getState().isFullscreen) {
      await exitFullscreen()
    }
    await action()
  }, [exitFullscreen])

  const openSettings = useCallback(() => {
    void runAfterNormalLayout(() => {
      setSettingsSection(null)
      setSettingsOpen(true)
    })
  }, [runAfterNormalLayout])

  useEffect(() => {
    const handleOpenSettingsSection = (event: Event) => {
      const section = (event as CustomEvent<{ section?: string }>).detail?.section ?? null
      void runAfterNormalLayout(() => {
        setSettingsSection(section)
        setSettingsOpen(true)
      })
    }
    window.addEventListener(OPEN_SETTINGS_SECTION_EVENT, handleOpenSettingsSection)
    return () => window.removeEventListener(OPEN_SETTINGS_SECTION_EVENT, handleOpenSettingsSection)
  }, [runAfterNormalLayout])

  const openCommandPalette = useCallback((mode: 'commands' | 'files') => {
    void runAfterNormalLayout(() => {
      setCommandPaletteMode(mode)
      setCommandPaletteOpen(true)
    })
  }, [runAfterNormalLayout])

  // Intercept browser default shortcuts (Ctrl+S save, Ctrl+F find, etc.)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey) {
        const key = e.key.toLowerCase()
        const isSettingsShortcut = key === 'i'
        if (isSettingsShortcut) {
          e.preventDefault()
          e.stopPropagation()
          openSettings()
          return
        }
        if (key === 's' || key === 'f' || key === 'g' || key === 'h' || key === 'p' || key === 'b' || key === 'j' || key === 'e' || key === 'd' || ['1', '2', '3', '4', '5'].includes(key)) {
          e.preventDefault()
          e.stopPropagation()
        }
      }
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [openSettings])

  const shortcuts = {
    'CTRL+P': () => openCommandPalette('files'),
    'CTRL+SHIFT+P': () => openCommandPalette('commands'),
    'CTRL+B': () => {
      if (useAppStore.getState().isFullscreen) {
        toggleFullscreenFileDrawer()
        return
      }
      toggleSidebar()
    },
    'CTRL+J': () => toggleAiPanel(),
    'CTRL+N': () => handleNewFile(),
    'CTRL+O': () => void runAfterNormalLayout(() => handleOpenFile()),
    'CTRL+S': () => handleSaveFile(),
    'CTRL+SHIFT+V': () => togglePreview(),
    'CTRL+SHIFT+D': () => toggleDiffPreview(),
    'CTRL+SHIFT+L': () => toggleTheme(),
    'F11': () => void toggleFullscreen(),
    'CTRL+SHIFT+1': () => setViewMode('edit'),
    'CTRL+SHIFT+2': () => setViewMode('preview'),
    'CTRL+SHIFT+3': () => setViewMode('edit-preview'),
    'CTRL+SHIFT+4': () => setViewMode('dual-preview'),
    'CTRL+SHIFT+5': () => setViewMode('diff-preview'),
    'CTRL+SHIFT+E': () => handleExportHtml(),
    'CTRL+I': () => openSettings(),
  }

  useKeyboardShortcuts(shortcuts)

  const handleClosePalette = useCallback(() => {
    setCommandPaletteOpen(false)
  }, [])

  return (
    <div className="flex flex-col h-full w-full bg-gm-canvas">
      {/* Title Bar */}
      {!isFullscreen && <TitleBar />}

      {/* Main Content Area */}
      <div className="flex flex-1 overflow-hidden">
        {/* Sidebar */}
        {!isFullscreen && (
          <Sidebar
            collapsed={sidebarCollapsed}
            width={sidebarWidth}
            onOpenSettings={openSettings}
            onOpenSearch={handleOpenSearch}
          />
        )}

        {/* Editor Area */}
        <div className="flex-1 flex overflow-hidden">
          <EditorArea />
        </div>

        {/* AI Panel */}
        {!isFullscreen && aiPanelOpen && (
          <div
            className="border-l border-gm-border flex-shrink-0 animate-slideInRight relative"
            style={{ width: aiPanelWidth, contain: 'layout' }}
          >
            {/* Resize handle */}
            <div
              className="absolute left-0 top-0 bottom-0 w-1 cursor-col-resize z-10 hover:bg-gm-primary/30 transition-colors"
              onMouseDown={handleResizeStart}
            />
            <Suspense fallback={null}><AiPanel /></Suspense>
          </div>
        )}
      </div>

      {isFullscreen && (
        <FullscreenControlBar
          fileDrawerOpen={fullscreenFileDrawerOpen}
          onToggleFileDrawer={toggleFullscreenFileDrawer}
          onCloseFileDrawer={closeFullscreenFileDrawer}
        />
      )}

      {isFullscreen && (
        <FullscreenFileDrawer
          open={fullscreenFileDrawerOpen}
          onClose={closeFullscreenFileDrawer}
          onOpenSearch={handleOpenSearch}
        />
      )}

      {isFullscreen && aiPanelOpen && (
        <div
          ref={fullscreenAiPanelRef}
          className="fixed z-[45] flex flex-col overflow-hidden rounded-2xl border border-gm-border bg-gm-surface/92 shadow-lg backdrop-blur-xl animate-slideInRight"
          style={{
            left: fullscreenAiPosition.x,
            top: fullscreenAiPosition.y,
            width: getFullscreenAiSize().width,
            height: getFullscreenAiSize().height,
            contain: 'layout',
          }}
        >
          <div className="min-h-0 min-w-0 flex-1">
            <Suspense fallback={null}><AiPanel
              fullscreenDragHandleProps={{
                onPointerDown: handleFullscreenAiDragStart,
                onPointerMove: handleFullscreenAiDragMove,
                onPointerUp: handleFullscreenAiDragEnd,
                onPointerCancel: handleFullscreenAiDragEnd,
              }}
            /></Suspense>
          </div>
        </div>
      )}

      {/* Status Bar */}
      {!isFullscreen && <StatusBar />}

      {/* Command Palette */}
      <CommandPalette
        open={commandPaletteOpen}
        onClose={handleClosePalette}
        mode={commandPaletteMode}
      />

      {/* Settings Modal */}
      <Modal
        open={settingsOpen}
        width={860}
        className={`gm-settings-modal ${customCursorEnabled ? '' : 'gm-system-cursor'}`}
        maskClassName={`gm-settings-mask ${customCursorEnabled ? '' : 'gm-system-cursor'}`}
        onClose={() => setSettingsOpen(false)}
        footer={null}
        typewriter={false}
        cursor={customCursorEnabled}
      >
        <div className={customCursorEnabled ? undefined : 'gm-system-cursor'} style={{ width: '100%', height: '560px', overflow: 'hidden', padding: '10px 14px', minHeight: 0 }}>
          <Suspense fallback={null}><SettingsPage initialSection={settingsSection} /></Suspense>
        </div>
      </Modal>

      {/* Search highlight styles (CSS Highlight API) */}
      <style>{`
        ::highlight(search-highlight) { background-color: rgba(251, 191, 36, 0.35); }
        ::highlight(search-highlight-active) { background-color: rgba(251, 191, 36, 0.7); }
        ::highlight(preview-context-selection) { background-color: rgba(58, 175, 164, 0.28); }
      `}</style>
    </div>
  )
}

const FULLSCREEN_AI_MARGIN = 16
const FULLSCREEN_AI_MAX_WIDTH = 404

function getFullscreenAiSize() {
  const width = Math.min(FULLSCREEN_AI_MAX_WIDTH, Math.max(320, window.innerWidth - FULLSCREEN_AI_MARGIN * 2))
  const height = Math.min(680, Math.max(360, window.innerHeight - FULLSCREEN_AI_MARGIN * 2))
  return { width, height }
}

function getDefaultFullscreenAiPosition() {
  const size = getFullscreenAiSize()
  return clampFullscreenAiPosition(window.innerWidth - size.width - FULLSCREEN_AI_MARGIN, 64)
}

function clampFullscreenAiPosition(x: number, y: number) {
  const size = getFullscreenAiSize()
  const maxX = Math.max(FULLSCREEN_AI_MARGIN, window.innerWidth - size.width - FULLSCREEN_AI_MARGIN)
  const maxY = Math.max(FULLSCREEN_AI_MARGIN, window.innerHeight - size.height - FULLSCREEN_AI_MARGIN)
  return {
    x: Math.min(Math.max(FULLSCREEN_AI_MARGIN, x), maxX),
    y: Math.min(Math.max(FULLSCREEN_AI_MARGIN, y), maxY),
  }
}
