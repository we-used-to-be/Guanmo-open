import { useState, useCallback } from 'react'
import { useAppStore } from '@/stores/appStore'
import { useEditorStore } from '@/stores/editorStore'
import { isTauri } from '@/hooks/useTauri'
import { openFile, pickDirectory } from '@/services/fileSystem'
import { isWorkspaceDisplayFile } from '@/services/fileTree'
import { scheduleMarkdownDocumentIndex, isMarkdownPath } from '@/services/rag/indexer'
import { addKnowledgeDocument, isKnowledgeDocumentIndexed } from '@/services/rag/knowledgeBase'
import { isSameFilePath } from '@/services/pathIdentity'
import { toast } from '@/services/toast'
import { getRuntimeCapabilities } from '@/services/runtimeCapabilities'
import { Button, Collapse, Divider } from 'animal-island-ui'
import { RecentFiles } from '@/components/file-tree/FileTree'
import { WorkspaceRoots } from '@/components/file-tree/WorkspaceRoots'
import { ContextMenu, ContextMenuGroupTitle, ContextMenuItem, ContextMenuSeparator } from '@/components/common/ContextMenu'
import { addFileContextTag, summarizeFileWithAi } from '@/services/aiContext'
import { saveExistingFileAs } from '@/services/fileEntryActions'
import { describeFileOperationError } from '@/services/fileOperationErrors'
import { readRememberedFile } from '@/services/persistedFileAccess'
import { readMarkdownFileForOpen, readRememberedMarkdownFileForOpen } from '@/services/markdownFileOpenPolicy'
import { TruncatedText } from '@/components/common/Tooltip'
import { useFileRename } from '@/hooks/useFileRename'

interface SidebarProps {
  collapsed: boolean
  width: number
  onResizeStart: (event: React.MouseEvent) => void
  onOpenSettings: () => void
  onOpenSearch: () => void
}

