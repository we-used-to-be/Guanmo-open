import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import { createWorkspaceRoot, normalizeWorkspacePath, type WorkspaceRoot } from '@/services/workspaceIdentity'
import { isWebRuntime } from '@/services/runtimeCapabilities'
import { createVolatilePersistStorage } from '@/services/webSessionStorage'

export { createWorkspaceRoot, normalizeWorkspacePath } from '@/services/workspaceIdentity'
export type { WorkspaceRoot } from '@/services/workspaceIdentity'

export interface FullscreenAiPosition {
  x: number
  y: number
}

export interface FullscreenAiSize {
  width: number
  height: number
}

export type SidebarSection = 'recentFiles' | 'favorites' | 'workspace'

export interface SidebarSectionExpanded {
  recentFiles: boolean
  favorites: boolean
  workspace: boolean
}

const DEFAULT_SIDEBAR_SECTION_EXPANDED: SidebarSectionExpanded = {
  recentFiles: true,
  favorites: false,
  workspace: true,
}

export type AiServiceStatus =
  | 'unchecked'
  | 'ok'
  | 'chat_unreachable'
  | 'embedding_unreachable'
  | 'both_unreachable'
  | 'search_unreachable'
  | 'chat_search_unreachable'
  | 'embedding_search_unreachable'
  | 'all_unreachable'
  | 'not_configured'

export interface AppState {
  sidebarCollapsed: boolean
  sidebarSectionExpanded: SidebarSectionExpanded
  aiPanelOpen: boolean
  sidebarWidth: number
  aiPanelWidth: number
  fullscreenAiPosition: FullscreenAiPosition | null
  fullscreenAiSize: FullscreenAiSize | null
  workspaceRoots: WorkspaceRoot[]
  aiStatus: AiServiceStatus
  isFullscreen: boolean

  toggleSidebar: () => void
  setSidebarSectionExpanded: (section: SidebarSection, expanded: boolean) => void
  toggleAiPanel: () => void
  closeAiPanel: () => void
  setSidebarWidth: (width: number) => void
  setAiPanelWidth: (width: number) => void
  setFullscreenAiPosition: (position: FullscreenAiPosition) => void
  setFullscreenAiSize: (size: FullscreenAiSize) => void
  addWorkspaceRoot: (path: string) => boolean
  removeWorkspaceRoot: (id: string) => void
  resetWorkspaceForWebSession: () => void
  setAiStatus: (status: AiServiceStatus) => void
  setFullscreen: (isFullscreen: boolean) => void
}

function sanitizeWorkspaceRoots(value: unknown): WorkspaceRoot[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const roots: WorkspaceRoot[] = []
  for (const item of value) {
    if (!item || typeof item !== 'object') continue
    const candidate = item as Partial<WorkspaceRoot>
    if (typeof candidate.path !== 'string') continue
    const identity = normalizeWorkspacePath(candidate.path)
    if (!identity || seen.has(identity)) continue
    const root = createWorkspaceRoot(candidate.path, typeof candidate.id === 'string' && candidate.id ? candidate.id : undefined)
    if (!root) continue
    if (typeof candidate.name === 'string' && candidate.name.trim()) root.name = candidate.name.trim()
    seen.add(identity)
    roots.push(root)
  }
  return roots
}

function sanitizeFullscreenAiPosition(value: unknown): FullscreenAiPosition | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as Partial<FullscreenAiPosition>
  if (!Number.isFinite(candidate.x) || !Number.isFinite(candidate.y)) return null
  return { x: candidate.x as number, y: candidate.y as number }
}

function sanitizeFullscreenAiSize(value: unknown): FullscreenAiSize | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as Partial<FullscreenAiSize>
  if (!Number.isFinite(candidate.width) || !Number.isFinite(candidate.height)) return null
  return { width: candidate.width as number, height: candidate.height as number }
}

function sanitizeSidebarSectionExpanded(value: unknown): SidebarSectionExpanded {
  if (!value || typeof value !== 'object') return { ...DEFAULT_SIDEBAR_SECTION_EXPANDED }
  const candidate = value as Partial<SidebarSectionExpanded>
  return {
    recentFiles: typeof candidate.recentFiles === 'boolean' ? candidate.recentFiles : DEFAULT_SIDEBAR_SECTION_EXPANDED.recentFiles,
    favorites: typeof candidate.favorites === 'boolean' ? candidate.favorites : DEFAULT_SIDEBAR_SECTION_EXPANDED.favorites,
    workspace: typeof candidate.workspace === 'boolean' ? candidate.workspace : DEFAULT_SIDEBAR_SECTION_EXPANDED.workspace,
  }
}

