import { lazy, Suspense, useState, useCallback, useRef, useEffect, useLayoutEffect } from 'react'
import { useAppStore } from '@/stores/appStore'
import { useEditorStore } from '@/stores/editorStore'
import { useKeyboardShortcuts } from '@/hooks/useKeyboard'
import { useFileOperations } from '@/hooks/useFileOperations'
import { Modal } from 'animal-island-ui'
import { exportMarkdownAsHtml } from '@/services/markdownExport'
import { Sidebar } from './Sidebar'
import { StatusBar } from './StatusBar'
import { TitleBar } from './TitleBar'
import { OPEN_EDITOR_SEARCH_EVENT } from '@/services/editorEvents'
import { FullscreenControlBar } from '../editor/FullscreenControlBar'
import { FullscreenFileDrawer } from './FullscreenFileDrawer'
import { CommandPalette } from '../common/CommandPalette'
import { toast } from '@/services/toast'
import { useSettingsStore } from '@/stores/settingsStore'
import { useFullscreen } from '@/hooks/useFullscreen'
import { OPEN_SETTINGS_SECTION_EVENT } from '@/services/settingsNavigation'
import {
  OPEN_FEATURE_INTRO_EVENT,
  type FeatureIntroEventDetail,
} from '@/features/featureIntro/featureIntroEvents'
import {
  OVERVIEW_FEATURES,
  getVersionFeatures,
} from '@/features/featureIntro/featureIntroContent'
import {
  OPEN_PRODUCT_TOUR_EVENT,
} from '@/features/productTour/productTourEvents'
import {
  PRODUCT_TOUR_DEMO_CONTENT,
  PRODUCT_TOUR_DEMO_TAB_ID,
} from '@/features/productTour/productTourContent'
import { markStartupPoint } from '@/services/startupPerformance'
import { hasBootSnapshotContent } from '@/services/bootSnapshot'

const AiPanel = lazy(() => import('@/components/ai/AiPanel').then((module) => ({ default: module.AiPanel })))
const EditorArea = lazy(() => import('../editor/EditorArea').then((module) => ({ default: module.EditorArea })))
const SettingsPage = lazy(() => import('@settings-entry').then((module) => ({ default: module.SettingsPage })))
const FeatureIntroModal = lazy(() => import('@/features/featureIntro/FeatureIntroModal').then((module) => ({ default: module.FeatureIntroModal })))
const ProductTourOverlay = lazy(() => import('@/features/productTour/ProductTourOverlay').then((module) => ({ default: module.ProductTourOverlay })))

function BootDocumentFallback() {
  const activeTab = useEditorStore((state) => state.tabs.find((tab) => tab.id === state.activeTabId))
  const snapshotContent = activeTab && hasBootSnapshotContent(activeTab) ? activeTab.content : null

  useLayoutEffect(() => {
    if (snapshotContent !== null) {
      markStartupPoint('active-document-first-visible')
    }
  }, [snapshotContent])

  if (snapshotContent === null) return null

  return (
    <div className="h-full w-full overflow-auto bg-gm-surface px-8 py-6 text-gm-text-primary" aria-label="启动文档快照">
      <pre className="m-0 whitespace-pre-wrap break-words font-[inherit] text-body leading-relaxed">{snapshotContent}</pre>
    </div>
  )
}

