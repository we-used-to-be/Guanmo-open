import { normalizeRequestTimeoutMs } from '@/services/requestTimeout'

export class UnsupportedCapabilityError extends Error {
  readonly capability: string
  constructor(capability: string, message = `当前浏览器不支持${capability}`) {
    super(message)
    this.name = 'UnsupportedCapabilityError'
    this.capability = capability
  }
}

export class ExternalHttpError extends Error {
  readonly status?: number
  constructor(message: string, status?: number) {
    super(message)
    this.name = 'ExternalHttpError'
    this.status = status
  }
}

function assertSafeUrl(raw: string): URL {
  let url: URL
  try { url = new URL(raw) } catch { throw new ExternalHttpError('请求地址无效') }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')) {
    throw new ExternalHttpError('Web 端仅允许 HTTPS 请求；本机回环地址可使用 HTTP')
  }
  return url
}

export async function externalFetch(input: string | URL, init: RequestInit & { timeoutMs?: number } = {}): Promise<Response> {
  const url = assertSafeUrl(String(input))
  const { timeoutMs, ...requestInit } = init
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort('timeout'), normalizeRequestTimeoutMs(timeoutMs))
  const forwardAbort = () => controller.abort(init.signal?.reason || 'aborted')
  init.signal?.addEventListener('abort', forwardAbort, { once: true })
  try {
    return await fetch(url, {
      ...requestInit,
      signal: controller.signal,
      credentials: 'omit',
      cache: 'no-store',
      mode: 'cors',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
    })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error
    throw new ExternalHttpError('浏览器请求失败，请确认地址可访问且服务允许跨域请求')
  } finally {
    clearTimeout(timeout)
    init.signal?.removeEventListener('abort', forwardAbort)
  }
}

export async function listAuthorizedApiOrigins(): Promise<never> {
  throw new UnsupportedCapabilityError('桌面 API 地址授权管理')
}

export async function revokeApiOrigin(_origin: string): Promise<never> {
  throw new UnsupportedCapabilityError('桌面 API 地址授权管理')
}
