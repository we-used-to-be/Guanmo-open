import { useState, useCallback, useEffect, useRef } from 'react'
import { useAppStore } from '@/stores/appStore'
import { useEditorStore } from '@/stores/editorStore'
import { joinPath } from '@/hooks/useTauri'
import { openFile } from '@/services/fileSystem'
import { pickDirectory, listDirectory } from '@/services/fileSystem'
import { isWorkspaceDisplayFile, shouldSkipWorkspaceDirectory, getFileIcon, type FileNode } from '@/services/fileTree'
import { indexMarkdownDocument, indexWorkspaceMarkdown } from '@/services/rag/indexer'
import { isSameFilePath } from '@/services/pathIdentity'
import { toast } from '@/services/toast'
import { Button, Collapse, Divider } from 'animal-island-ui'
import { FileTree, RecentFiles, FileIconSVG } from '@/components/file-tree/FileTree'
import { ContextMenu, ContextMenuGroupTitle, ContextMenuItem, ContextMenuSeparator } from '@/components/common/ContextMenu'
import { addFileContextTag } from '@/services/aiContext'
import { useChatStore } from '@/stores/chatStore'
import { renameFileEntry, saveExistingFileAs, validateFileName } from '@/services/fileEntryActions'
import { describeFileOperationError } from '@/services/fileOperationErrors'
import { cleanupMissingWorkspaceDocuments, rebuildWorkspaceDocuments } from '@/services/workspaceIndex'

interface SidebarProps {
  collapsed: boolean
  width: number
  onOpenSettings: () => void
  onOpenSearch: () => void
}