export function AppLayout() {
  const [editorSurfaceEnabled, setEditorSurfaceEnabled] = useState(false)

  useLayoutEffect(() => {
    markStartupPoint('app-shell-first-visible')
    const frame = requestAnimationFrame(() => {
      markStartupPoint('first-animation-frame')
      setEditorSurfaceEnabled(true)
    })
    return () => cancelAnimationFrame(frame)
  }, [])

  useEffect(() => {
    markStartupPoint('app-shell-interactive')
  }, [])

  const sidebarCollapsed = useAppStore((s) => s.sidebarCollapsed)
  const aiPanelOpen = useAppStore((s) => s.aiPanelOpen)
  const sidebarWidth = useAppStore((s) => s.sidebarWidth)
  const aiPanelWidth = useAppStore((s) => s.aiPanelWidth)
  const toggleSidebar = useAppStore((s) => s.toggleSidebar)
  const toggleAiPanel = useAppStore((s) => s.toggleAiPanel)
  const setSidebarWidth = useAppStore((s) => s.setSidebarWidth)
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
  const [featureIntroOpen, setFeatureIntroOpen] = useState(false)
  const [featureIntroMode, setFeatureIntroMode] = useState<'overview' | 'version'>('overview')
  const [featureIntroVersion, setFeatureIntroVersion] = useState<string | undefined>()
  const [fullscreenFileDrawerOpen, setFullscreenFileDrawerOpen] = useState(false)
  const [productTourOpen, setProductTourOpen] = useState(false)
  const [productTourStep, setProductTourStep] = useState(0)
  const productTourSnapshotRef = useRef<{
    activeTabId: string | null
    viewMode: ReturnType<typeof useEditorStore.getState>['viewMode']
    previewVisible: boolean
    rightPaneTabId: string | null
    rightPaneUserSelected: boolean
    createdDemoTab: boolean
  } | null>(null)
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
      useAppStore.getState().closeAiPanel()
      setFullscreenAiPosition(getDefaultFullscreenAiPosition())
      setFullscreenFileDrawerOpen(false)
    } else {
      setFullscreenFileDrawerOpen(false)
    }
  }, [isFullscreen])

  // Sidebar resize
  const isSidebarResizing = useRef(false)

  const handleSidebarResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    isSidebarResizing.current = true
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }, [])

  const finishProductTour = useCallback(() => {
    const snapshot = productTourSnapshotRef.current
    if (snapshot) {
      const editor = useEditorStore.getState()
      if (snapshot.createdDemoTab && editor.tabs.some((tab) => tab.id === PRODUCT_TOUR_DEMO_TAB_ID)) {
        editor.closeTab(PRODUCT_TOUR_DEMO_TAB_ID)
      }
      editor.restoreProductTourState({
        viewMode: snapshot.viewMode,
        previewVisible: snapshot.previewVisible,
        rightPaneTabId: snapshot.rightPaneTabId,
        rightPaneUserSelected: snapshot.rightPaneUserSelected,
        activeTabId: snapshot.activeTabId && useEditorStore.getState().tabs.some((tab) => tab.id === snapshot.activeTabId)
          ? snapshot.activeTabId
          : null,
        previewSwitchingTabId: null,
      })
    }
    productTourSnapshotRef.current = null
    setProductTourOpen(false)
    setProductTourStep(0)
  }, [])

  const startProductTour = useCallback(() => {
    if (productTourOpen) return
    const editor = useEditorStore.getState()
    const createdDemoTab = editor.tabs.length === 0
    productTourSnapshotRef.current = {
      activeTabId: editor.activeTabId,
      viewMode: editor.viewMode,
      previewVisible: editor.previewVisible,
      rightPaneTabId: editor.rightPaneTabId,
      rightPaneUserSelected: editor.rightPaneUserSelected,
      createdDemoTab,
    }
    if (createdDemoTab) {
      editor.openTab({
        id: PRODUCT_TOUR_DEMO_TAB_ID,
        title: '观墨产品导览.md',
        filePath: null,
        content: PRODUCT_TOUR_DEMO_CONTENT,
        savedContent: PRODUCT_TOUR_DEMO_CONTENT,
        originalContent: PRODUCT_TOUR_DEMO_CONTENT,
        modified: false,
        ephemeral: true,
      })
    }
    editor.setViewMode('preview')
    useAppStore.getState().closeAiPanel()
    if (!useAppStore.getState().sidebarCollapsed) useAppStore.getState().toggleSidebar()
    setSettingsOpen(false)
    setProductTourStep(0)
    setProductTourOpen(true)
  }, [productTourOpen])

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isSidebarResizing.current) return
      const clamped = Math.max(250, Math.min(500, e.clientX))
      setSidebarWidth(clamped)
    }

    const handleMouseUp = () => {
      if (isSidebarResizing.current) {
        isSidebarResizing.current = false
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
  }, [setSidebarWidth])

  // AI panel resize
  const isAiPanelResizing = useRef(false)

  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    isAiPanelResizing.current = true
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }, [])

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isAiPanelResizing.current) return
      // Calculate new width from the right edge of the window
      const newWidth = window.innerWidth - e.clientX
      const clamped = Math.max(280, Math.min(600, newWidth))
      setAiPanelWidth(clamped)
    }

    const handleMouseUp = () => {
      if (isAiPanelResizing.current) {
        isAiPanelResizing.current = false
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
      useAppStore.getState().closeAiPanel()
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
    const { appearance, updateAppearanceSettings } = useSettingsStore.getState()
    updateAppearanceSettings({ themeId: appearance.themeId === 'dark' ? appearance.lastLightThemeId : 'dark' })
  }, [])

  const runAfterNormalLayout = useCallback(async (action: () => void | Promise<void>) => {
    if (useAppStore.getState().isFullscreen) {
      await exitFullscreen()
    }
    await action()
  }, [exitFullscreen])

  useEffect(() => {
    const handleOpenProductTour = () => {
      void runAfterNormalLayout(() => {
        startProductTour()
      })
    }
    window.addEventListener(OPEN_PRODUCT_TOUR_EVENT, handleOpenProductTour)
    return () => window.removeEventListener(OPEN_PRODUCT_TOUR_EVENT, handleOpenProductTour)
  }, [runAfterNormalLayout, startProductTour])

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

  useEffect(() => {
    const handleOpenFeatureIntro = (event: Event) => {
      const detail = (event as CustomEvent<FeatureIntroEventDetail>).detail
      setFeatureIntroMode(detail.mode)
      setFeatureIntroVersion(detail.version)
      setFeatureIntroOpen(true)
    }
    window.addEventListener(OPEN_FEATURE_INTRO_EVENT, handleOpenFeatureIntro)
    return () => window.removeEventListener(OPEN_FEATURE_INTRO_EVENT, handleOpenFeatureIntro)
  }, [])

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
            onResizeStart={handleSidebarResizeStart}
            onOpenSettings={openSettings}
            onOpenSearch={handleOpenSearch}
          />
        )}

        {/* Editor Area */}
        <div className="flex-1 flex overflow-hidden">
          {editorSurfaceEnabled
            ? <Suspense fallback={<BootDocumentFallback />}><EditorArea /></Suspense>
            : <BootDocumentFallback />}
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

      {/* Feature Intro Modal */}
      {featureIntroOpen && <Suspense fallback={null}><FeatureIntroModal
        open={featureIntroOpen}
        features={
          featureIntroMode === 'overview'
            ? OVERVIEW_FEATURES
            : featureIntroVersion
              ? (getVersionFeatures(featureIntroVersion) ?? [])
              : []
        }
        onClose={() => setFeatureIntroOpen(false)}
      /></Suspense>}

      {productTourOpen && <Suspense fallback={null}><ProductTourOverlay
        open={productTourOpen}
        stepIndex={productTourStep}
        onStepChange={setProductTourStep}
        onClose={finishProductTour}
      /></Suspense>}

      {/* Search highlight styles (CSS Highlight API) */}
      <style>{`
        ::highlight(search-highlight) { background-color: color-mix(in srgb, var(--gm-warning) 35%, transparent); }
        ::highlight(search-highlight-active) { background-color: color-mix(in srgb, var(--gm-warning) 70%, transparent); }
        ::highlight(preview-context-selection) { background-color: color-mix(in srgb, var(--gm-primary) 28%, transparent); }
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
