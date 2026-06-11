import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { AiConfig, EmbeddingConfig } from '@/services/ai/types'
import { DEFAULT_AI_CONFIG } from '@/services/ai/types'
import type { WebSearchConfig } from '@/services/webSearch'
import { updateSearchConfig } from '@/services/webSearch'
import {
  AI_API_KEY_SECRET,
  EMBEDDING_API_KEY_SECRET,
  WEB_SEARCH_API_KEY_SECRET,
  deleteSecret,
  saveSecret,
} from '@/services/secureStorage'
import { toast } from '@/services/toast'

interface EditorSettings {
  fontSize: number
  lineHeight: number
  fontFamily: string
  tabSize: number
  wordWrap: boolean
  lineNumbers: boolean
  minimap: boolean
  autoSave: boolean
  autoSaveDelay: number
}

interface AppearanceSettings {
  customCursorEnabled: boolean
}

interface SettingsState {
  ai: AiConfig
  editor: EditorSettings
  appearance: AppearanceSettings
  webSearch: WebSearchConfig

  updateAiConfig: (config: Partial<AiConfig>) => void
  updateEmbeddingConfig: (config: Partial<EmbeddingConfig>) => void
  updateEditorSettings: (settings: Partial<EditorSettings>) => void
  updateAppearanceSettings: (settings: Partial<AppearanceSettings>) => void
  updateWebSearchConfig: (config: Partial<WebSearchConfig>) => void
}

const DEFAULT_EDITOR_SETTINGS: EditorSettings = {
  fontSize: 14,
  lineHeight: 1.65,
  fontFamily: "'JetBrains Mono', 'Cascadia Code', monospace",
  tabSize: 2,
  wordWrap: true,
  lineNumbers: true,
  minimap: false,
  autoSave: true,
  autoSaveDelay: 1000,
}

const DEFAULT_APPEARANCE_SETTINGS: AppearanceSettings = {
  customCursorEnabled: true,
}

const DEFAULT_WEB_SEARCH: WebSearchConfig = {
  provider: 'duckduckgo',
  apiKey: '',
  maxResults: 5,
  customUrl: '',
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      ai: DEFAULT_AI_CONFIG,
      editor: DEFAULT_EDITOR_SETTINGS,
      appearance: DEFAULT_APPEARANCE_SETTINGS,
      webSearch: DEFAULT_WEB_SEARCH,

      updateAiConfig: (config) => {
        if ('apiKey' in config) {
          const value = config.apiKey ?? ''
          const task = value
            ? saveSecret(AI_API_KEY_SECRET, value)
            : deleteSecret(AI_API_KEY_SECRET)
          task.catch((err) => { console.warn('[settings] failed to save API key:', err); toast.error('API Key 保存失败') })
        }
        set((s) => ({ ai: { ...s.ai, ...config } }))
      },

      updateEmbeddingConfig: (config) => {
        if ('apiKey' in config) {
          const value = config.apiKey ?? ''
          const task = value
            ? saveSecret(EMBEDDING_API_KEY_SECRET, value)
            : deleteSecret(EMBEDDING_API_KEY_SECRET)
          task.catch((err) => { console.warn('[settings] failed to save embedding API key:', err); toast.error('Embedding Key 保存失败') })
        }
        set((s) => ({ ai: { ...s.ai, embedding: { ...s.ai.embedding, ...config } } }))
      },

      updateEditorSettings: (settings) =>
        set((s) => ({ editor: { ...s.editor, ...settings } })),

      updateAppearanceSettings: (settings) =>
        set((s) => ({ appearance: { ...s.appearance, ...settings } })),

      updateWebSearchConfig: (config) => {
        if ('apiKey' in config) {
          const value = config.apiKey ?? ''
          const task = value
            ? saveSecret(WEB_SEARCH_API_KEY_SECRET, value)
            : deleteSecret(WEB_SEARCH_API_KEY_SECRET)
          task.catch((err) => { console.warn('[settings] failed to save web search API key:', err); toast.error('搜索 Key 保存失败') })
        }
        set((s) => {
          const webSearch = { ...s.webSearch, ...config }
          updateSearchConfig(webSearch)
          return { webSearch }
        })
      },
    }),
    {
      name: 'guanmo-settings',
      partialize: (state) => ({
        ...state,
        ai: {
          ...state.ai,
          apiKey: '',
          embedding: { ...state.ai.embedding, apiKey: '' },
        },
        webSearch: { ...state.webSearch, apiKey: '' },
      }),
      merge: (persisted, current) => {
        const saved = persisted as Partial<SettingsState>
        return {
          ...current,
          ...saved,
          ai: {
            ...current.ai,
            ...saved.ai,
            apiKey: '',
            embedding: {
              ...current.ai.embedding,
              ...saved.ai?.embedding,
              apiKey: '',
            },
          },
          appearance: {
            ...current.appearance,
            ...saved.appearance,
          },
          webSearch: {
            ...current.webSearch,
            ...saved.webSearch,
            apiKey: '',
          },
        }
      },
    }
  )
)
