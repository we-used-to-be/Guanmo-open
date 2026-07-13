import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { AiConfig, ChatProtocol, CustomPreset, EmbeddingConfig, EmbeddingProtocol, ProviderId } from '@/services/ai/types'
import { DEFAULT_AI_CONFIG } from '@/services/ai/types'
import { inferProvider } from '@/services/ai/aiClient'
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
  syncScroll: boolean
  autoSendAiShortcut: boolean
  modePrewarm: 'off' | 'smart' | 'turbo'
}

interface AppearanceSettings {
  customCursorEnabled: boolean
  theme: 'light' | 'dark'
  lightPalette: 'warm' | 'plain'
}

type AppearanceTheme = AppearanceSettings['theme']
type LightPalette = AppearanceSettings['lightPalette']

interface SettingsState {
  ai: AiConfig
  editor: EditorSettings
  appearance: AppearanceSettings
  webSearch: WebSearchConfig
  customChatPresets: CustomPreset[]
  customEmbeddingPresets: CustomPreset[]

  updateAiConfig: (config: Partial<AiConfig>) => void
  updateEmbeddingConfig: (config: Partial<EmbeddingConfig>) => void
  updateEditorSettings: (settings: Partial<EditorSettings>) => void
  updateAppearanceSettings: (settings: Partial<AppearanceSettings>) => void
  updateWebSearchConfig: (config: Partial<WebSearchConfig>) => void
  addCustomChatPreset: (preset: CustomPreset) => void
  removeCustomChatPreset: (id: string) => void
  addCustomEmbeddingPreset: (preset: CustomPreset) => void
  removeCustomEmbeddingPreset: (id: string) => void
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
  syncScroll: true,
  autoSendAiShortcut: false,
  modePrewarm: 'smart',
}

const DEFAULT_APPEARANCE_SETTINGS: AppearanceSettings = {
  customCursorEnabled: false,
  theme: 'light',
  lightPalette: 'warm',
}

const DEFAULT_WEB_SEARCH: WebSearchConfig = {
  provider: 'duckduckgo',
  apiKey: '',
  maxResults: 5,
  customUrl: '',
}

const THEME_SWITCH_THROTTLE_MS = 180
let lastThemeSwitchAt = 0

export function syncDocumentTheme(theme: AppearanceTheme, lightPalette: LightPalette = 'warm') {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  root.dataset.theme = theme
  root.dataset.lightPalette = lightPalette
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      ai: DEFAULT_AI_CONFIG,
      editor: DEFAULT_EDITOR_SETTINGS,
      appearance: DEFAULT_APPEARANCE_SETTINGS,
      webSearch: DEFAULT_WEB_SEARCH,
      customChatPresets: [],
      customEmbeddingPresets: [],

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
        set((s) => {
          let nextSettings = settings
          if (settings.theme && settings.theme !== s.appearance.theme) {
            const now = typeof performance !== 'undefined' ? performance.now() : Date.now()
            if (now - lastThemeSwitchAt < THEME_SWITCH_THROTTLE_MS) {
              const { theme: _theme, ...rest } = settings
              nextSettings = rest
            } else {
              lastThemeSwitchAt = now
            }
          }
          if (Object.keys(nextSettings).length === 0) return s
          const appearance = { ...s.appearance, ...nextSettings }
          if ('theme' in nextSettings || 'lightPalette' in nextSettings) {
            syncDocumentTheme(appearance.theme, appearance.lightPalette)
          }
          return { appearance }
        }),

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

      addCustomChatPreset: (preset) =>
        set((s) => {
          const existing = s.customChatPresets.findIndex((p) => p.id === preset.id)
          if (existing >= 0) {
            const updated = [...s.customChatPresets]
            updated[existing] = preset
            return { customChatPresets: updated }
          }
          return { customChatPresets: [...s.customChatPresets, preset] }
        }),

      removeCustomChatPreset: (id) =>
        set((s) => ({ customChatPresets: s.customChatPresets.filter((p) => p.id !== id) })),

      addCustomEmbeddingPreset: (preset) =>
        set((s) => {
          const existing = s.customEmbeddingPresets.findIndex((p) => p.id === preset.id)
          if (existing >= 0) {
            const updated = [...s.customEmbeddingPresets]
            updated[existing] = preset
            return { customEmbeddingPresets: updated }
          }
          return { customEmbeddingPresets: [...s.customEmbeddingPresets, preset] }
        }),

      removeCustomEmbeddingPreset: (id) =>
        set((s) => ({ customEmbeddingPresets: s.customEmbeddingPresets.filter((p) => p.id !== id) })),
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
        // 向后兼容：旧配置没有 protocol/provider，自动补全
        const savedAi = saved.ai
        const patchedAi = savedAi ? {
          ...savedAi,
          protocol: savedAi.protocol || 'openai-chat' as const,
          provider: savedAi.provider || (savedAi.baseUrl ? inferProvider(savedAi.baseUrl) : 'custom' as const),
          embedding: savedAi.embedding ? {
            ...savedAi.embedding,
            protocol: savedAi.embedding.protocol || 'openai-embedding' as const,
            provider: savedAi.embedding.provider || (savedAi.embedding.baseUrl ? inferProvider(savedAi.embedding.baseUrl) : 'custom' as const),
            apiKey: '',
          } : current.ai.embedding,
          apiKey: '',
        } : undefined
        // 向后兼容：旧自定义预设没有 protocol/provider，补齐后类型断言
        const VALID_CHAT_PROTOCOLS: ChatProtocol[] = ['openai-chat', 'anthropic-messages', 'openai-responses']
        const patchedChatPresets: CustomPreset[] = (saved.customChatPresets || []).map((p) => ({
          id: p.id || '',
          label: p.label || '',
          protocol: VALID_CHAT_PROTOCOLS.includes((p as unknown as Record<string, unknown>).protocol as ChatProtocol)
            ? (p as unknown as Record<string, unknown>).protocol as ChatProtocol
            : 'openai-chat',
          provider: ((p as unknown as Record<string, unknown>).provider as ProviderId) || (p.baseUrl ? inferProvider(p.baseUrl) : 'custom'),
          baseUrl: p.baseUrl || '',
          chatModel: p.chatModel,
          embeddingModel: p.embeddingModel,
          capabilities: p.capabilities,
        }))
        const patchedEmbPresets: CustomPreset[] = (saved.customEmbeddingPresets || []).map((p) => ({
          id: p.id || '',
          label: p.label || '',
          protocol: ((p as unknown as Record<string, unknown>).protocol as EmbeddingProtocol) || 'openai-embedding',
          provider: ((p as unknown as Record<string, unknown>).provider as ProviderId) || (p.baseUrl ? inferProvider(p.baseUrl) : 'custom'),
          baseUrl: p.baseUrl || '',
          chatModel: p.chatModel,
          embeddingModel: p.embeddingModel,
          capabilities: p.capabilities,
        }))
        return {
          ...current,
          ...saved,
          ai: patchedAi || current.ai,
          customChatPresets: patchedChatPresets.length > 0 ? patchedChatPresets : current.customChatPresets,
          customEmbeddingPresets: patchedEmbPresets.length > 0 ? patchedEmbPresets : current.customEmbeddingPresets,
          editor: {
            ...current.editor,
            ...saved.editor,
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