export function Sidebar({ collapsed, width, onResizeStart, onOpenSettings, onOpenSearch }: SidebarProps) {
  const toggleSidebar = useAppStore((s) => s.toggleSidebar)
  const addWorkspaceRoot = useAppStore((s) => s.addWorkspaceRoot)
  const recentFiles = useEditorStore((s) => s.recentFiles).filter((file) => isWorkspaceDisplayFile(file.path))
  const favorites = useEditorStore((s) => s.favorites).filter(isWorkspaceDisplayFile)
  const tabs = useEditorStore((s) => s.tabs)
  const browserFileSystem = getRuntimeCapabilities().browserFileSystem

  // Build favorites list with file names
  const favoriteFiles = favorites.map((path) => {
    const tab = tabs.find((t) => t.filePath === path)
    const name = tab?.title || path.split(/[/\\]/).pop() || path
    return { name, path }
  })

  const handleOpenFile = useCallback(async () => {
    try {
      const file = await openFile()
      if (file) {
        const state = useEditorStore.getState()
        const existing = state.tabs.find((t) => isSameFilePath(t.filePath, file.path))
        if (existing) {
          state.setActiveTab(existing.id)
        } else {
          state.addTab(file.path, file.name, file.content)
        }
        scheduleMarkdownDocumentIndex(file.path, file.name, file.content)
      }
    } catch (err) {
      console.error('Open file failed:', err)
      toast.error(describeFileOperationError(err, '打开文件失败'))
    }
  }, [])

  const handleOpenFolder = useCallback(async () => {
    if (!isTauri() && !getRuntimeCapabilities().browserFileSystem) {
      toast.error('当前浏览器不支持目录工作区，请使用 Chrome 或 Edge')
      return
    }
    try {
      const dirPath = await pickDirectory()
      if (!dirPath) return
      if (!addWorkspaceRoot(dirPath)) {
        toast.error('该文件夹已在工作区中')
      }
    } catch (err) {
      console.error('Open folder failed:', err)
      toast.error('打开文件夹失败')
    }
  }, [addWorkspaceRoot])

  const handleOpenFileFromTree = useCallback(async (path: string) => {
      try {
        if (!isWorkspaceDisplayFile(path)) return
        const state = useEditorStore.getState()
        const existing = state.tabs.find((t) => isSameFilePath(t.filePath, path))
        if (existing) {
          state.setActiveTab(existing.id)
          return
        }
        const content = await readMarkdownFileForOpen(path)
        const name = path.split(/[/\\]/).pop() || 'untitled.md'
        state.addTab(path, name, content)
        scheduleMarkdownDocumentIndex(path, name, content)
    } catch (err) {
      if (err instanceof Error && err.message === 'Not running in Tauri') {
        toast.error('浏览器模式下无法打开本地文件，请下载桌面版')
        return
      }
      console.error('Open file from tree failed:', err)
      toast.error(describeFileOperationError(err, '打开文件失败'))
      window.dispatchEvent(new Event('guanmo:workspace-refresh'))
    }
  }, [])

  const handleOpenRecentFile = useCallback(async (file: { name: string; path: string }) => {
    try {
      const state = useEditorStore.getState()
      const existing = state.tabs.find((t) => isSameFilePath(t.filePath, file.path))
      if (existing) {
        state.setActiveTab(existing.id)
        return
      }
      const content = await readRememberedMarkdownFileForOpen(file.path)
      state.addTab(file.path, file.name, content)
      scheduleMarkdownDocumentIndex(file.path, file.name, content)
    } catch (err) {
      if (err instanceof Error && err.message === 'Not running in Tauri') {
        toast.error('浏览器模式下无法打开本地文件，请下载桌面版')
        return
      }
      console.error('Open recent file failed:', err)
      toast.error(describeFileOperationError(err, '打开最近文件失败'))
    }
  }, [])

  const refreshWorkspaces = useCallback(() => {
    window.dispatchEvent(new Event('guanmo:workspace-refresh'))
  }, [])

  if (collapsed) {
    return (
      <div className="animal-cursor gm-instant-color w-14 flex-shrink-0 bg-gm-surface border-r border-gm-border flex flex-col items-center py-3 gap-2">
        <SidebarIcon label="展开侧边栏" onClick={toggleSidebar} tourTarget="sidebar-toggle">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 6h16M4 12h16M4 18h16" />
          </svg>
        </SidebarIcon>
        <SidebarIcon label="打开文件" onClick={handleOpenFile} tourTarget="open-file">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
            <path d="M14 2v6h6" />
          </svg>
        </SidebarIcon>
        <SidebarIcon label="搜索" onClick={onOpenSearch}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="8" />
            <path d="M21 21l-4.35-4.35" />
          </svg>
        </SidebarIcon>
        <SidebarIcon
          label="打开文件夹"
          onClick={handleOpenFolder}
          disabled={!isTauri() && !browserFileSystem}
          title={!isTauri() && !browserFileSystem ? '当前浏览器不支持目录工作区' : undefined}
          tourTarget="open-folder"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
            <path d="M12 11v6M9 14l3-3 3 3" />
          </svg>
        </SidebarIcon>
        <div className="flex-1" />
        <SidebarIcon label="设置" onClick={onOpenSettings} tourTarget="settings">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z" />
          </svg>
        </SidebarIcon>
      </div>
    )
  }

  return (
    <div
      className="animal-cursor gm-instant-color relative flex-shrink-0 bg-gm-surface border-r border-gm-border flex flex-col overflow-hidden"
      style={{ width }}
    >
      <div
        className="absolute right-0 top-0 bottom-0 w-1 cursor-col-resize z-10 hover:bg-gm-primary/30 transition-colors"
        onMouseDown={onResizeStart}
      />
      {/* Header */}
      <div className="h-11 flex items-center px-4 border-b border-gm-border-subtle">
        <span className="text-body font-bold text-gm-text tracking-wide">
          文件侧边栏
        </span>
        <div className="flex-1" />
        <Button
          type="text"
          size="small"
          onClick={toggleSidebar}
          title="折叠侧边栏"
          icon={
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M11 19l-7-7 7-7M18 19l-7-7 7-7" />
            </svg>
          }
        />
      </div>

      {/* File Sections with Collapse */}
      <div className="flex-1 overflow-y-auto p-3 pb-16 space-y-2">
        <Collapse
          question="最近文件"
          defaultExpanded
          answer={
            <RecentFiles files={recentFiles} onOpen={handleOpenRecentFile} onRefreshWorkspace={refreshWorkspaces} />
          }
        />
        <Collapse
          question="收藏"
          answer={
            favoriteFiles.length > 0 ? (
              <FavoriteFiles files={favoriteFiles} onRefreshWorkspace={refreshWorkspaces} />
            ) : (
              <div className="text-caption text-gm-text-tertiary text-center py-4">
                暂无收藏
              </div>
            )
          }
        />
        <Collapse
          question="工作区"
          defaultExpanded
          answer={
            <WorkspaceRoots onOpenFile={(path) => { void handleOpenFileFromTree(path) }} />
          }
        />
      </div>

      {/* Bottom Actions */}
      <div className="absolute bottom-0 left-0 right-0 z-20 bg-gm-surface/70 shadow-[0_-8px_24px_0_rgba(61,52,40,0.08)] backdrop-blur-xl">
        <Divider type="line-brown" />
        <div className="flex items-center gap-1 p-2">
          <Button type="text" size="small" title="打开文件" onClick={handleOpenFile}
            icon={
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
              </svg>
            }
          />
          <Button type="text" size="small" title="搜索" onClick={onOpenSearch}
            icon={
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="11" cy="11" r="8" />
                <path d="M21 21l-4.35-4.35" />
              </svg>
            }
          />
          <Button type="text" size="small" title={browserFileSystem || isTauri() ? '打开文件夹' : '当前浏览器不支持目录工作区'} onClick={handleOpenFolder} disabled={!isTauri() && !browserFileSystem}
            icon={
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
                <path d="M12 11v6M9 14l3-3 3 3" />
              </svg>
            }
          />
          <div className="flex-1" />
          <div className="w-px h-5 bg-gm-border-subtle mx-1" />
          <Button type="text" size="small" title="设置" onClick={onOpenSettings}
            icon={
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z" />
              </svg>
            }
          />
        </div>
      </div>
    </div>
  )
}

