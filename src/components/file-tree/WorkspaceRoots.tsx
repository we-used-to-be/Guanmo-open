import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { FileTree } from '@/components/file-tree/FileTree'
import { isTauri } from '@/hooks/useTauri'
import { useWorkspaceFileTree } from '@/hooks/useWorkspaceFileTree'
import { pickDirectory } from '@/services/fileSystem'
import { indexWorkspaceDocuments } from '@/services/workspaceIndex'
import { toast } from '@/services/toast'
import { getRuntimeCapabilities } from '@/services/runtimeCapabilities'
import type { FileNode } from '@/services/fileTree'
import { TreeCollapse } from './TreeCollapse'

interface WorkspaceRootsProps {
  onOpenFile: (path: string) => void
}

interface WorkspaceSearchResult {
  name: string
  path: string
  rootName: string
  directory: string
}

function collectWorkspaceFiles(
  nodes: FileNode[],
  rootName: string,
  directories: string[] = [],
): WorkspaceSearchResult[] {
  return nodes.flatMap((node) => {
    if (node.type === 'directory') {
      return collectWorkspaceFiles(node.children ?? [], rootName, [...directories, node.name])
    }
    return [{
      name: node.name,
      path: node.path,
      rootName,
      directory: directories.join(' / '),
    }]
  })
}

function SearchIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-4-4" />
    </svg>
  )
}

function CloseIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
      <path d="m6 6 12 12M18 6 6 18" />
    </svg>
  )
}

function PlusIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
      <path d="M12 5v14M5 12h14" />
    </svg>
  )
}

