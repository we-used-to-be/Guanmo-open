import { Channel, invoke } from '@tauri-apps/api/core'
import { isTauri } from '@/hooks/useTauri'

export class UnsupportedCapabilityError extends Error {
  constructor(capability: string) {
    super(`当前运行环境不支持${capability}`)
    this.name = 'UnsupportedCapabilityError'
  }
}

export class ExternalHttpError extends Error {
  readonly code: string
  readonly origin?: string

  constructor(code: string, message: string, origin?: string) {
    super(message)
    this.name = 'ExternalHttpError'
    this.code = code
    this.origin = origin
  }
}

export interface AuthorizedApiOrigin {
  origin: string
  persistence: 'session' | 'permanent'
}

type OriginAuthorizationChoice = 'session' | 'permanent' | 'cancel'
type OriginAuthorizationPrompt = (origin: string) => Promise<OriginAuthorizationChoice>

interface NativeHttpRequest {
  requestId: string
  url: string
  method: string
  headers: [string, string][]
  body?: number[]
  timeoutMs?: number
}

let requestSequence = 0

function createRequestId(): string {
  requestSequence += 1
  return `external-http-${Date.now().toString(36)}-${requestSequence.toString(36)}`
}

type NativeStreamEvent =
  | { event: 'start'; status: number; headers: [string, string][] }
  | { event: 'chunk'; data: number[] }
  | { event: 'end' }
  | { event: 'error'; error: { code: string; message: string; origin?: string } }

const STREAM_ACK_WINDOW = 4

let authorizationPrompt: OriginAuthorizationPrompt = showOriginAuthorizationDialog
const pendingAuthorizations = new Map<string, Promise<OriginAuthorizationChoice>>()

export function setOriginAuthorizationPrompt(prompt: OriginAuthorizationPrompt): () => void {
  const previous = authorizationPrompt
  authorizationPrompt = prompt
  return () => { authorizationPrompt = previous }
}

function toExternalHttpError(value: unknown): ExternalHttpError {
  if (value instanceof ExternalHttpError) return value
  let parsed = value
  if (typeof value === 'string') {
    try { parsed = JSON.parse(value) } catch { return new ExternalHttpError('NETWORK_ERROR', value) }
  }
  if (parsed && typeof parsed === 'object') {
    const error = parsed as { code?: unknown; message?: unknown; origin?: unknown }
    return new ExternalHttpError(
      typeof error.code === 'string' ? error.code : 'NETWORK_ERROR',
      typeof error.message === 'string' ? error.message : String(value),
      typeof error.origin === 'string' ? error.origin : undefined,
    )
  }
  return new ExternalHttpError('NETWORK_ERROR', String(value))
}

