import { create } from 'zustand'
import { persist, type PersistStorage, type StorageValue } from 'zustand/middleware'
import { isSameFilePath, normalizeFilePath } from '@/services/pathIdentity'
import { mergeBackgroundRestoredTab } from '@/services/sessionRestorePolicy'
import { eventMarker } from '@/services/eventMarker'
import type { ReadingPosition } from '@/services/editorSession'

export interface Tab {
  id: string
  title: string
  filePath: string | null
  content: string
  savedContent: string
  /** 文件打开时的内容，用于 diff 对比（不受自动保存影响） */
  originalContent: string
  modified: boolean
  pinned?: boolean
}

export interface RecentFile {
  path: string
  name: string
  lastOpened: number
}

export type ViewMode = 'edit' | 'preview' | 'edit-preview' | 'dual-preview' | 'diff-preview'
type PrewarmableViewMode = Exclude<ViewMode, 'edit'>

export interface ViewModeUsageStat {
  count: number
  lastUsedAt: number
}

interface PersistedEditorState {
  recentFiles: RecentFile[]
  favorites: string[]
  tabs: Tab[]
  activeTabId: string | null
  viewMode: ViewMode
  rightPaneTabId: string | null
  rightPaneUserSelected: boolean
  viewModeUsage: Partial<Record<PrewarmableViewMode, ViewModeUsageStat>>
  readingPositions: Record<string, ReadingPosition>
  pendingReveal: null
}

interface EditorState {
  tabs: Tab[]
  activeTabId: string | null
  previewVisible: boolean
  viewMode: ViewMode
  rightPaneTabId: string | null
  rightPaneUserSelected: boolean
  viewModeUsage: Partial<Record<PrewarmableViewMode, ViewModeUsageStat>>
  recentFiles: RecentFile[]
  favorites: string[]
  readingPositions: Record<string, ReadingPosition>
  pendingReveal: { tabId: string; startLine: number; endLine?: number } | null
  previewSwitchingTabId: string | null

  openTab: (tab: Tab) => void
  addTab: (filePath?: string, title?: string, content?: string) => void
  closeTab: (id: string) => void
  setActiveTab: (id: string) => void
  clearPreviewSwitching: (tabId?: string) => void
  updateTabContent: (id: string, content: string) => void
  markTabSaved: (id: string, content: string) => void
  replaceTabContentWithSaved: (id: string, content: string) => void
  resetTabsForExternalOpen: () => void
  restoreTabs: (tabs: Tab[], activeTabId: string | null, rightPaneTabId: string | null) => void
  mergeRestoredTab: (originalTab: Tab, restoredTab: Tab) => void
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
  flushReadingPositions: (positions: Record<string, ReadingPosition>) => void
}

function dedupeRecentFiles(files: RecentFile[] = []) {
  const seen = new Set<string>()
  return [...files]
    .sort((a, b) => b.lastOpened - a.lastOpened)
    .filter((file) => {
      const key = normalizeFilePath(file.path)
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .slice(0, 5)
}

function dedupeRestoredTabs(tabs: Tab[] = []) {
  const restored: Tab[] = []
  for (const tab of tabs) {
    // 确保 originalContent 存在（兼容旧数据）
    const hydratedTab = {
      ...tab,
      originalContent: tab.originalContent ?? tab.savedContent ?? tab.content,
    }

    if (!tab.filePath) {
      restored.push(hydratedTab)
      continue
    }
    const duplicate = restored.find((item) => isSameFilePath(item.filePath, tab.filePath))
    const canMerge =
      duplicate &&
      !tab.modified &&
      tab.content === tab.savedContent &&
      tab.content === duplicate.content &&
      tab.savedContent === duplicate.savedContent
    if (canMerge) continue
    restored.push(hydratedTab)
  }
  return restored
}

function compactPersistedTab(tab: Tab): Tab {
  if (!tab.filePath || tab.modified) return tab
  return {
    ...tab,
    content: '',
    savedContent: '',
    originalContent: '',
  }
}

function createDeferredEditorStorage(delayMs: number): PersistStorage<PersistedEditorState> {
  let timer: ReturnType<typeof setTimeout> | null = null
  let pending: { name: string; value: StorageValue<PersistedEditorState> } | null = null

  const flush = () => {
    timer = null
    if (!pending) return
    const { name, value } = pending
    pending = null
    localStorage.setItem(name, JSON.stringify(value))
  }

  window.addEventListener('beforeunload', flush)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush()
  })

  return {
    getItem(name) {
      const raw = localStorage.getItem(name)
      return raw ? JSON.parse(raw) as StorageValue<PersistedEditorState> : null
    },
    setItem(name, value) {
      pending = { name, value }
      if (timer !== null) clearTimeout(timer)
      timer = setTimeout(flush, delayMs)
    },
    removeItem(name) {
      if (pending?.name === name) pending = null
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
      localStorage.removeItem(name)
    },
  }
}

