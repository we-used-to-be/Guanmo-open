import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import { createWorkspaceRoot, normalizeWorkspacePath, type WorkspaceRoot } from '@/services/workspaceIdentity'
import { isWebRuntime } from '@/services/runtimeCapabilities'
import { createVolatilePersistStorage } from '@/services/webSessionStorage'

export { createWorkspaceRoot, normalizeWorkspacePath } from '@/services/workspaceIdentity'
export type { WorkspaceRoot } from '@/services/workspaceIdentity'

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
  aiPanelOpen: boolean
  sidebarWidth: number
  aiPanelWidth: number
  workspaceRoots: WorkspaceRoot[]
  aiStatus: AiServiceStatus
  isFullscreen: boolean

  toggleSidebar: () => void
  toggleAiPanel: () => void
  closeAiPanel: () => void
  setSidebarWidth: (width: number) => void
  setAiPanelWidth: (width: number) => void
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
  return { ...rest, workspaceRoots }
}

export function selectPrimaryWorkspacePath(state: Pick<AppState, 'workspaceRoots'>): string | null {
  return state.workspaceRoots[0]?.path ?? null
}

export const useAppStore = create<AppState>()(
  persist(
    (set) => ({
      sidebarCollapsed: true,
      aiPanelOpen: false,
      sidebarWidth: 260,
      aiPanelWidth: 360,
      workspaceRoots: [],
      aiStatus: 'unchecked',
      isFullscreen: false,

      toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
      toggleAiPanel: () => set((s) => ({ aiPanelOpen: !s.aiPanelOpen })),
      closeAiPanel: () => set({ aiPanelOpen: false }),
      setSidebarWidth: (width) => set({ sidebarWidth: width }),
      setAiPanelWidth: (width) => set({ aiPanelWidth: width }),
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
        workspaceRoots: state.workspaceRoots,
      }),
      version: 1,
      migrate: migratePersistedAppState,
      merge: (persistedState, currentState) => ({
        ...currentState,
        ...(persistedState as Partial<AppState>),
        workspaceRoots: sanitizeWorkspaceRoots((persistedState as Partial<AppState>)?.workspaceRoots),
        sidebarCollapsed: true,
        aiPanelOpen: false,
      }),
    }
  )
)
