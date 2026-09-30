import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { Download, Plus, Trash2 } from 'lucide-react'
import { useEditorStore, type Tab } from '@/stores/editorStore'
import { useAppStore } from '@/stores/appStore'
import { FULLSCREEN_CONTENT_PADDING_PERCENT, useSettingsStore, type ThemeId } from '@/stores/settingsStore'
import { createAppearanceRegistry, type ThemeDefinition } from '@/services/appearance/appearanceRegistry'
import { addFileContextTag, summarizeFileWithAi } from '@/services/aiContext'
import { addKnowledgeDocument, isKnowledgeDocumentIndexed } from '@/services/rag/knowledgeBase'
import { isMarkdownPath } from '@/services/rag/indexer'
import { isSameFilePath } from '@/services/pathIdentity'
import { saveTabAsFile } from '@/services/fileEntryActions'
import { describeFileOperationError } from '@/services/fileOperationErrors'
import { toast } from '@/services/toast'
import { ContextMenu, ContextMenuGroupTitle, ContextMenuItem, ContextMenuSeparator } from '@/components/common/ContextMenu'
import { useFullscreen } from '@/hooks/useFullscreen'
import { useFileRename } from '@/hooks/useFileRename'
import { SettingSlider } from '@/components/common/SettingSlider'
import { isTauri, openFileDialog } from '@/hooks/useTauri'
import { deleteReadingBackground, downloadReadingBackground, importReadingBackground, listReadingBackgrounds, OFFICIAL_BACKGROUNDS, readReadingBackground, type BackgroundItem, type BackgroundLibrary } from '@/services/fullscreenBackgrounds'
import { releaseFullscreenBackground, updateFullscreenBackground, waitForFullscreenVisualIdle } from '@/services/fullscreenBackgroundLayer'

type ViewMode = 'edit' | 'preview' | 'edit-preview' | 'dual-preview' | 'diff-preview'

const MODES: Array<{ key: ViewMode; label: string }> = [
  { key: 'edit', label: '编辑' },
  { key: 'preview', label: '预览' },
  { key: 'edit-preview', label: '分屏' },
  { key: 'dual-preview', label: '对照' },
  { key: 'diff-preview', label: 'Diff' },
]
const PANEL_CONTENT_REVEAL_DELAY = 190
const FULLSCREEN_PADDING_DEBOUNCE_MS = 150
interface FullscreenControlBarProps {
  productTourStep: number | null
  fileDrawerOpen: boolean
  onToggleFileDrawer: () => void
  onCloseFileDrawer: () => void
  onNewFile: () => void
  onOpenFile: () => void
}

