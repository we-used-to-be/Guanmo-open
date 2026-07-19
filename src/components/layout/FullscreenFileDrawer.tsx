import { useCallback, useEffect, useRef } from 'react'
import { isTauri } from '@/hooks/useTauri'
import { pickDirectory } from '@/services/fileSystem'
import { isWorkspaceDisplayFile } from '@/services/fileTree'
import { scheduleMarkdownDocumentIndex } from '@/services/rag/indexer'
import { isSameFilePath } from '@/services/pathIdentity'
import { describeFileOperationError } from '@/services/fileOperationErrors'
import { readRememberedFile } from '@/services/persistedFileAccess'
import { toast } from '@/services/toast'
import { useAppStore } from '@/stores/appStore'
import { useEditorStore } from '@/stores/editorStore'
import { FileTree, RecentFiles } from '@/components/file-tree/FileTree'
import { useWorkspaceFileTree } from '@/hooks/useWorkspaceFileTree'
import { Button, Collapse } from 'animal-island-ui'

interface FullscreenFileDrawerProps {
  open: boolean
  onClose: () => void
  onOpenSearch: () => void
}

export function FullscreenFileDrawer({
  open,
  onClose,
  onOpenSearch,
}: FullscreenFileDrawerProps) {
  const panelRef = useRef<HTMLDivElement | null>(null)
  const previousFocusRef = useRef<HTMLElement | null>(null)
  const setWorkspacePath = useAppStore((s) => s.setWorkspacePath)
  const { workspacePath, workspaceFiles, workspaceHiddenCount, loadWorkspace, refreshWorkspace, closeWorkspace } = useWorkspaceFileTree()
  const tabs = useEditorStore((s) => s.tabs)
  const activeTabId = useEditorStore((s) => s.activeTabId)
  const recentFiles = useEditorStore((s) => s.recentFiles)
  const favorites = useEditorStore((s) => s.favorites)
  const activeFilePath = tabs.find((tab) => tab.id === activeTabId)?.filePath
  const favoriteFiles = favorites.map((path) => {
    const tab = tabs.find((t) => t.filePath === path)
    const name = tab?.title || path.split(/[/\\]/).pop() || path
    return { name, path }
  })

  useEffect(() => {
    if (!open) return
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    window.setTimeout(() => panelRef.current?.focus(), 0)
    const handlePointerDown = (e: PointerEvent) => {
      const target = e.target as HTMLElement | null
      if (!target) return
      if (panelRef.current?.contains(target)) return
      if (target?.closest('[data-fullscreen-control-bar]')) return
      if (target?.closest('[data-context-menu]')) return
      onClose()
    }
    document.addEventListener('pointerdown', handlePointerDown, true)
    return () => {
      previousFocusRef.current?.focus?.()
      document.removeEventListener('pointerdown', handlePointerDown, true)
    }
  }, [open, onClose])

  const openFileByPath = useCallback(async (path: string, fallbackName?: string) => {
    try {
      if (!isWorkspaceDisplayFile(path)) return
      const content = await readRememberedFile(path)
      const name = fallbackName || path.split(/[/\\]/).pop() || 'untitled.md'
      const state = useEditorStore.getState()
      const existing = state.tabs.find((t) => isSameFilePath(t.filePath, path))
      if (existing) {
        state.setActiveTab(existing.id)
      } else {
        state.addTab(path, name, content)
      }
      scheduleMarkdownDocumentIndex(path, name, content)
    } catch (err) {
      if (err instanceof Error && err.message === 'Not running in Tauri') {
        toast.error('浏览器模式下无法打开本地文件，请下载桌面版')
        return
      }
      console.error('Open fullscreen file from tree failed:', err)
      toast.error(describeFileOperationError(err, '打开文件失败'))
      await refreshWorkspace()
    }
  }, [refreshWorkspace])

  const handleOpenFileFromTree = useCallback((path: string) => {
    void openFileByPath(path)
  }, [openFileByPath])

  const handleOpenListedFile = useCallback((file: { name: string; path: string }) => {
    void openFileByPath(file.path, file.name)
  }, [openFileByPath])

  const handleSearch = useCallback(() => {
    onOpenSearch()
    onClose()
  }, [onClose, onOpenSearch])

  const handleOpenFolder = useCallback(async () => {
    if (!isTauri()) {
      toast.error('浏览器模式下不可用，请下载桌面版')
      return
    }
    try {
      const dirPath = await pickDirectory()
      if (!dirPath) return
      setWorkspacePath(dirPath)
      await loadWorkspace(dirPath)
    } catch (err) {
      console.error('Open fullscreen workspace failed:', err)
      toast.error('打开文件夹失败')
    }
  }, [loadWorkspace, setWorkspacePath])

  const handleRefreshWorkspace = useCallback(async () => {
    await refreshWorkspace()
    toast.success('工作区已刷新')
  }, [refreshWorkspace])

  return (
    <div
      className={`fixed inset-0 z-[44] pointer-events-none transition-opacity duration-150 ease-out ${
        open ? 'opacity-100' : 'opacity-0'
      }`}
      aria-hidden={!open}
    >
      <aside
        ref={panelRef}
        data-fullscreen-file-drawer="true"
        tabIndex={open ? -1 : undefined}
        className={`gm-fullscreen-file-drawer absolute left-3 top-12 flex w-[min(292px,calc(100vw-24px))] flex-col overflow-hidden rounded-2xl border border-gm-border/75 bg-[var(--gm-surface)] shadow-[0_16px_48px_-8px_rgba(0,0,0,0.25),0_0_0_1px_rgba(0,0,0,0.04)] outline-none transition-all duration-180 ease-out ${
          open ? 'translate-x-0 opacity-100 pointer-events-auto' : '-translate-x-4 opacity-0 pointer-events-none'
        }`}
        style={{
          maxHeight: 'calc(100vh - 60px)',
          minHeight: '200px',
        }}
        role="dialog"
        aria-modal="false"
        aria-label="全屏文件侧边栏"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex h-11 items-center px-4 border-b border-gm-border-subtle">
          <span className="text-body font-bold text-gm-text tracking-wide">
            文件侧边栏
          </span>
          <div className="flex-1" />
          <Button
            type="text"
            size="small"
            onClick={onClose}
            title="关闭"
            icon={
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M18 6 6 18" />
                <path d="m6 6 12 12" />
              </svg>
            }
          />
        </div>

        {/* Content */}
        <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-2">
          {!isTauri() ? (
            <div className="text-caption text-gm-text-tertiary text-center py-4">
              浏览器模式下本地文件列表不可用
            </div>
          ) : (
            <>
              <Collapse
                question="最近文件"
                defaultExpanded
                answer={
                  recentFiles.length > 0 ? (
                    <RecentFiles files={recentFiles} onOpen={handleOpenListedFile} onRefreshWorkspace={workspacePath ? () => loadWorkspace(workspacePath) : undefined} />
                  ) : (
                    <div className="text-caption text-gm-text-tertiary text-center py-4">暂无最近文件</div>
                  )
                }
              />
              <Collapse
                question="收藏"
                answer={
                  favoriteFiles.length > 0 ? (
                    <FavoriteFileList
                      files={favoriteFiles}
                      activeFilePath={activeFilePath}
                      onOpen={handleOpenListedFile}
                    />
                  ) : (
                    <div className="text-caption text-gm-text-tertiary text-center py-4">暂无收藏</div>
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
                          onClick={handleRefreshWorkspace}
                          className="text-micro text-gm-text-tertiary hover:text-gm-text ml-2"
                        >
                          刷新
                        </button>
                        <button
                          onClick={handleOpenFolder}
                          className="text-micro text-gm-text-tertiary hover:text-gm-text ml-2"
                        >
                          打开
                        </button>
                        <button
                          onClick={closeWorkspace}
                          className="text-micro text-gm-text-tertiary hover:text-gm-text ml-2"
                        >
                          关闭
                        </button>
                      </div>
                      {workspaceHiddenCount > 0 && (
                        <div className="text-micro text-gm-text-disabled mb-1">
                          已隐藏 {workspaceHiddenCount} 个非文本文件或大型目录
                        </div>
                      )}
                      <div className="max-h-[320px] overflow-y-auto">
                        <FileTree
                          nodes={workspaceFiles}
                          onOpenFile={handleOpenFileFromTree}
                          workspacePath={workspacePath}
                          onRefreshWorkspace={refreshWorkspace}
                          onCloseWorkspace={closeWorkspace}
                        />
                      </div>
                    </div>
                  ) : (
                    <div className="text-caption text-gm-text-tertiary text-center py-4">
                      <button
                        type="button"
                        onClick={handleOpenFolder}
                        className="text-gm-primary hover:underline"
                      >
                        打开文件夹
                      </button>
                    </div>
                  )
                }
              />
            </>
          )}
        </div>
      </aside>
    </div>
  )
}

function FavoriteFileList({
  files,
  activeFilePath,
  onOpen,
}: {
  files: { name: string; path: string }[]
  activeFilePath?: string | null
  onOpen: (file: { name: string; path: string }) => void
}) {
  return (
    <div className="space-y-0.5 py-1">
      {files.map((file) => {
        const isActive = isSameFilePath(activeFilePath, file.path)
        return (
          <button
            key={file.path}
            type="button"
            onClick={() => onOpen(file)}
            className={`w-full flex items-center gap-1.5 px-2 py-1 rounded-lg text-caption text-left truncate ${
              isActive
                ? 'bg-gm-primary-subtle text-gm-text font-bold'
                : 'text-gm-text-secondary hover:text-gm-text hover:bg-gm-surface-hover'
            }`}
          >
            <span className="min-w-0 flex-1 truncate">{file.name}</span>
          </button>
        )
      })}
    </div>
  )
}
