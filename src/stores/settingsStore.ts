import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { AiConfig, ChatProtocol, CustomPreset, EmbeddingConfig, EmbeddingProtocol, ProviderId } from '@/services/ai/types'
import { DEFAULT_AI_CONFIG } from '@/services/ai/types'
import { inferProvider } from '@/services/ai/aiClient'
import type { WebSearchConfig } from '@/services/webSearch'
import { updateSearchConfig } from '@/services/webSearch'
import { DEFAULT_REQUEST_TIMEOUT_MS, normalizeRequestTimeoutMs } from '@/services/requestTimeout'
import {
  AI_API_KEY_SECRET,
  EMBEDDING_API_KEY_SECRET,
  WEB_SEARCH_API_KEY_SECRET,
  deleteSecret,
  saveSecret,
} from '@/services/secureStorage'
import { toast } from '@/services/toast'
import {
  createDefaultAiShortcutActions,
  normalizeAiShortcutActions,
  type AiShortcutAction,
} from '@/services/aiShortcutActions'
import {
  DEFAULT_APPEARANCE_CONFIG_V1,
  resolveAppearanceConfig,
  resolveLastLightThemeId,
  resolveThemeId,
  THEME_IDS,
} from '@/services/appearance/appearanceSchema'
import type { AppearanceConfigV1, CustomThemeDefinition, NonDarkThemeId, ThemeId, ThemeSlot } from '@/services/appearance/appearanceSchema'
import { createAppearanceRegistry } from '@/services/appearance/appearanceRegistry'
import { setAppearanceRegistry, syncDocumentTheme as applyDocumentTheme } from '@/services/appearance/appearanceDom'

export { THEME_IDS, resolveLastLightThemeId, resolveThemeId }
export type { NonDarkThemeId, ThemeId }

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
  inlinePreviewEdit: boolean
  modePerformancePolicy: 'memory' | 'balanced' | 'speed'
  fullscreenContentPaddingPercent: number
  defaultOpenMode: 'edit' | 'preview'
}

export const AI_ASSISTANT_FONT_SIZES = [12, 14, 16, 18] as const
export type AiAssistantFontSize = typeof AI_ASSISTANT_FONT_SIZES[number]

// 保留字段名与持久化结构，避免旧版本配置读取失败；运行时唯一头像方案为小球。
export const AI_AVATAR_STYLES = ['sprite'] as const
export type AiAvatarStyle = typeof AI_AVATAR_STYLES[number]

interface AppearanceSettings extends AppearanceConfigV1 {
  customCursorEnabled: boolean
  aiAvatarStyle: AiAvatarStyle
  aiAssistantFontSize: AiAssistantFontSize
  fullscreenTransitionEnabled: boolean
  lastLightThemeId: NonDarkThemeId
  fullscreenBackgroundPath: string | null
  fullscreenBackgroundOpacity: number
  fullscreenBackgroundEnabled: boolean
  fullscreenBackgroundScene: 'snow' | 'sea' | 'stars' | 'custom' | `local:${string}`
}

interface KnowledgeSettings {
  autoIndexEnabled: boolean
}

interface UsageTrackingSettings {
  enabled: boolean
}

interface SettingsState {
  ai: AiConfig
  editor: EditorSettings
  appearance: AppearanceSettings
  webSearch: WebSearchConfig
  knowledge: KnowledgeSettings
  usageTracking: UsageTrackingSettings
  aiShortcutActions: AiShortcutAction[]
  customChatPresets: CustomPreset[]
  customEmbeddingPresets: CustomPreset[]