function showOriginAuthorizationDialog(origin: string): Promise<OriginAuthorizationChoice> {
  if (typeof document === 'undefined') return Promise.resolve('cancel')
  return new Promise((resolve) => {
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const overlay = document.createElement('div')
    overlay.className = 'fixed inset-0 z-[10000] flex items-center justify-center bg-black/45 p-4'
    overlay.setAttribute('role', 'presentation')
    if (!reduceMotion) {
      overlay.style.opacity = '0'
      overlay.style.transition = 'opacity 160ms ease-out'
    }

    const dialog = document.createElement('div')
    dialog.className = 'w-full max-w-md rounded-xl border border-gm-border bg-gm-surface p-5 shadow-2xl'
    dialog.setAttribute('role', 'dialog')
    dialog.setAttribute('aria-modal', 'true')
    dialog.setAttribute('aria-labelledby', 'api-origin-dialog-title')
    if (!reduceMotion) {
      dialog.style.opacity = '0'
      dialog.style.transform = 'translateY(8px) scale(0.98)'
      dialog.style.transition = 'opacity 160ms ease-out, transform 180ms cubic-bezier(0.16, 1, 0.3, 1)'
    }

    const title = document.createElement('h2')
    title.id = 'api-origin-dialog-title'
    title.className = 'text-heading font-semibold text-gm-text'
    title.textContent = '允许连接此 API 地址？'

    const description = document.createElement('p')
    description.className = 'mt-2 text-body text-gm-text-secondary'
    description.textContent = '应用将向以下地址发送当前连接配置中的请求：'

    const address = document.createElement('code')
    address.className = 'mt-2 block break-all rounded-lg bg-gm-surface-elevated px-3 py-2 text-caption text-gm-text'
    address.textContent = origin

    const actions = document.createElement('div')
    actions.className = 'mt-5 flex flex-wrap justify-end gap-2'

    let closing = false
    const finish = (choice: OriginAuthorizationChoice) => {
      if (closing) return
      closing = true
      document.removeEventListener('keydown', onKeyDown)
      const complete = () => {
        overlay.remove()
        resolve(choice)
      }
      if (reduceMotion) {
        complete()
        return
      }
      overlay.style.opacity = '0'
      dialog.style.opacity = '0'
      dialog.style.transform = 'translateY(6px) scale(0.98)'
      dialog.addEventListener('transitionend', complete, { once: true })
      window.setTimeout(() => {
        if (overlay.isConnected) complete()
      }, 220)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') finish('cancel')
    }
    document.addEventListener('keydown', onKeyDown)

    const buttons: Array<[string, OriginAuthorizationChoice, string]> = [
      ['取消', 'cancel', 'border border-gm-border text-gm-text-secondary'],
      ['仅本次', 'session', 'border border-gm-border text-gm-text'],
      ['始终允许', 'permanent', 'bg-gm-primary text-white'],
    ]
    for (const [label, choice, classes] of buttons) {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = `rounded-lg px-3 py-2 text-body transition-opacity hover:opacity-80 ${classes}`
      button.textContent = label
      button.addEventListener('click', () => finish(choice), { once: true })
      actions.appendChild(button)
    }

    dialog.append(title, description, address, actions)
    overlay.appendChild(dialog)
    document.body.appendChild(overlay)
    if (!reduceMotion) {
      requestAnimationFrame(() => {
        overlay.style.opacity = '1'
        dialog.style.opacity = '1'
        dialog.style.transform = 'translateY(0) scale(1)'
      })
    }
    ;(actions.lastElementChild as HTMLButtonElement | null)?.focus()
  })
}

async function requestAuthorization(origin: string): Promise<OriginAuthorizationChoice> {
  const existing = pendingAuthorizations.get(origin)
  if (existing) return existing
  const pending = authorizationPrompt(origin).finally(() => pendingAuthorizations.delete(origin))
  pendingAuthorizations.set(origin, pending)
  return pending
}

async function createNativeRequest(input: string | URL | Request, init?: RequestInit & { timeoutMs?: number }): Promise<NativeHttpRequest> {
  const request = new Request(input, init)
  const headers = new Headers(request.headers)
  if (init?.headers) {
    new Headers(init.headers).forEach((value, name) => headers.set(name, value))
  }
  const body = request.method === 'GET' ? undefined : Array.from(new Uint8Array(await request.arrayBuffer()))
  return {
    requestId: createRequestId(),
    url: request.url,
    method: request.method,
    headers: Array.from(headers.entries()),
    body,
    timeoutMs: init?.timeoutMs,
  }
}

