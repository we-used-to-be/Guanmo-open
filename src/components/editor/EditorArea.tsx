import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { EditorView } from '@codemirror/view'
import { Card } from 'animal-island-ui'
import { useAppStore } from '@/stores/appStore'
import { useEditorStore } from '@/stores/editorStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { useFileOperations } from '@/hooks/useFileOperations'
import { saveFile } from '@/services/fileSystem'
import { indexMarkdownDocument } from '@/services/rag/indexer'
import { extractToc, type TocItem } from '@/services/markdownToc'
import { toggleMarkdownTaskAtLine } from '@/services/markdownTasks'
import { saveExternalImageForMarkdown, saveImageFileForMarkdown } from '@/services/markdownImages'
import { toast } from '@/services/toast'
import { describeFileOperationError } from '@/services/fileOperationErrors'
import { openFileDialog } from '@/hooks/useTauri'
import { CodeMirrorEditor } from './CodeMirrorEditor'
import { EditorContextMenu } from './EditorContextMenu'
import { MarkdownDiffView } from './MarkdownDiffView'
import { MarkdownPreview, MarkdownToc } from './MarkdownPreview'
import { SearchOverlay } from './SearchOverlay'
import { TabBar } from './TabBar'
import { ContextMenu, ContextMenuGroupTitle, ContextMenuItem } from '@/components/common/ContextMenu'

interface PreviewMenuState {
  x: number
  y: number
  selectedText: string
  pane: 'left' | 'right'
}

const PREVIEW_CONTEXT_HIGHLIGHT = 'preview-context-selection'
const DROP_IMAGES_EVENT = 'guanmo:drop-image-paths'

