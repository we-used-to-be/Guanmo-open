import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_AI_CONFIG } from '@/services/ai/types'
import { useSettingsStore } from '@/stores/settingsStore'
import { resolveRouterConfig } from '@/services/agent/routerConfig'

const mocks = vi.hoisted(() => ({ mainChat: vi.fn(), routeChat: vi.fn(), create: vi.fn() }))
let config = { ...DEFAULT_AI_CONFIG, baseUrl: 'http://127.0.0.1:1234', chatModel: 'anonymous-main', apiKeyConfigured: true }
vi.mock('@/services/ai/aiClient', async importOriginal => ({
  ...await importOriginal<typeof import('@/services/ai/aiClient')>(),
  getAiConfig: () => config,
  getAiClient: () => ({ chat: mocks.mainChat }),
  createChatProvider: mocks.create,
}))

beforeEach(() => {
  config = { ...config }
  mocks.create.mockReset().mockReturnValue({ chat: mocks.routeChat })
  mocks.mainChat.mockReset().mockResolvedValue({ content: 'anonymous-main' })
  mocks.routeChat.mockReset().mockResolvedValue({ content: 'anonymous-route' })
})

describe('Routing model reuses existing API identity', () => {
  it('reuses the main provider when the model is blank or unchanged', async () => {
    const { routingModelChat } = await import('@/services/agent/routingModel')
    await routingModelChat('', { messages: [] })
    await routingModelChat('anonymous-main', { messages: [] })
    expect(mocks.mainChat).toHaveBeenCalledTimes(2)
    expect(mocks.create).not.toHaveBeenCalled()
  })
  it('caches a model override and preserves the credential-bound target', async () => {
    const { routingModelChat } = await import('@/services/agent/routingModel')
    await routingModelChat('anonymous-small', { messages: [] })
    await routingModelChat('anonymous-small', { messages: [] })
    expect(mocks.create).toHaveBeenCalledTimes(1)
    expect(mocks.create.mock.calls[0][0]).toEqual({ ...config, chatModel: 'anonymous-small' })
    expect(config.chatModel).toBe('anonymous-main')
    config = { ...config, credentialVersion: 2 }
    await routingModelChat('anonymous-small', { messages: [] })
    expect(mocks.create).toHaveBeenCalledTimes(2)
  })
  it('reads old persisted settings without removing the original connection', () => {
    const current = useSettingsStore.getState()
    const merge = useSettingsStore.persist.getOptions().merge!
    const merged = merge({ ai: { ...DEFAULT_AI_CONFIG, chatModel: 'old-model' } }, current)
    expect(merged.ai.chatModel).toBe('old-model')
    expect(resolveRouterConfig(merged.ai.routing)).toMatchObject({ enabled: true, model: '', timeoutMs: 1200 })
  })
})