export function migratePersistedAppState(persistedState: unknown): Partial<AppState> {
  const saved = (persistedState ?? {}) as Partial<AppState> & { workspacePath?: string | null }
  const workspaceRoots = sanitizeWorkspaceRoots(
    Array.isArray(saved.workspaceRoots)
      ? saved.workspaceRoots
      : saved.workspacePath
        ? [createWorkspaceRoot(saved.workspacePath)]
        : []
  )
  const { workspacePath: _legacyWorkspacePath, ...rest } = saved
  return {
    ...rest,
    fullscreenAiPosition: sanitizeFullscreenAiPosition(saved.fullscreenAiPosition),
    fullscreenAiSize: sanitizeFullscreenAiSize(saved.fullscreenAiSize),
    sidebarSectionExpanded: sanitizeSidebarSectionExpanded(saved.sidebarSectionExpanded),
    workspaceRoots,
  }
}

export function selectPrimaryWorkspacePath(state: Pick<AppState, 'workspaceRoots'>): string | null {
  return state.workspaceRoots[0]?.path ?? null
}

export const useAppStore = create<AppState>()(
  persist(
    (set) => ({
      sidebarCollapsed: true,
      sidebarSectionExpanded: { ...DEFAULT_SIDEBAR_SECTION_EXPANDED },
      aiPanelOpen: false,
      sidebarWidth: 260,
      aiPanelWidth: 360,
      fullscreenAiPosition: null,
      fullscreenAiSize: null,
      workspaceRoots: [],
      aiStatus: 'unchecked',
      isFullscreen: false,

      toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
      setSidebarSectionExpanded: (section, expanded) => set((state) => ({
        sidebarSectionExpanded: state.sidebarSectionExpanded[section] === expanded
          ? state.sidebarSectionExpanded
          : { ...state.sidebarSectionExpanded, [section]: expanded },
      })),
      toggleAiPanel: () => set((s) => ({ aiPanelOpen: !s.aiPanelOpen })),
      closeAiPanel: () => set({ aiPanelOpen: false }),
      setSidebarWidth: (width) => set({ sidebarWidth: width }),
      setAiPanelWidth: (width) => set({ aiPanelWidth: width }),
      setFullscreenAiPosition: (position) => set({ fullscreenAiPosition: position }),
      setFullscreenAiSize: (size) => set({ fullscreenAiSize: size }),
      addWorkspaceRoot: (path) => {
        const root = createWorkspaceRoot(path)
        if (!root) return false
        let added = false
        set((state) => {
          const identity = normalizeWorkspacePath(root.path)
          if (state.workspaceRoots.some((item) => normalizeWorkspacePath(item.path) === identity)) return state
          added = true
          return { workspaceRoots: [...state.workspaceRoots, root] }
        })
        return added
      },
      removeWorkspaceRoot: (id) => set((state) => ({
        workspaceRoots: state.workspaceRoots.filter((root) => root.id !== id),
      })),
      resetWorkspaceForWebSession: () => set({ workspaceRoots: [], aiStatus: 'unchecked' }),
      setAiStatus: (status) => set({ aiStatus: status }),
      setFullscreen: (isFullscreen) => set({ isFullscreen }),
    }),
    {
      name: 'guanmo-app',
      storage: isWebRuntime()
        ? createVolatilePersistStorage<Partial<AppState>>()
        : createJSONStorage<Partial<AppState>>(() => localStorage),
      partialize: (state) => ({
        sidebarWidth: state.sidebarWidth,
        aiPanelWidth: state.aiPanelWidth,
        fullscreenAiPosition: state.fullscreenAiPosition,
        fullscreenAiSize: state.fullscreenAiSize,
        sidebarSectionExpanded: state.sidebarSectionExpanded,
        workspaceRoots: state.workspaceRoots,
      }),
      version: 2,
      migrate: migratePersistedAppState,
      merge: (persistedState, currentState) => ({
        ...currentState,
        ...(persistedState as Partial<AppState>),
        sidebarSectionExpanded: sanitizeSidebarSectionExpanded((persistedState as Partial<AppState>)?.sidebarSectionExpanded),
        workspaceRoots: sanitizeWorkspaceRoots((persistedState as Partial<AppState>)?.workspaceRoots),
        sidebarCollapsed: true,
        aiPanelOpen: false,
      }),
    }
  )
)