function FavoriteFiles({ files, onRefreshWorkspace }: {
  files: { name: string; path: string }[]
  onRefreshWorkspace?: () => void
}) {
  const activeTabId = useEditorStore((s) => s.activeTabId)
  const tabs = useEditorStore((s) => s.tabs)
  const databaseEnabled = getRuntimeCapabilities().database
  const activeFilePath = tabs.find((t) => t.id === activeTabId)?.filePath
  const [showAll, setShowAll] = useState(false)
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; file: { name: string; path: string } } | null>(null)
  const rename = useFileRename()
  const [missingPaths, setMissingPaths] = useState<Set<string>>(new Set())
  const [kbStatus, setKbStatus] = useState<'idle' | 'checking' | 'not-indexed' | 'indexed' | 'adding'>('idle')

  const INITIAL_SHOW = 20
  const visibleFiles = showAll ? files : files.slice(0, INITIAL_SHOW)
  const hasMore = files.length > INITIAL_SHOW

  const startRename = useCallback((file: { name: string; path: string }) => {
    rename.startRename(file.path, file.name)
    setContextMenu(null)
  }, [rename])

  const handleOpenFavorite = useCallback(async (file: { name: string; path: string }) => {
    try {
      const state = useEditorStore.getState()
      const existing = state.tabs.find((t) => isSameFilePath(t.filePath, file.path))
      if (existing) {
        state.setActiveTab(existing.id)
      } else {
        const content = await readRememberedMarkdownFileForOpen(file.path)
        state.addTab(file.path, file.name, content)
        scheduleMarkdownDocumentIndex(file.path, file.name, content)
      }
      setMissingPaths((current) => {
        if (!current.has(file.path)) return current
        const next = new Set(current)
        next.delete(file.path)
        return next
      })
    } catch (err) {
      if (err instanceof Error && err.message === 'Not running in Tauri') {
        toast.error('浏览器模式下无法打开本地文件，请下载桌面版')
        return
      }
      const message = err instanceof Error ? err.message : String(err)
      const lower = message.toLowerCase()
      const isMissing =
        lower.includes('not found') ||
        lower.includes('os error 2') ||
        message.includes('找不到') ||
        message.includes('不存在')

      if (isMissing) {
        setMissingPaths((current) => new Set(current).add(file.path))
        toast.error(`收藏文件已丢失：${file.name}`)
        onRefreshWorkspace?.()
        return
      }
      toast.error(describeFileOperationError(err, '打开收藏文件失败'))
    }
  }, [onRefreshWorkspace])

  return (
    <div className="space-y-0.5 py-1">
      {visibleFiles.map((file) => {
        const isActive = isSameFilePath(activeFilePath, file.path)
        const isMissing = missingPaths.has(file.path)
        return (
          <button
            key={file.path}
            onClick={() => void handleOpenFavorite(file)}
            onContextMenu={(e) => {
              e.preventDefault()
              setContextMenu({ x: e.clientX, y: e.clientY, file })
              if (databaseEnabled && isMarkdownPath(file.path)) {
                setKbStatus('checking')
                isKnowledgeDocumentIndexed(file.path).then((indexed) => {
                  setKbStatus(indexed ? 'indexed' : 'not-indexed')
                }).catch(() => {
                  setKbStatus('not-indexed')
                })
              } else {
                setKbStatus('idle')
              }
            }}
            className={`w-full flex items-center gap-1.5 px-2 py-1 rounded-lg text-caption text-left truncate ${
              isActive
                ? 'bg-gm-primary-subtle text-gm-text font-bold'
                : isMissing
                  ? 'text-gm-text-disabled bg-gm-surface-elevated/60'
                  : 'text-gm-text-secondary hover:text-gm-text hover:bg-gm-surface-hover'
            }`}
          >
            {rename.isRenaming(file.path) ? (
              <input
                autoFocus
                value={rename.state.value}
                disabled={rename.state.status === 'submitting'}
                onClick={(e) => e.stopPropagation()}
                onFocus={(e) => e.currentTarget.select()}
                onChange={(e) => rename.setRenameValue(e.target.value)}
                onBlur={() => void rename.submitRename(file.path, file.path, onRefreshWorkspace)}
                onKeyDown={(e) => {
                  e.stopPropagation()
                  if (e.key === 'Enter') void rename.submitRename(file.path, file.path, onRefreshWorkspace)
                  if (e.key === 'Escape') {
                    rename.cancelRename(file.path)
                  }
                }}
                className="min-w-0 flex-1 rounded border border-gm-primary bg-gm-canvas px-1 py-0.5 outline-none"
              />
            ) : (
              <>
                <TruncatedText text={isMissing ? `文件已丢失：${file.path}` : file.name} className="flex-1" />
                {isMissing && <span className="ml-auto shrink-0 text-micro">已丢失</span>}
              </>
            )}
          </button>
        )
      })}
      {contextMenu && (
        <ContextMenu position={contextMenu} onClose={() => setContextMenu(null)} minWidth={176} maxWidth={176}>
          <ContextMenuGroupTitle variant="strong">文件操作</ContextMenuGroupTitle>
          <ContextMenuItem onClick={() => startRename(contextMenu.file)}>重命名</ContextMenuItem>
          <ContextMenuItem onClick={async () => {
            setContextMenu(null)
            try {
              await saveExistingFileAs(contextMenu.file.path)
              toast.success('已另存为')
            } catch {
              toast.error('另存为失败')
            }
          }}>另存为</ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuGroupTitle variant="strong">AI 助手</ContextMenuGroupTitle>
          <ContextMenuItem onClick={() => {
            addFileContextTag({ title: contextMenu.file.name, filePath: contextMenu.file.path })
            setContextMenu(null)
          }}>添加到 AI 上下文</ContextMenuItem>
          <ContextMenuItem onClick={() => {
            summarizeFileWithAi({ title: contextMenu.file.name, filePath: contextMenu.file.path })
            setContextMenu(null)
          }}>AI 总结该文件</ContextMenuItem>
          {isMarkdownPath(contextMenu.file.path) && (
            <>
              <ContextMenuSeparator />
              <ContextMenuGroupTitle>知识库</ContextMenuGroupTitle>
               {!databaseEnabled && (
                 <ContextMenuItem onClick={() => {}} disabled>
                   知识库仅桌面版可用
                 </ContextMenuItem>
               )}
               {kbStatus === 'checking' && (
                <ContextMenuItem onClick={() => {}} disabled>
                  正在读取知识库状态…
                </ContextMenuItem>
              )}
               {databaseEnabled && kbStatus === 'not-indexed' && (
                <ContextMenuItem onClick={async () => {
                  setContextMenu(null)
                  setKbStatus('adding')
                  try {
                    const content = await readRememberedFile(contextMenu.file.path)
                    const result = await addKnowledgeDocument({
                      filePath: contextMenu.file.path,
                      title: contextMenu.file.name,
                      content,
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
                }}>加入知识库</ContextMenuItem>
              )}
               {databaseEnabled && kbStatus === 'indexed' && (
                <ContextMenuItem onClick={async () => {
                  setContextMenu(null)
                  setKbStatus('adding')
                  try {
                    const content = await readRememberedFile(contextMenu.file.path)
                    const result = await addKnowledgeDocument({
                      filePath: contextMenu.file.path,
                      title: contextMenu.file.name,
                      content,
                    })
                    if (result.success) {
                      setKbStatus('indexed')
                      toast.success('已更新知识库')
                    } else {
                      setKbStatus('not-indexed')
                      toast.error(result.error || '更新知识库失败')
                    }
                  } catch (err) {
                    setKbStatus('not-indexed')
                    toast.error(err instanceof Error ? err.message : '更新知识库失败')
                  }
                }}>✓ 已加入知识库（点击更新）</ContextMenuItem>
              )}
               {databaseEnabled && kbStatus === 'adding' && (
                <ContextMenuItem onClick={() => {}} disabled>
                  正在加入知识库…
                </ContextMenuItem>
              )}
            </>
          )}
          <ContextMenuSeparator />
          <ContextMenuGroupTitle variant="strong">路径与收藏</ContextMenuGroupTitle>
          <ContextMenuItem onClick={() => { navigator.clipboard.writeText(contextMenu.file.path); setContextMenu(null) }}>复制路径</ContextMenuItem>
          <ContextMenuItem onClick={() => { useEditorStore.getState().toggleFavorite(contextMenu.file.path); setContextMenu(null) }}>从收藏移除</ContextMenuItem>
        </ContextMenu>
      )}
      {hasMore && !showAll && (
        <button
          onClick={() => setShowAll(true)}
          className="w-full px-2 py-1 text-micro text-gm-text-tertiary hover:text-gm-text-secondary hover:bg-gm-surface-hover rounded-lg text-center"
        >
          展开更多 ({files.length - INITIAL_SHOW})
        </button>
      )}
      {hasMore && showAll && (
        <button
          onClick={() => setShowAll(false)}
          className="w-full px-2 py-1 text-micro text-gm-text-tertiary hover:text-gm-text-secondary hover:bg-gm-surface-hover rounded-lg text-center"
        >
          收起
        </button>
      )}
    </div>
  )
}

function SidebarIcon({
  children,
  label,
  onClick,
  disabled = false,
  title,
  tourTarget,
}: {
  children: React.ReactNode
  label: string
  onClick: () => void
  disabled?: boolean
  title?: string
  tourTarget?: string
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      data-product-tour={tourTarget}
      aria-label={label}
      className="w-10 h-10 flex items-center justify-center rounded-lg text-gm-text-secondary hover:text-gm-text hover:bg-gm-surface-hover disabled:cursor-not-allowed disabled:opacity-50"
      title={title ?? label}
    >
      {children}
    </button>
  )
}
