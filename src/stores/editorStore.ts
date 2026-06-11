import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { isSameFilePath, normalizeFilePath } from '@/services/pathIdentity'
import { validatePersistedTabs } from '@/services/sessionRestore'

export interface Tab {
  id: string
  title: string
  filePath: string | null
  content: string
  savedContent: string
  modified: boolean
  pinned?: boolean
}

export interface RecentFile {
  path: string
  name: string
  lastOpened: number
}

type ViewMode = 'edit' | 'preview' | 'edit-preview' | 'dual-preview' | 'diff-preview'

interface EditorState {
  tabs: Tab[]
  activeTabId: string | null
  previewVisible: boolean
  viewMode: ViewMode
  rightPaneTabId: string | null
  recentFiles: RecentFile[]
  favorites: string[]
  pendingReveal: { tabId: string; startLine: number; endLine?: number } | null

  openTab: (tab: Tab) => void
  addTab: (filePath?: string, title?: string, content?: string) => void
  closeTab: (id: string) => void
  setActiveTab: (id: string) => void
  updateTabContent: (id: string, content: string) => void
  togglePreview: () => void
  toggleDiffPreview: () => void
  reorderTabs: (sourceId: string, targetId: string) => void
  setViewMode: (mode: ViewMode) => void
  setRightPaneTabId: (id: string | null) => void
  addRecentFile: (path: string, name: string) => void
  removeRecentFile: (path: string) => void
  toggleFavorite: (filePath: string) => void
  isFavorite: (filePath: string) => boolean
  togglePinTab: (id: string) => void
  renameFilePath: (oldPath: string, newPath: string, newName: string) => void
  saveTabAs: (id: string, filePath: string, title: string, content: string) => void
  requestReveal: (tabId: string, startLine: number, endLine?: number) => void
  clearPendingReveal: () => void
}