export function EditorArea() {
  const { tabs, activeTabId, updateTabContent, viewMode, setViewMode, rightPaneTabId, setRightPaneTabId } = useEditorStore()
  const editorFontSize = useSettingsStore((s) => s.editor.fontSize)
  const editorLineHeight = useSettingsStore((s) => s.editor.lineHeight)
  const editorViewRef = useRef<EditorView | null>(null)
  const leftPreviewRef = useRef<HTMLDivElement>(null)
  const rightPreviewRef = useRef<HTMLDivElement>(null)
  const [searchOpen, setSearchOpen] = useState(false)
  const [rightPaneDragOver, setRightPaneDragOver] = useState(false)
  const [tocCollapsed, setTocCollapsed] = useState(false)
  const [previewMenu, setPreviewMenu] = useState<PreviewMenuState | null>(null)

  const activeTab = tabs.find((t) => t.id === activeTabId)
  const rightTab = rightPaneTabId ? tabs.find((t) => t.id === rightPaneTabId) : null
  const toc = useMemo(() => extractToc(activeTab?.content || ''), [activeTab?.content])

  const clearPreviewContextHighlight = useCallback(() => {
    if (typeof CSS !== 'undefined' && CSS.highlights) {
      CSS.highlights.delete(PREVIEW_CONTEXT_HIGHLIGHT)
    }
  }, [])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f' && !e.altKey) {
        setSearchOpen(true)
      }
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [])

  // Ctrl + 滚轮快捷调节字号
  useEffect(() => {
    const handler = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return
      e.preventDefault()
      const delta = e.deltaY < 0 ? 1 : -1
      const current = useSettingsStore.getState().editor.fontSize
      const next = Math.max(10, Math.min(24, current + delta))
      if (next !== current) {
        useSettingsStore.getState().updateEditorSettings({ fontSize: next })
      }
    }
    window.addEventListener('wheel', handler, { passive: false, capture: true })
    return () => window.removeEventListener('wheel', handler, { capture: true })
  }, [])

  useEffect(() => clearPreviewContextHighlight, [clearPreviewContextHighlight])

  const handleEditorChange = useCallback(
    (content: string) => {
      if (activeTabId) updateTabContent(activeTabId, content)
    },
    [activeTabId, updateTabContent]
  )

  const handleSave = useCallback(async () => {
    if (!activeTab) return
    try {
      if (activeTab.filePath) {
        await saveFile(activeTab.filePath, activeTab.content)
        indexMarkdownDocument(activeTab.filePath, activeTab.title, activeTab.content)
        useEditorStore.setState((s) => ({
          tabs: s.tabs.map((t) =>
            t.id === activeTab.id ? { ...t, savedContent: activeTab.content, modified: false } : t
          ),
        }))
        toast.success('已保存')
      } else {
        const { saveFileAs } = await import('@/services/fileSystem')
        const result = await saveFileAs(activeTab.content)
        if (result) {
          indexMarkdownDocument(result.path, result.name, result.content)
          useEditorStore.setState((s) => ({
            tabs: s.tabs.map((t) =>
              t.id === activeTab.id
                ? { ...t, filePath: result.path, title: result.name, savedContent: result.content, modified: false }
                : t
            ),
          }))
          toast.success('已保存')
        }
      }
    } catch (err) {
      console.error('Save failed:', err)
      toast.error(describeFileOperationError(err, '保存失败'))
    }
  }, [activeTab])

  const persistTabContent = useCallback(async (tabId: string, nextContent: string) => {
    const targetTab = useEditorStore.getState().tabs.find((tab) => tab.id === tabId)
    if (!targetTab) return

    updateTabContent(tabId, nextContent)

    if (!targetTab.filePath) return

    try {
      await saveFile(targetTab.filePath, nextContent)
      indexMarkdownDocument(targetTab.filePath, targetTab.title, nextContent)
      useEditorStore.setState((state) => ({
        tabs: state.tabs.map((tab) =>
          tab.id === tabId
            ? { ...tab, content: nextContent, savedContent: nextContent, modified: false }
            : tab
        ),
      }))
    } catch (err) {
      console.error('Auto-save markdown task failed:', err)
      toast.error(describeFileOperationError(err, '任务勾选保存失败'))
    }
  }, [updateTabContent])

  const handleTaskToggle = useCallback(async (tabId: string, content: string, line: number, checked: boolean) => {
    const nextContent = toggleMarkdownTaskAtLine(content, line, checked)
    if (!nextContent || nextContent === content) return
    await persistTabContent(tabId, nextContent)
  }, [persistTabContent])

  const jumpToLine = useCallback((line: number) => {
    const view = editorViewRef.current
    if (!view || line < 1 || line > view.state.doc.lines) return
    const pos = view.state.doc.line(line).from
    view.dispatch({
      selection: { anchor: pos },
      effects: EditorView.scrollIntoView(pos, { y: 'start' }),
    })
    view.focus()
  }, [])

  const jumpToEditorHeading = useCallback((item: TocItem) => {
    jumpToLine(item.line)
  }, [jumpToLine])

  const insertMarkdownAtCursor = useCallback((markdown: string, insertAt?: number) => {
    const view = editorViewRef.current
    if (!view || !activeTabId) return false
    const selection = view.state.selection.main
    const from = typeof insertAt === 'number' ? insertAt : selection.from
    const to = typeof insertAt === 'number' ? insertAt : selection.to
    view.dispatch({
      changes: { from, to, insert: markdown },
      selection: { anchor: from + markdown.length },
      scrollIntoView: true,
    })
    view.focus()
    return true
  }, [activeTabId])

  const handleChooseImage = useCallback(async () => {
    if (!activeTab) return
    if (!activeTab.filePath) {
      toast.info('请先保存当前 Markdown 文件，再插入图片')
      return
    }

    try {
      const selected = await openFileDialog([
        { name: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'] },
      ])
      const imagePath = Array.isArray(selected) ? selected[0] : selected
      if (!imagePath) return

      const relativePath = await saveExternalImageForMarkdown(activeTab.filePath, imagePath)
      if (insertMarkdownAtCursor(`![图片描述](${relativePath})`)) {
        toast.success('图片已插入')
      }
    } catch (err) {
      console.error('Insert image failed:', err)
      toast.error(describeFileOperationError(err, '插入图片失败'))
    }
  }, [activeTab, insertMarkdownAtCursor])

  const handleInsertImageFiles = useCallback(async (files: File[], insertAt?: number) => {
    if (!activeTab) return
    if (!activeTab.filePath) {
      toast.info('请先保存当前 Markdown 文件，再插入图片')
      return
    }

    try {
      const snippets: string[] = []
      for (const file of files) {
        const relativePath = await saveImageFileForMarkdown(activeTab.filePath, file)
        snippets.push(`![图片描述](${relativePath})`)
      }
      if (snippets.length > 0 && insertMarkdownAtCursor(snippets.join('\n'), insertAt)) {
        toast.success(snippets.length > 1 ? `已插入 ${snippets.length} 张图片` : '图片已插入')
      }
    } catch (err) {
      console.error('Insert dropped/pasted image failed:', err)
      toast.error(describeFileOperationError(err, '插入图片失败'))
    }
  }, [activeTab, insertMarkdownAtCursor])

  const handleInsertImagePaths = useCallback(async (paths: string[]) => {
    if (!activeTab) return
    if (!activeTab.filePath) {
      toast.info('请先保存当前 Markdown 文件，再插入图片')
      return
    }

    try {
      const snippets: string[] = []
      for (const path of paths) {
        const relativePath = await saveExternalImageForMarkdown(activeTab.filePath, path)
        snippets.push(`![图片描述](${relativePath})`)
      }
      if (snippets.length > 0 && insertMarkdownAtCursor(snippets.join('\n'))) {
        toast.success(snippets.length > 1 ? `已插入 ${snippets.length} 张图片` : '图片已插入')
      }
    } catch (err) {
      console.error('Insert dragged image path failed:', err)
      toast.error(describeFileOperationError(err, '插入图片失败'))
    }
  }, [activeTab, insertMarkdownAtCursor])

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ paths?: string[] }>).detail
      if (detail?.paths?.length) {
        void handleInsertImagePaths(detail.paths)
      }
    }
    window.addEventListener(DROP_IMAGES_EVENT, handler)
    return () => window.removeEventListener(DROP_IMAGES_EVENT, handler)
  }, [handleInsertImagePaths])

  const jumpToPreviewHeading = useCallback((item: TocItem) => {
    const container = leftPreviewRef.current
    const heading = container?.querySelector<HTMLElement>(`[data-md-line="${item.line}"]`)
    if (!container || !heading) return
    const targetTop = heading.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop - 24
    container.scrollTo({ top: Math.max(0, targetTop), behavior: 'smooth' })
  }, [])

  const handlePreviewContextMenu = useCallback((
    e: React.MouseEvent<HTMLDivElement>,
    pane: 'left' | 'right'
  ) => {
    e.preventDefault()
    const container = pane === 'left' ? leftPreviewRef.current : rightPreviewRef.current
    const selection = window.getSelection()
    const selectedText = container && selection && selection.rangeCount > 0
      && container.contains(selection.anchorNode) && container.contains(selection.focusNode)
      ? selection.toString()
      : ''
    clearPreviewContextHighlight()
    if (selectedText && selection && typeof CSS !== 'undefined' && CSS.highlights) {
      CSS.highlights.set(PREVIEW_CONTEXT_HIGHLIGHT, new Highlight(selection.getRangeAt(0).cloneRange()))
    }
    setPreviewMenu({ x: e.clientX, y: e.clientY, selectedText, pane })
  }, [clearPreviewContextHighlight])

  const handleCopyPreviewSelection = useCallback(() => {
    if (previewMenu?.selectedText) {
      void navigator.clipboard.writeText(previewMenu.selectedText)
    }
    clearPreviewContextHighlight()
    setPreviewMenu(null)
  }, [clearPreviewContextHighlight, previewMenu])

  const handleSelectAllPreview = useCallback(() => {
    const container = previewMenu?.pane === 'right' ? rightPreviewRef.current : leftPreviewRef.current
    if (!container) return
    const selection = window.getSelection()
    const range = document.createRange()
    range.selectNodeContents(container)
    selection?.removeAllRanges()
    selection?.addRange(range)
    clearPreviewContextHighlight()
    setPreviewMenu(null)
  }, [clearPreviewContextHighlight, previewMenu])

  // Drag & drop for dual-preview right pane
  const handleRightPaneDragOver = useCallback((e: React.DragEvent) => {
    const hasTab = e.dataTransfer.types.includes('application/x-guanmo-tab')
    if (hasTab) {
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
      setRightPaneDragOver(true)
    }
  }, [])

  const handleRightPaneDragLeave = useCallback(() => {
    setRightPaneDragOver(false)
  }, [])

  const handleRightPaneDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setRightPaneDragOver(false)
    const tabData = e.dataTransfer.getData('application/x-guanmo-tab')
    let tabId: string | undefined
    try {
      tabId = tabData ? JSON.parse(tabData).tabId as string | undefined : undefined
    } catch {
      tabId = undefined
    }
    if (tabId) {
      setRightPaneTabId(tabId)
      if (viewMode !== 'dual-preview') {
        setViewMode('dual-preview')
      }
    }
  }, [setRightPaneTabId, viewMode, setViewMode])

  const getSearchProps = () => {
    if (viewMode === 'edit' || viewMode === 'edit-preview') return { editorViewRef }
    const panes: React.RefObject<HTMLDivElement>[] = []
    if (leftPreviewRef.current) panes.push(leftPreviewRef)
    if (rightPreviewRef.current) panes.push(rightPreviewRef)
    return { previewPanes: panes }
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-gm-canvas">
      <TabBar />

      <div className="flex-1 flex overflow-hidden relative">
        {tabs.length === 0 ? (
          <WelcomeScreen />
        ) : viewMode === 'diff-preview' ? (
          activeTab?.filePath ? (
            <MarkdownDiffView original={activeTab.savedContent} current={activeTab.content} />
          ) : (
            <div className="flex h-full flex-1 items-center justify-center text-caption text-gm-text-tertiary">
              新文件尚未保存，无法与磁盘内容对比。
            </div>
          )
        ) : viewMode === 'preview' ? (
          <div className="flex flex-1 overflow-hidden bg-gm-surface">
            <div
              ref={leftPreviewRef}
              className="flex-1 overflow-auto p-6 select-text"
              onContextMenu={(e) => handlePreviewContextMenu(e, 'left')}
            >
              <MarkdownPreview
                content={activeTab?.content || ''}
                filePath={activeTab?.filePath}
                fontSize={editorFontSize}
                lineHeight={editorLineHeight}
                onTaskToggle={
                  activeTab
                    ? (line, checked) => void handleTaskToggle(activeTab.id, activeTab.content, line, checked)
                    : undefined
                }
              />
            </div>
            <MarkdownToc
              toc={toc}
              collapsed={tocCollapsed}
              onToggle={() => setTocCollapsed((collapsed) => !collapsed)}
              onHeadingClick={jumpToPreviewHeading}
            />
          </div>
        ) : viewMode === 'dual-preview' ? (
          <>
            <div
              ref={leftPreviewRef}
              className="w-1/2 border-r border-gm-border-subtle overflow-auto p-6 select-text bg-gm-surface"
              onContextMenu={(e) => handlePreviewContextMenu(e, 'left')}
            >
              <PaneHeader title={activeTab?.title || ''} />
              <MarkdownPreview
                content={activeTab?.content || ''}
                filePath={activeTab?.filePath}
                fontSize={editorFontSize}
                lineHeight={editorLineHeight}
                onTaskToggle={
                  activeTab
                    ? (line, checked) => void handleTaskToggle(activeTab.id, activeTab.content, line, checked)
                    : undefined
                }
              />
            </div>
            <div
              ref={rightPreviewRef}
              className={`w-1/2 overflow-auto p-6 select-text bg-gm-surface relative ${rightPaneDragOver ? 'ring-2 ring-inset ring-gm-primary/40' : ''}`}
              onDragOver={handleRightPaneDragOver}
              onDragLeave={handleRightPaneDragLeave}
              onDrop={handleRightPaneDrop}
              onContextMenu={(e) => handlePreviewContextMenu(e, 'right')}
            >
              {rightPaneDragOver && (
                <div className="absolute inset-0 z-10 flex items-center justify-center bg-gm-primary/5 border-2 border-dashed border-gm-primary/50 rounded-lg pointer-events-none">
                  <span className="text-caption text-gm-primary font-bold">{'释放以在右栏打开'}</span>
                </div>
              )}
              <PaneHeader
                title={rightTab?.title || '选择文件'}
                onClose={() => {
                  setRightPaneTabId(null)
                  useEditorStore.getState().setViewMode('edit')
                }}
              />
              {rightTab ? (
                <MarkdownPreview
                  content={rightTab.content}
                  filePath={rightTab.filePath}
                  fontSize={editorFontSize}
                  lineHeight={editorLineHeight}
                  onTaskToggle={(line, checked) => void handleTaskToggle(rightTab.id, rightTab.content, line, checked)}
                />
              ) : (
                <div className="flex items-center justify-center h-full text-gm-text-tertiary text-caption">
                  {'拖拽标签页到此处，或右键选择"在右栏打开"'}
                </div>
              )}
            </div>
          </>
        ) : (
          <>
            <div className={`${viewMode === 'edit-preview' ? 'w-1/2 border-r border-gm-border-subtle' : 'flex-1'} overflow-hidden relative`}>
              {activeTab && (
                <CodeMirrorEditor
                  content={activeTab.content}
                  onChange={handleEditorChange}
                  onSave={handleSave}
                  onImageFiles={(files, insertAt) => void handleInsertImageFiles(files, insertAt)}
                  viewRef={editorViewRef}
                  documentKey={activeTab.id}
                  tabId={activeTab.id}
                />
              )}
              {activeTab && (
                <button
                  type="button"
                  onClick={() => void handleChooseImage()}
                  className="absolute right-3 top-3 z-10 flex h-8 w-8 items-center justify-center rounded-lg border border-gm-border bg-gm-surface/90 text-gm-text-secondary shadow-sm transition-colors hover:border-gm-primary/50 hover:text-gm-primary"
                  title="选择图片插入"
                >
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                    <circle cx="8.5" cy="8.5" r="1.5" />
                    <path d="M21 15l-5-5L5 21" />
                  </svg>
                </button>
              )}
              <EditorContextMenu viewRef={editorViewRef} />
            </div>

            {viewMode === 'edit-preview' && (
              <div
                ref={leftPreviewRef}
                className="w-1/2 overflow-auto p-6 select-text bg-gm-surface relative"
                onContextMenu={(e) => handlePreviewContextMenu(e, 'left')}
              >
                <MarkdownPreview
                  content={activeTab?.content || ''}
                  filePath={activeTab?.filePath}
                  fontSize={editorFontSize}
                  lineHeight={editorLineHeight}
                  onHeadingClick={jumpToLine}
                  onTaskToggle={
                    activeTab
                      ? (line, checked) => void handleTaskToggle(activeTab.id, activeTab.content, line, checked)
                      : undefined
                  }
                />
              </div>
            )}

            {viewMode === 'edit' && (
              <MarkdownToc
                toc={toc}
                collapsed={tocCollapsed}
                onToggle={() => setTocCollapsed((collapsed) => !collapsed)}
                onHeadingClick={jumpToEditorHeading}
              />
            )}
          </>
        )}

        {searchOpen && tabs.length > 0 && (
          <SearchOverlay onClose={() => setSearchOpen(false)} {...getSearchProps()} />
        )}
        {previewMenu && (
          <ContextMenu position={previewMenu} onClose={() => {
            clearPreviewContextHighlight()
            setPreviewMenu(null)
          }} minWidth={144} maxWidth={144}>
            <ContextMenuGroupTitle>预览操作</ContextMenuGroupTitle>
            <ContextMenuItem onClick={handleCopyPreviewSelection} disabled={!previewMenu.selectedText}>
              复制
            </ContextMenuItem>
            <ContextMenuItem onClick={handleSelectAllPreview}>
              全选
            </ContextMenuItem>
          </ContextMenu>
        )}
      </div>
    </div>
  )
}

