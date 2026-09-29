import { lazy, Suspense, useState, useCallback, useRef, useEffect, useLayoutEffect, useMemo } from 'react'
import { useAppStore, type FullscreenAiPosition, type FullscreenAiSize } from '@/stores/appStore'
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
import { resolveThemeDefinition } from '@/services/appearance/appearanceDom'
import { useFullscreen } from '@/hooks/useFullscreen'
import { OPEN_SETTINGS_SECTION_EVENT } from '@/services/settingsNavigation'
import { getRuntimeCapabilities } from '@/services/runtimeCapabilities'
import { getAiPanelView, requestOpenAiChat, requestOpenReadingArtifacts, requestOpenReadingReminders, type AiPanelView } from '@/services/aiPanelNavigation'
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
  getProductTourSteps,
  type ProductTourTopic,
} from '@/features/productTour/productTourContent'
import { markStartupPoint } from '@/services/startupPerformance'
import { getBootSnapshotDisplayContent, hasBootSnapshotContent, readBootSnapshot } from '@/services/bootSnapshot'

type AiPanelModule = typeof import('@/components/ai/AiPanel')
let aiPanelModulePromise: Promise<AiPanelModule> | null = null

const loadAiPanelModule = (): Promise<AiPanelModule> => {
  if (!aiPanelModulePromise) {
    aiPanelModulePromise = import('@/components/ai/AiPanel').catch((error) => {
      aiPanelModulePromise = null
      throw error
    })
  }
  return aiPanelModulePromise
}
const AiPanel = lazy(() => loadAiPanelModule().then((module) => ({ default: module.AiPanel })))

/** 仅下载并解析 AI 面板模块，不挂载面板或触发其数据加载。 */
export function preloadAiPanel(): Promise<AiPanelModule> {
  return loadAiPanelModule()
}
const EditorArea = lazy(() => import('../editor/EditorArea').then((module) => ({ default: module.EditorArea })))
const SettingsPage = lazy(() => import('@settings-entry').then((module) => ({ default: module.SettingsPage })))
const FeatureIntroModal = lazy(() => import('@/features/featureIntro/FeatureIntroModal').then((module) => ({ default: module.FeatureIntroModal })))
const ProductTourOverlay = lazy(() => import('@/features/productTour/ProductTourOverlay').then((module) => ({ default: module.ProductTourOverlay })))

function BootDocumentFallback() {
  const activeTab = useEditorStore((state) => state.tabs.find((tab) => tab.id === state.activeTabId))
  const snapshotContent = activeTab && hasBootSnapshotContent(activeTab) ? activeTab.content : null
  const snapshot = snapshotContent === null ? null : readBootSnapshot()
  const snapshotTopLine = snapshot?.readingPosition?.topLine
  const hasPositionedSnapshot = !snapshot?.readingPosition
    || (Number.isInteger(snapshotTopLine) && (snapshotTopLine as number) >= 1)
  const display = snapshotContent === null
    ? null
    : getBootSnapshotDisplayContent(snapshotContent, snapshot?.readingPosition?.topLine)

  useLayoutEffect(() => {
    if (display !== null && hasPositionedSnapshot) {
      markStartupPoint('active-document-first-visible')
    }
  }, [display, hasPositionedSnapshot])

  if (snapshotContent === null) return null

  return (
    <div className="h-full w-full overflow-auto bg-gm-surface px-8 py-6 text-gm-text-primary" aria-label="启动文档快照">
      <pre className="m-0 whitespace-pre-wrap break-words font-[inherit] text-body leading-relaxed" data-boot-start-line={display?.startLine ?? 1}>{display?.content}</pre>
    </div>
  )
}

interface AppLayoutProps {
  databaseReady: boolean
}

