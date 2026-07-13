import { useState, useRef, useCallback } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { useEditorStore, type Tab } from '@/stores/editorStore'
import { useChatStore } from '@/stores/chatStore'
import { exportMarkdownAsHtml, exportMarkdownAsPdf } from '@/services/markdownExport'
import { isSameFilePath } from '@/services/pathIdentity'
import { addFileContextTag } from '@/services/aiContext'
import { indexMarkdownDocument } from '@/services/rag/indexer'
import { ContextMenu, ContextMenuGroupTitle, ContextMenuItem, ContextMenuSeparator } from '@/components/common/ContextMenu'
import { renameFileEntry, saveTabAsFile, validateFileName } from '@/services/fileEntryActions'
import { describeFileOperationError } from '@/services/fileOperationErrors'
import { toast } from '@/services/toast'

interface TabBarProps {
  onOpenSettings?: () => void
}

type ViewMode = 'edit' | 'preview' | 'edit-preview' | 'dual-preview' | 'diff-preview'

export function TabBar({ onOpenSettings }: TabBarProps) {
  const tabs = useEditorStore((s) => s.tabs)
  const activeTabId = useEditorStore((s) => s.activeTabId)
  const setActiveTab = useEditorStore((s) => s.setActiveTab)
  const closeTab = useEditorStore((s) => s.closeTab)
  const reorderTabs = useEditorStore((s) => s.reorderTabs)
  const viewMode = useEditorStore((s) => s.viewMode)
  const setViewMode = useEditorStore((s) => s.setViewMode)
  const rightPaneTabId = useEditorStore((s) => s.rightPaneTabId)
  const setRightPaneTabId = useEditorStore((s) => s.setRightPaneTabId)
  const favorites = useEditorStore((s) => s.favorites)
  const toggleFavorite = useEditorStore((s) => s.toggleFavorite)
  const togglePinTab = useEditorStore((s) => s.togglePinTab)
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; tabId: string } | null>(null)
  const [exportMenu, setExportMenu] = useState<{ x: number; y: number } | null>(null)
  const [dragState, setDragState] = useState<{ tabId: string; startX: number } | null>(null)
  const [dragOverTabId, setDragOverTabId] = useState<string | null>(null)
  const [renamingTabId, setRenamingTabId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const renameCancelledRef = useRef(false)
  const renameSubmittingRef = useRef(false)
  const exportButtonRef = useRef<HTMLButtonElement>(null)
  const draggedTabIdRef = useRef<string | null>(null)

  const handleContextMenu = useCallback((e: React.MouseEvent, tabId: string) => {
    e.preventDefault()
    setContextMenu({ x: e.clientX, y: e.clientY, tabId })
  }, [])

  const handleDragStart = useCallback((e: React.DragEvent, tabId: string) => {
    e.dataTransfer.setData('text/plain', tabId)
    e.dataTransfer.effectAllowed = 'copyMove'
    const tab = tabs.find((t) => t.id === tabId)
    if (tab) {
      e.dataTransfer.setData('application/x-guanmo-tab', JSON.stringify({
        tabId: tab.id,
        filePath: tab.filePath,
        title: tab.title,
      }))
    }
    draggedTabIdRef.current = tabId
    setDragState({ tabId, startX: e.clientX })
  }, [tabs])

  const handleDragOver = useCallback((e: React.DragEvent, tabId: string) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    setDragOverTabId(tabId)
  }, [])

  const handleDragLeave = useCallback(() => {
    setDragOverTabId(null)
  }, [])

  const handleDrop = useCallback((e: React.DragEvent, targetTabId: string) => {
    e.preventDefault()
    let transferredTabId: string | null = null
    const tabData = e.dataTransfer.getData('application/x-guanmo-tab')
    if (tabData) {
      try {
        transferredTabId = JSON.parse(tabData).tabId as string
      } catch {
        transferredTabId = null
      }
    }
    const sourceTabId = transferredTabId || e.dataTransfer.getData('text/plain') || draggedTabIdRef.current
    if (sourceTabId && sourceTabId !== targetTabId) {
      reorderTabs(sourceTabId, targetTabId)
    }
    draggedTabIdRef.current = null
    setDragOverTabId(null)
    setDragState(null)
  }, [reorderTabs])

  const handleDragEnd = useCallback(() => {
    draggedTabIdRef.current = null
    setDragState(null)
    setDragOverTabId(null)
  }, [])

  // Context menu actions
  const contextTab = contextMenu ? tabs.find((t) => t.id === contextMenu.tabId) : null

  const handleContextAction = useCallback(
    async (action: string) => {
      if (!contextMenu) return
      const tabId = contextMenu.tabId
      setContextMenu(null)

      switch (action) {
        case 'close':
          closeTab(tabId)
          break
        case 'closeOthers': {
          const otherTabs = tabs.filter((t) => t.id !== tabId && !t.pinned)
          otherTabs.forEach((t) => closeTab(t.id))
          break
        }
        case 'closeRight': {
          const idx = tabs.findIndex((t) => t.id === tabId)
          tabs.slice(idx + 1).filter((t) => !t.pinned).forEach((t) => closeTab(t.id))
          break
        }
        case 'closeAll':
          tabs.filter((t) => !t.pinned).forEach((t) => closeTab(t.id))
          break
        case 'copyPath':
          if (contextTab?.filePath) {
            navigator.clipboard.writeText(contextTab.filePath)
          }
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
        case 'copyContent':
          if (contextTab) {
            navigator.clipboard.writeText(contextTab.content)
          }
          break
        case 'addToAi':
          if (contextTab) {
            addFileContextTag({
              title: contextTab.title,
              filePath: contextTab.filePath,
            })
          }
          break
        case 'openInRightPane':
          setRightPaneTabId(tabId)
          if (viewMode !== 'dual-preview') {
            setViewMode('dual-preview')
          }
          break
        case 'pinTab':
          togglePinTab(tabId)
          break
        case 'aiSummarize':
          if (contextTab) {
            addFileContextTag({
              title: contextTab.title,
              filePath: contextTab.filePath,
            })
            useChatStore.getState().setDraftInput(`请总结文件「${contextTab.title}」的内容`)
          }
          break
        case 'reindexRag':
          if (contextTab?.filePath) {
            indexMarkdownDocument(contextTab.filePath, contextTab.title, contextTab.content)
          }
          break
        case 'rename':
          if (contextTab?.filePath) {
            renameCancelledRef.current = false
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
    },
    [contextMenu, contextTab, tabs, closeTab, setRightPaneTabId, viewMode, setViewMode, togglePinTab]
  )

  const commitRename = useCallback(async (tab: Tab) => {
    if (renameCancelledRef.current) {
      renameCancelledRef.current = false
      return
    }
    if (renameSubmittingRef.current) return
    if (!tab.filePath) {
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

  const handleModeChange = useCallback((mode: ViewMode) => {
    setViewMode(mode)
  }, [setViewMode])

  const handleExportHtml = useCallback(async () => {
    const tab = tabs.find((item) => item.id === activeTabId)
    if (!tab) return
    try {
      await exportMarkdownAsHtml(tab.content, tab.title.replace(/\.(md|markdown|mdx)$/i, ''), tab.filePath)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'HTML export failed')
    }
  }, [activeTabId, tabs])

  const handleExportPdf = useCallback(async () => {
    const tab = tabs.find((item) => item.id === activeTabId)
    if (!tab) return
    try {
      await exportMarkdownAsPdf(tab.content, tab.title.replace(/\.(md|markdown|mdx)$/i, ''), tab.filePath)
      toast.success('已打开 PDF 打印对话框')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'PDF export failed')
    }
  }, [activeTabId, tabs])

  const openExportMenu = useCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation()
    if (exportMenu) {
      setExportMenu(null)
      return
    }
    const rect = exportButtonRef.current?.getBoundingClientRect()
    if (!rect) return
    setExportMenu({ x: rect.right - 160, y: rect.bottom + 4 })
  }, [exportMenu])

  const exportHtmlFromMenu = useCallback(() => {
    setExportMenu(null)
    void handleExportHtml()
  }, [handleExportHtml])

  const exportPdfFromMenu = useCallback(() => {
    setExportMenu(null)
    void handleExportPdf()
  }, [handleExportPdf])

  if (tabs.length === 0) return null

  return (
    <>
      <div className="gm-instant-color h-10 min-w-0 flex items-center bg-gm-surface border-b border-gm-border overflow-hidden">
        {/* Tabs */}
        <div className="min-w-0 flex-1 flex items-center overflow-x-auto">
          {[...tabs].sort((a, b) => {
            if (a.pinned && !b.pinned) return -1
            if (!a.pinned && b.pinned) return 1
            return 0
          }).map((tab) => {
            const isFav = tab.filePath ? favorites.some((path) => isSameFilePath(path, tab.filePath)) : false
            return (
              <div
                key={tab.id}
                role="button"
                tabIndex={0}
                draggable={renamingTabId !== tab.id}
                onClick={() => setActiveTab(tab.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    setActiveTab(tab.id)
                  }
                }}
                onContextMenu={(e) => handleContextMenu(e, tab.id)}
                onDragStart={(e) => handleDragStart(e, tab.id)}
                onDragOver={(e) => handleDragOver(e, tab.id)}
                onDragLeave={handleDragLeave}
                onDrop={(e) => handleDrop(e, tab.id)}
                onDragEnd={handleDragEnd}
                className={`h-full px-3 flex items-center gap-1.5 text-caption border-r border-gm-border-subtle group select-none cursor-pointer ${
                  activeTabId === tab.id
                    ? 'bg-gm-canvas text-gm-text font-bold'
                    : 'text-gm-text-secondary hover:text-gm-text hover:bg-gm-surface-hover'
                } ${dragState?.tabId === tab.id ? 'opacity-50' : ''} ${
                  dragOverTabId === tab.id && dragState?.tabId !== tab.id
                    ? 'border-l-2 border-l-gm-primary'
                    : ''
                }`}
                style={activeTabId === tab.id ? { borderBottom: '2px solid var(--gm-active-indicator)' } : undefined}
              >
                {renamingTabId === tab.id ? (
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
                    className="w-32 rounded border border-gm-primary bg-gm-canvas px-1 py-0.5 text-caption text-gm-text outline-none"
                  />
                ) : (
                  <span className="whitespace-nowrap">{tab.title}</span>
                )}
                {tab.pinned && (
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" stroke="none" className="flex-shrink-0 text-gm-primary">
                    <path d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2l-2-2z" />
                  </svg>
                )}
                {tab.modified && (
                  <span className="w-2 h-2 rounded-full bg-gm-primary animate-bounceIn" />
                )}
                {/* Favorite star */}
                {tab.filePath && (
                  <span
                    onClick={(e) => {
                      e.stopPropagation()
                      toggleFavorite(tab.filePath!)
                    }}
                    className={`opacity-0 group-hover:opacity-100 transition-opacity p-0.5 ${
                      isFav ? 'opacity-100' : ''
                    }`}
                    title={isFav ? '取消收藏' : '收藏'}
                    draggable={false}
                    onMouseDown={(e) => e.stopPropagation()}
                    onDragStart={(e) => e.preventDefault()}
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill={isFav ? '#f5c31c' : 'none'} stroke={isFav ? '#f5c31c' : 'currentColor'} strokeWidth="1.5">
                      <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
                    </svg>
                  </span>
                )}
                <span
                  onClick={(e) => {
                    e.stopPropagation()
                    closeTab(tab.id)
                  }}
                  className="opacity-0 group-hover:opacity-100 hover:bg-gm-surface-overlay rounded-full p-0.5 transition-opacity"
                  draggable={false}
                  onMouseDown={(e) => e.stopPropagation()}
                  onDragStart={(e) => e.preventDefault()}
                >
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M18 6L6 18M6 6l12 12" />
                  </svg>
                </span>
              </div>
            )
          })}
        </div>

        {/* View mode switcher */}
        <div className="flex items-center gap-0.5 px-2 border-l border-gm-border-subtle flex-shrink-0">
          <button
            type="button"
            ref={exportButtonRef}
            onClick={openExportMenu}
            disabled={!activeTabId}
            aria-haspopup="menu"
            aria-expanded={Boolean(exportMenu)}
            className="mr-2 rounded-lg border border-gm-border bg-gm-surface-elevated px-2.5 py-1 text-caption font-bold text-gm-text-secondary hover:text-gm-primary disabled:cursor-not-allowed disabled:opacity-50"
          >
            导出
          </button>
          <ModeButton
            active={viewMode === 'edit'}
            onClick={() => handleModeChange('edit')}
            title="编辑模式"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" />
              <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" />
            </svg>
          </ModeButton>
          <ModeButton
            active={viewMode === 'preview'}
            onClick={() => handleModeChange('preview')}
            title="预览模式"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" />
              <circle cx="12" cy="12" r="3" />
            </svg>
          </ModeButton>
          <ModeButton
            active={viewMode === 'edit-preview'}
            onClick={() => handleModeChange('edit-preview')}
            title="编辑+预览"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <rect x="3" y="3" width="7" height="18" rx="1" />
              <rect x="14" y="3" width="7" height="18" rx="1" />
            </svg>
          </ModeButton>
          <ModeButton
            active={viewMode === 'dual-preview'}
            onClick={() => handleModeChange('dual-preview')}
            title="对照阅读"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <rect x="3" y="3" width="7" height="18" rx="1" />
              <path d="M7 7h-1M7 11h-1M7 15h-1" />
              <rect x="14" y="3" width="7" height="18" rx="1" />
              <path d="M18 7h-1M18 11h-1M18 15h-1" />
            </svg>
          </ModeButton>
          <ModeButton
            active={viewMode === 'diff-preview'}
            onClick={() => handleModeChange('diff-preview')}
            title="Diff 对比"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M6 3v18M18 3v18M9 8h6M9 16h6" />
            </svg>
          </ModeButton>
        </div>
      </div>

      {exportMenu && (
        <ContextMenu position={exportMenu} onClose={() => setExportMenu(null)} minWidth={160} maxWidth={160}>
          <ContextMenuGroupTitle>导出</ContextMenuGroupTitle>
          <ContextMenuItem onClick={exportPdfFromMenu} disabled={!activeTabId}>
            导出 PDF
          </ContextMenuItem>
          <ContextMenuItem onClick={exportHtmlFromMenu} disabled={!activeTabId}>
            导出 HTML
          </ContextMenuItem>
        </ContextMenu>
      )}

      {/* Context Menu */}
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

function ModeButton({ children, active, onClick, title }: {
  children: React.ReactNode
  active: boolean
  onClick: () => void
  title: string
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={`p-1.5 rounded-lg ${
        active
          ? 'text-gm-primary'
          : 'text-gm-text-tertiary hover:text-gm-text-secondary hover:bg-gm-surface-hover'
      }`}
    >
      {children}
    </button>
  )
}
