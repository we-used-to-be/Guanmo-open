import type { AiProvider, AiConfig, EmbeddingConfig } from './types'
import type { AiServiceStatus } from '../../stores/appStore'
import { AiConfigError } from './errors'
import { OpenAICompatibleProvider } from './providers/openaiCompatible'
import { getSearchConfig } from '../webSearch'

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
  currentProvider = new OpenAICompatibleProvider(effectiveConfig)
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

  const [chatOk, embOk, searchOk] = await Promise.all([
    chatReady ? currentProvider!.validateConfig().catch(() => false) : false,
    embReady ? embeddingProvider!.validateConfig().catch(() => false) : false,
    searchNeedsCheck ? validateSearchApi(searchCfg.provider, searchCfg.apiKey) : true,
  ])

  if (chatOk && embOk && searchOk) return 'ok'
  if (!chatOk && !embOk && !searchOk) return 'all_unreachable'
  if (!chatOk && !embOk) return 'both_unreachable'
  if (!chatOk && !searchOk) return 'chat_search_unreachable'
  if (!embOk && !searchOk) return 'embedding_search_unreachable'
  if (!chatOk) return 'chat_unreachable'
  if (!embOk) return 'embedding_unreachable'
  return 'search_unreachable'
}

/** 轻量校验搜索 API Key 是否有效 */
async function validateSearchApi(provider: string, apiKey: string): Promise<boolean> {
  if (!apiKey) return false
  try {
    if (provider === 'tavily') {
      const res = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_key: apiKey, query: 'test', max_results: 1 }),
      })
      return res.ok
    }
    if (provider === 'serper') {
      const res = await fetch('https://google.serper.dev/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-KEY': apiKey },
        body: JSON.stringify({ q: 'test', num: 1 }),
      })
      return res.ok
    }
    if (provider === 'brave') {
      const res = await fetch('https://api.search.brave.com/res/v1/web/search?q=test&count=1', {
        headers: { 'X-Subscription-Token': apiKey },
      })
      return res.ok
    }
    return true
  } catch {
    return false
  }
}
