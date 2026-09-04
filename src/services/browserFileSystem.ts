import { normalizeFilePath } from '@/services/pathIdentity'
import { assertMarkdownOpenSize, MAX_OPEN_MARKDOWN_BYTES } from '@/services/markdownOpenLimits'

type BrowserFileHandle = {
  kind: 'file'
  name: string
  getFile: () => Promise<File>
  createWritable?: () => Promise<{ write: (value: string | Blob | ArrayBuffer | ArrayBufferView) => Promise<void>; close: () => Promise<void> }>
  move?: (name: string) => Promise<void>
}

type BrowserDirectoryHandle = {
  kind: 'directory'
  name: string
  getFileHandle: (name: string, options?: { create?: boolean }) => Promise<BrowserFileHandle>
  getDirectoryHandle: (name: string, options?: { create?: boolean }) => Promise<BrowserDirectoryHandle>
  removeEntry: (name: string, options?: { recursive?: boolean }) => Promise<void>
  entries: () => AsyncIterableIterator<[string, BrowserFileHandle | BrowserDirectoryHandle]>
}

type BrowserHandle = BrowserFileHandle | BrowserDirectoryHandle

interface BrowserRoot {
  id: string
  handle: BrowserDirectoryHandle
  name: string
}

export interface BrowserDirectoryEntry {
  name: string
  isDirectory: boolean
  isFile: boolean
}

const roots = new Map<string, BrowserRoot>()
const handles = new Map<string, BrowserHandle>()
const files = new Map<string, File>()

function newId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`
}

function encodePart(value: string): string {
  return encodeURIComponent(value)
}

function decodePart(value: string): string {
  return decodeURIComponent(value)
}

function makePath(rootId: string, segments: string[]): string {
  return `webfs://${rootId}/${segments.map(encodePart).join('/')}`
}

function pathParts(path: string): { rootId: string; segments: string[] } | null {
  const match = /^webfs:\/\/([^/]+)(?:\/(.*))?$/.exec(path)
  if (!match) return null
  return {
    rootId: match[1],
    segments: (match[2] ?? '').split('/').filter(Boolean).map(decodePart),
  }
}

function pathKey(path: string): string {
  const parsed = pathParts(path)
  return parsed ? normalizeFilePath(makePath(parsed.rootId, parsed.segments)) : normalizeFilePath(path)
}

function browserWindow(): Record<string, unknown> | null {
  return typeof window === 'undefined' ? null : window as unknown as Record<string, unknown>
}

export function supportsBrowserFileSystem(): boolean {
  const record = browserWindow()
  return typeof record?.showDirectoryPicker === 'function'
}

export function supportsBrowserFileWrite(): boolean {
  const record = browserWindow()
  return typeof record?.showDirectoryPicker === 'function'
    || typeof record?.showSaveFilePicker === 'function'
    || typeof record?.showOpenFilePicker === 'function'
}

export function supportsBrowserFileRename(): boolean {
  return typeof (globalThis as { FileSystemHandle?: { prototype?: { move?: unknown } } }).FileSystemHandle?.prototype?.move === 'function'
}

export function clearBrowserFileSession(): void {
  roots.clear()
  handles.clear()
  files.clear()
}

export function getBrowserRootPath(rootId: string): string {
  return `webfs://${rootId}/`
}

export async function openBrowserFile(): Promise<{ path: string; name: string; content: string } | null> {
  const record = browserWindow()
  const picker = record?.showOpenFilePicker as ((options?: unknown) => Promise<BrowserFileHandle[]>) | undefined
  if (typeof picker === 'function') {
    const selected = await picker({ multiple: false, types: [{ description: 'Markdown', accept: { 'text/markdown': ['.md'] } }] })
    const handle = selected?.[0]
    if (!handle) return null
    const rootId = newId('file')
    const path = makePath(rootId, [handle.name])
    handles.set(pathKey(path), handle)
    const content = await readBrowserFile(path)
    return { path, name: handle.name, content }
  }

  return new Promise((resolve, reject) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.md,text/markdown'
    input.onchange = async () => {
      const file = input.files?.[0]
      if (!file) {
        resolve(null)
        return
      }
      try {
        assertMarkdownOpenSize(file.size)
        const rootId = newId('file')
        const path = makePath(rootId, [file.name])
        files.set(pathKey(path), file)
        resolve({ path, name: file.name, content: await file.text() })
      } catch (error) {
        reject(error)
      }
    }
    input.click()
  })
}