export function FullscreenControlBar({
  productTourStep,
  fileDrawerOpen,
  onToggleFileDrawer,
  onCloseFileDrawer,
  onNewFile,
  onOpenFile,
}: FullscreenControlBarProps) {
  const tabs = useEditorStore((s) => s.tabs)
  const activeTabId = useEditorStore((s) => s.activeTabId)
  const viewMode = useEditorStore((s) => s.viewMode)
  const backgroundPreviewVisible = viewMode === 'preview' || viewMode === 'edit-preview' || viewMode === 'dual-preview'
  const setActiveTab = useEditorStore((s) => s.setActiveTab)
  const setViewMode = useEditorStore((s) => s.setViewMode)
  const closeTab = useEditorStore((s) => s.closeTab)
  const setRightPaneTabId = useEditorStore((s) => s.setRightPaneTabId)
  const togglePinTab = useEditorStore((s) => s.togglePinTab)
  const favorites = useEditorStore((s) => s.favorites)
  const aiPanelOpen = useAppStore((s) => s.aiPanelOpen)
  const toggleAiPanel = useAppStore((s) => s.toggleAiPanel)
  const themeId = useSettingsStore((s) => s.appearance.themeId)
  const themeSlots = useSettingsStore((s) => s.appearance.themeSlots)
  const backgroundPath = useSettingsStore((s) => s.appearance.fullscreenBackgroundPath)
  const backgroundOpacity = useSettingsStore((s) => s.appearance.fullscreenBackgroundOpacity)
  const backgroundEnabled = useSettingsStore((s) => s.appearance.fullscreenBackgroundEnabled)
  const backgroundScene = useSettingsStore((s) => s.appearance.fullscreenBackgroundScene)
  const fullscreenContentPaddingPercent = useSettingsStore((s) => s.editor.fullscreenContentPaddingPercent)
  const updateAppearanceSettings = useSettingsStore((s) => s.updateAppearanceSettings)
  const updateEditorSettings = useSettingsStore((s) => s.updateEditorSettings)
  const fullscreenThemes = useMemo(() => createAppearanceRegistry(themeSlots).themes, [themeSlots])
  const { exitFullscreen } = useFullscreen()
  const [visible, setVisible] = useState(false)
  const [tabMode, setTabMode] = useState(false)
  const [renderedTabMode, setRenderedTabMode] = useState(false)
  const [contentVisible, setContentVisible] = useState(true)
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; tabId: string } | null>(null)
  const [kbStatus, setKbStatus] = useState<'idle' | 'checking' | 'not-indexed' | 'indexed' | 'adding'>('idle')
  const rename = useFileRename()
  const [paddingCardOpen, setPaddingCardOpen] = useState(false)
  const [themeCardOpen, setThemeCardOpen] = useState(false)
  const [backgroundCardOpen, setBackgroundCardOpen] = useState(false)
  const [hoveredBackgroundScene, setHoveredBackgroundScene] = useState<string | null>(null)
  const [backgroundLibrary, setBackgroundLibrary] = useState<BackgroundLibrary>({ downloadedOfficialIds: [], localBackgrounds: [] })
  const [localThumbnailUrls, setLocalThumbnailUrls] = useState<Record<string, string>>({})
  const [backgroundRevision, setBackgroundRevision] = useState(0)
  const [downloadProgress, setDownloadProgress] = useState<Record<string, number>>({})
  const [fileMenuOpen, setFileMenuOpen] = useState(false)
  const hideTimerRef = useRef<number | null>(null)
  const contentTimerRef = useRef<number | null>(null)
  const pointerWithinControlRef = useRef(false)
  const shellRef = useRef<HTMLDivElement>(null)
  const widthBeforeRef = useRef<number>(0)
  const widthAnimatingRef = useRef(false)
  const renderedTabModeRef = useRef(false)
  useEffect(() => {
    if (import.meta.env.MODE === 'web') return
    let cancelled = false
    void waitForFullscreenVisualIdle().then(() => {
      if (!cancelled) void import('@/styles/fullscreenBackground.css')
    })
    return () => { cancelled = true }
  }, [])

  const clearHideTimer = useCallback(() => {
    if (hideTimerRef.current !== null) {
      window.clearTimeout(hideTimerRef.current)
      hideTimerRef.current = null
    }
  }, [])

  const clearPanelTimers = useCallback(() => {
    if (contentTimerRef.current !== null) {
      window.clearTimeout(contentTimerRef.current)
      contentTimerRef.current = null
    }
  }, [])

  const switchPanel = useCallback((nextTabMode: boolean) => {
    clearPanelTimers()
    setTabMode(nextTabMode)

    if (renderedTabModeRef.current === nextTabMode) {
      setContentVisible(true)
      return
    }

    setContentVisible(false)
    renderedTabModeRef.current = nextTabMode
    setRenderedTabMode(nextTabMode)
    contentTimerRef.current = window.setTimeout(() => {
      setContentVisible(true)
    }, PANEL_CONTENT_REVEAL_DELAY)
  }, [clearPanelTimers])

  const showBar = useCallback(() => {
    clearHideTimer()
    setVisible(true)
  }, [clearHideTimer])

  const hideTabs = useCallback(() => {
    clearHideTimer()
    setFileMenuOpen(false)
    if (fileDrawerOpen) {
      onCloseFileDrawer()
      return
    }
    setVisible(true)
    switchPanel(false)
  }, [clearHideTimer, fileDrawerOpen, onCloseFileDrawer, switchPanel])

  const scheduleHide = useCallback(() => {
    if (productTourStep !== null || fileDrawerOpen || paddingCardOpen || themeCardOpen || backgroundCardOpen || fileMenuOpen) return
    clearHideTimer()
    hideTimerRef.current = window.setTimeout(() => {
      setVisible(false)
      if (!contextMenu) switchPanel(false)
    }, tabMode ? 2200 : 700)
  }, [backgroundCardOpen, clearHideTimer, contextMenu, fileDrawerOpen, fileMenuOpen, paddingCardOpen, productTourStep, switchPanel, tabMode, themeCardOpen])

  useEffect(() => {
    if (productTourStep === null) {
      setPaddingCardOpen(false)
      return
    }
    clearHideTimer()
    setVisible(true)
    setPaddingCardOpen(productTourStep === 2)
    switchPanel(productTourStep === 3)
  }, [clearHideTimer, productTourStep, switchPanel])

  const handleControlMouseEnter = useCallback(() => {
    pointerWithinControlRef.current = true
    showBar()
  }, [showBar])

  const handleControlMouseLeave = useCallback(() => {
    pointerWithinControlRef.current = false
    scheduleHide()
  }, [scheduleHide])

  useEffect(() => () => {
    clearHideTimer()
    clearPanelTimers()
  }, [clearHideTimer, clearPanelTimers])

  useEffect(() => {
    clearHideTimer()
    if (fileDrawerOpen) {
      setVisible(true)
      switchPanel(true)
    } else if (!contextMenu) {
      switchPanel(false)
    }
  }, [clearHideTimer, contextMenu, fileDrawerOpen, switchPanel])

  useEffect(() => {
    if (!visible || fileDrawerOpen || paddingCardOpen || themeCardOpen || backgroundCardOpen || fileMenuOpen) return
    if (!pointerWithinControlRef.current) scheduleHide()
  }, [backgroundCardOpen, contextMenu, fileDrawerOpen, fileMenuOpen, paddingCardOpen, scheduleHide, themeCardOpen, visible])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (document.querySelector('[data-editor-search-overlay]')) return
      if (contextMenu) {
        e.preventDefault()
        e.stopPropagation()
        setContextMenu(null)
        return
      }
      if (fileMenuOpen) {
        e.preventDefault()
        e.stopPropagation()
        setFileMenuOpen(false)
        return
      }
      if (paddingCardOpen) {
        e.preventDefault()
        e.stopPropagation()
        setPaddingCardOpen(false)
        return
      }
      if (themeCardOpen) {
        e.preventDefault()
        e.stopPropagation()
        setThemeCardOpen(false)
        return
      }
      if (backgroundCardOpen) {
        e.preventDefault()
        e.stopPropagation()
        setBackgroundCardOpen(false)
        return
      }
      if (fileDrawerOpen) {
        const target = e.target as HTMLElement | null
        if (target?.closest('[data-fullscreen-file-drawer] input')) return
        e.preventDefault()
        e.stopPropagation()
        onCloseFileDrawer()
        return
      }
      if (tabMode) {
        e.preventDefault()
        e.stopPropagation()
        switchPanel(false)
        setVisible(true)
        return
      }
      if (useAppStore.getState().aiPanelOpen) {
        e.preventDefault()
        e.stopPropagation()
        useAppStore.getState().closeAiPanel()
        return
      }
      e.preventDefault()
      e.stopPropagation()
      void exitFullscreen()
    }

    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [backgroundCardOpen, contextMenu, exitFullscreen, fileDrawerOpen, fileMenuOpen, onCloseFileDrawer, paddingCardOpen, switchPanel, tabMode, themeCardOpen])

  useEffect(() => {
    if (!paddingCardOpen && !themeCardOpen && !backgroundCardOpen && !fileMenuOpen) return
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null
      if (target?.closest('.gm-product-tour')) return
      if (target?.closest('[data-fullscreen-padding-control], [data-fullscreen-theme-control], [data-fullscreen-background-control], [data-fullscreen-file-menu]')) return
      setPaddingCardOpen(false)
      setThemeCardOpen(false)
      setBackgroundCardOpen(false)
      setFileMenuOpen(false)
    }
    window.addEventListener('pointerdown', handlePointerDown, true)
    return () => window.removeEventListener('pointerdown', handlePointerDown, true)
  }, [backgroundCardOpen, fileMenuOpen, paddingCardOpen, themeCardOpen])

  useLayoutEffect(() => {
    const shell = shellRef.current
    if (!shell || widthAnimatingRef.current) return

    const newWidth = shell.offsetWidth
    const oldWidth = widthBeforeRef.current
    widthBeforeRef.current = newWidth

    if (oldWidth === 0 || Math.abs(newWidth - oldWidth) < 3) return

    widthAnimatingRef.current = true
    shell.style.width = `${oldWidth}px`
    shell.style.transition = 'none'
    shell.getBoundingClientRect()
    shell.style.transition = 'width 440ms cubic-bezier(0.18, 0.9, 0.18, 1)'
    shell.style.width = `${newWidth}px`

    const onEnd = () => {
      shell.style.width = ''
      shell.style.transition = ''
      widthAnimatingRef.current = false
      widthBeforeRef.current = shell.offsetWidth
    }
    shell.addEventListener('transitionend', onEnd, { once: true })

    return () => {
      shell.removeEventListener('transitionend', onEnd)
      if (widthAnimatingRef.current) {
        shell.style.width = ''
        shell.style.transition = ''
        widthAnimatingRef.current = false
      }
    }
  })

  const togglePaddingCard = useCallback(() => {
    clearHideTimer()
    setVisible(true)
    setThemeCardOpen(false)
    setBackgroundCardOpen(false)
    setFileMenuOpen(false)
    setPaddingCardOpen((open) => !open)
  }, [clearHideTimer])

  const toggleThemeCard = useCallback(() => {
    clearHideTimer()
    setVisible(true)
    setPaddingCardOpen(false)
    setBackgroundCardOpen(false)
    setFileMenuOpen(false)
    setThemeCardOpen((open) => !open)
  }, [clearHideTimer])

  const toggleFileMenu = useCallback(() => {
    clearHideTimer()
    setVisible(true)
    setPaddingCardOpen(false)
    setThemeCardOpen(false)
    setBackgroundCardOpen(false)
    setFileMenuOpen((open) => !open)
  }, [clearHideTimer])

  const toggleBackgroundCard = useCallback(() => {
    clearHideTimer()
    setVisible(true)
    setPaddingCardOpen(false)
    setThemeCardOpen(false)
    setFileMenuOpen(false)
    setBackgroundCardOpen((open) => !open)
  }, [clearHideTimer])

  useEffect(() => {
    if (!backgroundCardOpen || !isTauri()) return
    let cancelled = false
    const urls: string[] = []
    void listReadingBackgrounds().then(async (library) => {
      if (cancelled) return
      setBackgroundLibrary((current) => ({ ...library, downloadedOfficialIds: [...new Set([...current.downloadedOfficialIds, ...library.downloadedOfficialIds])] }))
      const thumbnails = await Promise.all(library.localBackgrounds.map(async (item) => {
        try {
          const bytes = await readReadingBackground(item.id, true)
          if (cancelled) return null
          const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: 'image/jpeg' }))
          urls.push(url)
          return [item.id, url] as const
        } catch { return null }
      }))
      if (!cancelled) setLocalThumbnailUrls(Object.fromEntries(thumbnails.filter((item) => item !== null)))
    }).catch(() => { if (!cancelled) toast.error('背景列表读取失败') })
    return () => {
      cancelled = true
      urls.forEach(URL.revokeObjectURL)
      setLocalThumbnailUrls({})
    }
  }, [backgroundCardOpen, backgroundRevision])

  const backgroundItems = useMemo<BackgroundItem[]>(() => [
    ...OFFICIAL_BACKGROUNDS.map((item) => ({ ...item, downloaded: backgroundLibrary.downloadedOfficialIds.includes(item.id) })),
    ...backgroundLibrary.localBackgrounds.map((item) => ({
      ...item, kind: 'local' as const, thumbnail: localThumbnailUrls[item.id] ?? '', downloaded: true,
    })),
  ], [backgroundLibrary, localThumbnailUrls])

  const chooseBackground = useCallback(async () => {
    if (backgroundLibrary.localBackgrounds.length >= 3) {
      toast.error('最多添加 3 张背景')
      return
    }
    try {
      const selected = await openFileDialog([{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }])
      if (typeof selected === 'string') {
        const item = await importReadingBackground(selected)
        updateAppearanceSettings({ fullscreenBackgroundPath: null, fullscreenBackgroundScene: `local:${item.id}`, fullscreenBackgroundEnabled: true })
        setBackgroundRevision((value) => value + 1)
      }
    } catch {
      toast.error('背景图片导入失败')
    }
  }, [backgroundLibrary.localBackgrounds.length, updateAppearanceSettings])

  const selectBackground = useCallback((item: BackgroundItem) => {
    if (item.kind === 'official' && !item.downloaded) {
      if (downloadProgress[item.id] !== undefined) return
      setDownloadProgress((current) => ({ ...current, [item.id]: 0 }))
      void downloadReadingBackground(item.id, (percent) => {
        setDownloadProgress((current) => ({ ...current, [item.id]: percent }))
      }).then(() => {
        setBackgroundLibrary((current) => ({ ...current, downloadedOfficialIds: [...new Set([...current.downloadedOfficialIds, item.id])] }))
        updateAppearanceSettings({ fullscreenBackgroundScene: item.id as 'snow' | 'sea' | 'stars', fullscreenBackgroundEnabled: true })
      }).catch(() => toast.error(`${item.label}下载失败，请重试`)).finally(() => {
        setDownloadProgress((current) => {
          const next = { ...current }
          delete next[item.id]
          return next
        })
      })
      return
    }
    updateAppearanceSettings({ fullscreenBackgroundScene: item.kind === 'local' ? `local:${item.id}` : item.id as 'snow' | 'sea' | 'stars', fullscreenBackgroundEnabled: true })
  }, [downloadProgress, updateAppearanceSettings])

  const removeBackground = useCallback(async (item: BackgroundItem) => {
    try {
      await deleteReadingBackground(item.id)
      if (backgroundScene === `local:${item.id}`) {
        updateAppearanceSettings({ fullscreenBackgroundScene: 'custom', fullscreenBackgroundPath: null, fullscreenBackgroundEnabled: false })
      }
      setBackgroundRevision((value) => value + 1)
    } catch { toast.error('背景删除失败') }
  }, [backgroundScene, updateAppearanceSettings])

  useEffect(() => {
    if (!backgroundPreviewVisible || !backgroundPath || !isTauri()) return
    let cancelled = false
    void waitForFullscreenVisualIdle().then(() => {
      if (cancelled) return null
      return importReadingBackground(backgroundPath)
    }).then((item) => {
      if (!item) return
      const current = useSettingsStore.getState().appearance
      if (current.fullscreenBackgroundPath !== backgroundPath) {
        void deleteReadingBackground(item.id)
        return
      }
      useSettingsStore.getState().updateAppearanceSettings({ fullscreenBackgroundPath: null, ...(current.fullscreenBackgroundScene === 'custom' ? { fullscreenBackgroundScene: `local:${item.id}` as const } : {}) })
      if (!cancelled) setBackgroundRevision((value) => value + 1)
    }).catch(() => undefined)
    return () => { cancelled = true }
  }, [backgroundPath, backgroundPreviewVisible])

  useEffect(() => {
    void updateFullscreenBackground({
      enabled: backgroundEnabled,
      path: backgroundPath,
      scene: backgroundScene,
      opacity: backgroundOpacity,
      previewVisible: backgroundPreviewVisible,
    })
  }, [backgroundEnabled, backgroundOpacity, backgroundPath, backgroundPreviewVisible, backgroundScene])

  useEffect(() => () => {
    void releaseFullscreenBackground()
  }, [])
  const selectFileAction = useCallback((action: () => void) => {
    setFileMenuOpen(false)
    onCloseFileDrawer()
    action()
  }, [onCloseFileDrawer])

  const selectFullscreenTheme = useCallback((nextTheme: ThemeId) => {
    updateAppearanceSettings({ themeId: nextTheme })
  }, [updateAppearanceSettings])

  const contextTab = contextMenu ? tabs.find((tab) => tab.id === contextMenu.tabId) : null

  const handleTabContextMenu = useCallback((e: React.MouseEvent, tabId: string) => {
    e.preventDefault()
    setVisible(true)
    setContextMenu({ x: e.clientX, y: e.clientY, tabId })
    const tab = tabs.find((t) => t.id === tabId)
    if (tab?.filePath && isMarkdownPath(tab.filePath)) {
      setKbStatus('checking')
      isKnowledgeDocumentIndexed(tab.filePath).then((indexed) => {
        setKbStatus(indexed ? 'indexed' : 'not-indexed')
      }).catch(() => {
        setKbStatus('not-indexed')
      })
    } else {
      setKbStatus('idle')
    }
  }, [tabs])

  const handleContextAction = useCallback(async (action: string) => {
    if (!contextMenu) return
    const tabId = contextMenu.tabId
    setContextMenu(null)

    switch (action) {
      case 'close':
        closeTab(tabId)
        break
      case 'closeOthers':
        tabs.filter((tab) => tab.id !== tabId && !tab.pinned).forEach((tab) => closeTab(tab.id))
        break
      case 'closeRight': {
        const index = tabs.findIndex((tab) => tab.id === tabId)
        tabs.slice(index + 1).filter((tab) => !tab.pinned).forEach((tab) => closeTab(tab.id))
        break
      }
      case 'closeAll':
        tabs.filter((tab) => !tab.pinned).forEach((tab) => closeTab(tab.id))
        break
      case 'copyPath':
        if (contextTab?.filePath) await navigator.clipboard.writeText(contextTab.filePath)
        break
      case 'copyContent':
        if (contextTab) await navigator.clipboard.writeText(contextTab.content)
        break
      case 'revealFile':
        if (contextTab?.filePath) {
          try {
            await invoke('reveal_file_in_folder', { path: contextTab.filePath })
          } catch (err) {
            toast.error(err instanceof Error ? err.message : String(err || '打开文件位置失败'))
          }
        }
        break
      case 'addToAi':
        if (contextTab) addFileContextTag({ title: contextTab.title, filePath: contextTab.filePath })
        break
      case 'aiSummarize':
        if (contextTab) {
          summarizeFileWithAi({ title: contextTab.title, filePath: contextTab.filePath })
        }
        break
      case 'openInRightPane':
        setRightPaneTabId(tabId)
        if (viewMode !== 'dual-preview') setViewMode('dual-preview')
        break
      case 'pinTab':
        togglePinTab(tabId)
        break
      case 'addToKb':
      case 'updateKb': {
        if (!contextTab?.filePath) return
        setKbStatus('adding')
        try {
          const result = await addKnowledgeDocument({
            filePath: contextTab.filePath,
            title: contextTab.title,
            content: contextTab.content,
          })
          if (result.success) {
            setKbStatus('indexed')
            toast.success('已加入知识库')
          } else {
            setKbStatus('not-indexed')
            toast.error(result.error || '加入知识库失败')
          }
        } catch (err) {
          setKbStatus('not-indexed')
          toast.error(err instanceof Error ? err.message : '加入知识库失败')
        }
        break
      }
      case 'rename':
        if (contextTab?.filePath) {
          setVisible(true)
          switchPanel(true)
          rename.startRename(contextTab.id, contextTab.title)
        }
        break
      case 'saveAs':
        if (contextTab) {
          try {
            await saveTabAsFile(contextTab)
            toast.success('已另存为')
          } catch (err) {
            toast.error(describeFileOperationError(err, '另存为失败'))
          }
        }
        break
    }
  }, [closeTab, contextMenu, contextTab, rename, setRightPaneTabId, setViewMode, switchPanel, tabs, togglePinTab, viewMode])

  const sortedTabs = [...tabs].sort((a, b) => {
    if (a.pinned && !b.pinned) return -1
    if (!a.pinned && b.pinned) return 1
    return 0
  })

  return (
    <>
      <div
        data-fullscreen-control-trigger="true"
        className="fixed left-1/2 top-0 z-40 h-9 w-[min(960px,calc(100vw-32px))] -translate-x-1/2"
        onMouseEnter={handleControlMouseEnter}
        onMouseLeave={handleControlMouseLeave}
      />
      <div
        data-fullscreen-control-bar="true"
        className={`fixed left-1/2 top-4 z-50 max-w-[calc(100vw-32px)] -translate-x-1/2 overflow-visible transition-[opacity,transform] duration-300 ease-out ${
          visible ? 'translate-y-0 opacity-100' : '-translate-y-1.5 opacity-0 pointer-events-none'
        }`}
        onMouseEnter={handleControlMouseEnter}
        onMouseLeave={handleControlMouseLeave}
      >
        <div
          ref={shellRef}
          className="gm-fullscreen-control-shell gm-instant-color relative max-w-[min(960px,calc(100vw-32px))] overflow-hidden rounded-2xl border px-3 py-2 [backface-visibility:hidden] [isolation:isolate]"
        >
          {/* 一级：模式按钮 */}
          <div className={`flex w-full max-w-full items-center gap-2 transition-opacity duration-200 ease-out ${
            renderedTabMode ? 'absolute inset-0 opacity-0 pointer-events-none' : `relative ${contentVisible ? 'opacity-100' : 'opacity-0 pointer-events-none'}`
          }`}
          >
            <div className="flex min-w-0 items-center gap-1 overflow-x-auto">
              <BubbleButton onClick={onToggleFileDrawer} active={fileDrawerOpen} title="标签 / 文件 Ctrl+B" variant="text">
                标签 / 文件
              </BubbleButton>
              <Separator />
              {MODES.map((mode) => (
                <BubbleButton
                  key={mode.key}
                  active={viewMode === mode.key}
                  onClick={() => setViewMode(mode.key)}
                  variant="text"
                >
                  {mode.label}
                </BubbleButton>
              ))}
            </div>
            <div className="flex flex-shrink-0 items-center gap-1">
              <Separator />
              <BubbleButton onClick={toggleAiPanel} active={aiPanelOpen} title="切换 AI 助手" variant="text">
                AI
              </BubbleButton>
              <div data-fullscreen-padding-control="true">
                <BubbleButton
                  onClick={togglePaddingCard}
                  active={paddingCardOpen}
                  title="调整正文左右边距"
                  ariaExpanded={paddingCardOpen}
                  ariaControls="fullscreen-padding-card"
                  variant="text"
                >
                  边距
                </BubbleButton>
              </div>
              <div data-fullscreen-theme-control="true">
                <BubbleButton
                  onClick={toggleThemeCard}
                  active={themeCardOpen}
                  title="选择主题"
                  ariaExpanded={themeCardOpen}
                  ariaControls="fullscreen-theme-card"
                >
                  主题
                </BubbleButton>
              </div>
              {isTauri() && <div data-fullscreen-background-control="true">
                <BubbleButton onClick={toggleBackgroundCard} active={backgroundCardOpen} title="设置阅读背景" ariaExpanded={backgroundCardOpen} ariaControls="fullscreen-background-card" variant="text">
                  背景
                </BubbleButton>
              </div>}
              <BubbleButton onClick={() => void exitFullscreen()} title="退出全屏">
                退出
              </BubbleButton>
            </div>
          </div>

          {/* 二级：标签列表 */}
          <div className={`flex w-[min(900px,calc(100vw-56px))] max-w-full items-center justify-center gap-2 transition-opacity duration-200 ease-out ${
            renderedTabMode ? `relative ${contentVisible ? 'opacity-100' : 'opacity-0 pointer-events-none'}` : 'absolute inset-0 opacity-0 pointer-events-none'
          }`}
          >
            <BubbleButton onClick={hideTabs} title="返回" square>
              <span aria-hidden="true" className="block -translate-y-px text-[22px] font-serif leading-none">‹</span>
            </BubbleButton>
            <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto px-1">
              {sortedTabs.map((tab) => {
                const active = tab.id === activeTabId
                const isFav = tab.filePath ? favorites.some((path) => isSameFilePath(path, tab.filePath)) : false
                return (
                  <button
                    key={tab.id}
                    type="button"
                    data-active={active ? 'true' : 'false'}
                    onClick={() => setActiveTab(tab.id)}
                    onContextMenu={(e) => handleTabContextMenu(e, tab.id)}
                    className={`group gm-fullscreen-tab-button flex h-9 max-w-[300px] flex-shrink-0 items-center gap-2 rounded-lg px-3 text-body font-semibold transition-colors ${
                      active
                        ? 'text-gm-primary underline underline-offset-4'
                        : 'text-gm-text-secondary hover:bg-gm-surface-hover hover:text-gm-text'
                    }`}
                    title={tab.title}
                  >
                    <span className="truncate">{rename.isRenaming(tab.id) ? (
                      <input
                        autoFocus
                        value={rename.state.value}
                        disabled={rename.state.status === 'submitting'}
                        onClick={(e) => e.stopPropagation()}
                        onChange={(e) => rename.setRenameValue(e.target.value)}
                        onBlur={() => { if (tab.filePath) void rename.submitRename(tab.id, tab.filePath) }}
                        onKeyDown={(e) => {
                          e.stopPropagation()
                          if (e.key === 'Enter' && tab.filePath) void rename.submitRename(tab.id, tab.filePath)
                          if (e.key === 'Escape') {
                            rename.cancelRename(tab.id)
                          }
                        }}
                        className="w-32 bg-transparent text-body font-semibold outline-none"
                      />
                    ) : tab.title}</span>
                    {tab.pinned && <span className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-gm-primary" />}
                    {isFav && <span className="text-gm-warning">★</span>}
                    {tab.modified && <span className="h-1.5 w-1.5 rounded-full bg-gm-primary" />}
                    <span
                      onClick={(e) => {
                        e.stopPropagation()
                        closeTab(tab.id)
                      }}
                      className="flex-shrink-0 opacity-0 group-hover:opacity-100 rounded-full p-0 text-gm-text-tertiary hover:bg-gm-surface-overlay hover:text-gm-error transition-opacity"
                      title="关闭"
                    >
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M18 6L6 18M6 6l12 12" />
                      </svg>
                    </span>
                  </button>
                )
              })}
            </div>
            <div data-fullscreen-file-menu="true">
              <BubbleButton onClick={toggleFileMenu} title="新建或打开文件" ariaExpanded={fileMenuOpen} ariaControls="fullscreen-file-menu" square>
                <span aria-hidden="true" className="block -translate-y-px text-[22px] font-light leading-none">+</span>
              </BubbleButton>
            </div>
          </div>
        </div>

        <div
          id="fullscreen-file-menu"
          data-fullscreen-file-menu="true"
          role="dialog"
          aria-label="文件操作"
          aria-hidden={!fileMenuOpen}
          className={`gm-fullscreen-spacing-card absolute right-3 top-[calc(100%+10px)] w-40 origin-top-right rounded-xl border p-1.5 transition-[opacity,transform,visibility] duration-200 ease-out ${
            fileMenuOpen ? 'visible translate-y-0 scale-100 opacity-100' : 'invisible -translate-y-1 scale-95 opacity-0 pointer-events-none'
          }`}
        >
          <button type="button" onClick={() => selectFileAction(onNewFile)} className="gm-fullscreen-file-action w-full rounded-lg px-3 py-2 text-left text-body font-semibold transition-colors">
            新增文件
          </button>
          <button type="button" onClick={() => selectFileAction(onOpenFile)} className="gm-fullscreen-file-action w-full rounded-lg px-3 py-2 text-left text-body font-semibold transition-colors">
            打开文件
          </button>
        </div>

        {paddingCardOpen && (
          <div
            id="fullscreen-padding-card"
            data-fullscreen-padding-control="true"
            role="dialog"
            aria-label="调整全屏正文边距"
            className="gm-fullscreen-spacing-card absolute left-1/2 top-[calc(100%+10px)] w-[min(320px,calc(100vw-32px))] -translate-x-1/2 rounded-2xl border p-4"
          >
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-body font-bold text-gm-text">正文边距</div>
                <div className="mt-0.5 text-caption text-gm-text-tertiary">仅调整文字区域，不移动滚动条与目录</div>
              </div>
            </div>
            <SettingSlider
              label="全屏正文边距"
              value={fullscreenContentPaddingPercent}
              min={FULLSCREEN_CONTENT_PADDING_PERCENT.min}
              max={FULLSCREEN_CONTENT_PADDING_PERCENT.max}
              step={FULLSCREEN_CONTENT_PADDING_PERCENT.step}
              debounceMs={FULLSCREEN_PADDING_DEBOUNCE_MS}
              onChange={(value) => updateEditorSettings({ fullscreenContentPaddingPercent: Math.round(value) })}
              format={(value) => `${value}%`}
              className="mt-3"
              valueClassName="w-14"
            />
            <div className="mt-1 flex justify-between text-micro text-gm-text-tertiary" aria-hidden="true">
              <span>紧凑</span>
              <span>宽松</span>
            </div>
          </div>
        )}

        {themeCardOpen && (
          <div
            id="fullscreen-theme-card"
            data-fullscreen-theme-control="true"
            role="dialog"
            aria-label="选择主题"
            className="gm-fullscreen-spacing-card absolute left-1/2 top-[calc(100%+10px)] w-[min(340px,calc(100vw-32px))] -translate-x-1/2 rounded-2xl border p-4"
          >
            <div>
              <div className="text-body font-bold text-gm-text">主题</div>
              <div className="mt-0.5 text-caption text-gm-text-tertiary">选择阅读与控制条配色</div>
            </div>
            <FullscreenThemeSegmented
              value={themeId}
              themes={fullscreenThemes}
              onChange={selectFullscreenTheme}
            />
          </div>
        )}
        {backgroundCardOpen && (
          <div
            id="fullscreen-background-card"
            data-fullscreen-background-control="true"
            role="dialog"
            aria-label="设置全屏阅读背景"
            className="gm-fullscreen-spacing-card absolute left-1/2 top-[calc(100%+10px)] w-[min(440px,calc(100vw-32px))] -translate-x-1/2 rounded-2xl border p-4"
          >
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-body font-bold text-gm-text">阅读背景</div>
                <div className="mt-0.5 text-caption text-gm-text-tertiary">仅显示在全屏预览区域</div>
              </div>
              <button
                type="button"
                aria-pressed={backgroundEnabled}
                onClick={() => updateAppearanceSettings({ fullscreenBackgroundEnabled: !backgroundEnabled })}
                className="gm-fullscreen-file-action rounded-lg px-3 py-2 text-body font-semibold transition-colors"
              >
                {backgroundEnabled ? '停用背景' : '启用背景'}
              </button>
            </div>
            <div className="mt-4">
              <div className="mb-2 text-caption font-semibold text-gm-text-secondary">图片可见度</div>
              <SettingSlider label="图片可见度" value={backgroundOpacity} min={0} max={100} step={5} onChange={(value) => updateAppearanceSettings({ fullscreenBackgroundOpacity: value })} format={(value) => `${value}%`} />
            </div>
            <div className="mt-4 border-t border-gm-border-subtle pt-3">
              <div className="mb-2 text-caption font-semibold text-gm-text-secondary">场景</div>
              <div className="gm-fullscreen-background-scenes" onMouseLeave={() => setHoveredBackgroundScene(null)}>
                {backgroundItems.filter((item) => item.kind === 'official').map((item) => (
                  <BackgroundSceneCard key={item.id} item={item} selected={backgroundScene === item.id}
                    expanded={(hoveredBackgroundScene ?? backgroundScene) === item.id}
                    progress={downloadProgress[item.id]} onHover={setHoveredBackgroundScene}
                    onSelect={() => selectBackground(item)} />
                ))}
              </div>
              <div className="mt-4 mb-2 flex items-center justify-between">
                <div className="text-caption font-semibold text-gm-text-secondary">我的背景</div>
                <button type="button" onClick={() => void chooseBackground()} disabled={backgroundLibrary.localBackgrounds.length >= 3}
                  title={backgroundLibrary.localBackgrounds.length >= 3 ? '最多添加 3 张背景' : '导入本地背景'}
                  className="gm-fullscreen-file-action flex items-center gap-1 rounded-lg px-2 py-1 text-caption font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-45">
                  <Plus size={14} aria-hidden="true" />导入
                </button>
              </div>
              {backgroundLibrary.localBackgrounds.length >= 3 && <div className="mb-2 text-caption text-gm-text-tertiary">最多添加 3 张背景</div>}
              {backgroundLibrary.localBackgrounds.length === 0 ? (
                <div className="gm-fullscreen-background-empty">还没有导入背景</div>
              ) : (
                <div className="gm-fullscreen-background-scenes" onMouseLeave={() => setHoveredBackgroundScene(null)}>
                  {backgroundItems.filter((item) => item.kind === 'local').map((item) => (
                    <BackgroundSceneCard key={item.id} item={item} selected={backgroundScene === `local:${item.id}`}
                      expanded={(hoveredBackgroundScene ?? backgroundScene) === `local:${item.id}`}
                      onHover={(id) => setHoveredBackgroundScene(id ? `local:${id}` : null)}
                      onSelect={() => selectBackground(item)} onDelete={() => void removeBackground(item)} />
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {contextMenu && (
        <ContextMenu position={contextMenu} onClose={() => setContextMenu(null)} minWidth={176} maxWidth={176}>
          <ContextMenuGroupTitle>标签操作</ContextMenuGroupTitle>
          <ContextMenuItem onClick={() => handleContextAction('pinTab')}>
            {contextTab?.pinned ? '取消固定' : '固定标签'}
          </ContextMenuItem>
          <ContextMenuItem onClick={() => handleContextAction('openInRightPane')}>
            在右栏打开
          </ContextMenuItem>
          <ContextMenuItem onClick={() => handleContextAction('rename')} disabled={!contextTab?.filePath}>
            重命名
          </ContextMenuItem>
          <ContextMenuItem onClick={() => handleContextAction('saveAs')}>
            另存为
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuGroupTitle>AI 助手</ContextMenuGroupTitle>
          <ContextMenuItem onClick={() => handleContextAction('aiSummarize')}>
            AI 总结该文件
          </ContextMenuItem>
          <ContextMenuItem onClick={() => handleContextAction('addToAi')}>
            添加文件到 AI 上下文
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuGroupTitle>复制与索引</ContextMenuGroupTitle>
          <ContextMenuItem onClick={() => handleContextAction('copyContent')}>
            复制内容
          </ContextMenuItem>
          {contextTab?.filePath && (
            <ContextMenuItem onClick={() => handleContextAction('copyPath')}>
              复制路径
            </ContextMenuItem>
          )}
          {contextTab?.filePath && (
            <ContextMenuItem onClick={() => handleContextAction('revealFile')}>
              打开文件位置
            </ContextMenuItem>
          )}
          {contextTab?.filePath && isMarkdownPath(contextTab.filePath) && (
            <>
              <ContextMenuSeparator />
              <ContextMenuGroupTitle>知识库</ContextMenuGroupTitle>
              {kbStatus === 'checking' && (
                <ContextMenuItem onClick={() => {}} disabled>
                  正在读取知识库状态…
                </ContextMenuItem>
              )}
              {kbStatus === 'not-indexed' && (
                <ContextMenuItem onClick={() => handleContextAction('addToKb')}>
                  加入知识库
                </ContextMenuItem>
              )}
              {kbStatus === 'indexed' && (
                <ContextMenuItem onClick={() => handleContextAction('updateKb')}>
                  ✓ 已加入知识库（点击更新）
                </ContextMenuItem>
              )}
              {kbStatus === 'adding' && (
                <ContextMenuItem onClick={() => {}} disabled>
                  正在加入知识库…
                </ContextMenuItem>
              )}
            </>
          )}
          <ContextMenuSeparator />
          <ContextMenuGroupTitle>关闭标签</ContextMenuGroupTitle>
          <ContextMenuItem onClick={() => handleContextAction('close')}>
            关闭
          </ContextMenuItem>
          <ContextMenuItem onClick={() => handleContextAction('closeOthers')}>
            关闭其他
          </ContextMenuItem>
          <ContextMenuItem onClick={() => handleContextAction('closeRight')}>
            关闭右侧标签
          </ContextMenuItem>
          <ContextMenuItem onClick={() => handleContextAction('closeAll')}>
            全部关闭
          </ContextMenuItem>
        </ContextMenu>
      )}
    </>
  )
}

function BubbleButton({
  children,
  active = false,
  onClick,
  title,
  variant,
  ariaExpanded,
  ariaControls,
  square = false,
}: {
  children: React.ReactNode
  active?: boolean
  onClick: () => void
  title?: string
  variant?: 'pill' | 'text'
  ariaExpanded?: boolean
  ariaControls?: string
  square?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-expanded={ariaExpanded}
      aria-controls={ariaControls}
      data-active={active ? 'true' : 'false'}
      className={`gm-fullscreen-bubble h-8 flex-shrink-0 whitespace-nowrap rounded-full ${square ? 'w-8 p-0' : 'px-3'} text-body font-bold transition-colors ${
        active
          ? variant === 'text'
            ? 'text-gm-primary'
            : 'bg-gm-primary text-gm-text-on-primary shadow-sm'
          : 'text-gm-text-secondary hover:bg-gm-surface-hover hover:text-gm-text'
      }`}
    >
      {children}
    </button>
  )
}

function Separator() {
  return <div className="mx-1.5 h-4 w-px bg-gm-border-subtle" />
}

function BackgroundSceneCard({ item, selected, expanded, progress, onHover, onSelect, onDelete }: {
  item: BackgroundItem
  selected: boolean
  expanded: boolean
  progress?: number
  onHover: (id: string | null) => void
  onSelect: () => void
  onDelete?: () => void
}) {
  return (
    <div className={`gm-fullscreen-background-scene ${expanded ? 'is-expanded' : ''} ${selected ? 'is-selected' : ''}`}
      onMouseEnter={() => onHover(item.id)} onMouseLeave={() => onHover(null)}>
      <button type="button" aria-label={item.downloaded ? `使用${item.label}背景` : `下载${item.label}背景`}
        aria-pressed={selected} disabled={progress !== undefined} onFocus={() => onHover(item.id)}
        onBlur={() => onHover(null)} onClick={onSelect} className="gm-fullscreen-background-scene__select">
        {item.thumbnail && <img src={item.thumbnail} alt="" className="gm-fullscreen-background-scene__image" />}
        {item.kind === 'official' && !item.downloaded && (
          <span className="gm-fullscreen-background-scene__download" aria-label={progress === undefined ? '未下载' : `下载进度 ${progress}%`}>
            {progress === undefined ? <Download size={21} aria-hidden="true" /> : (
              <svg width="32" height="32" viewBox="0 0 36 36" aria-hidden="true">
                <circle cx="18" cy="18" r="15" fill="none" stroke="currentColor" strokeOpacity="0.35" strokeWidth="3" />
                <circle cx="18" cy="18" r="15" fill="none" stroke="currentColor" strokeWidth="3"
                  strokeDasharray={`${Math.max(progress, 2) * 0.942} 94.2`} transform="rotate(-90 18 18)" />
              </svg>
            )}
          </span>
        )}
        <span className="gm-fullscreen-background-scene__caption"><strong>{item.label}</strong></span>
      </button>
      {onDelete && <button type="button" aria-label={`删除${item.label}背景`} title="删除背景"
        className="gm-fullscreen-background-scene__delete" onClick={onDelete}><Trash2 size={14} aria-hidden="true" /></button>}
    </div>
  )
}

function FullscreenThemeSegmented({
  value,
  themes,
  onChange,
}: {
  value: ThemeId
  themes: readonly ThemeDefinition[]
  onChange: (value: ThemeId) => void
}) {
  return (
    <div className="gm-light-palette-segmented gm-fullscreen-theme-segmented mt-3" role="radiogroup" aria-label="主题">
      {themes.map((theme) => (
        <button
          key={theme.id}
          type="button"
          className="gm-light-palette-segmented__item"
          data-active={value === theme.id}
          role="radio"
          aria-checked={value === theme.id}
          onClick={() => onChange(theme.id)}
        >
          {theme.label}
        </button>
      ))}
    </div>
  )
}