function PaneHeader({ title, onClose }: { title: string; onClose?: () => void }) {
  return (
    <div className="flex items-center justify-between mb-4 pb-2 border-b border-gm-border-subtle">
      <div className="flex items-center gap-2">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#19c8b9" strokeWidth="1.5">
          <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
          <path d="M14 2v6h6" />
        </svg>
        <span className="text-caption font-bold text-gm-text truncate">{title}</span>
      </div>
      {onClose && (
        <button
          onClick={onClose}
          className="p-1 rounded-lg text-gm-text-tertiary hover:text-gm-text hover:bg-gm-surface-hover transition-colors"
          title="关闭右栏"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>
      )}
    </div>
  )
}

function WelcomeScreen() {
  const { handleNewFile, handleOpenFile } = useFileOperations()
  const toggleAiPanel = useAppStore((s) => s.toggleAiPanel)

  return (
    <div className="flex-1 flex flex-col items-center justify-center p-8 animate-fadeIn">
      <div className="mb-6 animate-float">
        <svg width="80" height="80" viewBox="0 0 24 24" fill="none" stroke="var(--gm-primary)" strokeWidth="1">
          <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
          <path d="M14 2v6h6M16 13H8M16 17H8M10 9H8" />
        </svg>
      </div>

      <h2 className="text-display text-gm-text mb-2 font-display">观墨</h2>
      <p className="text-body text-gm-text-secondary mb-8">AI 驱动的 Markdown 知识管理</p>

      <div className="grid grid-cols-2 gap-3 max-w-md w-full">
        <ActionCard label="新建文件" shortcut="Ctrl+N" color="app-teal" onClick={handleNewFile}
          icon={<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--gm-primary)" strokeWidth="1.5"><path d="M12 5v14M5 12h14" /></svg>}
        />
        <ActionCard label="打开文件" shortcut="Ctrl+O" color="app-blue" onClick={handleOpenFile}
          icon={<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--gm-primary)" strokeWidth="1.5"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" /></svg>}
        />
        <ActionCard
          label="快速打开"
          shortcut="Ctrl+P"
          color="app-yellow"
          onClick={() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', ctrlKey: true, bubbles: true }))}
          icon={<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--gm-primary)" strokeWidth="1.5"><circle cx="11" cy="11" r="8" /><path d="M21 21l-4.35-4.35" /></svg>}
        />
        <ActionCard label="AI 对话" shortcut="Ctrl+J" color="app-green" onClick={toggleAiPanel}
          icon={<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--gm-primary)" strokeWidth="1.5"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" /></svg>}
        />
      </div>
    </div>
  )
}

function ActionCard({
  icon,
  label,
  shortcut,
  color,
  onClick,
}: {
  icon: React.ReactNode
  label: string
  shortcut: string
  color: 'app-teal' | 'app-blue' | 'app-yellow' | 'app-green'
  onClick: () => void
}) {
  return (
    <Card color={color} className="p-4 cursor-pointer hover:shadow-lg transition-shadow duration-200 group" onClick={onClick}>
      <div className="flex flex-col items-center gap-2">
        <div className="group-hover:scale-110 transition-transform duration-200">{icon}</div>
        <span className="text-body font-bold text-gm-text">{label}</span>
        <kbd className="px-2 py-0.5 rounded-full bg-white/50 text-micro text-gm-text-secondary font-mono">{shortcut}</kbd>
      </div>
    </Card>
  )
}
