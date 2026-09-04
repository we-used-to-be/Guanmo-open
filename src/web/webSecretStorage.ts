export const WEB_API_KEY_STORAGE_KEY = 'guanmo-web-api-key-v1'
export const WEB_PLAINTEXT_API_KEYS_STORAGE_KEY = 'guanmo-web-api-keys-plaintext-v1'

const ITERATIONS = 600_000
const encoder = new TextEncoder()
const additionalData = encoder.encode('guanmo:web-api-key:v1')

export interface WebApiSecrets {
  chatApiKey: string
  webSearchApiKey: string
}

interface EncryptedSecret {
  version: 1 | 2
  iterations: number
  salt: string
  iv: string
  ciphertext: string
}

interface PlaintextSecretsV1 extends WebApiSecrets {
  version: 1
}

function toBase64(value: Uint8Array): string {
  let binary = ''
  for (const byte of value) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

async function deriveKey(password: string, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

function parseEncryptedSecret(raw: string): EncryptedSecret {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw new Error('本机保存的 API Key 数据已损坏')
  }
  const secret = value as Partial<EncryptedSecret> | null
  if (!secret || (secret.version !== 1 && secret.version !== 2) || secret.iterations !== ITERATIONS
    || typeof secret.salt !== 'string' || typeof secret.iv !== 'string' || typeof secret.ciphertext !== 'string') {
    throw new Error('本机保存的 API Key 数据格式不受支持')
  }
  return secret as EncryptedSecret
}

function parsePlaintextSecrets(raw: string): WebApiSecrets | null {
  try {
    const value = JSON.parse(raw) as Partial<PlaintextSecretsV1> | null
    if (!value || value.version !== 1 || typeof value.chatApiKey !== 'string' || typeof value.webSearchApiKey !== 'string') return null
    return { chatApiKey: value.chatApiKey, webSearchApiKey: value.webSearchApiKey }
  } catch {
    return null
  }
}

export function hasEncryptedWebApiKeys(): boolean {
  try {
    return localStorage.getItem(WEB_API_KEY_STORAGE_KEY) !== null
  } catch {
    return false
  }
}

export function loadPlaintextWebApiKeys(): WebApiSecrets | null {
  try {
    const raw = localStorage.getItem(WEB_PLAINTEXT_API_KEYS_STORAGE_KEY)
    return raw ? parsePlaintextSecrets(raw) : null
  } catch {
    return null
  }
}

export function savePlaintextWebApiKeys(secrets: WebApiSecrets): void {
  const payload: PlaintextSecretsV1 = { version: 1, ...secrets }
  try {
    localStorage.setItem(WEB_PLAINTEXT_API_KEYS_STORAGE_KEY, JSON.stringify(payload))
  } catch {
    throw new Error('浏览器不允许保存 API Key')
  }
}

export async function saveEncryptedWebApiKeys(secrets: WebApiSecrets, password: string): Promise<void> {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const key = await deriveKey(password, salt, ITERATIONS)
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData },
    key,
    encoder.encode(JSON.stringify(secrets)),
  )
  const payload: EncryptedSecret = {
    version: 2,
    iterations: ITERATIONS,
    salt: toBase64(salt),
    iv: toBase64(iv),
    ciphertext: toBase64(new Uint8Array(ciphertext)),
  }
  try {
    localStorage.setItem(WEB_API_KEY_STORAGE_KEY, JSON.stringify(payload))
  } catch {
    throw new Error('浏览器不允许保存本地加密数据')
  }
}

export async function unlockEncryptedWebApiKeys(password: string): Promise<WebApiSecrets> {
  let raw: string | null
  try {
    raw = localStorage.getItem(WEB_API_KEY_STORAGE_KEY)
  } catch {
    throw new Error('浏览器不允许读取本地加密数据')
  }
  if (!raw) throw new Error('此设备没有已保存的 API Key')
  const payload = parseEncryptedSecret(raw)
  try {
    const salt = fromBase64(payload.salt)
    const iv = fromBase64(payload.iv)
    const key = await deriveKey(password, salt, payload.iterations)
    const plaintext = new TextDecoder().decode(await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv, additionalData },
      key,
      fromBase64(payload.ciphertext),
    ))
    if (payload.version === 1) return { chatApiKey: plaintext, webSearchApiKey: '' }
    const secrets = JSON.parse(plaintext) as Partial<WebApiSecrets> | null
    if (!secrets || typeof secrets.chatApiKey !== 'string' || typeof secrets.webSearchApiKey !== 'string') throw new Error()
    return { chatApiKey: secrets.chatApiKey, webSearchApiKey: secrets.webSearchApiKey }
  } catch {
    throw new Error('本地密码不正确或加密数据已损坏')
  }
}

export function clearStoredWebApiKeys(): void {
  try {
    localStorage.removeItem(WEB_API_KEY_STORAGE_KEY)
    localStorage.removeItem(WEB_PLAINTEXT_API_KEYS_STORAGE_KEY)
  } catch {
    throw new Error('浏览器不允许清除本地 API Key')
  }
}

export function clearEncryptedWebApiKeys(): void {
  try {
    localStorage.removeItem(WEB_API_KEY_STORAGE_KEY)
  } catch {
    throw new Error('浏览器不允许清除本地加密数据')
  }
}

export function clearPlaintextWebApiKeys(): void {
  try {
    localStorage.removeItem(WEB_PLAINTEXT_API_KEYS_STORAGE_KEY)
  } catch {
    throw new Error('浏览器不允许清除 API Key')
  }
}
