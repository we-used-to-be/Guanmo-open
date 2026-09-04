import {
  clearStoredWebApiKeys,
  clearEncryptedWebApiKeys,
  clearPlaintextWebApiKeys,
  hasEncryptedWebApiKeys,
  loadPlaintextWebApiKeys,
  unlockEncryptedWebApiKeys,
  saveEncryptedWebApiKeys,
  savePlaintextWebApiKeys,
  type WebApiSecrets,
} from './webSecretStorage'

export type WebSecretMode = 'session' | 'plaintext' | 'encrypted'

export interface WebSecretRuntimeState {
  mode: WebSecretMode
  saved: boolean
  unlocked: boolean
  chatApiKey: string
  webSearchApiKey: string
}

const listeners = new Set<() => void>()
let state: WebSecretRuntimeState = (() => {
  if (hasEncryptedWebApiKeys()) {
    return { mode: 'encrypted', saved: true, unlocked: false, chatApiKey: '', webSearchApiKey: '' }
  }
  const plaintext = loadPlaintextWebApiKeys()
  return plaintext
    ? { mode: 'plaintext', saved: true, unlocked: true, ...plaintext }
    : { mode: 'session', saved: false, unlocked: true, chatApiKey: '', webSearchApiKey: '' }
})()

function emit() {
  listeners.forEach((listener) => listener())
}

export function getWebSecretRuntimeState(): WebSecretRuntimeState {
  return state
}

export function subscribeWebSecretRuntime(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function setWebSessionApiKeys(secrets: WebApiSecrets): void {
  try {
    clearStoredWebApiKeys()
  } catch {
    // 会话模式不依赖 LocalStorage；隐私模式下清理失败不阻断当前页使用。
  }
  state = { mode: 'session', saved: false, unlocked: true, ...secrets }
  emit()
}

export function persistWebApiKeys(secrets: WebApiSecrets, mode: 'plaintext' | 'encrypted', password?: string): Promise<void> {
  return (async () => {
    if (mode === 'plaintext') {
      clearEncryptedWebApiKeys()
      savePlaintextWebApiKeys(secrets)
    }
    else {
      if (!password) throw new Error('请输入用于保护 API Key 的密码')
      clearPlaintextWebApiKeys()
      await saveEncryptedWebApiKeys(secrets, password)
    }
    state = { mode, saved: true, unlocked: true, ...secrets }
    emit()
  })()
}

export async function unlockWebApiKeys(password: string): Promise<void> {
  const secrets = await unlockEncryptedWebApiKeys(password)
  state = { mode: 'encrypted', saved: true, unlocked: true, ...secrets }
  emit()
}

export function clearWebApiKeys(): void {
  clearStoredWebApiKeys()
  state = { mode: 'session', saved: false, unlocked: true, chatApiKey: '', webSearchApiKey: '' }
  emit()
}
