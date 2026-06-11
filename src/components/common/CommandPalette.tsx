import { useCallback, useEffect, useRef, useState } from 'react'
import { Input } from 'animal-island-ui'
import { useAppStore } from '@/stores/appStore'
import { useEditorStore } from '@/stores/editorStore'
import { openFile, saveFile } from '@/services/fileSystem'
import { exportMarkdownAsHtml } from '@/services/markdownExport'
import { indexMarkdownDocument } from '@/services/rag/indexer'
import { SHORTCUTS } from '@/services/shortcuts'
import { isSameFilePath } from '@/services/pathIdentity'
import { toast } from '@/services/toast'

interface Command {
  id: string
  label: string
  shortcut?: string
  category?: string
  action: () => void
}

interface CommandPaletteProps {
  open: boolean
  onClose: () => void
  mode?: 'commands' | 'files'
}

function shortcut(id: string): string | undefined {
  return SHORTCUTS.find((item) => item.id === id)?.key
}

export function CommandPalette({ open, onClose, mode = 'commands' }: CommandPaletteProps) {
  const [query, setQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const inputWrapperRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const handleNewFile = useCallback(() => {
    useEditorStore.getState().addTab(undefined, '未命名.md')
    onClose()
  }, [onClose])

  const handleOpenFile = useCallback(async () => {
    onClose()
    try {
      const file = await openFile()
      if (!file) return
      const state = useEditorStore.getState()
      const existing = state.tabs.find((t) => isSameFilePath(t.filePath, file.path))
      if (existing) {
        state.setActiveTab(existing.id)
      } else {
        state.addTab(file.path, file.name, file.content)
      }
      indexMarkdownDocument(file.path, file.name, file.content)
    } catch (err) {
      console.error('Open file failed:', err)
    }
  }, [onClose])

  const handleSaveFile = useCallback(async () => {
    onClose()
    const state = useEditorStore.getState()
    const tab = state.tabs.find((t) => t.id === state.activeTabId)
    if (!tab) return
    try {
      if (tab.filePath) {
        await saveFile(tab.filePath, tab.content)
        indexMarkdownDocument(tab.filePath, tab.title, tab.content)
      } else {
        const { saveFileAs } = await import('@/services/fileSystem')
        const result = await saveFileAs(tab.content)
        if (result) indexMarkdownDocument(result.path, result.name, result.content)
      }
      toast.success('已保存')
    } catch (err) {
      console.error('Save failed:', err)
      toast.error('保存失败')
    }
  }, [onClose])

  const handleExportHtml = useCallback(async () => {
    onClose()
    const state = useEditorStore.getState()
    const tab = state.tabs.find((t) => t.id === state.activeTabId)
    if (!tab) return
    let result: string | null = null
    try {
      result = await exportMarkdownAsHtml(tab.content, tab.title.replace(/\.(md|markdown|mdx)$/i, ''), tab.filePath)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'HTML export failed')
      return
    }
    if (result) {
      toast.success('已导出为 HTML')
    }
  }, [onClose])

  const commands: Command[] = [
    { id: 'new-file', label: '新建文件', shortcut: shortcut('new-file'), category: '文件', action: handleNewFile },
    { id: 'open-file', label: '打开文件...', shortcut: shortcut('open-file'), category: '文件', action: handleOpenFile },
    { id: 'save-file', label: '保存', shortcut: shortcut('save-file'), category: '文件', action: handleSaveFile },
    { id: 'export-html', label: '导出 HTML...', shortcut: shortcut('export-html'), category: '文件', action: handleExportHtml },
    {
      id: 'toggle-preview',
      label: '切换预览面板',
      shortcut: shortcut('toggle-preview'),
      category: '视图',
      action: () => {
        useEditorStore.getState().togglePreview()
        onClose()
      },
    },
    {
      id: 'toggle-diff',
      label: '切换 Markdown Diff',
      shortcut: shortcut('toggle-diff'),
      category: '视图',
      action: () => {
        useEditorStore.getState().toggleDiffPreview()
        onClose()
      },
    },
    {
      id: 'view-edit',
      label: '切换到编辑模式',
      shortcut: shortcut('view-edit'),
      category: '视图',
      action: () => {
        useEditorStore.getState().setViewMode('edit')
        onClose()
      },
    },
    {
      id: 'view-preview',
      label: '切换到预览模式',
      shortcut: shortcut('view-preview'),
      category: '视图',
      action: () => {
        useEditorStore.getState().setViewMode('preview')
        onClose()
      },
    },
    {
      id: 'view-edit-preview',
      label: '切换到编辑+预览',
      shortcut: shortcut('view-edit-preview'),
      category: '视图',
      action: () => {
        useEditorStore.getState().setViewMode('edit-preview')
        onClose()
      },
    },
    {
      id: 'view-dual-preview',
      label: '切换到对照阅读',
      shortcut: shortcut('view-dual-preview'),
      category: '视图',
      action: () => {
        useEditorStore.getState().setViewMode('dual-preview')
        onClose()
      },
    },
    {
      id: 'view-diff-preview',
      label: '切换到 Diff 对比',
      shortcut: shortcut('view-diff-preview'),
      category: '视图',
      action: () => {
        useEditorStore.getState().setViewMode('diff-preview')
        onClose()
      },
    },
    {
      id: 'toggle-sidebar',
      label: '切换侧边栏',
      shortcut: shortcut('toggle-sidebar'),
      category: '视图',
      action: () => {
        useAppStore.getState().toggleSidebar()
        onClose()
      },
    },
    {
      id: 'toggle-ai',
      label: '切换 AI 面板',
      shortcut: shortcut('toggle-ai'),
      category: '视图',
      action: () => {
        useAppStore.getState().toggleAiPanel()
        onClose()
      },
    },
  ]

  const filteredCommands = commands.filter(
    (cmd) =>
      cmd.label.toLowerCase().includes(query.toLowerCase()) ||
      cmd.category?.toLowerCase().includes(query.toLowerCase())
  )

  useEffect(() => {
    if (!open) return
    setQuery('')
    setSelectedIndex(0)
    setTimeout(() => inputWrapperRef.current?.querySelector('input')?.focus(), 50)
  }, [open])

  useEffect(() => {
    setSelectedIndex(0)
  }, [query])

  const executeCommand = useCallback((cmd: Command) => {
    cmd.action()
  }, [])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault()
          setSelectedIndex((i) => Math.min(i + 1, filteredCommands.length - 1))
          break
        case 'ArrowUp':
          e.preventDefault()
          setSelectedIndex((i) => Math.max(i - 1, 0))
          break
        case 'Enter':
          e.preventDefault()
          if (filteredCommands[selectedIndex]) executeCommand(filteredCommands[selectedIndex])
          break
        case 'Escape':
          e.preventDefault()
          onClose()
          break
      }
    },
    [filteredCommands, selectedIndex, executeCommand, onClose]
  )

  useEffect(() => {
    const item = listRef.current?.children[selectedIndex] as HTMLElement | undefined
    item?.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh]">
      <div className="absolute inset-0 bg-black/20 animate-fadeIn" onClick={onClose} />
      <div className="relative w-[560px] max-h-[400px] bg-gm-surface rounded-2xl shadow-lg border-2 border-gm-border overflow-hidden animate-slideInUp">
        <div ref={inputWrapperRef} className="flex items-center gap-2 px-3 py-2 border-b border-gm-border-subtle">
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={mode === 'files' ? '搜索文件...' : '输入命令...'}
            allowClear
            prefix={
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <circle cx="11" cy="11" r="8" />
                <path d="M21 21l-4.35-4.35" />
              </svg>
            }
          />
          <kbd className="px-2 py-0.5 rounded-full bg-gm-surface-elevated text-micro text-gm-text-secondary border border-gm-border font-mono flex-shrink-0">
            ESC
          </kbd>
        </div>
        <div ref={listRef} className="max-h-[320px] overflow-y-auto py-2">
          {filteredCommands.length === 0 ? (
            <div className="px-4 py-8 text-center text-gm-text-secondary text-caption">没有匹配的命令</div>
          ) : (
            filteredCommands.map((cmd, index) => (
              <button
                key={cmd.id}
                onClick={() => executeCommand(cmd)}
                className={`w-full flex items-center gap-3 px-4 py-2.5 text-left transition-all duration-150 mx-2 rounded-xl ${
                  index === selectedIndex ? 'bg-gm-primary-subtle text-gm-text' : 'text-gm-text-secondary hover:bg-gm-surface-hover'
                }`}
                style={{ width: 'calc(100% - 16px)' }}
              >
                {cmd.category && <span className="text-micro text-gm-text-tertiary w-10 flex-shrink-0 font-bold">{cmd.category}</span>}
                <span className="flex-1 text-body">{cmd.label}</span>
                {cmd.shortcut && (
                  <kbd className="px-2 py-0.5 rounded-full bg-gm-surface-elevated text-micro text-gm-text-tertiary border border-gm-border font-mono">
                    {cmd.shortcut}
                  </kbd>
                )}
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  )
}
