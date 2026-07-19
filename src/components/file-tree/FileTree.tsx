import { useState, useCallback, useRef } from 'react'
import { useEditorStore } from '@/stores/editorStore'
import { createFile, createFolder, openFile } from '@/services/fileSystem'
import type { FileNode } from '@/services/fileTree'
import { isSameFilePath } from '@/services/pathIdentity'
import { addFileContextTag, summarizeFileWithAi } from '@/services/aiContext'
import { ContextMenu, ContextMenuGroupTitle, ContextMenuItem, ContextMenuSeparator } from '@/components/common/ContextMenu'
import { renameFileEntry, saveExistingFileAs, validateFileName } from '@/services/fileEntryActions'
import { describeFileOperationError } from '@/services/fileOperationErrors'
import { toast } from '@/services/toast'
import { Tooltip, TruncatedText } from '@/components/common/Tooltip'

interface FileTreeProps {
  nodes: FileNode[]
  onOpenFile?: (path: string) => void
  workspacePath?: string | null
  onRefreshWorkspace?: () => void
  onCloseWorkspace?: () => void
}

export function FileTree({ nodes, onOpenFile, workspacePath, onRefreshWorkspace, onCloseWorkspace }: FileTreeProps) {
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null)
  const [creating, setCreating] = useState<'file' | 'folder' | null>(null)
  const [newName, setNewName] = useState('')
  const createCancelledRef = useRef(false)
  const createSubmittingRef = useRef(false)

  const handleBlankContextMenu = useCallback((e: React.MouseEvent) => {
    if (!workspacePath) return
    const target = e.target as HTMLElement
    if (target.closest('[data-file-tree-node="true"]')) return
    e.preventDefault()
    setContextMenu({ x: e.clientX, y: e.clientY })
  }, [workspacePath])

  const startCreate = useCallback((type: 'file' | 'folder') => {
    createCancelledRef.current = false
    setCreating(type)
    setNewName(type === 'file' ? 'untitled.md' : '新建文件夹')
    setContextMenu(null)
  }, [])

  const commitCreate = useCallback(async () => {
    if (!workspacePath || !creating) return
    if (createCancelledRef.current) {
      createCancelledRef.current = false
      return
    }
    if (createSubmittingRef.current) return
    const name = newName.trim()
    const validationError = validateFileName(name)
    if (validationError) {
      toast.error(validationError)
      return
    }
    createSubmittingRef.current = true
    try {
      if (creating === 'file') {
        const path = await createFile(workspacePath, name)
        useEditorStore.getState().addTab(path, name, '')
      } else {
        await createFolder(workspacePath, name)
      }
      onRefreshWorkspace?.()
      createCancelledRef.current = true
      setCreating(null)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '创建失败')
    } finally {
      createSubmittingRef.current = false
    }
  }, [workspacePath, creating, newName, onRefreshWorkspace])

  return (
    <div className="py-1 min-h-[160px]" onContextMenu={handleBlankContextMenu}>
      {nodes.length === 0 ? (
        <EmptyState />
      ) : (
        nodes.map((node) => (
          <FileTreeNode key={node.path} node={node} depth={0} onOpenFile={onOpenFile} onRefreshWorkspace={onRefreshWorkspace} />
        ))
      )}
      {creating && (
        <div className="flex items-center gap-1.5 px-2 py-1 text-caption text-gm-text">
          <span className="w-3" />
          <input
            autoFocus
            value={newName}
            onFocus={(e) => e.currentTarget.select()}
            onChange={(e) => setNewName(e.target.value)}
            onBlur={() => { if (!createSubmittingRef.current) void commitCreate() }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); void commitCreate() }
              if (e.key === 'Escape') {
                createCancelledRef.current = true
                setCreating(null)
              }
            }}
            className="min-w-0 flex-1 rounded border border-gm-primary bg-gm-canvas px-1 py-0.5 text-caption outline-none"
          />
        </div>
      )}
      {contextMenu && (
        <ContextMenu position={contextMenu} onClose={() => setContextMenu(null)} minWidth={176} maxWidth={176}>
          <ContextMenuGroupTitle>新建</ContextMenuGroupTitle>
          <ContextMenuItem onClick={() => startCreate('file')}>新建文件</ContextMenuItem>
          <ContextMenuItem onClick={() => startCreate('folder')}>新建文件夹</ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuGroupTitle>工作区</ContextMenuGroupTitle>
          <ContextMenuItem onClick={() => { onRefreshWorkspace?.(); setContextMenu(null) }}>刷新工作区</ContextMenuItem>
          {onCloseWorkspace && (
            <ContextMenuItem onClick={() => { onCloseWorkspace(); setContextMenu(null) }}>关闭工作区</ContextMenuItem>
          )}
        </ContextMenu>
      )}
    </div>
  )
}