function shouldMaskPreviewSwitch(viewMode: ViewMode) {
  return viewMode === 'preview' || viewMode === 'edit-preview' || viewMode === 'dual-preview'
}

function markPreviewSwitchStart(tabId: string, viewMode: ViewMode) {
  if (!import.meta.env.DEV || !shouldMaskPreviewSwitch(viewMode)) return
  const markName = `guanmo:preview-switch:${tabId}:start`
  performance.clearMarks(markName)
  performance.mark(markName)
  eventMarker.mark('preview-render-start', { mode: viewMode })
}

function isPrewarmableViewMode(mode: ViewMode): mode is PrewarmableViewMode {
  return mode !== 'edit'
}

function markUserViewModeUse(
  usage: Partial<Record<PrewarmableViewMode, ViewModeUsageStat>>,
  mode: ViewMode,
  previousMode: ViewMode
) {
  if (mode === previousMode || !isPrewarmableViewMode(mode)) return usage
  const current = usage[mode] ?? { count: 0, lastUsedAt: 0 }
  return {
    ...usage,
    [mode]: {
      count: current.count + 1,
      lastUsedAt: Date.now(),
    },
  }
}

export const useEditorStore = create<EditorState>()(
  persist(
    (set, get) => ({
      tabs: [],
      activeTabId: null,
      previewVisible: true,
      viewMode: 'edit',
      rightPaneTabId: null,
      rightPaneUserSelected: false,
      viewModeUsage: {},
      recentFiles: [],
      favorites: [],
      readingPositions: {},
      pendingReveal: null,
      previewSwitchingTabId: null,

      openTab: (tab) => {
        const existing = get().tabs.find((t) => t.id === tab.id || isSameFilePath(t.filePath, tab.filePath))
        if (existing) {
          set((s) => ({
            activeTabId: existing.id,
            rightPaneTabId: s.viewMode === 'dual-preview' && !s.rightPaneUserSelected
              ? existing.id
              : s.rightPaneTabId,
            previewSwitchingTabId: shouldMaskPreviewSwitch(s.viewMode) && s.activeTabId !== existing.id ? existing.id : null,
          }))
        } else {
          const hydratedTab = {
            ...tab,
            savedContent: tab.savedContent ?? tab.content,
            originalContent: tab.originalContent ?? tab.savedContent ?? tab.content,
          }
          set((s) => ({
            tabs: [hydratedTab, ...s.tabs],
            activeTabId: hydratedTab.id,
            rightPaneTabId: s.viewMode === 'dual-preview' && !s.rightPaneUserSelected
              ? hydratedTab.id
              : s.rightPaneTabId,
            previewSwitchingTabId: null,
          }))
        }
      },

      addTab: (filePath, title, content) => {
        const existing = get().tabs.find((t) => isSameFilePath(t.filePath, filePath))
        if (existing) {
          set((s) => ({
            activeTabId: existing.id,
            rightPaneTabId: s.viewMode === 'dual-preview' && !s.rightPaneUserSelected
              ? existing.id
              : s.rightPaneTabId,
            previewSwitchingTabId: shouldMaskPreviewSwitch(s.viewMode) && s.activeTabId !== existing.id ? existing.id : null,
          }))
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
          originalContent: initialContent,
          modified: false,
        }
        set((s) => ({
          tabs: [tab, ...s.tabs],
          activeTabId: id,
          rightPaneTabId: s.viewMode === 'dual-preview' && !s.rightPaneUserSelected
            ? id
            : s.rightPaneTabId,
          previewSwitchingTabId: null,
        }))
        if (filePath && title) {
          get().addRecentFile(filePath, title)
        }
      },

      closeTab: (id) => {
        const closedTab = get().tabs.find((t) => t.id === id)
        set((s) => {
          const tabs = s.tabs.filter((t) => t.id !== id)
          let activeTabId = s.activeTabId
          if (activeTabId === id) {
            activeTabId = tabs.length > 0 ? tabs[0].id : null
          }
          let rightPaneTabId = s.rightPaneTabId
          let rightPaneUserSelected = s.rightPaneUserSelected
          if (rightPaneTabId === id) {
            rightPaneTabId = null
            rightPaneUserSelected = false
          }
          if (s.viewMode === 'dual-preview' && !rightPaneUserSelected) {
            rightPaneTabId = activeTabId
          }
          return {
            tabs,
            activeTabId,
            rightPaneTabId,
            rightPaneUserSelected,
            previewSwitchingTabId: activeTabId && shouldMaskPreviewSwitch(s.viewMode) && s.activeTabId !== activeTabId
              ? activeTabId
              : null,
          }
        })
        if (closedTab) {
          eventMarker.mark('close-file', { modified: closedTab.modified })
        }
      },

      setActiveTab: (id) => set((s) => {
        if (s.activeTabId !== id) {
          markPreviewSwitchStart(id, s.viewMode)
        }
        let rightPaneTabId = s.rightPaneTabId
        if (s.viewMode === 'dual-preview' && !s.rightPaneUserSelected) {
          rightPaneTabId = id
        }

        return {
          activeTabId: id,
          rightPaneTabId,
          previewSwitchingTabId: shouldMaskPreviewSwitch(s.viewMode) && s.activeTabId !== id ? id : null,
        }
      }),

      clearPreviewSwitching: (tabId) => set((s) => (
        !tabId || s.previewSwitchingTabId === tabId
          ? { previewSwitchingTabId: null }
          : s
      )),

      updateTabContent: (id, content) => {
        set((s) => ({
          tabs: s.tabs.map((t) =>
            t.id === id ? { ...t, content, modified: true } : t
          ),
        }))
      },

      markTabSaved: (id, content) => set((s) => ({
        tabs: s.tabs.map((tab) => (
          tab.id === id
            ? { ...tab, savedContent: content, modified: tab.content !== content }
            : tab
        )),
      })),

      replaceTabContentWithSaved: (id, content) => set((s) => ({
        tabs: s.tabs.map((tab) => (
          tab.id === id
            ? { ...tab, content, savedContent: content, modified: false }
            : tab
        )),
      })),

      resetTabsForExternalOpen: () => set({
        tabs: [],
        activeTabId: null,
        rightPaneTabId: null,
        viewMode: 'edit',
        previewVisible: false,
      }),

      restoreTabs: (tabs, activeTabId, rightPaneTabId) => set({
        tabs,
        activeTabId,
        rightPaneTabId,
      }),

      mergeRestoredTab: (originalTab, restoredTab) => set((s) => ({
        tabs: s.tabs.map((tab) => (
          tab.id === originalTab.id
            ? mergeBackgroundRestoredTab(tab, originalTab, restoredTab)
            : tab
        )),
      })),

      togglePreview: () => {
        const { viewMode } = get()
        const nextMode: ViewMode = viewMode === 'edit-preview' || viewMode === 'preview' ? 'edit' : 'edit-preview'
        eventMarker.start('switch-mode-start', { from: viewMode, to: nextMode })
        if (viewMode === 'edit-preview' || viewMode === 'preview') {
          set({ viewMode: 'edit', previewVisible: false })
        } else {
          set((s) => ({
            viewMode: 'edit-preview',
            previewVisible: true,
            viewModeUsage: markUserViewModeUse(s.viewModeUsage, 'edit-preview', s.viewMode),
          }))
        }
      },

      toggleDiffPreview: () => {
        const { viewMode } = get()
        const nextMode: ViewMode = viewMode === 'diff-preview' ? 'edit' : 'diff-preview'
        eventMarker.start('switch-mode-start', { from: viewMode, to: nextMode })
        if (viewMode === 'diff-preview') {
          set({ viewMode: 'edit', previewVisible: false })
        } else {
          set((s) => ({
            viewMode: 'diff-preview',
            previewVisible: false,
            viewModeUsage: markUserViewModeUse(s.viewModeUsage, 'diff-preview', s.viewMode),
          }))
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
        const previousMode = get().viewMode
        if (mode === previousMode) return
        eventMarker.start('switch-mode-start', { from: previousMode, to: mode })
        if (shouldMaskPreviewSwitch(mode)) eventMarker.mark('preview-render-start', { mode })
        if (mode === 'edit') {
          set({ viewMode: 'edit', previewVisible: false })
        } else if (mode === 'preview') {
          set((s) => ({
            viewMode: 'preview',
            previewVisible: true,
            viewModeUsage: markUserViewModeUse(s.viewModeUsage, mode, s.viewMode),
          }))
        } else if (mode === 'edit-preview') {
          set((s) => ({
            viewMode: 'edit-preview',
            previewVisible: true,
            viewModeUsage: markUserViewModeUse(s.viewModeUsage, mode, s.viewMode),
          }))
        } else if (mode === 'dual-preview') {
          const { activeTabId, rightPaneTabId, rightPaneUserSelected, tabs } = get()
          const hasRightPaneTab = tabs.some((tab) => tab.id === rightPaneTabId)
          const nextRightPaneTabId = rightPaneUserSelected && hasRightPaneTab
            ? rightPaneTabId
            : activeTabId
          set({
            viewMode: 'dual-preview',
            previewVisible: false,
            rightPaneTabId: nextRightPaneTabId,
            rightPaneUserSelected: rightPaneUserSelected && hasRightPaneTab,
            viewModeUsage: markUserViewModeUse(get().viewModeUsage, mode, get().viewMode),
          })
        } else if (mode === 'diff-preview') {
          set((s) => ({
            viewMode: 'diff-preview',
            previewVisible: false,
            viewModeUsage: markUserViewModeUse(s.viewModeUsage, mode, s.viewMode),
          }))
        }
      },

      setRightPaneTabId: (id) => set({
        rightPaneTabId: id,
        rightPaneUserSelected: Boolean(id),
      }),

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
              ? { ...tab, filePath, title, content, savedContent: content, originalContent: content, modified: false }
              : tab
          ),
        }))
        get().addRecentFile(filePath, title)
      },

      requestReveal: (tabId, startLine, endLine) => set({
        pendingReveal: { tabId, startLine, endLine },
      }),

      clearPendingReveal: () => set({ pendingReveal: null }),

      flushReadingPositions: (positions) => set((s) => ({
        readingPositions: { ...s.readingPositions, ...positions },
      })),
    }),
    {
      name: 'guanmo-editor',
      storage: createDeferredEditorStorage(250),
      partialize: (state) => ({
        recentFiles: state.recentFiles,
        favorites: state.favorites,
        tabs: state.tabs.map(compactPersistedTab),
        activeTabId: state.activeTabId,
        viewMode: state.viewMode,
        rightPaneTabId: state.rightPaneTabId,
        rightPaneUserSelected: state.rightPaneUserSelected,
        viewModeUsage: state.viewModeUsage,
        readingPositions: state.readingPositions,
        pendingReveal: null,
      }),
      merge: (persisted, current) => {
        const saved = persisted as Partial<EditorState>
        const tabs = dedupeRestoredTabs(saved.tabs ?? current.tabs)
        const activeTabId = tabs.some((tab) => tab.id === saved.activeTabId)
          ? saved.activeTabId ?? null
          : tabs[0]?.id ?? null
        const rightPaneTabId = tabs.some((tab) => tab.id === saved.rightPaneTabId)
          ? saved.rightPaneTabId ?? null
          : null
        const rightPaneUserSelected = Boolean(saved.rightPaneUserSelected && rightPaneTabId)

        return {
          ...current,
          ...saved,
          tabs,
          activeTabId,
          rightPaneTabId,
          rightPaneUserSelected,
          viewModeUsage: saved.viewModeUsage ?? current.viewModeUsage,
          readingPositions: saved.readingPositions ?? current.readingPositions,
          recentFiles: dedupeRecentFiles(saved.recentFiles ?? current.recentFiles),
          pendingReveal: null,
          previewSwitchingTabId: null,
        }
      },
    }
  )
)