function invokeStream(request: NativeHttpRequest, signal?: AbortSignal): Promise<Response> {
  return new Promise((resolve, reject) => {
    const channel = new Channel<NativeStreamEvent>()
    let controller: ReadableStreamDefaultController<Uint8Array> | null = null
    let settled = false
    let completed = false
    const pendingChunks: Uint8Array[] = []
    let streamEnded = false
    let pullPending = false

    const acknowledgeChunk = () => {
      void invoke('acknowledge_external_http_stream', { requestId: request.requestId }).catch(() => undefined)
    }

    const drain = () => {
      if (!controller || !pullPending || pendingChunks.length === 0) {
        if (controller && streamEnded) controller.close()
        return
      }
      pullPending = false
      controller.enqueue(pendingChunks.shift()!)
      acknowledgeChunk()
      if (pendingChunks.length === 0 && streamEnded) controller.close()
    }

    const cancelNative = () => {
      if (completed) return
      void invoke('cancel_external_http_request', { requestId: request.requestId }).catch(() => undefined)
    }

    const fail = (error: unknown) => {
      completed = true
      const normalized = toExternalHttpError(error)
      if (!settled) {
        settled = true
        reject(normalized)
      } else {
        void import('@/services/productionDiagnostics').then(({ recordDiagnostic }) =>
          recordDiagnostic('ai.request_failed', 'error')).catch(() => undefined)
        controller?.error(normalized)
      }
    }

    const abort = () => {
      cancelNative()
      const error = signal?.reason instanceof Error
        ? signal.reason
        : new DOMException('Request aborted', 'AbortError')
      if (!settled) {
        settled = true
        reject(error)
      } else {
        controller?.error(error)
      }
    }
    if (signal?.aborted) {
      abort()
      return
    }
    signal?.addEventListener('abort', abort, { once: true })

    channel.onmessage = (event) => {
      if (event.event === 'error') {
        fail(event.error)
        signal?.removeEventListener('abort', abort)
        return
      }
      if (event.event === 'start') {
        if (settled) return
        const hasBody = ![204, 205, 304].includes(event.status)
        const stream = hasBody ? new ReadableStream<Uint8Array>({
          start(value) { controller = value },
          pull() {
            pullPending = true
            drain()
          },
          cancel() {
            cancelNative()
            signal?.removeEventListener('abort', abort)
          },
        }, { highWaterMark: 0 }) : null
        settled = true
        resolve(new Response(stream, { status: event.status, headers: event.headers }))
        return
      }
      if (event.event === 'chunk') {
        if (pendingChunks.length >= STREAM_ACK_WINDOW) {
          cancelNative()
          fail(new ExternalHttpError('STREAM_BACKPRESSURE_EXCEEDED', '流式响应超过慢消费者缓冲上限'))
          return
        }
        pendingChunks.push(Uint8Array.from(event.data))
        drain()
        return
      }
      completed = true
      streamEnded = true
      if (pendingChunks.length === 0) controller?.close()
      signal?.removeEventListener('abort', abort)
    }

    invoke('external_http_stream', { request, onEvent: channel })
      .then(() => { if (signal?.aborted) cancelNative() })
      .catch(fail)
  })
}

async function externalFetchInner(input: string | URL | Request, init?: RequestInit & { timeoutMs?: number }): Promise<Response> {
  if (!isTauri()) {
    throw new UnsupportedCapabilityError('外部 API 请求')
  }
  const request = await createNativeRequest(input, init)
  try {
    return await invokeStream(request, init?.signal ?? (input instanceof Request ? input.signal : undefined))
  } catch (error) {
    const normalized = toExternalHttpError(error)
    if (normalized.code !== 'ORIGIN_NOT_AUTHORIZED' || !normalized.origin) throw error
    const choice = await requestAuthorization(normalized.origin)
    if (choice === 'cancel') throw normalized
    await authorizeApiOrigin(normalized.origin, choice)
    return invokeStream(request, init?.signal ?? (input instanceof Request ? input.signal : undefined))
  }
}

export async function externalFetch(input: string | URL | Request, init?: RequestInit & { timeoutMs?: number }): Promise<Response> {
  const startedAt = performance.now()
  try {
    const response = await externalFetchInner(input, init)
    const durationMs = performance.now() - startedAt
    if (durationMs >= 1000) void import('@/services/productionDiagnostics').then(({ recordDiagnostic }) =>
      recordDiagnostic('ai.request_slow', 'slow', durationMs)).catch(() => undefined)
    return response
  } catch (error) {
    void import('@/services/productionDiagnostics').then(({ recordDiagnostic }) =>
      recordDiagnostic('ai.request_failed', 'error', performance.now() - startedAt)).catch(() => undefined)
    throw error
  }
}

export async function authorizeApiOrigin(origin: string, persistence: 'session' | 'permanent'): Promise<string> {
  if (!isTauri()) throw new UnsupportedCapabilityError('API 地址授权')
  return invoke<string>('authorize_api_origin', { request: { origin, persistence } })
}

export async function listAuthorizedApiOrigins(): Promise<AuthorizedApiOrigin[]> {
  if (!isTauri()) throw new UnsupportedCapabilityError('API 地址授权')
  return invoke<AuthorizedApiOrigin[]>('list_authorized_api_origins')
}

export async function revokeApiOrigin(origin: string): Promise<void> {
  if (!isTauri()) throw new UnsupportedCapabilityError('API 地址授权')
  await invoke('revoke_api_origin', { origin })
}
