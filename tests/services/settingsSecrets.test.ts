import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const state = {
    ai: { apiKey: '', embedding: { apiKey: '' } },
    webSearch: { apiKey: '' },
  }
  return {
    state,
    loadSecret: vi.fn(),
    saveSecret: vi.fn(),
    updateSearchConfig: vi.fn(),
    hydrateSecrets: vi.fn((secrets: {
      apiKey: string | null
      embeddingApiKey: string | null
      webSearchApiKey: string | null
    }, initial: {
      apiKey: string
      embeddingApiKey: string
      webSearchApiKey: string
    }) => {
      if (secrets.apiKey && state.ai.apiKey === initial.apiKey) state.ai.apiKey = secrets.apiKey
      if (secrets.embeddingApiKey && state.ai.embedding.apiKey === initial.embeddingApiKey) {
        state.ai.embedding.apiKey = secrets.embeddingApiKey
      }
      if (secrets.webSearchApiKey && state.webSearch.apiKey === initial.webSearchApiKey) {
        state.webSearch.apiKey = secrets.webSearchApiKey
      }
    }),
  }
})

vi.mock('@/stores/settingsStore', () => ({
  useSettingsStore: {
    getState: () => ({ ...mocks.state, hydrateSecrets: mocks.hydrateSecrets }),
    hydrateSecrets: mocks.hydrateSecrets,
  },
}))

vi.mock('@/services/secureStorage', () => ({
  AI_API_KEY_SECRET: 'ai',
  EMBEDDING_API_KEY_SECRET: 'embedding',
  WEB_SEARCH_API_KEY_SECRET: 'search',
  loadSecret: mocks.loadSecret,
  saveSecret: mocks.saveSecret,
}))

vi.mock('@/services/webSearch', () => ({
  updateSearchConfig: mocks.updateSearchConfig,
}))

import {
  ensureSettingsSecretsHydrated,
  resetSettingsSecretsHydrationForTest,
} from '@/services/settingsSecrets'

beforeEach(() => {
  localStorage.clear()
  mocks.loadSecret.mockReset()
  mocks.saveSecret.mockReset()
  mocks.updateSearchConfig.mockReset()
  mocks.hydrateSecrets.mockClear()
  mocks.state.ai = { apiKey: '', embedding: { apiKey: '' } }
  mocks.state.webSearch = { apiKey: '' }
  resetSettingsSecretsHydrationForTest()
})

describe('settings secrets hydration', () => {
  it('shares one hydration promise and loads independent secrets in parallel', async () => {
    const pending = new Map<string, (value: string | null) => void>()
    mocks.loadSecret.mockImplementation((key: string) => new Promise((resolve) => pending.set(key, resolve)))

    const first = ensureSettingsSecretsHydrated()
    const second = ensureSettingsSecretsHydrated()

    expect(second).toBe(first)
    await vi.waitFor(() => expect(mocks.loadSecret).toHaveBeenCalledTimes(3))
    expect(mocks.loadSecret.mock.calls.map(([key]) => key).sort()).toEqual(['ai', 'embedding', 'search'])
    pending.get('ai')?.('chat-key')
    pending.get('embedding')?.('embedding-key')
    pending.get('search')?.('search-key')
    await first

    expect(mocks.hydrateSecrets).toHaveBeenCalledTimes(1)
    expect(mocks.state.ai.apiKey).toBe('chat-key')
    expect(mocks.state.ai.embedding.apiKey).toBe('embedding-key')
    expect(mocks.state.webSearch.apiKey).toBe('search-key')
    expect(mocks.saveSecret).not.toHaveBeenCalled()
  })

  it('does not overwrite keys changed while hydration is pending', async () => {
    const pending = new Map<string, (value: string | null) => void>()
    mocks.loadSecret.mockImplementation((key: string) => new Promise((resolve) => pending.set(key, resolve)))

    const hydration = ensureSettingsSecretsHydrated()
    await vi.waitFor(() => expect(mocks.loadSecret).toHaveBeenCalledTimes(3))
    mocks.state.ai.apiKey = 'new-chat-key'
    mocks.state.ai.embedding.apiKey = 'new-embedding-key'
    mocks.state.webSearch.apiKey = 'new-search-key'
    pending.get('ai')?.('old-chat-key')
    pending.get('embedding')?.('old-embedding-key')
    pending.get('search')?.('old-search-key')
    await hydration

    expect(mocks.state.ai.apiKey).toBe('new-chat-key')
    expect(mocks.state.ai.embedding.apiKey).toBe('new-embedding-key')
    expect(mocks.state.webSearch.apiKey).toBe('new-search-key')
  })

  it('migrates legacy plaintext keys before loading and removes them only after save', async () => {
    localStorage.setItem('guanmo-settings', JSON.stringify({
      state: {
        ai: { apiKey: 'legacy-chat' },
        webSearch: { apiKey: 'legacy-search' },
      },
    }))
    mocks.saveSecret.mockResolvedValue(undefined)
    mocks.loadSecret.mockResolvedValue(null)

    await ensureSettingsSecretsHydrated()

    expect(mocks.saveSecret).toHaveBeenCalledWith('ai', 'legacy-chat')
    expect(mocks.saveSecret).toHaveBeenCalledWith('search', 'legacy-search')
    const persisted = JSON.parse(localStorage.getItem('guanmo-settings')!)
    expect(persisted.state.ai.apiKey).toBe('')
    expect(persisted.state.webSearch.apiKey).toBe('')
  })
})
