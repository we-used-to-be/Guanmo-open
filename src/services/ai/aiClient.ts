import type { AiProvider, AiConfig, EmbeddingConfig } from './types'
import { AiConfigError } from './errors'
import { OpenAICompatibleProvider } from './providers/openaiCompatible'

let currentProvider: AiProvider | null = null
let currentConfig: AiConfig | null = null

let embeddingProvider: AiProvider | null = null
let embeddingConfig: EmbeddingConfig | null = null

export function initAiClient(config: AiConfig): AiProvider {
  if (!config.apiKey) {
    throw new AiConfigError('API Key is required')
  }
  if (!config.baseUrl) {
    throw new AiConfigError('Base URL is required')
  }
  if (!config.chatModel) {
    throw new AiConfigError('Chat model name is required')
  }

  currentConfig = config
  currentProvider = new OpenAICompatibleProvider(config)
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
  if (!config.apiKey) {
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
    timeout: 60000,
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
