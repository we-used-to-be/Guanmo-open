import { useState, useEffect, useCallback } from 'react'
import { undo, redo } from '@codemirror/commands'
import { useEditorStore } from '@/stores/editorStore'
import { useEditorHistoryStore } from '@/stores/editorHistoryStore'
import { getActiveEditorView } from '@/services/editorViewRef'
import { appIconUrl } from '@/assets/appIcon'

// Detect if running inside Tauri
const isTauri = typeof window !== 'undefined' && '__TAURI__' in window

export function TitleBar() {
  const [maximized, setMaximized] = useState(false)
  const activeTab = useEditorStore((s) => s.tabs.find((t) => t.id === s.activeTabId))
  const canUndo = useEditorHistoryStore((s) => s.canUndo)
  const canRedo = useEditorHistoryStore((s) => s.canRedo)

  useEffect(() => {
    if (!isTauri) return

    let disposed = false
    let cleanup: (() => void) | undefined

    import('@tauri-apps/api/window').then(({ getCurrentWindow }) => {
      const win = getCurrentWindow()

      win.isMaximized().then(setMaximized)

      win.onResized(() => {
        win.isMaximized().then(setMaximized)
      }).then((unlisten) => {
        if (disposed) {
          unlisten()
        } else {
          cleanup = unlisten
        }
      })
    }).catch((err) => {
      console.error('TitleBar: failed to initialize Tauri window:', err)
    })

    return () => {
      disposed = true
      cleanup?.()
    }
  }, [])

  const handleMinimize = useCallback(() => {
    if (!isTauri) return
    import('@tauri-apps/api/window')
      .then(({ getCurrentWindow }) => getCurrentWindow().minimize())
      .catch((err) => console.error('TitleBar: minimize failed:', err))
  }, [])

  const handleToggleMaximize = useCallback(() => {
    if (!isTauri) return
    import('@tauri-apps/api/window')
      .then(({ getCurrentWindow }) => getCurrentWindow().toggleMaximize())
      .catch((err) => console.error('TitleBar: toggleMaximize failed:', err))
  }, [])

  const handleClose = useCallback(() => {
    if (!isTauri) return
    import('@tauri-apps/api/window')
      .then(({ getCurrentWindow }) => getCurrentWindow().close())
      .catch((err) => console.error('TitleBar: close failed:', err))
  }, [])

  const handleUndo = useCallback(() => {
    const view = getActiveEditorView()
    if (view) undo({ state: view.state, dispatch: view.dispatch })
  }, [])

  const handleRedo = useCallback(() => {
    const view = getActiveEditorView()
    if (view) redo({ state: view.state, dispatch: view.dispatch })
  }, [])

  return (
    <div className="h-[38px] flex items-center bg-gm-surface border-b border-gm-border-subtle select-none flex-shrink-0">
      {/* App branding */}
      <div className="flex items-center gap-2 pl-3 pr-2 flex-shrink-0">
        <img src={appIconUrl} alt="观墨" width={18} height={18} className="rounded" />
        <span className="text-caption font-bold text-gm-text tracking-wide">观墨</span>
      </div>

      {/* Drag region + current file */}
      <div
        data-tauri-drag-region=""
        className="flex-1 h-full flex items-center justify-center"
      >
        {activeTab && (
          <span className="text-micro text-gm-text-tertiary truncate max-w-[300px]">
            {activeTab.title}
            {activeTab.modified && ' ·'}
          </span>
        )}
      </div>

      {/* Undo/Redo + Window controls */}
      <div className="flex items-center h-full flex-shrink-0">
        {/* Undo */}
        <button
          onClick={handleUndo}
          disabled={!canUndo}
          className={`h-full w-10 flex items-center justify-center transition-colors ${
            canUndo ? 'text-gm-text-secondary hover:bg-gm-surface-hover' : 'text-gm-text-disabled cursor-not-allowed'
          }`}
          title="撤销 (Ctrl+Z)"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="1 4 1 10 7 10" />
            <path d="M3.51 15a9 9 0 102.13-9.36L1 10" />
          </svg>
        </button>
        {/* Redo */}
        <button
          onClick={handleRedo}
          disabled={!canRedo}
          className={`h-full w-10 flex items-center justify-center transition-colors ${
            canRedo ? 'text-gm-text-secondary hover:bg-gm-surface-hover' : 'text-gm-text-disabled cursor-not-allowed'
          }`}
          title="重做 (Ctrl+Y)"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="23 4 23 10 17 10" />
            <path d="M20.49 15a9 9 0 11-2.12-9.36L23 10" />
          </svg>
        </button>
        {/* Divider */}
        <div className="w-px h-5 bg-gm-border-subtle mx-1" />
        {/* Window controls */}
        <button
          onClick={handleMinimize}
          className="h-full w-12 flex items-center justify-center text-gm-text-secondary hover:bg-gm-surface-hover transition-colors"
          title="最小化"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M5 12h14" />
          </svg>
        </button>
        <button
          onClick={handleToggleMaximize}
          className="h-full w-12 flex items-center justify-center text-gm-text-secondary hover:bg-gm-surface-hover transition-colors"
          title={maximized ? '还原' : '最大化'}
        >
          {maximized ? (
            <svg width="12" height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M8 3H5a2 2 0 00-2 2v3m18 0V5a2 2 0 00-2-2h-3m0 18h3a2 2 0 002-2v-3M3 16v3a2 2 0 002 2h3" />
            </svg>
          ) : (
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="3" y="3" width="18" height="18" rx="2" />
            </svg>
          )}
        </button>
        <button
          onClick={handleClose}
          className="h-full w-12 flex items-center justify-center text-gm-text-secondary hover:bg-red-500 hover:text-white transition-colors"
          title="关闭"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>
      </div>
    </div>
  )
}