function EmptyState() {
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
      }
    } catch (err) {
      console.error('Open file failed:', err)
    }
  }, [])

  return (
    <div className="flex flex-col items-center justify-center py-6 px-4 text-center">
      <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="var(--gm-text-tertiary)" strokeWidth="1" className="mb-2 opacity-60">
        <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
      </svg>
      <p className="text-caption text-gm-text-tertiary">暂无文件</p>
      <button
        onClick={handleOpenFile}
        className="mt-2 text-micro text-gm-primary hover:underline"
      >
        打开文件
      </button>
    </div>
  )
}

function FileTreeNode({
  node,
  depth,
  onOpenFile,
  onRefreshWorkspace,
}: {
  node: FileNode
  depth: number
  onOpenFile?: (path: string) => void
  onRefreshWorkspace?: () => void
}) {
  const [expanded, setExpanded] = useState(depth === 0)
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null)
  const [renaming, setRenaming] = useState(false)
  const [renameValue, setRenameValue] = useState(node.name)
  const renameCancelledRef = useRef(false)
  const renameSubmittingRef = useRef(false)
  const activeTab = useEditorStore((s) => s.tabs.find((t) => t.id === s.activeTabId))
  const isActive = isSameFilePath(activeTab?.filePath, node.path)
  const isFile = node.type !== 'directory'

  const handleClick = useCallback(() => {
    if (node.type === 'directory') {
      setExpanded((prev) => !prev)
    } else {
      onOpenFile?.(node.path)
    }
  }, [node, onOpenFile])

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    if (!isFile) return
    e.preventDefault()
    setContextMenu({ x: e.clientX, y: e.clientY })
  }, [isFile])

  const handleAddToAi = useCallback(() => {
    addFileContextTag({ title: node.name, filePath: node.path })
    setContextMenu(null)
  }, [node])

  const handleSummarize = useCallback(() => {
    summarizeFileWithAi({ title: node.name, filePath: node.path })
    setContextMenu(null)
  }, [node])

  const handleSaveAs = useCallback(async () => {
    setContextMenu(null)
    try {
      await saveExistingFileAs(node.path)
      toast.success('已另存为')
    } catch (err) {
      toast.error(describeFileOperationError(err, '另存为失败'))
    }
  }, [node])

  const commitRename = useCallback(async () => {
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
      await renameFileEntry(node.path, renameValue)
      renameCancelledRef.current = true
      setRenaming(false)
      onRefreshWorkspace?.()
      toast.success('已重命名')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '重命名失败')
    } finally {
      renameSubmittingRef.current = false
    }
  }, [node.path, renameValue, onRefreshWorkspace])

  const handleDragStart = useCallback((e: React.DragEvent) => {
    const mime = isFile ? 'application/x-guanmo-file' : 'application/x-guanmo-folder'
    e.dataTransfer.setData(mime, JSON.stringify({ name: node.name, path: node.path }))
    e.dataTransfer.setData('text/plain', node.path)
    e.dataTransfer.effectAllowed = 'copy'
  }, [node, isFile])

  return (
    <div>
      <button
        data-file-tree-node="true"
        draggable
        onClick={handleClick}
        onContextMenu={handleContextMenu}
        onDragStart={handleDragStart}
        className={`w-full flex items-center gap-1.5 px-2 py-1 rounded-lg text-caption text-left truncate ${
          isActive
            ? 'bg-gm-primary-subtle text-gm-text font-bold'
            : 'text-gm-text-secondary hover:text-gm-text hover:bg-gm-surface-hover'
        }`}
        style={{ paddingLeft: `${8 + depth * 12}px` }}
      >
        {/* Expand/Collapse Arrow */}
        {node.type === 'directory' && (
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            className={`flex-shrink-0 transition-transform duration-200 ${expanded ? 'rotate-90' : ''}`}
          >
            <path d="M9 18l6-6-6-6" />
          </svg>
        )}

        {/* Name */}
        {renaming ? (
          <input
            autoFocus
            value={renameValue}
            onClick={(e) => e.stopPropagation()}
            onFocus={(e) => e.currentTarget.select()}
            onChange={(e) => setRenameValue(e.target.value)}
            onBlur={() => { if (!renameSubmittingRef.current) void commitRename() }}
            onKeyDown={(e) => {
              e.stopPropagation()
              if (e.key === 'Enter') { e.preventDefault(); void commitRename() }
              if (e.key === 'Escape') {
                renameCancelledRef.current = true
                setRenaming(false)
              }
            }}
            className="min-w-0 flex-1 rounded border border-gm-primary bg-gm-canvas px-1 py-0.5 text-caption outline-none"
          />
        ) : (
          <TruncatedText text={node.name} className="flex-1" />
        )}
      </button>

      {/* Context Menu */}
      {contextMenu && (
        <ContextMenu position={contextMenu} onClose={() => setContextMenu(null)} minWidth={176} maxWidth={176}>
          <ContextMenuGroupTitle variant="strong">文件操作</ContextMenuGroupTitle>
          <ContextMenuItem onClick={() => { renameCancelledRef.current = false; setRenaming(true); setRenameValue(node.name); setContextMenu(null) }}>重命名</ContextMenuItem>
          <ContextMenuItem onClick={handleSaveAs}>另存为</ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuGroupTitle variant="strong">AI 助手</ContextMenuGroupTitle>
          <ContextMenuItem onClick={handleSummarize}>AI 总结该文件</ContextMenuItem>
          <ContextMenuItem onClick={handleAddToAi}>添加文件到 AI 上下文</ContextMenuItem>
        </ContextMenu>
      )}

      {/* Children */}
      {node.type === 'directory' && expanded && node.children && (
        <div>
          {node.children.map((child) => (
            <FileTreeNode key={child.path} node={child} depth={depth + 1} onOpenFile={onOpenFile} onRefreshWorkspace={onRefreshWorkspace} />
          ))}
        </div>
      )}
    </div>
  )
}

