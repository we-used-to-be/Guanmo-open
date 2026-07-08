import type {
  AiProvider,
  AiConfig,
  ChatRequest,
  ChatResponse,
  StreamChunk,
  EmbeddingResponse,
} from '../types'
import { AiAuthError, AiNetworkError, AiError } from '../errors'
import { parseSSEStream } from '../stream'

function isLocalApi(baseUrl: string): boolean {
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

function wrapNetworkError(err: unknown, baseUrl: string): AiNetworkError {
  const rawMsg = (err as Error).message || String(err)
  if (isLocalApi(baseUrl)) {
    return new AiNetworkError(`本地模型服务连接失败，请确认模型已启动（${rawMsg}）`)
  }
  return new AiNetworkError(rawMsg)
}

export class OpenAICompatibleProvider implements AiProvider {
  constructor(private config: AiConfig) {}

  private createAbortContext(signal?: AbortSignal) {
    const controller = new AbortController()
    let timeout: ReturnType<typeof setTimeout>
    const refreshTimeout = () => {
      clearTimeout(timeout)
      timeout = setTimeout(() => controller.abort(new DOMException('timeout', 'AbortError')), this.config.timeout)
    }
    const forwardAbort = () => controller.abort(signal?.reason || 'aborted')
    signal?.addEventListener('abort', forwardAbort, { once: true })
    refreshTimeout()

    return {
      signal: controller.signal,
      refreshTimeout,
      cleanup: () => {
        clearTimeout(timeout)
        signal?.removeEventListener('abort', forwardAbort)
      },
    }
  }

  private get headers(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    }
    if (this.config.apiKey) {
      headers['Authorization'] = `Bearer ${this.config.apiKey}`
    }
    return headers
  }

  private get baseUrl(): string {
    return this.config.baseUrl.replace(/\/+$/, '')
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const body = {
      model: this.config.chatModel,
      messages: request.messages,
      stream: false,
      temperature: request.temperature ?? this.config.temperature,
      top_p: this.config.topP,
      max_tokens: request.maxTokens,
      tools: request.tools && request.tools.length > 0 ? request.tools : undefined,
      tool_choice: request.tools && request.tools.length > 0 ? request.toolChoice || 'auto' : undefined,
    }

    const abort = this.createAbortContext(request.signal)

    try {
      const res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify(body),
        signal: abort.signal,
      })

      if (res.status === 401) throw new AiAuthError()
      if (!res.ok) {
        const text = await res.text()
        throw new AiError(text, 'API_ERROR', res.status)
      }

      const data = await res.json()
      const message = data.choices[0].message
      return {
        id: data.id,
        content: message.content || '',
        role: 'assistant',
        toolCalls: Array.isArray(message.tool_calls)
          ? message.tool_calls
              .filter((call: { function?: { name?: unknown; arguments?: unknown } }) => typeof call.function?.name === 'string')
              .map((call: { id?: string; function: { name: string; arguments?: string } }) => {
                let args: Record<string, unknown> = {}
                try {
                  args = call.function.arguments ? JSON.parse(call.function.arguments) : {}
                } catch {
                  args = {}
                }
                return { id: call.id, name: call.function.name, args }
              })
          : undefined,
        usage: data.usage
          ? {
              promptTokens: data.usage.prompt_tokens,
              completionTokens: data.usage.completion_tokens,
              totalTokens: data.usage.total_tokens,
            }
          : undefined,
      }
    } catch (err) {
      if (err instanceof AiError) throw err
      if ((err as Error).name === 'AbortError') {
        throw new AiNetworkError(request.signal?.aborted ? 'Request aborted' : 'Request timeout')
      }
      throw wrapNetworkError(err, this.baseUrl)
    } finally {
      abort.cleanup()
    }
  }

  async *streamChat(request: ChatRequest): AsyncIterable<StreamChunk> {
    const body = {
      model: this.config.chatModel,
      messages: request.messages,
      stream: true,
      temperature: request.temperature ?? this.config.temperature,
      top_p: this.config.topP,
      max_tokens: request.maxTokens,
      tools: request.tools && request.tools.length > 0 ? request.tools : undefined,
      tool_choice: request.tools && request.tools.length > 0 ? request.toolChoice || 'auto' : undefined,
    }

    const abort = this.createAbortContext(request.signal)

    try {
      const res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify(body),
        signal: abort.signal,
      })

      if (res.status === 401) throw new AiAuthError()
      if (!res.ok) {
        const text = await res.text()
        throw new AiError(text, 'API_ERROR', res.status)
      }

      abort.refreshTimeout()
      for await (const chunk of parseSSEStream(res)) {
        abort.refreshTimeout()
        yield chunk
      }
    } catch (err) {
      if (err instanceof AiError) throw err
      if ((err as Error).name === 'AbortError') {
        throw new AiNetworkError(request.signal?.aborted ? 'Request aborted' : 'Request timeout')
      }
      throw wrapNetworkError(err, this.baseUrl)
    } finally {
      abort.cleanup()
    }
  }

  async embedding(text: string, signal?: AbortSignal): Promise<EmbeddingResponse> {
    const body = {
      model: this.config.embedding.embeddingModel,
      input: text,
    }

    const abort = this.createAbortContext(signal)

    try {
      const res = await fetch(`${this.baseUrl}/embeddings`, {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify(body),
        signal: abort.signal,
      })

      if (res.status === 401) throw new AiAuthError()
      if (!res.ok) {
        const errText = await res.text()
        throw new AiError(errText, 'API_ERROR', res.status)
      }

      const data = await res.json()
      return {
        embedding: data.data[0].embedding,
        usage: data.usage
          ? { totalTokens: data.usage.total_tokens }
          : undefined,
      }
    } catch (err) {
      if (err instanceof AiError) throw err
      if ((err as Error).name === 'AbortError') {
        throw new AiNetworkError(signal?.aborted ? 'Request aborted' : 'Request timeout')
      }
      throw wrapNetworkError(err, this.baseUrl)
    } finally {
      abort.cleanup()
    }
  }

  async batchEmbedding(texts: string[], signal?: AbortSignal): Promise<number[][]> {
    if (texts.length === 0) return []

    const body = {
      model: this.config.embedding.embeddingModel,
      input: texts,
    }

    const abort = this.createAbortContext(signal)

    try {
      const res = await fetch(`${this.baseUrl}/embeddings`, {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify(body),
        signal: abort.signal,
      })

      if (res.status === 401) throw new AiAuthError()
      if (!res.ok) {
        const errText = await res.text()
        throw new AiError(errText, 'API_ERROR', res.status)
      }

      const data = await res.json()
      return data.data
        .sort((a: { index: number; embedding: number[] }, b: { index: number }) => a.index - b.index)
        .map((item: { embedding: number[] }) => item.embedding)
    } catch (err) {
      if (err instanceof AiError) throw err
      if ((err as Error).name === 'AbortError') {
        throw new AiNetworkError(signal?.aborted ? 'Request aborted' : 'Request timeout')
      }
      throw wrapNetworkError(err, this.baseUrl)
    } finally {
      abort.cleanup()
    }
  }

  async validateConfig(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/models`, {
        headers: this.headers,
      })
      return res.ok
    } catch {
      return false
    }
  }

  async listModels(): Promise<string[]> {
    const res = await fetch(`${this.baseUrl}/models`, {
      headers: this.headers,
    })

    if (!res.ok) return []

    const data = await res.json()
    return data.data?.map((m: { id: string }) => m.id) || []
  }
}
