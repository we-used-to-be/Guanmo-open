import type { AiProvider, AiConfig, ChatProtocol, EmbeddingConfig, ProviderId, ValidateResult } from './types'
import type { AiServiceStatus } from '../../stores/appStore'
import { AiConfigError } from './errors'
import { OpenAICompatibleProvider } from './providers/openaiCompatible'
import { getSearchConfig } from '../webSearch'
import { externalFetch, UnsupportedCapabilityError } from '../externalHttp'

let currentProvider: AiProvider | null = null
let currentConfig: AiConfig | null = null

let embeddingProvider: AiProvider | null = null
let embeddingConfig: EmbeddingConfig | null = null

/** 判断是否为本地 API（Ollama 等），本地 API 不需要 API Key */
export function isLocalApi(baseUrl: string): boolean {
  try {
    const { hostname } = new URL(baseUrl)
    return (
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname === '::1' ||
      hostname === '[::1]' ||
      /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname) ||
      /^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/.test(hostname) ||
      /^192\.168\.\d{1,3}\.\d{1,3}$/.test(hostname)
    )
  } catch {
    return false
  }
}

/** 根据协议类型创建对话 Provider */
export function createChatProvider(config: AiConfig): AiProvider {
  switch (config.protocol) {
    case 'openai-chat':
      return new OpenAICompatibleProvider(config)
    case 'anthropic-messages':
      throw new AiConfigError('Anthropic Messages 协议尚未实现，请使用 OpenAI Compatible 协议')
    case 'openai-responses':
      throw new AiConfigError('OpenAI Responses 协议尚未实现，请使用 OpenAI Compatible 协议')
    default:
      throw new AiConfigError(`不支持的协议类型: ${(config as AiConfig).protocol}`)
  }
}

/** 从 baseUrl 推断供应商标识（用于旧配置迁移） */
export function inferProvider(baseUrl: string): ProviderId {
  if (!baseUrl) return 'custom'
  const url = baseUrl.toLowerCase()
  if (url.includes('api.openai.com')) return 'openai'
  if (url.includes('api.deepseek.com')) return 'deepseek'
  if (url.includes('api.siliconflow.cn')) return 'siliconflow'
  if (url.includes('bigmodel.cn')) return 'zhipu'
  if (url.includes('xiaomimimo.com')) return 'mimo'
  if (url.includes('localhost') || url.includes('127.0.0.1') || url.includes('::1') || url.includes('ollama')) return 'ollama'
  if (url.includes('dashscope') || url.includes('coding')) return 'coding-plan'
  if (url.includes('anthropic') || url.includes('api.anthropic')) return 'anthropic'
  return 'custom'
}

export function initAiClient(config: AiConfig): AiProvider {
  if (!config.apiKey && !isLocalApi(config.baseUrl)) {
    throw new AiConfigError('API Key is required')
  }
  if (!config.baseUrl) {
    throw new AiConfigError('Base URL is required')
  }
  if (!config.chatModel) {
    throw new AiConfigError('Chat model name is required')
  }

  currentConfig = config
  const effectiveConfig = isLocalApi(config.baseUrl)
    ? { ...config, timeout: Math.min(config.timeout, 15000) }
    : config
  currentProvider = createChatProvider(effectiveConfig)
  return currentProvider
}

export function getAiClient(): AiProvider {
  if (!currentProvider) {
    throw new AiConfigError('AI client not initialized. Call initAiClient first.')
  }
  return currentProvider
}

export function getAiConfig(): AiConfig | null {
  return currentConfig
}

export function isAiReady(): boolean {
  return currentProvider !== null
}

export function initEmbeddingClient(config: EmbeddingConfig): AiProvider {
  if (!config.apiKey && !isLocalApi(config.baseUrl)) {
    throw new AiConfigError('Embedding API Key is required')
  }
  if (!config.baseUrl) {
    throw new AiConfigError('Embedding Base URL is required')
  }
  if (!config.embeddingModel) {
    throw new AiConfigError('Embedding model name is required')
  }

  embeddingConfig = config
  const fullConfig: AiConfig = {
    protocol: 'openai-chat',
    provider: config.provider || 'custom',
    baseUrl: config.baseUrl.replace(/\/embeddings\/?$/, '').replace(/\/+$/, ''),
    apiKey: config.apiKey,
    chatModel: config.embeddingModel,
    streamEnabled: false,
    webSearchEnabled: false,
    customPreferencePrompt: '',
    timeout: isLocalApi(config.baseUrl) ? 15000 : 60000,
    maxContextLength: 8192,
    temperature: 0,
    topP: 1,
    embedding: config,
  }
  embeddingProvider = new OpenAICompatibleProvider(fullConfig)
  return embeddingProvider
}

export function getEmbeddingClient(): AiProvider {
  if (!embeddingProvider) {
    throw new AiConfigError('Embedding client not initialized. Configure embedding API first.')
  }
  return embeddingProvider
}

export function isEmbeddingReady(): boolean {
  return embeddingProvider !== null
}

export function getEmbeddingConfig(): EmbeddingConfig | null {
  return embeddingConfig
}

/** 校验对话、Embedding 和联网搜索服务连通性，返回具体状态 */
export async function validateAiStatus(): Promise<AiServiceStatus> {
  const chatReady = currentProvider !== null
  const embReady = embeddingProvider !== null

  if (!chatReady && !embReady) return 'not_configured'

  const searchCfg = getSearchConfig()
  const searchNeedsCheck = searchCfg.provider !== 'duckduckgo' && searchCfg.provider !== 'custom'

  const [chatResult, embResult, searchOk] = await Promise.all([
    chatReady ? currentProvider!.validateConfig().then(r => r.ok).catch(() => false) : false,
    embReady ? embeddingProvider!.validateConfig().then(r => r.ok).catch(() => false) : false,
    searchNeedsCheck ? validateSearchApi(searchCfg.provider, searchCfg.apiKey) : true,
  ])

  if (chatResult && embResult && searchOk) return 'ok'
  if (!chatResult && !embResult && !searchOk) return 'all_unreachable'
  if (!chatResult && !embResult) return 'both_unreachable'
  if (!chatResult && !searchOk) return 'chat_search_unreachable'
  if (!embResult && !searchOk) return 'embedding_search_unreachable'
  if (!chatResult) return 'chat_unreachable'
  if (!embResult) return 'embedding_unreachable'
  return 'search_unreachable'
}

/** 独立测试连接（不影响全局客户端状态），返回详细 ValidateResult */
export async function testAiConnection(config: AiConfig): Promise<ValidateResult> {
  const provider = createChatProvider(config)
  return provider.validateConfig()
}

/** 轻量校验搜索 API Key 是否有效 */
async function validateSearchApi(provider: string, apiKey: string): Promise<boolean> {
  if (!apiKey) return false
  try {
    if (provider === 'tavily') {
      const res = await externalFetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_key: apiKey, query: 'test', max_results: 1 }),
      })
      return res.ok
    }
    if (provider === 'serper') {
      const res = await externalFetch('https://google.serper.dev/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-KEY': apiKey },
        body: JSON.stringify({ q: 'test', num: 1 }),
      })
      return res.ok
    }
    if (provider === 'brave') {
      const res = await externalFetch('https://api.search.brave.com/res/v1/web/search?q=test&count=1', {
        headers: { 'X-Subscription-Token': apiKey },
      })
      return res.ok
    }
    return true
  } catch (error) {
    if (error instanceof UnsupportedCapabilityError) throw error
    return false
  }
}