  updateAiConfig: (config: Partial<AiConfig>) => void
  updateEmbeddingConfig: (config: Partial<EmbeddingConfig>) => void
  updateEditorSettings: (settings: Partial<EditorSettings>) => void
  updateAppearanceSettings: (settings: Partial<Omit<AppearanceSettings, 'version'>>) => void
  updateWebSearchConfig: (config: Partial<WebSearchConfig>) => void
  updateKnowledgeSettings: (settings: Partial<KnowledgeSettings>) => void
  hydrateSecrets: (
    secrets: { apiKey: string | null; embeddingApiKey: string | null; webSearchApiKey: string | null },
    initial: { apiKey: string; embeddingApiKey: string; webSearchApiKey: string },
  ) => void
  // 仅将 Web 密钥运行时读取到的 API Key 写入内存（不触发 secureStorage 持久化）
  applyWebRuntimeApiKeys: (keys: { chatApiKey: string; webSearchApiKey: string }) => void
  updateUsageTrackingSettings: (settings: Partial<UsageTrackingSettings>) => void
  setAiShortcutActions: (actions: AiShortcutAction[]) => void
  resetAiShortcutActions: () => void
  addCustomChatPreset: (preset: CustomPreset) => void
  removeCustomChatPreset: (id: string) => void
  addCustomEmbeddingPreset: (preset: CustomPreset) => void
  removeCustomEmbeddingPreset: (id: string) => void
  addCustomTheme: (theme: CustomThemeDefinition) => boolean
  removeTheme: (themeId: ThemeId) => boolean
  restoreDefaultThemes: () => void
}

export const FULLSCREEN_CONTENT_PADDING_PERCENT = {
  min: 2,
  max: 30,
  step: 1,
  default: 7,
} as const

const LEGACY_FULLSCREEN_CONTENT_PADDING_REFERENCE_WIDTH = 1280

function resolveFullscreenContentPaddingPercent(value: unknown, legacyValue?: unknown) {
  const numericValue = typeof value === 'number' && Number.isFinite(value)
    ? value
    : typeof legacyValue === 'number' && Number.isFinite(legacyValue)
      ? Math.round((legacyValue / LEGACY_FULLSCREEN_CONTENT_PADDING_REFERENCE_WIDTH) * 100)
      : FULLSCREEN_CONTENT_PADDING_PERCENT.default
  return Math.min(
    FULLSCREEN_CONTENT_PADDING_PERCENT.max,
    Math.max(FULLSCREEN_CONTENT_PADDING_PERCENT.min, Math.round(numericValue)),
  )
}

function resolveFullscreenBackgroundScene(value: unknown): AppearanceSettings['fullscreenBackgroundScene'] {
  if (value === 'snow' || value === 'sea' || value === 'stars') return value
  if (typeof value === 'string' && /^local:[0-9a-f-]{36}$/i.test(value)) return value as `local:${string}`
  return 'custom'
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
  autoSendAiShortcut: true,
  inlinePreviewEdit: true,
  modePerformancePolicy: 'balanced',
  fullscreenContentPaddingPercent: FULLSCREEN_CONTENT_PADDING_PERCENT.default,
  defaultOpenMode: 'preview',
}

const DEFAULT_APPEARANCE_SETTINGS: AppearanceSettings = {
  ...DEFAULT_APPEARANCE_CONFIG_V1,
  customCursorEnabled: false,
  aiAvatarStyle: 'sprite',
  aiAssistantFontSize: 14,
  fullscreenTransitionEnabled: true,
  lastLightThemeId: 'warm',
  fullscreenBackgroundPath: null,
  fullscreenBackgroundOpacity: 40,
  fullscreenBackgroundEnabled: false,
  fullscreenBackgroundScene: 'custom',
}

function resolveAiAssistantFontSize(value: unknown): AiAssistantFontSize {
  return typeof value === 'number' && AI_ASSISTANT_FONT_SIZES.includes(value as AiAssistantFontSize)
    ? value as AiAssistantFontSize
    : DEFAULT_APPEARANCE_SETTINGS.aiAssistantFontSize
}

const DEFAULT_WEB_SEARCH: WebSearchConfig = {
  provider: 'duckduckgo',
  apiKey: '',
  maxResults: 5,
  customUrl: '',
  timeout: DEFAULT_REQUEST_TIMEOUT_MS,
}

const DEFAULT_KNOWLEDGE_SETTINGS: KnowledgeSettings = {
  autoIndexEnabled: true,
}

const DEFAULT_USAGE_TRACKING_SETTINGS: UsageTrackingSettings = {
  enabled: true,
}

export function resolveAiAvatarStyle(
  appearance: unknown,
  current: { appearance: AppearanceSettings },
): AiAvatarStyle {
  // 兼容旧版 aiAvatarStyle 与 aiMascotAvatarEnabled，但已移除的方案统一迁移为小球。
  void appearance
  void current
  return 'sprite'
}