function AiPanelFallback() {
  return (
    <div className="flex h-full min-h-0 flex-col bg-gm-surface" aria-label="正在加载 AI 侧边栏" role="status">
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-gm-border px-4">
        <div className="h-4 w-24 animate-pulse rounded bg-gm-surface-hover" />
        <div className="h-7 w-7 animate-pulse rounded-md bg-gm-surface-hover" />
      </div>
      <div className="flex-1 space-y-3 overflow-hidden px-4 py-5">
        <div className="h-3 w-2/5 animate-pulse rounded bg-gm-surface-hover" />
        <div className="h-16 w-full animate-pulse rounded-lg bg-gm-surface-hover" />
        <div className="ml-auto h-12 w-4/5 animate-pulse rounded-lg bg-gm-surface-hover" />
        <div className="h-20 w-full animate-pulse rounded-lg bg-gm-surface-hover" />
      </div>
      <div className="h-12 shrink-0 border-t border-gm-border px-4 py-3">
        <div className="h-6 w-full animate-pulse rounded-md bg-gm-surface-hover" />
      </div>
    </div>
  )
}

export function AppLayout({ databaseReady }: AppLayoutProps) {
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
  const storedFullscreenAiPosition = useAppStore((s) => s.fullscreenAiPosition)
  const storedFullscreenAiSize = useAppStore((s) => s.fullscreenAiSize)
  const persistFullscreenAiPosition = useAppStore((s) => s.setFullscreenAiPosition)
  const persistFullscreenAiSize = useAppStore((s) => s.setFullscreenAiSize)
  const toggleSidebar = useAppStore((s) => s.toggleSidebar)
  const toggleAiPanel = useAppStore((s) => s.toggleAiPanel)
  const setSidebarWidth = useAppStore((s) => s.setSidebarWidth)
  const setAiPanelWidth = useAppStore((s) => s.setAiPanelWidth)
  const togglePreview = useEditorStore((s) => s.togglePreview)
  const toggleDiffPreview = useEditorStore((s) => s.toggleDiffPreview)
  const setViewMode = useEditorStore((s) => s.setViewMode)
  const { handleNewFile, handleOpenFile, handleSaveFile } = useFileOperations()
  const { isFullscreen, toggleFullscreen, enterFullscreen, exitFullscreen } = useFullscreen()
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
  const [productTourTopic, setProductTourTopic] = useState<ProductTourTopic | 'topics'>('overview')
  const [productTourStep, setProductTourStep] = useState(0)
  const productTourSteps = useMemo(() => productTourTopic === 'topics' ? [] : getProductTourSteps(productTourTopic, getRuntimeCapabilities().isWeb), [productTourTopic])
  const productTourSnapshotRef = useRef<{
    isFullscreen: boolean
    fullscreenFileDrawerOpen: boolean
    activeTabId: string | null
    viewMode: ReturnType<typeof useEditorStore.getState>['viewMode']
    previewVisible: boolean
    rightPaneTabId: string | null
    rightPaneUserSelected: boolean
    createdDemoTab: boolean
    sidebarCollapsed: boolean
    aiPanelOpen: boolean
    aiPanelView: AiPanelView
    settingsOpen: boolean
    settingsSection: string | null
  } | null>(null)
  const [fullscreenAiPosition, setFullscreenAiPosition] = useState<FullscreenAiPosition>(() => (
    storedFullscreenAiPosition
      ? clampFullscreenAiPosition(storedFullscreenAiPosition.x, storedFullscreenAiPosition.y)
      : getDefaultFullscreenAiPosition()
  ))
  const [fullscreenAiSize, setFullscreenAiSize] = useState<FullscreenAiSize>(() => (
    storedFullscreenAiSize
      ? clampFullscreenAiSize(storedFullscreenAiSize.width, storedFullscreenAiSize.height)
      : getFullscreenAiSize()
  ))
  const fullscreenAiPositionRef = useRef(fullscreenAiPosition)
  const fullscreenAiSizeRef = useRef(fullscreenAiSize)
  const fullscreenAiDragRef = useRef<{
    pointerId: number
    startX: number
    startY: number
    originX: number
    originY: number
    latestPosition: FullscreenAiPosition
    dragged: boolean
  } | null>(null)
  const productTourFullscreenTaskRef = useRef<Promise<void> | null>(null)
  const setProductTourFullscreen = useCallback((next: boolean) => {
    const change = () => next ? enterFullscreen() : exitFullscreen()
    const task = productTourFullscreenTaskRef.current
      ? productTourFullscreenTaskRef.current.then(change, change)
      : change()
    productTourFullscreenTaskRef.current = task
    void task.then(() => {
      if (productTourFullscreenTaskRef.current === task) productTourFullscreenTaskRef.current = null
    }, () => {
      if (productTourFullscreenTaskRef.current === task) productTourFullscreenTaskRef.current = null
    })
    return task
  }, [enterFullscreen, exitFullscreen])
  const fullscreenAiResizeRef = useRef<{
    pointerId: number
    startX: number
    startY: number
    originSize: FullscreenAiSize
    latestSize: FullscreenAiSize
    latestPosition: FullscreenAiPosition
  } | null>(null)
  const fullscreenAiPanelRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (isFullscreen) {
      useAppStore.getState().closeAiPanel()
      const size = clampFullscreenAiSize(fullscreenAiSizeRef.current.width, fullscreenAiSizeRef.current.height)
      const position = clampFullscreenAiPosition(fullscreenAiPositionRef.current.x, fullscreenAiPositionRef.current.y, size)
      fullscreenAiSizeRef.current = size
      setFullscreenAiSize(size)
      persistFullscreenAiSize(size)
      fullscreenAiPositionRef.current = position
      setFullscreenAiPosition(position)
      persistFullscreenAiPosition(position)
      setFullscreenFileDrawerOpen(false)
    } else {
      setFullscreenFileDrawerOpen(false)
    }
  }, [isFullscreen, persistFullscreenAiPosition, persistFullscreenAiSize])

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
    setProductTourOpen(false)
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
      const app = useAppStore.getState()
      if (app.sidebarCollapsed !== snapshot.sidebarCollapsed) app.toggleSidebar()
      setSettingsSection(snapshot.settingsSection)
      setSettingsOpen(snapshot.settingsOpen)
      void setProductTourFullscreen(snapshot.isFullscreen).then(() => {
        const restoredApp = useAppStore.getState()
        if (restoredApp.aiPanelOpen !== snapshot.aiPanelOpen) restoredApp.toggleAiPanel()
        if (snapshot.aiPanelOpen) {
          if (snapshot.aiPanelView === 'artifacts') requestOpenReadingArtifacts()
          else if (snapshot.aiPanelView === 'reminders') requestOpenReadingReminders()
          else requestOpenAiChat()
        }
        setFullscreenFileDrawerOpen(snapshot.fullscreenFileDrawerOpen)
      })
    }
    productTourSnapshotRef.current = null
    setProductTourTopic('overview')
    setProductTourStep(0)
  }, [setProductTourFullscreen])

  const startProductTour = useCallback(() => {
    if (productTourOpen) return
    const editor = useEditorStore.getState()
    const createdDemoTab = editor.tabs.length === 0
    productTourSnapshotRef.current = {
      isFullscreen: useAppStore.getState().isFullscreen,
      fullscreenFileDrawerOpen,
      activeTabId: editor.activeTabId,
      viewMode: editor.viewMode,
      previewVisible: editor.previewVisible,
      rightPaneTabId: editor.rightPaneTabId,
      rightPaneUserSelected: editor.rightPaneUserSelected,
      createdDemoTab,
      sidebarCollapsed: useAppStore.getState().sidebarCollapsed,
      aiPanelOpen: useAppStore.getState().aiPanelOpen,
      aiPanelView: getAiPanelView(),
      settingsOpen,
      settingsSection,
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
    if (useAppStore.getState().isFullscreen) setProductTourFullscreen(false)
    setProductTourTopic('overview')
    setProductTourStep(0)
    setProductTourOpen(true)
  }, [fullscreenFileDrawerOpen, productTourOpen, setProductTourFullscreen, settingsOpen, settingsSection])

  const changeProductTourTopic = useCallback((topic: ProductTourTopic | 'topics') => {
    setProductTourFullscreen(topic === 'fullscreen')
    setFullscreenFileDrawerOpen(false)
    setProductTourTopic(topic)
    setProductTourStep(0)
  }, [setProductTourFullscreen])

  const tourSurface = productTourSteps[productTourStep]?.surface
  useEffect(() => {
    if (!productTourOpen || !tourSurface) return
    const app = useAppStore.getState()
    const settings = tourSurface === 'settings-ai' || tourSurface === 'settings-general'
    setSettingsOpen(settings)
    if (settings) {
      setSettingsSection(tourSurface === 'settings-ai' ? 'ai' : 'general')
      if (app.aiPanelOpen) app.closeAiPanel()
      return
    }
    if (tourSurface === 'fullscreen') {
      if (!app.sidebarCollapsed) app.toggleSidebar()
      return
    }
    const sidebar = tourSurface === 'sidebar'
    if (app.sidebarCollapsed === sidebar) app.toggleSidebar()
    const ai = tourSurface === 'ai-chat' || tourSurface === 'artifacts'
    if (ai && !app.aiPanelOpen) app.toggleAiPanel()
    if (!ai && app.aiPanelOpen) app.closeAiPanel()
    if (tourSurface === 'ai-chat') requestOpenAiChat()
    if (tourSurface === 'artifacts') requestOpenReadingArtifacts()
  }, [productTourOpen, tourSurface])

  useEffect(() => {
    if (!productTourOpen || productTourTopic !== 'fullscreen' || !isFullscreen) return
    const app = useAppStore.getState()
    if (productTourStep === 1) {
      if (!app.aiPanelOpen) app.toggleAiPanel()
    } else if (app.aiPanelOpen) {
      app.closeAiPanel()
    }
    setFullscreenFileDrawerOpen(productTourStep === 3)
  }, [isFullscreen, productTourOpen, productTourStep, productTourTopic])

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
      const size = clampFullscreenAiSize(fullscreenAiSizeRef.current.width, fullscreenAiSizeRef.current.height)
      const position = clampFullscreenAiPosition(fullscreenAiPositionRef.current.x, fullscreenAiPositionRef.current.y, size)
      fullscreenAiSizeRef.current = size
      setFullscreenAiSize(size)
      persistFullscreenAiSize(size)
      fullscreenAiPositionRef.current = position
      setFullscreenAiPosition(position)
      persistFullscreenAiPosition(position)
    }
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [isFullscreen, persistFullscreenAiPosition, persistFullscreenAiSize])

  const handleFullscreenAiDragStart = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    fullscreenAiDragRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      originX: fullscreenAiPositionRef.current.x,
      originY: fullscreenAiPositionRef.current.y,
      latestPosition: fullscreenAiPositionRef.current,
      dragged: false,
    }
    document.body.style.userSelect = 'none'
  }, [])

  const handleFullscreenAiDragMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const drag = fullscreenAiDragRef.current
    if (!drag || drag.pointerId !== e.pointerId) return
    const dx = e.clientX - drag.startX
    const dy = e.clientY - drag.startY
    if (Math.abs(dx) + Math.abs(dy) > 3) drag.dragged = true
    const position = clampFullscreenAiPosition(
      drag.originX + dx,
      drag.originY + dy,
      fullscreenAiSizeRef.current,
    )
    drag.latestPosition = position
    fullscreenAiPositionRef.current = position
    setFullscreenAiPosition(position)
  }, [])

  const handleFullscreenAiDragEnd = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const drag = fullscreenAiDragRef.current
    if (drag?.pointerId === e.pointerId) {
      fullscreenAiDragRef.current = null
      document.body.style.userSelect = ''
      persistFullscreenAiPosition(drag.latestPosition)
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId)
      }
    }
  }, [persistFullscreenAiPosition])

  const handleFullscreenAiResizeStart = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.stopPropagation()
    e.currentTarget.setPointerCapture(e.pointerId)
    fullscreenAiResizeRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      originSize: fullscreenAiSizeRef.current,
      latestSize: fullscreenAiSizeRef.current,
      latestPosition: fullscreenAiPositionRef.current,
    }
    document.body.style.cursor = 'nwse-resize'
    document.body.style.userSelect = 'none'
  }, [])

  const handleFullscreenAiResizeMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const resize = fullscreenAiResizeRef.current
    if (!resize || resize.pointerId !== e.pointerId) return
    const size = clampFullscreenAiSize(
      resize.originSize.width + e.clientX - resize.startX,
      resize.originSize.height + e.clientY - resize.startY,
    )
    const position = clampFullscreenAiPosition(
      fullscreenAiPositionRef.current.x,
      fullscreenAiPositionRef.current.y,
      size,
    )
    resize.latestSize = size
    resize.latestPosition = position
    fullscreenAiSizeRef.current = size
    fullscreenAiPositionRef.current = position
    setFullscreenAiSize(size)
    setFullscreenAiPosition(position)
  }, [])

  const handleFullscreenAiResizeEnd = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const resize = fullscreenAiResizeRef.current
    if (resize?.pointerId !== e.pointerId) return
    fullscreenAiResizeRef.current = null
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
    persistFullscreenAiSize(resize.latestSize)
    persistFullscreenAiPosition(resize.latestPosition)
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
    }
  }, [persistFullscreenAiPosition, persistFullscreenAiSize])

  useEffect(() => {
    if (!isFullscreen || !aiPanelOpen) return
    const handlePointerDown = (e: PointerEvent) => {
      if ((e.target as Element | null)?.closest('.gm-product-tour')) return
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
    updateAppearanceSettings({
      themeId: resolveThemeDefinition(appearance.themeId).colorScheme === 'dark'
        ? appearance.lastLightThemeId
        : 'dark',
    })
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
    'CTRL+O': () => void handleOpenFile(),
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
            ? <Suspense fallback={<BootDocumentFallback />}><EditorArea databaseReady={databaseReady} /></Suspense>
            : <BootDocumentFallback />}
        </div>

        {/* AI Panel */}
        {!isFullscreen && aiPanelOpen && (
          <div
            data-product-tour="ai-panel"
            className="border-l border-gm-border flex-shrink-0 animate-slideInRight relative"
            style={{ width: aiPanelWidth, contain: 'layout' }}
          >
            {/* Resize handle */}
            <div
              className="absolute left-0 top-0 bottom-0 w-1 cursor-col-resize z-10 hover:bg-gm-primary/30 transition-colors"
              onMouseDown={handleResizeStart}
            />
            <Suspense fallback={<AiPanelFallback />}><AiPanel /></Suspense>
          </div>
        )}
      </div>

      {isFullscreen && (
        <FullscreenControlBar
          productTourStep={productTourOpen && productTourTopic === 'fullscreen' ? productTourStep : null}
          fileDrawerOpen={fullscreenFileDrawerOpen}
          onToggleFileDrawer={toggleFullscreenFileDrawer}
          onCloseFileDrawer={closeFullscreenFileDrawer}
          onNewFile={handleNewFile}
          onOpenFile={handleOpenFile}
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
          data-fullscreen-ai-panel="true"
          ref={fullscreenAiPanelRef}
          className="fixed z-[45] flex flex-col overflow-hidden rounded-2xl border border-gm-border bg-gm-surface/92 shadow-lg backdrop-blur-xl animate-slideInRight"
          style={{
            left: fullscreenAiPosition.x,
            top: fullscreenAiPosition.y,
            width: fullscreenAiSize.width,
            height: fullscreenAiSize.height,
            contain: 'layout',
          }}
        >
          <div className="min-h-0 min-w-0 flex-1">
            <Suspense fallback={<AiPanelFallback />}><AiPanel
              fullscreenDragHandleProps={{
                onPointerDown: handleFullscreenAiDragStart,
                onPointerMove: handleFullscreenAiDragMove,
                onPointerUp: handleFullscreenAiDragEnd,
                onPointerCancel: handleFullscreenAiDragEnd,
            }}
          /></Suspense>
          </div>
          <div
            aria-label="调整 AI 助手窗口大小"
            className="absolute bottom-0 right-0 z-30 flex h-5 w-5 cursor-grab items-center justify-center text-gm-text-secondary touch-none hover:text-gm-primary active:cursor-grabbing"
            onPointerDown={handleFullscreenAiResizeStart}
            onPointerMove={handleFullscreenAiResizeMove}
            onPointerUp={handleFullscreenAiResizeEnd}
            onPointerCancel={handleFullscreenAiResizeEnd}
          >
            <svg className="rotate-90" width="13" height="13" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
              <path d="M5 5l10 10M10 5l5 5" />
            </svg>
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
          <Suspense fallback={null}><SettingsPage initialSection={settingsSection} onSectionChange={setSettingsSection} /></Suspense>
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
        topic={productTourTopic}
        steps={productTourSteps}
        stepIndex={productTourStep}
        onStepChange={setProductTourStep}
        onTopicChange={changeProductTourTopic}
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
const FULLSCREEN_AI_MIN_WIDTH = 360
const FULLSCREEN_AI_MIN_HEIGHT = 520
const FULLSCREEN_AI_RESIZE_SPAN = 280
const FULLSCREEN_AI_MAX_WIDTH = FULLSCREEN_AI_MIN_WIDTH + FULLSCREEN_AI_RESIZE_SPAN
const FULLSCREEN_AI_MAX_HEIGHT = FULLSCREEN_AI_MIN_HEIGHT + FULLSCREEN_AI_RESIZE_SPAN

function getFullscreenAiSize() {
  return clampFullscreenAiSize(404, 680)
}

function clampFullscreenAiSize(width: number, height: number): FullscreenAiSize {
  const availableWidth = Math.max(0, window.innerWidth - FULLSCREEN_AI_MARGIN * 2)
  const availableHeight = Math.max(0, window.innerHeight - FULLSCREEN_AI_MARGIN * 2)
  const maxWidth = Math.min(FULLSCREEN_AI_MAX_WIDTH, availableWidth)
  const maxHeight = Math.min(FULLSCREEN_AI_MAX_HEIGHT, availableHeight)
  return {
    width: Math.min(maxWidth, Math.max(Math.min(FULLSCREEN_AI_MIN_WIDTH, maxWidth), width)),
    height: Math.min(maxHeight, Math.max(Math.min(FULLSCREEN_AI_MIN_HEIGHT, maxHeight), height)),
  }
}

function getDefaultFullscreenAiPosition() {
  const size = getFullscreenAiSize()
  return clampFullscreenAiPosition(window.innerWidth - size.width - FULLSCREEN_AI_MARGIN, 64)
}

function clampFullscreenAiPosition(x: number, y: number, size = getFullscreenAiSize()) {
  const maxX = Math.max(FULLSCREEN_AI_MARGIN, window.innerWidth - size.width - FULLSCREEN_AI_MARGIN)
  const maxY = Math.max(FULLSCREEN_AI_MARGIN, window.innerHeight - size.height - FULLSCREEN_AI_MARGIN)
  return {
    x: Math.min(Math.max(FULLSCREEN_AI_MARGIN, x), maxX),
    y: Math.min(Math.max(FULLSCREEN_AI_MARGIN, y), maxY),
  }
}
