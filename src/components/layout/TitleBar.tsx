import { useState, useEffect, useCallback } from 'react'
import { undo, redo } from '@codemirror/commands'
import { useEditorHistoryStore } from '@/stores/editorHistoryStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { getActiveEditorView } from '@/services/editorViewRef'
import { useFullscreen } from '@/hooks/useFullscreen'

import { isTauri } from '@/hooks/useTauri'

export function TitleBar() {
  const [maximized, setMaximized] = useState(false)
  const canUndo = useEditorHistoryStore((s) => s.canUndo)
  const canRedo = useEditorHistoryStore((s) => s.canRedo)
  const { isFullscreen, toggleFullscreen } = useFullscreen()

  useEffect(() => {
    if (!isTauri()) return

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
    if (!isTauri()) return
    import('@tauri-apps/api/window')
      .then(({ getCurrentWindow }) => getCurrentWindow().minimize())
      .catch((err) => console.error('TitleBar: minimize failed:', err))
  }, [])

  const handleToggleMaximize = useCallback(() => {
    if (!isTauri()) return
    import('@tauri-apps/api/window')
      .then(({ getCurrentWindow }) => getCurrentWindow().toggleMaximize())
      .catch((err) => console.error('TitleBar: toggleMaximize failed:', err))
  }, [])

  const handleClose = useCallback(() => {
    if (!isTauri()) return
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

  const theme = useSettingsStore((s) => s.appearance.theme)
  const toggleTheme = useCallback(() => {
    const next = theme === 'dark' ? 'light' : 'dark'
    useSettingsStore.getState().updateAppearanceSettings({ theme: next })
  }, [theme])

  return (
    <div className="h-[38px] flex items-center bg-gm-surface border-b border-gm-border-subtle select-none flex-shrink-0">
      {/* App branding */}
      <div className="flex items-center gap-2 pl-3 pr-2 flex-shrink-0">
        <span className="text-caption font-bold text-gm-text tracking-wide">观墨</span>
        {!isTauri() && (
          <span className="text-micro text-gm-text-disabled bg-gm-surface-elevated px-1.5 py-0.5 rounded">
            浏览器模式，多项功能和样式会有问题，推荐下载桌面版
          </span>
        )}
      </div>

      {/* Drag region */}
      <div
        data-tauri-drag-region=""
        className="flex-1 h-full"
      />

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
        {/* Theme toggle */}
        <button
          onClick={toggleTheme}
          className="h-full w-10 flex items-center justify-center text-gm-text-secondary hover:bg-gm-surface-hover transition-colors"
          title={theme === 'dark' ? '切换为浅色模式' : '切换为深色模式'}
        >
          {theme === 'dark' ? (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="5" />
              <line x1="12" y1="1" x2="12" y2="3" />
              <line x1="12" y1="21" x2="12" y2="23" />
              <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
              <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
              <line x1="1" y1="12" x2="3" y2="12" />
              <line x1="21" y1="12" x2="23" y2="12" />
              <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
              <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
            </svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
            </svg>
          )}
        </button>
        {/* Divider */}
        <div className="w-px h-5 bg-gm-border-subtle mx-1" />
        <button
          onClick={() => void toggleFullscreen()}
          className="h-full w-12 flex items-center justify-center text-gm-text-secondary hover:bg-gm-surface-hover transition-colors"
          title={isFullscreen ? '退出全屏 F11' : '进入全屏 F11'}
        >
          {isFullscreen ? (
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4.5 1.5H1.5v3M7.5 1.5h3v3M4.5 10.5H1.5v-3M7.5 10.5h3v-3" />
            </svg>
          ) : (
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M1.5 4.5v-3h3M10.5 4.5v-3h-3M1.5 7.5v3h3M10.5 7.5v3h-3" />
            </svg>
          )}
        </button>
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
            <svg width="12" height={12} viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2">
              <path d="M4.2 2.2h5.1v5.1" />
              <rect x="2.2" y="4.2" width="5.6" height="5.6" />
            </svg>
          ) : (
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2">
              <rect x="2.2" y="2.2" width="7.6" height="7.6" />
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
