import { useSettingsStore } from '@/stores/settingsStore'
import { AI_API_KEY_SECRET, EMBEDDING_API_KEY_SECRET, WEB_SEARCH_API_KEY_SECRET, loadSecret, saveSecret } from './secureStorage'
import { updateSearchConfig } from './webSearch'

const SETTINGS_STORAGE_KEY = 'guanmo-settings'

function readLegacyApiKey(): string {
  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY)
    if (!raw) return ''
    const parsed = JSON.parse(raw)
    return parsed?.state?.ai?.apiKey || ''
  } catch {
    return ''
  }
}

function readLegacyWebSearchApiKey(): string {
  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY)
    if (!raw) return ''
    const parsed = JSON.parse(raw)
    return parsed?.state?.webSearch?.apiKey || ''
  } catch {
    return ''
  }
}

function removeLegacyApiKey(): void {
  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY)
    if (!raw) return
    const parsed = JSON.parse(raw)
    if (parsed?.state?.ai) {
      parsed.state.ai.apiKey = ''
      localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(parsed))
    }
  } catch {
    // Ignore malformed legacy settings.
  }
}

function removeLegacyWebSearchApiKey(): void {
  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY)
    if (!raw) return
    const parsed = JSON.parse(raw)
    if (parsed?.state?.webSearch) {
      parsed.state.webSearch.apiKey = ''
      localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(parsed))
    }
  } catch {
    // Ignore malformed legacy settings.
  }
}

let hydrationPromise: Promise<void> | null = null

async function hydrateSettingsSecretsOnce(): Promise<void> {
  const initialSettings = useSettingsStore.getState()
  const initialApiKey = initialSettings.ai.apiKey
  const initialEmbeddingApiKey = initialSettings.ai.embedding.apiKey
  const initialWebSearchApiKey = initialSettings.webSearch.apiKey
  const legacyApiKey = readLegacyApiKey()
  const legacyWebSearchApiKey = readLegacyWebSearchApiKey()
  await Promise.all([
    legacyApiKey
      ? saveSecret(AI_API_KEY_SECRET, legacyApiKey).then(removeLegacyApiKey)
      : Promise.resolve(),
    legacyWebSearchApiKey
      ? saveSecret(WEB_SEARCH_API_KEY_SECRET, legacyWebSearchApiKey).then(removeLegacyWebSearchApiKey)
      : Promise.resolve(),
  ])

  const [apiKey, webSearchApiKey, embeddingApiKey] = await Promise.all([
    loadSecret(AI_API_KEY_SECRET),
    loadSecret(WEB_SEARCH_API_KEY_SECRET),
    loadSecret(EMBEDDING_API_KEY_SECRET),
  ])
  useSettingsStore.getState().hydrateSecrets(
    { apiKey, embeddingApiKey, webSearchApiKey },
    {
      apiKey: initialApiKey,
      embeddingApiKey: initialEmbeddingApiKey,
      webSearchApiKey: initialWebSearchApiKey,
    },
  )
  updateSearchConfig(useSettingsStore.getState().webSearch)
}

export function ensureSettingsSecretsHydrated(): Promise<void> {
  if (!hydrationPromise) {
    hydrationPromise = hydrateSettingsSecretsOnce().catch((error) => {
      hydrationPromise = null
      throw error
    })
  }
  return hydrationPromise
}

export function hydrateSettingsSecrets(): Promise<void> {
  return ensureSettingsSecretsHydrated()
}

export function resetSettingsSecretsHydrationForTest(): void {
  hydrationPromise = null
}
