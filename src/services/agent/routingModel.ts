import { createChatProvider, getAiClient, getAiConfig } from '@/services/ai/aiClient'
import type { AiConfig, AiProvider, ChatRequest } from '@/services/ai/types'

let cached: { source: AiConfig; model: string; client: AiProvider } | undefined

/** Reuse the same credential-bound connection; only the model name may differ. */
export function routingModelChat(model: string, request: ChatRequest) {
  const config = getAiConfig()
  if (!config || !model || model === config.chatModel) return getAiClient().chat(request)
  if (cached?.source !== config || cached.model !== model) {
    cached = { source: config, model, client: createChatProvider({ ...config, chatModel: model }) }
  }
  return cached.client.chat(request)
}
