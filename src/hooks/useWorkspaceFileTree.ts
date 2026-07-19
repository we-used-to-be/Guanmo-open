import { useCallback, useEffect, useState } from 'react'
import { joinPath } from '@/hooks/useTauri'
import { listDirectory } from '@/services/fileSystem'
import { isWorkspaceDisplayFile, shouldSkipWorkspaceDirectory, type FileNode } from '@/services/fileTree'
import { toast } from '@/services/toast'
import { recoverRememberedWorkspace } from '@/services/persistedFileAccess'
import { useAppStore } from '@/stores/appStore'

export function useWorkspaceFileTree() {
  const workspacePath = useAppStore((s) => s.workspacePath)
  const setWorkspacePath = useAppStore((s) => s.setWorkspacePath)
  const [workspaceFiles, setWorkspaceFiles] = useState<FileNode[]>([])
  const [workspaceHiddenCount, setWorkspaceHiddenCount] = useState(0)

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
      const { nodes, hidden } = await recoverRememberedWorkspace(
        dirPath,
        () => readDirRecursive(dirPath, 0)
      )
      setWorkspaceHiddenCount(hidden)
      setWorkspaceFiles(nodes)
    } catch (err) {
      console.error('Load workspace failed:', err)
      const message = err instanceof Error ? err.message : String(err)
      toast.error(message || '工作区加载失败')
      if (!message.includes('重新授权已取消') && !message.includes('请选择原工作区')) {
        setWorkspacePath(null)
      }
      setWorkspaceFiles([])
      setWorkspaceHiddenCount(0)
    }
  }, [readDirRecursive, setWorkspacePath])

  const refreshWorkspace = useCallback(async () => {
    if (!workspacePath) return
    await loadWorkspace(workspacePath)
  }, [loadWorkspace, workspacePath])

  const closeWorkspace = useCallback(() => {
    setWorkspaceFiles([])
    setWorkspacePath(null)
    setWorkspaceHiddenCount(0)
  }, [setWorkspacePath])

  useEffect(() => {
    if (workspacePath) {
      void loadWorkspace(workspacePath)
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

  return {
    workspacePath,
    workspaceFiles,
    workspaceHiddenCount,
    loadWorkspace,
    refreshWorkspace,
    closeWorkspace,
  }
}
