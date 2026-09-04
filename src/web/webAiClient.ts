import { normalizeRequestTimeoutMs } from '@/services/requestTimeout'
import type { ValidateResult } from '@/services/ai/types'

export interface WebAiMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface WebAiConnectionRequest {
  baseUrl: string
  apiKey: string
  model: string
  timeoutMs: number
}

export interface WebAiRequest {
  baseUrl: string
  apiKey: string
  model: string
  messages: WebAiMessage[]
  signal?: AbortSignal
}

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024

function isLoopbackHostname(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]'
}

export function resolveWebChatCompletionsUrl(baseUrl: string): string {
  let url: URL
  try {
    url = new URL(baseUrl.trim())
  } catch {
    throw new Error('API 地址无效')
  }

  if (url.username || url.password || url.search || url.hash) {
    throw new Error('API 地址不能包含凭据、查询参数或片段')
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopbackHostname(url.hostname))) {
    throw new Error('Web 端仅允许 HTTPS API；本机回环地址可使用 HTTP')
  }

  url.pathname = `${url.pathname.replace(/\/$/, '')}/chat/completions`
  return url.toString()
}

function readAssistantContent(value: unknown): string {
  if (!value || typeof value !== 'object') throw new Error('API 返回格式不受支持')
  const choices = (value as { choices?: unknown }).choices
  if (!Array.isArray(choices) || choices.length === 0) throw new Error('API 未返回回答')
  const first = choices[0]
  if (!first || typeof first !== 'object') throw new Error('API 返回格式不受支持')
  const message = (first as { message?: unknown }).message
  if (!message || typeof message !== 'object') throw new Error('API 返回格式不受支持')
  const content = (message as { content?: unknown }).content
  if (typeof content !== 'string' || !content.trim()) throw new Error('API 返回了空回答')
  return content
}

export async function requestWebAiChat(request: WebAiRequest): Promise<string> {
  const model = request.model.trim()
  if (!model) throw new Error('请填写模型名称')
  const endpoint = resolveWebChatCompletionsUrl(request.baseUrl)
  const headers = new Headers({ 'Content-Type': 'application/json' })
  if (request.apiKey) headers.set('Authorization', `Bearer ${request.apiKey}`)

  let response: Response
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model, messages: request.messages, stream: false }),
      signal: request.signal,
      credentials: 'omit',
      cache: 'no-store',
      mode: 'cors',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
    })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error
    throw new Error('API 请求失败，请确认地址可访问且服务允许浏览器跨域请求')
  }

  if (!response.ok) throw new Error(`API 请求失败（HTTP ${response.status}）`)
  const declaredLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    throw new Error('API 响应过大')
  }
  const text = await response.text()
  if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES) throw new Error('API 响应过大')
  try {
    return readAssistantContent(JSON.parse(text))
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error('API 返回了无效 JSON')
    throw error
  }
}

/** 测试 Web 端 AI 连通性；只使用浏览器 fetch，不经过桌面代理。 */
export async function testWebAiConnection(request: WebAiConnectionRequest): Promise<ValidateResult> {
  const model = request.model.trim()
  if (!model) return { ok: false, error: 'bad_request', message: '请填写模型名称' }

  let endpoint: string
  try {
    endpoint = resolveWebChatCompletionsUrl(request.baseUrl)
  } catch (error) {
    return { ok: false, error: 'bad_request', message: error instanceof Error ? error.message : String(error) }
  }

  const headers = new Headers({ 'Content-Type': 'application/json' })
  if (request.apiKey) headers.set('Authorization', `Bearer ${request.apiKey}`)
  const controller = new AbortController()
  let timedOut = false
  const timeout = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, normalizeRequestTimeoutMs(request.timeoutMs))

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 5,
        stream: false,
      }),
      signal: controller.signal,
      credentials: 'omit',
      cache: 'no-store',
      mode: 'cors',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
    })

    if (response.ok) return { ok: true }
    if (response.status === 401 || response.status === 403) {
      return { ok: false, error: 'auth_failed', message: 'API Key 无效或权限不足' }
    }
    if (response.status === 404) {
      return { ok: false, error: 'not_found', message: '端点或模型不存在，请检查 Base URL 和模型名称' }
    }
    if (response.status === 400 || response.status === 422) {
      return { ok: false, error: 'bad_request', message: '请求参数被拒绝，可能是模型名称不支持' }
    }
    return { ok: false, error: 'unknown', message: `服务返回 HTTP ${response.status}` }
  } catch (error) {
    if (timedOut || (error as Error)?.name === 'AbortError') {
      return { ok: false, error: 'timeout', message: '连接超时，请检查网络或地址是否正确' }
    }
    return {
      ok: false,
      error: 'network_error',
      message: '网络连接失败：API 请求失败，请确认地址可访问且服务允许浏览器跨域请求',
    }
  } finally {
    clearTimeout(timeout)
  }
}