export function RecentFiles({ files, onOpen, onRefreshWorkspace }: {
  files: { name: string; path: string }[]
  onOpen?: (file: { name: string; path: string }) => void
  onRefreshWorkspace?: () => void
}) {
  const tabs = useEditorStore((s) => s.tabs)
  const activeTabId = useEditorStore((s) => s.activeTabId)
  const setActiveTab = useEditorStore((s) => s.setActiveTab)
  const addTab = useEditorStore((s) => s.addTab)
  const removeRecentFile = useEditorStore((s) => s.removeRecentFile)
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; file: { name: string; path: string } } | null>(null)
  const [renamingPath, setRenamingPath] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const renameCancelledRef = useRef(false)
  const renameSubmittingRef = useRef(false)

  const handleOpen = useCallback(
    (file: { name: string; path: string }) => {
      if (onOpen) {
        onOpen(file)
        return
      }
      const existing = tabs.find((t) => isSameFilePath(t.filePath, file.path))
      if (existing) {
        setActiveTab(existing.id)
      } else {
        addTab(file.path, file.name, '')
      }
    },
    [addTab, onOpen, setActiveTab, tabs]
  )

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

  if (files.length === 0) {
    return (
      <div className="text-caption text-gm-text-tertiary text-center py-4">
        暂无最近文件
      </div>
    )
  }

  return (
    <div className="space-y-0.5 py-1">
      {files.map((file) => {
        const isActive = isSameFilePath(tabs.find((t) => t.id === activeTabId)?.filePath, file.path)
        return (
          <button
            key={file.path}
            onClick={() => handleOpen(file)}
            onContextMenu={(e) => {
              e.preventDefault()
              setContextMenu({ x: e.clientX, y: e.clientY, file })
            }}
            className={`group w-full flex items-center gap-1.5 px-2 py-1 rounded-lg text-caption text-left truncate ${
              isActive
                ? 'bg-gm-primary-subtle text-gm-text font-bold'
                : 'text-gm-text-secondary hover:text-gm-text hover:bg-gm-surface-hover'
            }`}
          >
            {renamingPath === file.path ? (
              <input
                autoFocus
                value={renameValue}
                onClick={(e) => e.stopPropagation()}
                onFocus={(e) => e.currentTarget.select()}
                onChange={(e) => setRenameValue(e.target.value)}
                onBlur={() => { if (!renameSubmittingRef.current) void commitRename(file) }}
                onKeyDown={(e) => {
                  e.stopPropagation()
                  if (e.key === 'Enter') { e.preventDefault(); void commitRename(file) }
                  if (e.key === 'Escape') {
                    renameCancelledRef.current = true
                    setRenamingPath(null)
                  }
                }}
                className="min-w-0 flex-1 rounded border border-gm-primary bg-gm-canvas px-1 py-0.5 outline-none"
              />
            ) : (
              <TruncatedText text={file.name} className="flex-1" />
            )}
            <Tooltip content="删除最近记录" className="ml-auto flex-shrink-0">
              <span
                onClick={(e) => {
                  e.stopPropagation()
                  removeRecentFile(file.path)
                }}
                className="block rounded-full p-0.5 opacity-0 transition-opacity hover:bg-gm-surface-overlay group-hover:opacity-100"
              >
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M18 6L6 18M6 6l12 12" />
                </svg>
              </span>
            </Tooltip>
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
            } catch (err) {
              toast.error(describeFileOperationError(err, '另存为失败'))
            }
          }}>另存为</ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuGroupTitle variant="strong">AI 助手</ContextMenuGroupTitle>
          <ContextMenuItem onClick={() => { addFileContextTag({ title: contextMenu.file.name, filePath: contextMenu.file.path }); setContextMenu(null) }}>添加文件到 AI 上下文</ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuGroupTitle variant="strong">复制与索引</ContextMenuGroupTitle>
          <ContextMenuItem onClick={() => { navigator.clipboard.writeText(contextMenu.file.path); setContextMenu(null) }}>复制路径</ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuGroupTitle variant="strong">列表管理</ContextMenuGroupTitle>
          <ContextMenuItem onClick={() => { removeRecentFile(contextMenu.file.path); setContextMenu(null) }}>从最近文件移除</ContextMenuItem>
        </ContextMenu>
      )}
    </div>
  )
}