export async function pickBrowserDirectory(): Promise<{ path: string; name: string } | null> {
  const record = browserWindow()
  const picker = record?.showDirectoryPicker as (() => Promise<BrowserDirectoryHandle>) | undefined
  if (typeof picker !== 'function') return null
  const handle = await picker()
  if (!handle) return null
  const id = newId('root')
  const path = getBrowserRootPath(id)
  roots.set(id, { id, handle, name: handle.name })
  handles.set(pathKey(path), handle)
  return { path, name: handle.name }
}

export function registerBrowserDirectoryHandle(handle: BrowserDirectoryHandle): { path: string; name: string } {
  const id = newId('root')
  const path = getBrowserRootPath(id)
  roots.set(id, { id, handle, name: handle.name })
  handles.set(pathKey(path), handle)
  return { path, name: handle.name }
}

export async function registerBrowserFileHandle(handle: BrowserFileHandle): Promise<{ path: string; name: string; content: string }> {
  const rootId = newId('file')
  const path = makePath(rootId, [handle.name])
  handles.set(pathKey(path), handle)
  return { path, name: handle.name, content: await readBrowserFile(path) }
}

export async function registerBrowserFile(file: File): Promise<{ path: string; name: string; content: string }> {
  assertMarkdownOpenSize(file.size)
  const rootId = newId('file')
  const path = makePath(rootId, [file.name])
  files.set(pathKey(path), file)
  return { path, name: file.name, content: await file.text() }
}

export async function saveBrowserFileAs(content: string, suggestedName = 'untitled.md'): Promise<{ path: string; name: string; content: string } | null> {
  const record = browserWindow()
  const picker = record?.showSaveFilePicker as ((options?: unknown) => Promise<BrowserFileHandle>) | undefined
  if (typeof picker !== 'function') return null
  const handle = await picker({
    suggestedName: suggestedName.toLowerCase().endsWith('.md') ? suggestedName : `${suggestedName}.md`,
    types: [{ description: 'Markdown', accept: { 'text/markdown': ['.md'] } }],
  })
  if (!handle) return null
  const rootId = newId('file')
  const path = makePath(rootId, [handle.name])
  handles.set(pathKey(path), handle)
  await writeBrowserFile(path, content)
  return { path, name: handle.name, content }
}

async function resolveHandle(path: string): Promise<BrowserHandle> {
  const existing = handles.get(pathKey(path))
  if (existing) return existing
  const parsed = pathParts(path)
  if (!parsed) throw new Error('浏览器文件路径无效')
  const root = roots.get(parsed.rootId)
  if (!root) throw new Error('浏览器工作区已失效，请重新选择文件夹')
  let current: BrowserHandle = root.handle
  const consumed: string[] = []
  for (const segment of parsed.segments) {
    if (current.kind !== 'directory') throw new Error('浏览器文件路径无效')
    consumed.push(segment)
    const nextPath = makePath(parsed.rootId, consumed)
    const cached = handles.get(pathKey(nextPath))
    const directory = current as BrowserDirectoryHandle
    current = cached ?? await directory.getDirectoryHandle(segment).catch(() => directory.getFileHandle(segment))
    handles.set(pathKey(nextPath), current)
  }
  return current
}

export async function readBrowserFile(path: string): Promise<string> {
  const file = files.get(pathKey(path))
  if (file) {
    assertMarkdownOpenSize(file.size)
    return file.text()
  }
  const handle = await resolveHandle(path)
  if (handle.kind !== 'file') throw new Error('目标不是 Markdown 文件')
  const fileValue = await handle.getFile()
  if (fileValue.size > MAX_OPEN_MARKDOWN_BYTES) {
    assertMarkdownOpenSize(fileValue.size)
  }
  return fileValue.text()
}