export const useEditorStore = create<EditorState>()(
  persist(
    (set, get) => ({
      tabs: [],
      activeTabId: null,
      previewVisible: true,
      viewMode: 'edit',
      rightPaneTabId: null,
      recentFiles: [],
      favorites: [],
      pendingReveal: null,

      openTab: (tab) => {
        const existing = get().tabs.find((t) => t.id === tab.id || isSameFilePath(t.filePath, tab.filePath))
        if (existing) {
          set({ activeTabId: existing.id })
        } else {
          const hydratedTab = {
            ...tab,
            savedContent: tab.savedContent ?? tab.content,
          }
          set((s) => ({
            tabs: [hydratedTab, ...s.tabs],
            activeTabId: hydratedTab.id,
          }))
        }
      },

      addTab: (filePath, title, content) => {
        const existing = get().tabs.find((t) => isSameFilePath(t.filePath, filePath))
        if (existing) {
          set({ activeTabId: existing.id })
          return
        }
        const id = `tab-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
        const initialContent = content || ''
        const tab: Tab = {
          id,
          title: title || '未命名.md',
          filePath: filePath || null,
          content: initialContent,
          savedContent: initialContent,
          modified: false,
        }
        set((s) => ({
          tabs: [tab, ...s.tabs],
          activeTabId: id,
        }))
        if (filePath && title) {
          get().addRecentFile(filePath, title)
        }
      },

      closeTab: (id) => {
        set((s) => {
          const tabs = s.tabs.filter((t) => t.id !== id)
          let activeTabId = s.activeTabId
          if (activeTabId === id) {
            activeTabId = tabs.length > 0 ? tabs[0].id : null
          }
          let rightPaneTabId = s.rightPaneTabId
          if (rightPaneTabId === id) {
            rightPaneTabId = null
          }
          return { tabs, activeTabId, rightPaneTabId }
        })
      },

      setActiveTab: (id) => set({ activeTabId: id }),

      updateTabContent: (id, content) => {
        set((s) => ({
          tabs: s.tabs.map((t) =>
            t.id === id ? { ...t, content, modified: true } : t
          ),
        }))
      },

      togglePreview: () => {
        const { viewMode } = get()
        if (viewMode === 'edit-preview' || viewMode === 'preview') {
          set({ viewMode: 'edit', previewVisible: false })
        } else {
          set({ viewMode: 'edit-preview', previewVisible: true, rightPaneTabId: null })
        }
      },

      toggleDiffPreview: () => {
        const { viewMode } = get()
        if (viewMode === 'diff-preview') {
          set({ viewMode: 'edit', previewVisible: false, rightPaneTabId: null })
        } else {
          set({ viewMode: 'diff-preview', previewVisible: false, rightPaneTabId: null })
        }
      },

      reorderTabs: (sourceId, targetId) => {
        set((s) => {
          const tabs = [...s.tabs]
          const sourceIdx = tabs.findIndex((t) => t.id === sourceId)
          const targetIdx = tabs.findIndex((t) => t.id === targetId)
          if (sourceIdx === -1 || targetIdx === -1) return s
          const [moved] = tabs.splice(sourceIdx, 1)
          tabs.splice(targetIdx, 0, moved)
          return { tabs }
        })
      },

      setViewMode: (mode) => {
        if (mode === 'edit') {
          set({ viewMode: 'edit', previewVisible: false, rightPaneTabId: null })
        } else if (mode === 'preview') {
          set({ viewMode: 'preview', previewVisible: true, rightPaneTabId: null })
        } else if (mode === 'edit-preview') {
          set({ viewMode: 'edit-preview', previewVisible: true, rightPaneTabId: null })
        } else if (mode === 'dual-preview') {
          const { activeTabId, rightPaneTabId } = get()
          set({
            viewMode: 'dual-preview',
            previewVisible: false,
            rightPaneTabId: rightPaneTabId || activeTabId,
          })
        } else if (mode === 'diff-preview') {
          set({ viewMode: 'diff-preview', previewVisible: false, rightPaneTabId: null })
        }
      },

      setRightPaneTabId: (id) => set({ rightPaneTabId: id }),

      addRecentFile: (path, name) => {
        set((s) => {
          const normalizedPath = normalizeFilePath(path)
          const filtered = s.recentFiles.filter((f) => normalizeFilePath(f.path) !== normalizedPath)
          const updated = [{ path, name, lastOpened: Date.now() }, ...filtered].slice(0, 5)
          return { recentFiles: updated }
        })
      },

      removeRecentFile: (path) => {
        set((s) => {
          const normalizedPath = normalizeFilePath(path)
          return {
            recentFiles: s.recentFiles.filter((f) => normalizeFilePath(f.path) !== normalizedPath),
          }
        })
      },

      toggleFavorite: (filePath) => {
        set((s) => {
          if (s.favorites.some((path) => isSameFilePath(path, filePath))) {
            return { favorites: s.favorites.filter((f) => !isSameFilePath(f, filePath)) }
          }
          return { favorites: [...s.favorites, filePath] }
        })
      },

      isFavorite: (filePath) => {
        return get().favorites.some((path) => isSameFilePath(path, filePath))
      },

      togglePinTab: (id) => {
        set((s) => ({
          tabs: s.tabs.map((t) =>
            t.id === id ? { ...t, pinned: !t.pinned } : t
          ),
        }))
      },

      renameFilePath: (oldPath, newPath, newName) => {
        set((s) => ({
          tabs: s.tabs.map((tab) =>
            isSameFilePath(tab.filePath, oldPath)
              ? { ...tab, filePath: newPath, title: newName }
              : tab
          ),
          recentFiles: s.recentFiles.map((file) =>
            isSameFilePath(file.path, oldPath)
              ? { ...file, path: newPath, name: newName }
              : file
          ),
          favorites: s.favorites.map((path) =>
            isSameFilePath(path, oldPath) ? newPath : path
          ),
        }))
      },

      saveTabAs: (id, filePath, title, content) => {
        set((s) => ({
          tabs: s.tabs.map((tab) =>
            tab.id === id
              ? { ...tab, filePath, title, content, savedContent: content, modified: false }
              : tab
          ),
        }))
        get().addRecentFile(filePath, title)
      },

      requestReveal: (tabId, startLine, endLine) => set({
        pendingReveal: { tabId, startLine, endLine },
      }),

      clearPendingReveal: () => set({ pendingReveal: null }),
    }),
    {
      name: 'guanmo-editor',
      partialize: (state) => ({
        recentFiles: state.recentFiles,
        favorites: state.favorites,
        tabs: state.tabs,
        activeTabId: state.activeTabId,
        viewMode: state.viewMode,
        rightPaneTabId: state.rightPaneTabId,
        pendingReveal: null,
      }),
      onRehydrateStorage: () => (state) => {
        if (!state) return
        // 异步验证持久化的标签页文件是否存在
        validatePersistedTabs(state.tabs).then((validTabs) => {
          if (validTabs.length !== state.tabs.length) {
            const validIds = new Set(validTabs.map((t) => t.id))
            let activeTabId = state.activeTabId
            if (activeTabId && !validIds.has(activeTabId)) {
              activeTabId = validTabs.length > 0 ? validTabs[0].id : null
            }
            let rightPaneTabId = state.rightPaneTabId
            if (rightPaneTabId && !validIds.has(rightPaneTabId)) {
              rightPaneTabId = null
            }
            useEditorStore.setState({ tabs: validTabs, activeTabId, rightPaneTabId })
          }
        })
      },
    }
  )
)
