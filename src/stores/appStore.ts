import { create } from 'zustand'
import { persist } from 'zustand/middleware'

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

interface AppState {
  sidebarCollapsed: boolean
  aiPanelOpen: boolean
  sidebarWidth: number
  aiPanelWidth: number
  workspacePath: string | null
  aiStatus: AiServiceStatus
  isFullscreen: boolean

  toggleSidebar: () => void
  toggleAiPanel: () => void
  setSidebarWidth: (width: number) => void
  setAiPanelWidth: (width: number) => void
  setWorkspacePath: (path: string | null) => void
  setAiStatus: (status: AiServiceStatus) => void
  setFullscreen: (isFullscreen: boolean) => void
}

export const useAppStore = create<AppState>()(
  persist(
    (set) => ({
      sidebarCollapsed: true,
      aiPanelOpen: false,
      sidebarWidth: 260,
      aiPanelWidth: 360,
      workspacePath: null,
      aiStatus: 'unchecked',
      isFullscreen: false,

      toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
      toggleAiPanel: () => set((s) => ({ aiPanelOpen: !s.aiPanelOpen })),
      setSidebarWidth: (width) => set({ sidebarWidth: width }),
      setAiPanelWidth: (width) => set({ aiPanelWidth: width }),
      setWorkspacePath: (path) => set({ workspacePath: path }),
      setAiStatus: (status) => set({ aiStatus: status }),
      setFullscreen: (isFullscreen) => set({ isFullscreen }),
    }),
    {
      name: 'guanmo-app',
      partialize: (state) => ({
        sidebarWidth: state.sidebarWidth,
        aiPanelWidth: state.aiPanelWidth,
        workspacePath: state.workspacePath,
      }),
      merge: (persistedState, currentState) => ({
        ...currentState,
        ...(persistedState as Partial<AppState>),
        sidebarCollapsed: true,
        aiPanelOpen: false,
      }),
    }
  )
)