export async function writeBrowserFile(path: string, content: string): Promise<void> {
  await writeBrowserFileValue(path, content)
}

export async function writeBrowserBinaryFile(path: string, content: Uint8Array): Promise<void> {
  await writeBrowserFileValue(path, content)
}

async function writeBrowserFileValue(path: string, content: string | Blob | ArrayBuffer | ArrayBufferView): Promise<void> {
  const handle = await resolveHandle(path)
  if (handle.kind !== 'file' || !handle.createWritable) {
    throw new Error('当前浏览器不支持原位保存，请使用下载保存')
  }
  const writable = await handle.createWritable()
  await writable.write(content)
  await writable.close()
}

export async function listBrowserDirectory(path: string): Promise<BrowserDirectoryEntry[]> {
  const handle = await resolveHandle(path)
  if (handle.kind !== 'directory') throw new Error('目标不是文件夹')
  const entries: BrowserDirectoryEntry[] = []
  for await (const [name, child] of handle.entries()) {
    const childPath = makePath(pathParts(path)?.rootId ?? '', [...(pathParts(path)?.segments ?? []), name])
    handles.set(pathKey(childPath), child)
    entries.push({ name, isDirectory: child.kind === 'directory', isFile: child.kind === 'file' })
  }
  return entries
}

export async function browserFileExists(path: string): Promise<boolean> {
  try {
    await resolveHandle(path)
    return true
  } catch {
    return false
  }
}

export async function createBrowserFile(dirPath: string, name: string): Promise<string> {
  const directory = await resolveHandle(dirPath)
  if (directory.kind !== 'directory') throw new Error('目标不是文件夹')
  const handle = await directory.getFileHandle(name, { create: true })
  const parsed = pathParts(dirPath)
  if (!parsed) throw new Error('浏览器文件路径无效')
  const path = makePath(parsed.rootId, [...parsed.segments, name])
  handles.set(pathKey(path), handle)
  return path
}

export async function createBrowserFolder(dirPath: string, name: string): Promise<string> {
  const directory = await resolveHandle(dirPath)
  if (directory.kind !== 'directory') throw new Error('目标不是文件夹')
  const handle = await directory.getDirectoryHandle(name, { create: true })
  const parsed = pathParts(dirPath)
  if (!parsed) throw new Error('浏览器文件路径无效')
  const path = makePath(parsed.rootId, [...parsed.segments, name])
  handles.set(pathKey(path), handle)
  return path
}

export async function removeBrowserEntry(path: string): Promise<void> {
  const parsed = pathParts(path)
  if (!parsed || parsed.segments.length === 0) throw new Error('不能删除工作区根目录')
  const parentPath = makePath(parsed.rootId, parsed.segments.slice(0, -1))
  const parent = await resolveHandle(parentPath)
  if (parent.kind !== 'directory') throw new Error('目标父目录无效')
  const target = await resolveHandle(path)
  await parent.removeEntry(parsed.segments[parsed.segments.length - 1], { recursive: target.kind === 'directory' })
  handles.delete(pathKey(path))
  files.delete(pathKey(path))
}

export async function renameBrowserFile(path: string, nextName: string): Promise<string> {
  if (!supportsBrowserFileRename()) throw new Error('当前浏览器不支持安全重命名')
  const handle = await resolveHandle(path)
  if (handle.kind !== 'file' || !handle.move) throw new Error('当前浏览器不支持安全重命名')
  await handle.move(nextName)
  const parsed = pathParts(path)
  if (!parsed) throw new Error('浏览器文件路径无效')
  const nextPath = makePath(parsed.rootId, [...parsed.segments.slice(0, -1), nextName])
  handles.delete(pathKey(path))
  handles.set(pathKey(nextPath), handle)
  return nextPath
}
