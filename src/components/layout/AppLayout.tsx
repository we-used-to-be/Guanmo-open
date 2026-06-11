import { useState, useCallback, useRef, useEffect } from 'react'
import { useAppStore } from '@/stores/appStore'
import { useEditorStore } from '@/stores/editorStore'
import { useKeyboardShortcuts } from '@/hooks/useKeyboard'
import { useFileOperations } from '@/hooks/useFileOperations'
import { Modal } from 'animal-island-ui'
import { exportMarkdownAsHtml } from '@/services/markdownExport'
import { Sidebar } from './Sidebar'
import { StatusBar } from './StatusBar'
import { TitleBar } from './TitleBar'
import { EditorArea } from '../editor/EditorArea'
import { AiPanel } from '../ai/AiPanel'
import { CommandPalette } from '../common/CommandPalette'
import { SettingsPage } from '@/features/settings/SettingsPage'
import { toast } from '@/services/toast'

export function AppLayout() {
  const { sidebarCollapsed, aiPanelOpen, sidebarWidth, aiPanelWidth, toggleSidebar, toggleAiPanel, setAiPanelWidth } =
    useAppStore()
  const { togglePreview, toggleDiffPreview, setViewMode } = useEditorStore()
  const { handleNewFile, handleOpenFile, handleSaveFile } = useFileOperations()
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false)
  const [commandPaletteMode, setCommandPaletteMode] = useState<'commands' | 'files'>('commands')
  const [settingsOpen, setSettingsOpen] = useState(false)

  // Intercept browser default shortcuts (Ctrl+S save, Ctrl+F find, etc.)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey) {
        const key = e.key.toLowerCase()
        const isSettingsShortcut = e.code === 'Comma' || key === ',' || key === '，'
        if (isSettingsShortcut) {
          e.preventDefault()
          e.stopPropagation()
          setSettingsOpen(true)
          return
        }
        if (key === 's' || key === 'f' || key === 'g' || key === 'h' || key === 'p' || key === 'j' || key === 'e' || key === 'd' || ['1', '2', '3', '4', '5'].includes(key)) {
          e.preventDefault()
          e.stopPropagation()
        }
      }
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [])

  // AI panel resize
  const isResizing = useRef(false)

  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    isResizing.current = true
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }, [])

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizing.current) return
      // Calculate new width from the right edge of the window
      const newWidth = window.innerWidth - e.clientX
      const clamped = Math.max(280, Math.min(600, newWidth))
      setAiPanelWidth(clamped)
    }

    const handleMouseUp = () => {
      if (isResizing.current) {
        isResizing.current = false
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
      }
    }

    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)
    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    }
  }, [setAiPanelWidth])

  const handleOpenSearch = useCallback(() => {
    setCommandPaletteMode('files')
    setCommandPaletteOpen(true)
  }, [])

  const handleExportHtml = useCallback(async () => {
    const state = useEditorStore.getState()
    const tab = state.tabs.find((t) => t.id === state.activeTabId)
    if (!tab) return
    try {
      await exportMarkdownAsHtml(tab.content, tab.title.replace(/\.(md|markdown|mdx)$/i, ''), tab.filePath)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'HTML export failed')
    }
  }, [])

  const shortcuts = {
    'CTRL+P': () => {
      setCommandPaletteMode('files')
      setCommandPaletteOpen(true)
    },
    'CTRL+SHIFT+P': () => {
      setCommandPaletteMode('commands')
      setCommandPaletteOpen(true)
    },
    'CTRL+B': () => toggleSidebar(),
    'CTRL+J': () => toggleAiPanel(),
    'CTRL+N': () => handleNewFile(),
    'CTRL+O': () => handleOpenFile(),
    'CTRL+S': () => handleSaveFile(),
    'CTRL+SHIFT+V': () => togglePreview(),
    'CTRL+SHIFT+D': () => toggleDiffPreview(),
    'CTRL+SHIFT+1': () => setViewMode('edit'),
    'CTRL+SHIFT+2': () => setViewMode('preview'),
    'CTRL+SHIFT+3': () => setViewMode('edit-preview'),
    'CTRL+SHIFT+4': () => setViewMode('dual-preview'),
    'CTRL+SHIFT+5': () => setViewMode('diff-preview'),
    'CTRL+SHIFT+E': () => handleExportHtml(),
    'CTRL+,': () => setSettingsOpen(true),
  }

  useKeyboardShortcuts(shortcuts)

  const handleClosePalette = useCallback(() => {
    setCommandPaletteOpen(false)
  }, [])

  return (
    <div className="flex flex-col h-full w-full bg-gm-canvas">
      {/* Title Bar */}
      <TitleBar />

      {/* Main Content Area */}
      <div className="flex flex-1 overflow-hidden">
        {/* Sidebar */}
        <Sidebar
          collapsed={sidebarCollapsed}
          width={sidebarWidth}
          onOpenSettings={() => setSettingsOpen(true)}
          onOpenSearch={handleOpenSearch}
        />

        {/* Editor Area */}
        <div className="flex-1 flex overflow-hidden">
          <EditorArea />
        </div>

        {/* AI Panel */}
        {aiPanelOpen && (
          <div
            className="border-l border-gm-border flex-shrink-0 animate-slideInRight relative"
            style={{ width: aiPanelWidth }}
          >
            {/* Resize handle */}
            <div
              className="absolute left-0 top-0 bottom-0 w-1 cursor-col-resize z-10 hover:bg-gm-primary/30 transition-colors"
              onMouseDown={handleResizeStart}
            />
            <AiPanel />
          </div>
        )}
      </div>

      {/* Status Bar */}
      <StatusBar />

      {/* Command Palette */}
      <CommandPalette
        open={commandPaletteOpen}
        onClose={handleClosePalette}
        mode={commandPaletteMode}
      />

      {/* Settings Modal */}
      <Modal
        open={settingsOpen}
        width={860}
        onClose={() => setSettingsOpen(false)}
        footer={null}
        typewriter={false}
      >
        <div style={{ width: '100%', height: '560px', overflow: 'hidden', padding: '32px 36px', minHeight: 0 }}>
          <SettingsPage />
        </div>
      </Modal>

      {/* Search highlight styles (CSS Highlight API) */}
      <style>{`
        ::highlight(search-highlight) { background-color: rgba(251, 191, 36, 0.35); }
        ::highlight(search-highlight-active) { background-color: rgba(251, 191, 36, 0.7); }
        ::highlight(preview-context-selection) { background-color: rgba(25, 200, 185, 0.28); }
      `}</style>
    </div>
  )
}