export function syncDocumentTheme(themeId: ThemeId) {
  applyDocumentTheme(themeId)
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      ai: DEFAULT_AI_CONFIG,
      editor: DEFAULT_EDITOR_SETTINGS,
      appearance: DEFAULT_APPEARANCE_SETTINGS,
      webSearch: DEFAULT_WEB_SEARCH,
      knowledge: DEFAULT_KNOWLEDGE_SETTINGS,
      usageTracking: DEFAULT_USAGE_TRACKING_SETTINGS,
      aiShortcutActions: createDefaultAiShortcutActions(),
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

      updateKnowledgeSettings: (settings) => {
        set((s) => ({ knowledge: { ...s.knowledge, ...settings } }))
      },

      hydrateSecrets: (secrets, initial) => set((s) => ({
        ai: {
          ...s.ai,
          ...(secrets.apiKey && s.ai.apiKey === initial.apiKey ? { apiKey: secrets.apiKey } : {}),
          embedding: {
            ...s.ai.embedding,
            ...(secrets.embeddingApiKey && s.ai.embedding.apiKey === initial.embeddingApiKey
              ? { apiKey: secrets.embeddingApiKey }
              : {}),
          },
        },
        webSearch: {
          ...s.webSearch,
          ...(secrets.webSearchApiKey && s.webSearch.apiKey === initial.webSearchApiKey
            ? { apiKey: secrets.webSearchApiKey }
            : {}),
        },
      })),

      applyWebRuntimeApiKeys: ({ chatApiKey, webSearchApiKey }) =>
        set((s) => ({
          ai: { ...s.ai, apiKey: chatApiKey },
          webSearch: { ...s.webSearch, apiKey: webSearchApiKey },
        })),

      updateUsageTrackingSettings: (settings) =>
        set((s) => ({ usageTracking: { ...s.usageTracking, ...settings } })),

      setAiShortcutActions: (actions) =>
        set({ aiShortcutActions: actions.map((action) => ({ ...action })) }),

      resetAiShortcutActions: () =>
        set({ aiShortcutActions: createDefaultAiShortcutActions() }),

      updateAppearanceSettings: (settings) =>
        set((s) => {
          const appearance: AppearanceSettings = {
            ...s.appearance,
            ...settings,
            version: DEFAULT_APPEARANCE_CONFIG_V1.version,
          }
          const registry = createAppearanceRegistry(appearance.themeSlots)
          setAppearanceRegistry(registry)
          if (settings.themeId && registry.getTheme(settings.themeId).colorScheme !== 'dark') {
            appearance.lastLightThemeId = settings.themeId
          }
          if ('themeId' in settings) applyDocumentTheme(appearance.themeId)
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

      addCustomTheme: (theme) => {
        let added = false
        set((s) => {
          const slots = [...s.appearance.themeSlots] as [ThemeSlot, ThemeSlot]
          const emptyIndex = slots.findIndex((slot) => slot === null)
          if (emptyIndex < 0) return s
          const registry = createAppearanceRegistry(slots)
          const duplicate = registry.themes.some((entry) => (
            entry.label.trim().toLocaleLowerCase() === theme.label.trim().toLocaleLowerCase()
          ))
          if (duplicate) return s
          slots[emptyIndex] = { kind: 'custom', theme }
          const nextRegistry = createAppearanceRegistry(slots)
          setAppearanceRegistry(nextRegistry)
          const appearance: AppearanceSettings = {
            ...s.appearance,
            themeId: theme.id,
            lastLightThemeId: theme.colorScheme === 'dark' ? s.appearance.lastLightThemeId : theme.id,
            themeSlots: slots,
            version: DEFAULT_APPEARANCE_CONFIG_V1.version,
          }
          applyDocumentTheme(appearance.themeId)
          added = true
          return { appearance }
        })
        return added
      },

      removeTheme: (themeId) => {
        let removed = false
        set((s) => {
          if (themeId === 'warm' || themeId === 'light' || themeId === 'dark') return s
          const slots = [...s.appearance.themeSlots] as [ThemeSlot, ThemeSlot]
          const slotIndex = slots.findIndex((slot) => (
            slot?.kind === 'builtin'
              ? slot.themeId === themeId
              : slot?.kind === 'custom' && slot.theme.id === themeId
          ))
          if (slotIndex < 0) return s
          slots[slotIndex] = null
          const registry = createAppearanceRegistry(slots)
          setAppearanceRegistry(registry)
          const themeExists = registry.themes.some((theme) => theme.id === s.appearance.themeId)
          const lightExists = registry.themes.some((theme) => (
            theme.id === s.appearance.lastLightThemeId && theme.colorScheme === 'light'
          ))
          const appearance: AppearanceSettings = {
            ...s.appearance,
            themeId: themeExists ? s.appearance.themeId : 'warm',
            lastLightThemeId: lightExists ? s.appearance.lastLightThemeId : 'warm',
            themeSlots: slots,
            version: DEFAULT_APPEARANCE_CONFIG_V1.version,
          }
          applyDocumentTheme(appearance.themeId)
          removed = true
          return { appearance }
        })
        return removed
      },

      restoreDefaultThemes: () => set((s) => {
        const themeSlots = DEFAULT_APPEARANCE_CONFIG_V1.themeSlots
        const registry = createAppearanceRegistry(themeSlots)
        setAppearanceRegistry(registry)
        const themeId = registry.themes.some((theme) => theme.id === s.appearance.themeId)
          ? s.appearance.themeId
          : 'warm'
        const lastLightThemeId = registry.themes.some((theme) => (
          theme.id === s.appearance.lastLightThemeId && theme.colorScheme === 'light'
        )) ? s.appearance.lastLightThemeId : 'warm'
        applyDocumentTheme(themeId)
        return {
          appearance: {
            ...s.appearance,
            themeId,
            lastLightThemeId,
            themeSlots,
            version: DEFAULT_APPEARANCE_CONFIG_V1.version,
          },
        }
      }),
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
          ...current.ai,
          ...savedAi,
          timeout: normalizeRequestTimeoutMs(savedAi.timeout),
          protocol: savedAi.protocol || 'openai-chat' as const,
          provider: savedAi.provider || (savedAi.baseUrl ? inferProvider(savedAi.baseUrl) : 'custom' as const),
          embedding: savedAi.embedding ? {
            ...current.ai.embedding,
            ...savedAi.embedding,
            protocol: savedAi.embedding.protocol || 'openai-embedding' as const,
            provider: savedAi.embedding.provider || (savedAi.embedding.baseUrl ? inferProvider(savedAi.embedding.baseUrl) : 'custom' as const),
            apiKey: '',
            timeout: normalizeRequestTimeoutMs(savedAi.embedding.timeout),
          } : current.ai.embedding,
          apiKey: '',
        } : undefined
        const patchedWebSearch = saved.webSearch ? {
          ...current.webSearch,
          ...saved.webSearch,
          apiKey: '',
          timeout: normalizeRequestTimeoutMs(saved.webSearch.timeout),
        } : current.webSearch
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
          editor: (() => {
            const savedEditor = (saved.editor ?? {}) as Record<string, unknown>
            const {
              modePrewarm: _mp,
              modeResourcePolicy: _mrp,
              modePerformancePolicy: _mpp,
              fullscreenContentPadding: legacyFullscreenContentPadding,
              ...cleanSaved
            } = savedEditor as Record<string, unknown>
            const mergedEditor = { ...current.editor, ...cleanSaved }
            const fullscreenContentPaddingPercent = resolveFullscreenContentPaddingPercent(
              cleanSaved.fullscreenContentPaddingPercent,
              legacyFullscreenContentPadding,
            )
            const validPolicies = ['memory', 'balanced', 'speed']
            const newPolicy = savedEditor.modePerformancePolicy
            if (typeof newPolicy === 'string' && validPolicies.includes(newPolicy)) {
              return {
                ...mergedEditor,
                fullscreenContentPaddingPercent,
                modePerformancePolicy: newPolicy as 'memory' | 'balanced' | 'speed',
              }
            }
            const oldPrewarm = savedEditor.modePrewarm
            const oldResource = savedEditor.modeResourcePolicy
            const prewarmValid = typeof oldPrewarm === 'string' && ['off', 'smart', 'turbo'].includes(oldPrewarm as string)
            const resourceValid = typeof oldResource === 'string' && validPolicies.includes(oldResource as string)
            let migrated: 'memory' | 'balanced' | 'speed' = 'balanced'
            if (prewarmValid && !resourceValid) {
              migrated = ({ off: 'memory' as const, smart: 'balanced' as const, turbo: 'speed' as const })[oldPrewarm as string]!
            } else if (!prewarmValid && resourceValid) {
              migrated = oldResource as 'memory' | 'balanced' | 'speed'
            } else if (prewarmValid && resourceValid) {
              const prewarmRank = ({ off: 0, smart: 1, turbo: 2 } as Record<string, number>)[oldPrewarm as string] ?? 1
              const resourceRank = ({ memory: 0, balanced: 1, speed: 2 } as Record<string, number>)[oldResource as string] ?? 1
              migrated = (['memory', 'balanced', 'speed'] as const)[Math.min(prewarmRank, resourceRank)]
            }
            return { ...mergedEditor, fullscreenContentPaddingPercent, modePerformancePolicy: migrated }
          })(),
          appearance: (() => {
            const savedAppearance = (saved.appearance ?? {}) as unknown as Record<string, unknown>
            const resolved = resolveAppearanceConfig(savedAppearance)
            const registry = createAppearanceRegistry(resolved.themeSlots)
            setAppearanceRegistry(registry)
            const themeId = registry.themes.some((theme) => theme.id === resolved.themeId)
              ? resolved.themeId
              : DEFAULT_APPEARANCE_CONFIG_V1.themeId
            const requestedLastLightThemeId = resolveLastLightThemeId(savedAppearance)
            const lastLightThemeId = registry.themes.some((theme) => (
              theme.id === requestedLastLightThemeId && theme.colorScheme === 'light'
            )) ? requestedLastLightThemeId : DEFAULT_APPEARANCE_CONFIG_V1.themeId
            return {
              customCursorEnabled: typeof savedAppearance.customCursorEnabled === 'boolean'
                ? savedAppearance.customCursorEnabled
                : current.appearance.customCursorEnabled,
              aiAvatarStyle: resolveAiAvatarStyle(savedAppearance, current),
              aiAssistantFontSize: resolveAiAssistantFontSize(savedAppearance.aiAssistantFontSize),
              fullscreenTransitionEnabled: typeof savedAppearance.fullscreenTransitionEnabled === 'boolean'
                ? savedAppearance.fullscreenTransitionEnabled
                : current.appearance.fullscreenTransitionEnabled,
              fullscreenBackgroundPath: typeof savedAppearance.fullscreenBackgroundPath === 'string' && savedAppearance.fullscreenBackgroundPath
                ? savedAppearance.fullscreenBackgroundPath
                : null,
              fullscreenBackgroundOpacity: typeof savedAppearance.fullscreenBackgroundOpacity === 'number' && Number.isFinite(savedAppearance.fullscreenBackgroundOpacity)
                ? Math.min(100, Math.max(0, savedAppearance.fullscreenBackgroundOpacity))
                : savedAppearance.fullscreenBackgroundBrightness === 0
                  ? 0
                  : current.appearance.fullscreenBackgroundOpacity,
              fullscreenBackgroundEnabled: typeof savedAppearance.fullscreenBackgroundEnabled === 'boolean'
                ? savedAppearance.fullscreenBackgroundEnabled
                : Boolean(savedAppearance.fullscreenBackgroundPath),
              fullscreenBackgroundScene: resolveFullscreenBackgroundScene(savedAppearance.fullscreenBackgroundScene),
              ...resolved,
              themeId,
              lastLightThemeId,
            }
          })(),
          webSearch: patchedWebSearch,
          knowledge: {
            ...current.knowledge,
            ...(saved.knowledge || {}),
          },
          usageTracking: {
            ...current.usageTracking,
            ...(saved.usageTracking || {}),
          },
          aiShortcutActions: Object.prototype.hasOwnProperty.call(saved, 'aiShortcutActions')
            ? normalizeAiShortcutActions(saved.aiShortcutActions)
            : current.aiShortcutActions,
        }
      },
    }
  )
)