export function WorkspaceRoots({ onOpenFile }: WorkspaceRootsProps) {
  const {
    workspaceRoots,
    workspaceTrees,
    addWorkspaceRoot,
    removeWorkspace,
    refreshWorkspaceRoot,
  } = useWorkspaceFileTree()
  const [collapsedRootIds, setCollapsedRootIds] = useState<Set<string>>(() => new Set())
  const [workingRootId, setWorkingRootId] = useState<string | null>(null)
  const [rootSummaries, setRootSummaries] = useState<Record<string, string>>({})
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [searchPanelHeight, setSearchPanelHeight] = useState<number | null>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const reducedMotion = useReducedMotion() ?? false
  const browserFileSystem = getRuntimeCapabilities().browserFileSystem

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(searchQuery), 250)
    return () => window.clearTimeout(timer)
  }, [searchQuery])

  const workspaceFiles = useMemo(() => (
    workspaceRoots.flatMap((root) => collectWorkspaceFiles(workspaceTrees[root.id]?.nodes ?? [], root.name))
  ), [workspaceRoots, workspaceTrees])

  const searchResults = useMemo(() => {
    const query = debouncedQuery.trim().toLocaleLowerCase()
    if (!query) return []
    return workspaceFiles.filter((file) => file.name.toLocaleLowerCase().includes(query))
  }, [debouncedQuery, workspaceFiles])

  const workspaceLoading = workspaceRoots.some((root) => {
    const tree = workspaceTrees[root.id]
    return !tree || (tree.loading && !tree.nodes.length)
  })
  const workspaceHasError = workspaceRoots.some((root) => Boolean(workspaceTrees[root.id]?.error))

  const openSearch = useCallback(() => {
    if (searchOpen) return
    const measuredHeight = panelRef.current?.getBoundingClientRect().height ?? 0
    setSearchPanelHeight(measuredHeight > 0 ? measuredHeight : null)
    setSearchOpen(true)
  }, [searchOpen])

  const closeSearch = useCallback(() => {
    setSearchOpen(false)
    setSearchQuery('')
    setDebouncedQuery('')
  }, [])

  const handleAddWorkspace = useCallback(async () => {
    if (!isTauri() && !getRuntimeCapabilities().browserFileSystem) {
      toast.error('当前浏览器不支持目录工作区，请使用 Chrome 或 Edge')
      return
    }
    try {
      const path = await pickDirectory()
      if (!path) return
      if (!addWorkspaceRoot(path)) {
        toast.error('该文件夹已在工作区中')
        return
      }
      toast.success('已添加工作区')
    } catch (error) {
      console.error('Add workspace failed:', error)
      toast.error('添加工作区失败')
    }
  }, [addWorkspaceRoot])

  const setSummary = useCallback((rootId: string, summary: string | null) => {
    setRootSummaries((current) => {
      if (summary === null) {
        const next = { ...current }
        delete next[rootId]
        return next
      }
      return { ...current, [rootId]: summary }
    })
  }, [])

  const handleIndex = useCallback(async (rootId: string, rootPath: string) => {
    if (!getRuntimeCapabilities().database) {
      toast.error('网页版不提供知识库索引')
      return
    }
    if (workingRootId) return
    setWorkingRootId(rootId)
    setSummary(rootId, null)
    try {
      const result = await indexWorkspaceDocuments(rootPath)
      let summary = `已索引 ${result.indexed}`
      if (result.failed > 0) summary += `，失败 ${result.failed}`
      if (result.errors.length > 0) summary += `\n${result.errors.join('\n')}`
      setSummary(rootId, summary)
    } catch (error) {
      setSummary(rootId, error instanceof Error ? error.message : '索引失败')
    } finally {
      setWorkingRootId(null)
    }
  }, [setSummary, workingRootId])

  const handleRemove = useCallback((rootId: string) => {
    removeWorkspace(rootId)
    setSummary(rootId, null)
    toast.success('已移除工作区，本地文件未删除')
  }, [removeWorkspace, setSummary])

  return (
    <div
      ref={panelRef}
      className="relative overflow-hidden"
      style={searchPanelHeight !== null ? { height: searchPanelHeight } : undefined}
    >
      <AnimatePresence
        initial={false}
        mode="sync"
        onExitComplete={() => {
          if (!searchOpen) setSearchPanelHeight(null)
        }}
      >
        {searchOpen ? (
          <motion.div
            key="workspace-search"
            className="absolute inset-0 flex min-h-0 flex-col bg-gm-surface"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={reducedMotion ? { duration: 0 } : { duration: 0.18, ease: 'easeOut' }}
          >
            <div className="flex h-6 items-center gap-0.5 px-1">
              <div className="flex h-6 min-w-0 flex-1 items-center rounded-md border border-gm-border bg-gm-canvas px-2">
                <input
                  autoFocus
                  type="text"
                  role="searchbox"
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                  placeholder="搜索工作区文件"
                  aria-label="搜索工作区文件"
                  className="h-full min-w-0 flex-1 bg-transparent py-0 text-caption text-gm-text !outline-none placeholder:text-gm-text-disabled"
                />
              </div>
              <span
                aria-hidden="true"
                className="flex h-6 w-6 shrink-0 items-center justify-center text-gm-text-tertiary"
              >
                <SearchIcon />
              </span>
              <button
                type="button"
                aria-label="退出搜索"
                title="退出搜索"
                onClick={closeSearch}
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-gm-text-tertiary transition-colors hover:bg-gm-surface-hover/70 hover:text-gm-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-gm-primary/40"
              >
                <CloseIcon />
              </button>
            </div>
            <div className="mt-2 min-h-0 flex-1 overflow-y-auto px-1">
              {!debouncedQuery.trim() ? (
                <div className="py-6 text-center text-caption text-gm-text-tertiary">输入文件名以搜索工作区</div>
              ) : workspaceLoading ? (
                <div className="py-6 text-center text-caption text-gm-text-tertiary">正在读取工作区…</div>
              ) : searchResults.length === 0 && workspaceHasError ? (
                <div className="py-6 text-center text-caption text-gm-text-tertiary">部分工作区读取失败，结果可能不完整</div>
              ) : searchResults.length === 0 ? (
                <div className="py-6 text-center text-caption text-gm-text-tertiary">未找到匹配文件</div>
              ) : (
                <div className="space-y-0.5">
                  {searchResults.map((result) => (
                    <button
                      key={result.path}
                      type="button"
                      onClick={() => onOpenFile(result.path)}
                      className="flex w-full min-w-0 flex-col rounded-md px-2 py-1.5 text-left hover:bg-gm-surface-hover"
                    >
                      <span className="truncate text-caption text-gm-text">{result.name}</span>
                      <span className="truncate text-micro text-gm-text-tertiary">
                        {result.rootName}{result.directory ? ` / ${result.directory}` : ''}
                      </span>
                    </button>
                  ))}
                </div>
              )}
              {workspaceHasError && (searchResults.length > 0 || !debouncedQuery.trim()) && (
                <p className="px-2 py-2 text-center text-micro text-gm-text-disabled">部分工作区读取失败，结果可能不完整</p>
              )}
            </div>
          </motion.div>
        ) : (
          <motion.div
            key="workspace-content"
            className="space-y-2"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={reducedMotion ? { duration: 0 } : { duration: 0.18, ease: 'easeOut' }}
          >
            <div className="flex h-6 items-center justify-between gap-2 px-1">
              <div className="flex min-w-0 items-center gap-0.5">
                <span className="text-micro text-gm-text-tertiary">{workspaceRoots.length} 个文件夹</span>
              </div>
              <div className="flex items-center gap-0.5">
                <button
                  type="button"
                  aria-label="搜索工作区"
                  title="搜索工作区"
                  onClick={openSearch}
                  className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-gm-text-tertiary transition-colors hover:bg-gm-surface-hover/70 hover:text-gm-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-gm-primary/40"
                >
                  <SearchIcon />
                </button>
                <button
                  type="button"
                  aria-label="添加文件夹"
                  title={!isTauri() && !browserFileSystem ? '当前浏览器不支持目录工作区' : '添加文件夹'}
                  onClick={handleAddWorkspace}
                  disabled={!isTauri() && !browserFileSystem}
                  className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-gm-text-tertiary transition-colors hover:bg-gm-surface-hover/70 hover:text-gm-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-gm-primary/40 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <PlusIcon />
                </button>
              </div>
            </div>
            {workspaceRoots.length === 0 ? (
              <div className="text-caption text-gm-text-tertiary text-center py-4">
                <p>尚未添加工作区</p>
                <p className="mt-1 text-gm-text-disabled">仍可正常打开单个 Markdown 文件</p>
              </div>
            ) : workspaceRoots.map((root, index) => {
              const tree = workspaceTrees[root.id]
              const expanded = !collapsedRootIds.has(root.id)
              const working = workingRootId === root.id
              return (
                <section
                  key={root.id}
                  className={`px-1.5 py-2 ${index > 0 ? 'border-t border-gm-border-subtle' : ''}`}
                >
                  <div className="flex min-w-0 items-center gap-1">
                    <button
                      type="button"
                      aria-expanded={expanded}
                      aria-label={`${expanded ? '折叠' : '展开'} ${root.name}`}
                      onClick={() => setCollapsedRootIds((current) => {
                        const next = new Set(current)
                        if (next.has(root.id)) next.delete(root.id)
                        else next.add(root.id)
                        return next
                      })}
                      className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-1 py-1 text-left text-gm-text-secondary hover:bg-gm-surface-hover hover:text-gm-text"
                      title={root.path}
                    >
                      <svg
                        width="12"
                        height="12"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        className={`shrink-0 ${reducedMotion ? '' : 'transition-transform duration-200'} ${expanded ? 'rotate-90' : ''}`}
                      >
                        <path d="M9 18l6-6-6-6" />
                      </svg>
                      <span className="min-w-0 flex-1 truncate text-caption font-bold">
                        {root.name}
                      </span>
                    </button>
                    <button
                      type="button"
                      disabled={!getRuntimeCapabilities().database || Boolean(workingRootId)}
                      title={!getRuntimeCapabilities().database ? '知识库索引仅桌面版可用' : undefined}
                      onClick={() => void handleIndex(root.id, root.path)}
                      className="text-micro text-gm-text-tertiary hover:text-gm-text disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {working ? '索引中…' : '索引'}
                    </button>
                    <button
                      type="button"
                      onClick={() => void refreshWorkspaceRoot(root.id)}
                      className="text-micro text-gm-text-tertiary hover:text-gm-text"
                    >
                      刷新
                    </button>
                    <button
                      type="button"
                      onClick={() => handleRemove(root.id)}
                      className="text-micro text-gm-text-tertiary hover:text-gm-error"
                      title="仅移除工作区记录，不删除本地文件"
                    >
                      移除
                    </button>
                  </div>
                  <TreeCollapse open={expanded} reducedMotion={reducedMotion} className="pt-1">
                      {rootSummaries[root.id] && (
                        <div className="mb-1 rounded-lg border border-gm-border bg-gm-surface-elevated px-2 py-1.5 text-micro text-gm-text-tertiary break-words whitespace-pre-line">
                          {rootSummaries[root.id]}
                        </div>
                      )}
                      {tree?.error ? (
                        <div className="rounded-lg border border-gm-error/30 bg-gm-error/5 px-2 py-2 text-micro text-gm-text-tertiary">
                          <p className="break-words">{tree.error}</p>
                          <button type="button" className="mt-1 text-gm-primary hover:underline" onClick={() => void refreshWorkspaceRoot(root.id)}>重试</button>
                        </div>
                      ) : tree?.loading && !tree.nodes.length ? (
                        <div className="py-3 text-center text-micro text-gm-text-disabled">正在读取…</div>
                      ) : (
                        <FileTree
                          nodes={tree?.nodes ?? []}
                          onOpenFile={onOpenFile}
                          workspacePath={root.path}
                          onRefreshWorkspace={() => void refreshWorkspaceRoot(root.id)}
                          onCloseWorkspace={() => handleRemove(root.id)}
                        />
                      )}
                  </TreeCollapse>
                </section>
              )
            })}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
