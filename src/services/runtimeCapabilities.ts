import { isTauri } from '@/hooks/useTauri'

export interface RuntimeCapabilities {
  isWeb: boolean
  database: boolean
  nativeWindow: boolean
  browserFileSystem: boolean
  browserFileWrite: boolean
  browserFileRename: boolean
  webAi: boolean
  webSearch: boolean
  embedding: boolean
  persistentChatHistory: boolean
  persistentWorkspace: boolean
}

function getWindowRecord(): Record<string, unknown> | null {
  return typeof window === 'undefined' ? null : window as unknown as Record<string, unknown>
}

export function isWebRuntime(): boolean {
  return !isTauri()
}

export function getRuntimeCapabilities(): RuntimeCapabilities {
  const web = isWebRuntime()
  const record = getWindowRecord()
  const browserFileSystem = web && typeof record?.showDirectoryPicker === 'function'
  const browserFileWrite = web && (
    typeof record?.showDirectoryPicker === 'function'
    ||
    typeof record?.showSaveFilePicker === 'function'
    || typeof record?.showOpenFilePicker === 'function'
  )
  const browserFileRename = web && typeof (globalThis as { FileSystemHandle?: { prototype?: { move?: unknown } } }).FileSystemHandle?.prototype?.move === 'function'

  return {
    isWeb: web,
    database: !web,
    nativeWindow: !web,
    browserFileSystem,
    browserFileWrite,
    browserFileRename,
    webAi: web,
    webSearch: web,
    embedding: !web,
    persistentChatHistory: !web,
    persistentWorkspace: !web,
  }
}