export function Sidebar({ collapsed, width, onOpenSettings, onOpenSearch }: SidebarProps) {
  const { toggleSidebar, workspacePath, setWorkspacePath } = useAppStore()
  const { recentFiles, favorites, tabs } = useEditorStore()
  const activeTabId = useEditorStore((s) => s.activeTabId)
  const [workspaceFiles, setWorkspaceFiles] = useState<FileNode[]>([])
  const [workspaceHiddenCount, setWorkspaceHiddenCount] = useState(0)
  const [indexingWorkspace, setIndexingWorkspace] = useState(false)
  const [workspaceCleanupSummary, setWorkspaceCleanupSummary] = useState<string | null>(null)
  const [indexMenuOpen, setIndexMenuOpen] = useState(false)
  const indexMenuRef = useRef<HTMLDivElement>(null)

  // 递归读取目录并构建文件树
  const readDirRecursive = useCallback(async (dirPath: string, depth: number): Promise<{ nodes: FileNode[]; hidden: number }> => {
    if (depth > 5) return { nodes: [], hidden: 0 }
    const entries = await listDirectory(dirPath)
    const nodes: FileNode[] = []
    let hidden = 0
    for (const entry of entries) {
      const fullPath = await joinPath(dirPath, entry.name)
      if (entry.isDirectory) {
        if (shouldSkipWorkspaceDirectory(entry.name)) {
          hidden++
          continue
        }
        const { nodes: children, hidden: childHidden } = await readDirRecursive(fullPath, depth + 1)
        nodes.push({ name: entry.name, path: fullPath, type: 'directory', children })
        hidden += childHidden
      } else if (isWorkspaceDisplayFile(entry.name)) {
        const ext = entry.name.includes('.') ? entry.name.split('.').pop()?.toLowerCase() : undefined
        nodes.push({ name: entry.name, path: fullPath, type: 'file', extension: ext })
      } else {
        hidden++
      }
    }
    nodes.sort((a, b) => {
      if (a.type === 'directory' && b.type !== 'directory') return -1
      if (a.type !== 'directory' && b.type === 'directory') return 1
      return a.name.localeCompare(b.name)
    })
    return { nodes, hidden }
  }, [])

  const loadWorkspace = useCallback(async (dirPath: string) => {
    try {
      const { nodes, hidden } = await readDirRecursive(dirPath, 0)
      setWorkspaceHiddenCount(hidden)
      setWorkspaceFiles(nodes)
    } catch (err) {
      console.error('Load workspace failed:', err)
      toast.error('加载工作区失败')
      setWorkspacePath(null)
      setWorkspaceFiles([])
    }
  }, [setWorkspacePath, readDirRecursive])

  // 启动时自动恢复工作区
  useEffect(() => {
    if (workspacePath) {
      loadWorkspace(workspacePath)
    }
  }, [])

  useEffect(() => {
    if (!workspacePath) return
    const handler = () => {
      void loadWorkspace(workspacePath)
    }
    window.addEventListener('guanmo:workspace-refresh', handler)
    return () => window.removeEventListener('guanmo:workspace-refresh', handler)
  }, [loadWorkspace, workspacePath])

  // 点击外部关闭索引下拉菜单
  useEffect(() => {
    if (!indexMenuOpen) return
    const handler = (e: MouseEvent) => {
      if (indexMenuRef.current && !indexMenuRef.current.contains(e.target as Node)) {
        setIndexMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [indexMenuOpen])

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
        indexMarkdownDocument(file.path, file.name, file.content)
      }
    } catch (err) {
      console.error('Open file failed:', err)
      toast.error('打开文件失败')
    }
  }, [])

  const handleOpenFolder = useCallback(async () => {
    try {
      const dirPath = await pickDirectory()
      if (!dirPath) return
      setWorkspacePath(dirPath)
      setWorkspaceCleanupSummary(null)
      await loadWorkspace(dirPath)
    } catch (err) {
      console.error('Open folder failed:', err)
      toast.error('打开文件夹失败')
    }
  }, [setWorkspacePath, loadWorkspace])

  const handleOpenFileFromTree = useCallback(async (path: string) => {
    try {
      if (!isWorkspaceDisplayFile(path)) return
      const { readFile } = await import('@/hooks/useTauri')
      const content = await readFile(path)
      const name = path.split(/[/\\]/).pop() || 'untitled.md'
      const state = useEditorStore.getState()
      const existing = state.tabs.find((t) => isSameFilePath(t.filePath, path))
      if (existing) {
        state.setActiveTab(existing.id)
      } else {
        state.addTab(path, name, content)
      }
      indexMarkdownDocument(path, name, content)
    } catch (err) {
      console.error('Open file from tree failed:', err)
      toast.error(describeFileOperationError(err, '打开文件失败'))
      if (workspacePath) {
        await loadWorkspace(workspacePath)
      }
    }
  }, [loadWorkspace, workspacePath])

  const handleOpenRecentFile = useCallback(async (file: { name: string; path: string }) => {
    try {
      const state = useEditorStore.getState()
      const existing = state.tabs.find((t) => isSameFilePath(t.filePath, file.path))
      if (existing) {
        state.setActiveTab(existing.id)
        return
      }
      const { readFile } = await import('@/hooks/useTauri')
      const content = await readFile(file.path)
      state.addTab(file.path, file.name, content)
      indexMarkdownDocument(file.path, file.name, content)
    } catch (err) {
      console.error('Open recent file failed:', err)
    }
  }, [])

  const handleCloseWorkspace = useCallback(() => {
    setWorkspaceFiles([])
    setWorkspacePath(null)
    setWorkspaceHiddenCount(0)
    setWorkspaceCleanupSummary(null)
  }, [setWorkspacePath])

  const handleRefreshWorkspace = useCallback(async () => {
    if (!workspacePath) return
    await loadWorkspace(workspacePath)
  }, [loadWorkspace, workspacePath])

  const handleIndexWorkspace = useCallback(async () => {
    if (!workspacePath || indexingWorkspace) return
    setIndexingWorkspace(true)
    setWorkspaceCleanupSummary(null)
    try {
      const result = await indexWorkspaceMarkdown(workspacePath)
      let summary = `已索引 ${result.indexed}`
      if (result.failed > 0) summary += `，失败 ${result.failed}`
      if (result.errors.length > 0) summary += `\n${result.errors.join('\n')}`
      setWorkspaceCleanupSummary(summary)
    } catch (err) {
      setWorkspaceCleanupSummary(err instanceof Error ? err.message : '索引失败')
    } finally {
      setIndexingWorkspace(false)
    }
  }, [workspacePath, indexingWorkspace])

  const handleCleanupWorkspace = useCallback(async () => {
    if (!workspacePath || indexingWorkspace) return
    setIndexingWorkspace(true)
    setWorkspaceCleanupSummary(null)
    try {
      const result = await cleanupMissingWorkspaceDocuments(workspacePath)
      setWorkspaceCleanupSummary(result.removed > 0 ? `已清理 ${result.removed} 个失效索引` : '未发现失效索引')
      if (result.removed > 0) {
        await loadWorkspace(workspacePath)
      }
    } catch (err) {
      setWorkspaceCleanupSummary(err instanceof Error ? err.message : '清理失效索引失败')
    } finally {
      setIndexingWorkspace(false)
    }
  }, [indexingWorkspace, loadWorkspace, workspacePath])

  const handleRebuildWorkspace = useCallback(async () => {
    if (!workspacePath || indexingWorkspace) return
    setIndexingWorkspace(true)
    setWorkspaceCleanupSummary(null)
    try {
      const result = await rebuildWorkspaceDocuments(workspacePath)
      setWorkspaceCleanupSummary(`已移除 ${result.removed} 个旧索引并重新索引 ${result.indexed} 个文件`)
      await loadWorkspace(workspacePath)
    } catch (err) {
      setWorkspaceCleanupSummary(err instanceof Error ? err.message : '重建工作区索引失败')
    } finally {
      setIndexingWorkspace(false)
    }
  }, [indexingWorkspace, loadWorkspace, workspacePath])

  if (collapsed) {
    return (
      <div className="animal-cursor w-14 flex-shrink-0 bg-gm-surface border-r border-gm-border flex flex-col items-center py-3 gap-2">
        <SidebarIcon label="展开侧边栏" onClick={toggleSidebar}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 6h16M4 12h16M4 18h16" />
          </svg>
        </SidebarIcon>
        <SidebarIcon label="打开文件" onClick={handleOpenFile}>
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
        <SidebarIcon label="打开文件夹" onClick={handleOpenFolder}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
            <path d="M12 11v6M9 14l3-3 3 3" />
          </svg>
        </SidebarIcon>
        <div className="flex-1" />
        <SidebarIcon label="设置" onClick={onOpenSettings}>
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
      className="animal-cursor relative flex-shrink-0 bg-gm-surface border-r border-gm-border flex flex-col overflow-hidden"
      style={{ width }}
    >
      {/* Header */}
      <div className="h-11 flex items-center px-4 border-b border-gm-border-subtle">
        <span className="text-body font-bold text-gm-text tracking-wide">
          观墨
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
          answer={<RecentFiles files={recentFiles} onOpen={handleOpenRecentFile} onRefreshWorkspace={workspacePath ? () => loadWorkspace(workspacePath) : undefined} />}
        />
        <Collapse
          question="收藏"
          answer={
            favoriteFiles.length > 0 ? (
              <FavoriteFiles files={favoriteFiles} onRefreshWorkspace={workspacePath ? () => loadWorkspace(workspacePath) : undefined} />
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
            workspacePath ? (
              <div>
                <div className="flex items-center justify-between mb-2">
                  <span className="text-micro text-gm-text-tertiary truncate flex-1" title={workspacePath}>
                    {workspacePath.split(/[/\\]/).pop()}
                  </span>
                  <button
                    onClick={async () => {
                      await handleRefreshWorkspace()
                      toast.success('工作区已刷新')
                    }}
                    className="text-micro text-gm-text-tertiary hover:text-gm-text transition-colors ml-2"
                    title="重新读取工作区文件列表"
                  >
                    刷新
                  </button>
                  <button
                    onClick={handleCloseWorkspace}
                    className="text-micro text-gm-text-tertiary hover:text-gm-text transition-colors ml-2"
                  >
                    关闭
                  </button>
                </div>
                {/* 索引操作栏 */}
                <div className="relative inline-flex items-center gap-0.5 mb-1" ref={indexMenuRef}>
                  <Button
                    type="text"
                    size="small"
                    loading={indexingWorkspace}
                    onClick={handleIndexWorkspace}
                  >
                    索引 Markdown
                  </Button>
                  <button
                    onClick={() => setIndexMenuOpen((v) => !v)}
                    className="inline-flex items-center text-gm-text-tertiary hover:text-gm-text transition-colors"
                    title="更多索引操作"
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                      <path d="M6 9l6 6 6-6" />
                    </svg>
                  </button>
                  {indexMenuOpen && (
                    <div className="absolute left-0 top-full z-20 mt-1 min-w-[120px] rounded-lg border border-gm-border bg-gm-surface-elevated shadow-lg py-1">
                      <button
                        className="w-full px-3 py-1.5 text-left text-micro text-gm-text-secondary hover:bg-gm-surface-hover hover:text-gm-text transition-colors"
                        onClick={() => { setIndexMenuOpen(false); handleCleanupWorkspace() }}
                      >
                        清理失效索引
                      </button>
                      <button
                        className="w-full px-3 py-1.5 text-left text-micro text-gm-text-secondary hover:bg-gm-surface-hover hover:text-gm-text transition-colors"
                        onClick={() => { setIndexMenuOpen(false); handleRebuildWorkspace() }}
                      >
                        重建索引
                      </button>
                    </div>
                  )}
                </div>
                {/* 索引结果卡片 */}
                {workspaceCleanupSummary && (
                  <div className="mb-1 rounded-lg border border-gm-border bg-gm-surface-elevated px-2 py-1.5 text-micro text-gm-text-tertiary break-words whitespace-pre-line">
                    {workspaceCleanupSummary}
                  </div>
                )}
                {workspaceHiddenCount > 0 && (
                  <div className="text-micro text-gm-text-disabled">
                    已隐藏 {workspaceHiddenCount} 个非文本文件或大型目录
                  </div>
                )}
                <FileTree
                  nodes={workspaceFiles}
                  onOpenFile={handleOpenFileFromTree}
                  workspacePath={workspacePath}
                  onRefreshWorkspace={handleRefreshWorkspace}
                  onCloseWorkspace={handleCloseWorkspace}
                />
              </div>
            ) : (
              <div className="text-caption text-gm-text-tertiary text-center py-4">
                <button
                  onClick={handleOpenFolder}
                  className="text-gm-primary hover:underline text-caption"
                >
                  打开文件夹
                </button>
                <p className="mt-1 text-gm-text-disabled">Ctrl+O</p>
              </div>
            )
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
          <Button type="text" size="small" title="打开文件夹" onClick={handleOpenFolder}
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
  const activeFilePath = tabs.find((t) => t.id === activeTabId)?.filePath
  const [showAll, setShowAll] = useState(false)
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; file: { name: string; path: string } } | null>(null)
  const [renamingPath, setRenamingPath] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [missingPaths, setMissingPaths] = useState<Set<string>>(new Set())
  const renameCancelledRef = useRef(false)
  const renameSubmittingRef = useRef(false)

  const INITIAL_SHOW = 20
  const visibleFiles = showAll ? files : files.slice(0, INITIAL_SHOW)
  const hasMore = files.length > INITIAL_SHOW

  const startRename = useCallback((file: { name: string; path: string }) => {
    renameCancelledRef.current = false
    setRenamingPath(file.path)
    setRenameValue(file.name)
    setContextMenu(null)
  }, [])

  const commitRename = useCallback(async (file: { name: string; path: string }) => {
    if (renameCancelledRef.current) {
      renameCancelledRef.current = false
      return
    }
    if (renameSubmittingRef.current) return
    const error = validateFileName(renameValue)
    if (error) {
      toast.error(error)
      return
    }
    renameSubmittingRef.current = true
    try {
      await renameFileEntry(file.path, renameValue)
      renameCancelledRef.current = true
      setRenamingPath(null)
      onRefreshWorkspace?.()
      toast.success('已重命名')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '重命名失败')
    } finally {
      renameSubmittingRef.current = false
    }
  }, [renameValue, onRefreshWorkspace])

  const handleOpenFavorite = useCallback(async (file: { name: string; path: string }) => {
    try {
      const state = useEditorStore.getState()
      const existing = state.tabs.find((t) => isSameFilePath(t.filePath, file.path))
      if (existing) {
        state.setActiveTab(existing.id)
      } else {
        const { readFile } = await import('@/hooks/useTauri')
        const content = await readFile(file.path)
        state.addTab(file.path, file.name, content)
        indexMarkdownDocument(file.path, file.name, content)
      }
      setMissingPaths((current) => {
        if (!current.has(file.path)) return current
        const next = new Set(current)
        next.delete(file.path)
        return next
      })
    } catch (err) {
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
            }}
            title={isMissing ? `文件已丢失：${file.path}` : file.path}
            className={`w-full flex items-center gap-1.5 px-2 py-1 rounded-lg text-caption text-left transition-all duration-150 truncate ${
              isActive
                ? 'bg-gm-primary-subtle text-gm-text font-bold'
                : isMissing
                  ? 'text-gm-text-disabled bg-gm-surface-elevated/60'
                  : 'text-gm-text-secondary hover:text-gm-text hover:bg-gm-surface-hover'
            }`}
          >
            <span className={isMissing ? 'opacity-45 grayscale' : ''}>
              <FileIconSVG icon={getFileIcon(file.name, 'file')} expanded={false} />
            </span>
            {renamingPath === file.path ? (
              <input
                autoFocus
                value={renameValue}
                onClick={(e) => e.stopPropagation()}
                onFocus={(e) => e.currentTarget.select()}
                onChange={(e) => setRenameValue(e.target.value)}
                onBlur={() => void commitRename(file)}
                onKeyDown={(e) => {
                  e.stopPropagation()
                  if (e.key === 'Enter') void commitRename(file)
                  if (e.key === 'Escape') {
                    renameCancelledRef.current = true
                    setRenamingPath(null)
                  }
                }}
                className="min-w-0 flex-1 rounded border border-gm-primary bg-gm-canvas px-1 py-0.5 outline-none"
              />
            ) : (
              <>
                <span className="truncate">{file.name}</span>
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
            addFileContextTag({ title: contextMenu.file.name, filePath: contextMenu.file.path })
            useChatStore.getState().setDraftInput(`请总结文件「${contextMenu.file.name}」的内容`)
            setContextMenu(null)
          }}>AI 总结该文件</ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuGroupTitle variant="strong">路径与收藏</ContextMenuGroupTitle>
          <ContextMenuItem onClick={() => { navigator.clipboard.writeText(contextMenu.file.path); setContextMenu(null) }}>复制路径</ContextMenuItem>
          <ContextMenuItem onClick={() => { useEditorStore.getState().toggleFavorite(contextMenu.file.path); setContextMenu(null) }}>从收藏移除</ContextMenuItem>
        </ContextMenu>
      )}
      {hasMore && !showAll && (
        <button
          onClick={() => setShowAll(true)}
          className="w-full px-2 py-1 text-micro text-gm-text-tertiary hover:text-gm-text-secondary hover:bg-gm-surface-hover rounded-lg transition-colors text-center"
        >
          展开更多 ({files.length - INITIAL_SHOW})
        </button>
      )}
      {hasMore && showAll && (
        <button
          onClick={() => setShowAll(false)}
          className="w-full px-2 py-1 text-micro text-gm-text-tertiary hover:text-gm-text-secondary hover:bg-gm-surface-hover rounded-lg transition-colors text-center"
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
}: {
  children: React.ReactNode
  label: string
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      className="w-10 h-10 flex items-center justify-center rounded-lg text-gm-text-secondary hover:text-gm-text hover:bg-gm-surface-hover transition-all duration-200"
      title={label}
    >
      {children}
    </button>
  )
}
