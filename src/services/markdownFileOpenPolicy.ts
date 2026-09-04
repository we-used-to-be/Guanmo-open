import { readFile } from '@/hooks/useTauri'
import { readRememberedFile } from '@/services/persistedFileAccess'
import { isWebRuntime } from '@/services/runtimeCapabilities'
import { readBrowserFile } from '@/services/browserFileSystem'
export {
  MAX_OPEN_MARKDOWN_BYTES,
  FileTooLargeError,
  parseFileTooLargeError,
  assertMarkdownOpenSize,
} from '@/services/markdownOpenLimits'
import { MAX_OPEN_MARKDOWN_BYTES, parseFileTooLargeError, assertMarkdownOpenSize } from '@/services/markdownOpenLimits'

// 1 MiB is the current containment limit for Markdown files opened in the editor.
export function formatFileSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MiB`
  if (bytes >= 1024) return `${Math.ceil(bytes / 1024)} KiB`
  return `${bytes} B`
}

async function normalizeTooLargeRead<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read()
  } catch (error) {
    const tooLarge = parseFileTooLargeError(error)
    if (tooLarge) throw tooLarge
    throw error
  }
}

export async function readMarkdownFileForOpen(path: string): Promise<string> {
  if (isWebRuntime()) return normalizeTooLargeRead(() => readBrowserFile(path))
  return normalizeTooLargeRead(() => readFile(path, { maxBytes: MAX_OPEN_MARKDOWN_BYTES }))
}

export async function readRememberedMarkdownFileForOpen(path: string): Promise<string> {
  if (isWebRuntime()) return normalizeTooLargeRead(() => readBrowserFile(path))
  return normalizeTooLargeRead(() => readRememberedFile(path, { maxBytes: MAX_OPEN_MARKDOWN_BYTES }))
}

export async function readBrowserMarkdownFileForOpen(file: File): Promise<string> {
  assertMarkdownOpenSize(file.size)
  return file.text()
}
