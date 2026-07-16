import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { useEditorStore, type Tab } from '@/stores/editorStore'
import { useAppStore } from '@/stores/appStore'
import { FULLSCREEN_CONTENT_PADDING, useSettingsStore } from '@/stores/settingsStore'
import { addFileContextTag, summarizeFileWithAi } from '@/services/aiContext'
import { indexMarkdownDocument } from '@/services/rag/indexer'
import { isSameFilePath } from '@/services/pathIdentity'
import { renameFileEntry, saveTabAsFile, validateFileName } from '@/services/fileEntryActions'
import { describeFileOperationError } from '@/services/fileOperationErrors'
import { toast } from '@/services/toast'
import { ContextMenu, ContextMenuGroupTitle, ContextMenuItem, ContextMenuSeparator } from '@/components/common/ContextMenu'
import { useFullscreen } from '@/hooks/useFullscreen'
import { SettingSlider } from '@/components/common/SettingSlider'

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
  fileDrawerOpen: boolean
  onToggleFileDrawer: () => void
  onCloseFileDrawer: () => void
}

export function FullscreenControlBar({
  fileDrawerOpen,
  onToggleFileDrawer,
  onCloseFileDrawer,
}: FullscreenControlBarProps) {
  const tabs = useEditorStore((s) => s.tabs)
  const activeTabId = useEditorStore((s) => s.activeTabId)
  const viewMode = useEditorStore((s) => s.viewMode)
  const setActiveTab = useEditorStore((s) => s.setActiveTab)
  const setViewMode = useEditorStore((s) => s.setViewMode)
  const closeTab = useEditorStore((s) => s.closeTab)
  const setRightPaneTabId = useEditorStore((s) => s.setRightPaneTabId)
  const togglePinTab = useEditorStore((s) => s.togglePinTab)
  const favorites = useEditorStore((s) => s.favorites)
  const aiPanelOpen = useAppStore((s) => s.aiPanelOpen)
  const toggleAiPanel = useAppStore((s) => s.toggleAiPanel)
  const theme = useSettingsStore((s) => s.appearance.theme)
  const fullscreenContentPadding = useSettingsStore((s) => s.editor.fullscreenContentPadding)
  const updateEditorSettings = useSettingsStore((s) => s.updateEditorSettings)
  const { exitFullscreen } = useFullscreen()
  const [visible, setVisible] = useState(false)
  const [tabMode, setTabMode] = useState(false)
  const [renderedTabMode, setRenderedTabMode] = useState(false)
  const [contentVisible, setContentVisible] = useState(true)
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; tabId: string } | null>(null)
  const [renamingTabId, setRenamingTabId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [paddingCardOpen, setPaddingCardOpen] = useState(false)
  const hideTimerRef = useRef<number | null>(null)
  const contentTimerRef = useRef<number | null>(null)
  const renameCancelledRef = useRef(false)
  const renameSubmittingRef = useRef(false)
  const shellRef = useRef<HTMLDivElement>(null)
  const widthBeforeRef = useRef<number>(0)
  const widthAnimatingRef = useRef(false)
  const renderedTabModeRef = useRef(false)

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
    if (fileDrawerOpen) {
      onCloseFileDrawer()
      return
    }
    setVisible(true)
    switchPanel(false)
  }, [clearHideTimer, fileDrawerOpen, onCloseFileDrawer, switchPanel])

  const scheduleHide = useCallback(() => {
    if (fileDrawerOpen || paddingCardOpen) return
    clearHideTimer()
    hideTimerRef.current = window.setTimeout(() => {
      setVisible(false)
      if (!contextMenu) switchPanel(false)
    }, tabMode ? 2200 : 700)
  }, [clearHideTimer, contextMenu, fileDrawerOpen, paddingCardOpen, switchPanel, tabMode])

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
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (document.querySelector('[data-editor-search-overlay]')) return
      if (contextMenu) {
        e.preventDefault()
        e.stopPropagation()
        setContextMenu(null)
        return
      }
      if (paddingCardOpen) {
        e.preventDefault()
        e.stopPropagation()
        setPaddingCardOpen(false)
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
        useAppStore.setState({ aiPanelOpen: false })
        return
      }
      e.preventDefault()
      e.stopPropagation()
      void exitFullscreen()
    }

    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [contextMenu, exitFullscreen, fileDrawerOpen, onCloseFileDrawer, paddingCardOpen, switchPanel, tabMode])

  useEffect(() => {
    if (!paddingCardOpen) return
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null
      if (target?.closest('[data-fullscreen-padding-control]')) return
      setPaddingCardOpen(false)
    }
    window.addEventListener('pointerdown', handlePointerDown, true)
    return () => window.removeEventListener('pointerdown', handlePointerDown, true)
  }, [paddingCardOpen])

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

  const toggleTheme = useCallback(() => {
    useSettingsStore.getState().updateAppearanceSettings({ theme: theme === 'dark' ? 'light' : 'dark' })
  }, [theme])

  const togglePaddingCard = useCallback(() => {
    clearHideTimer()
    setVisible(true)
    setPaddingCardOpen((open) => !open)
  }, [clearHideTimer])

  const contextTab = contextMenu ? tabs.find((tab) => tab.id === contextMenu.tabId) : null

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
      case 'reindexRag':
        if (contextTab?.filePath) indexMarkdownDocument(contextTab.filePath, contextTab.title, contextTab.content)
        break
      case 'rename':
        if (contextTab?.filePath) {
          renameCancelledRef.current = false
          setVisible(true)
          switchPanel(true)
          setRenamingTabId(contextTab.id)
          setRenameValue(contextTab.title)
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
  }, [closeTab, contextMenu, contextTab, setRightPaneTabId, setViewMode, switchPanel, tabs, togglePinTab, viewMode])

  const commitRename = useCallback(async (tab: Tab) => {
    if (renameCancelledRef.current) {
      renameCancelledRef.current = false
      return
    }
    if (renameSubmittingRef.current || !tab.filePath) {
      setRenamingTabId(null)
      return
    }
    const error = validateFileName(renameValue)
    if (error) {
      toast.error(error)
      return
    }
    renameSubmittingRef.current = true
    try {
      await renameFileEntry(tab.filePath, renameValue)
      renameCancelledRef.current = true
      setRenamingTabId(null)
      toast.success('已重命名')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '重命名失败')
    } finally {
      renameSubmittingRef.current = false
    }
  }, [renameValue])

  const sortedTabs = [...tabs].sort((a, b) => {
    if (a.pinned && !b.pinned) return -1
    if (!a.pinned && b.pinned) return 1
    return 0
  })

  return (
    <>
      <div className="fixed left-1/2 top-0 z-40 h-9 w-[min(960px,calc(100vw-32px))] -translate-x-1/2" onMouseEnter={showBar} />
      <div
        data-fullscreen-control-bar="true"
        className={`fixed left-1/2 top-4 z-50 max-w-[calc(100vw-32px)] -translate-x-1/2 overflow-visible transition-[opacity,transform] duration-300 ease-out ${
          visible ? 'translate-y-0 opacity-100' : '-translate-y-1.5 opacity-0 pointer-events-none'
        }`}
        onMouseEnter={showBar}
        onMouseLeave={scheduleHide}
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
              <BubbleButton onClick={onToggleFileDrawer} active={fileDrawerOpen} title="标签 / 文件 Ctrl+B">
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
              <BubbleButton onClick={toggleAiPanel} active={aiPanelOpen} title="切换 AI 助手">
                AI
              </BubbleButton>
              <div data-fullscreen-padding-control="true">
                <BubbleButton
                  onClick={togglePaddingCard}
                  active={paddingCardOpen}
                  title="调整正文左右边距"
                  ariaExpanded={paddingCardOpen}
                  ariaControls="fullscreen-padding-card"
                >
                  边距
                </BubbleButton>
              </div>
              <BubbleButton onClick={toggleTheme} title={theme === 'dark' ? '切换为浅色主题' : '切换为深色主题'}>
                主题
              </BubbleButton>
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
            <BubbleButton onClick={hideTabs} title="返回">
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
                    onContextMenu={(e) => {
                      e.preventDefault()
                      setVisible(true)
                      setContextMenu({ x: e.clientX, y: e.clientY, tabId: tab.id })
                    }}
                    className={`group gm-fullscreen-tab-button flex h-9 max-w-[300px] flex-shrink-0 items-center gap-2 rounded-lg px-3 text-body font-semibold transition-colors ${
                      active
                        ? 'text-gm-primary underline underline-offset-4'
                        : 'text-gm-text-secondary hover:bg-gm-surface-hover hover:text-gm-text'
                    }`}
                    title={tab.title}
                  >
                    <span className="truncate">{renamingTabId === tab.id ? (
                      <input
                        autoFocus
                        value={renameValue}
                        onClick={(e) => e.stopPropagation()}
                        onChange={(e) => setRenameValue(e.target.value)}
                        onBlur={() => void commitRename(tab)}
                        onKeyDown={(e) => {
                          e.stopPropagation()
                          if (e.key === 'Enter') void commitRename(tab)
                          if (e.key === 'Escape') {
                            renameCancelledRef.current = true
                            setRenamingTabId(null)
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
          </div>
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
              value={fullscreenContentPadding}
              min={FULLSCREEN_CONTENT_PADDING.min}
              max={FULLSCREEN_CONTENT_PADDING.max}
              step={FULLSCREEN_CONTENT_PADDING.step}
              debounceMs={FULLSCREEN_PADDING_DEBOUNCE_MS}
              onChange={(value) => updateEditorSettings({ fullscreenContentPadding: Math.round(value) })}
              format={(value) => `${value}px`}
              className="mt-3"
              valueClassName="w-14"
            />
            <div className="mt-1 flex justify-between text-micro text-gm-text-tertiary" aria-hidden="true">
              <span>紧凑</span>
              <span>宽松</span>
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
          {contextTab?.filePath && (
            <ContextMenuItem onClick={() => handleContextAction('reindexRag')}>
              重新索引 RAG
            </ContextMenuItem>
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
}: {
  children: React.ReactNode
  active?: boolean
  onClick: () => void
  title?: string
  variant?: 'pill' | 'text'
  ariaExpanded?: boolean
  ariaControls?: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-expanded={ariaExpanded}
      aria-controls={ariaControls}
      data-active={active ? 'true' : 'false'}
      className={`gm-fullscreen-bubble h-8 flex-shrink-0 whitespace-nowrap rounded-full px-3 text-body font-bold transition-colors ${
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
