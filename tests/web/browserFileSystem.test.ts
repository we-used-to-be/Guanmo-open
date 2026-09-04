import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  browserFileExists,
  clearBrowserFileSession,
  createBrowserFile,
  createBrowserFolder,
  listBrowserDirectory,
  openBrowserFile,
  readBrowserFile,
  registerBrowserDirectoryHandle,
  removeBrowserEntry,
  renameBrowserFile,
  supportsBrowserFileRename,
  writeBrowserBinaryFile,
  writeBrowserFile,
} from '@/services/browserFileSystem'

type FakeFileHandle = {
  kind: 'file'
  name: string
  text: string
  getFile: () => Promise<File>
  createWritable: () => Promise<{ write: (value: string) => Promise<void>; close: () => Promise<void> }>
  move?: (nextName: string) => Promise<void>
}

type FakeDirectoryHandle = {
  kind: 'directory'
  name: string
  entriesMap: Map<string, FakeFileHandle | FakeDirectoryHandle>
  getFileHandle: (name: string, options?: { create?: boolean }) => Promise<FakeFileHandle>
  getDirectoryHandle: (name: string, options?: { create?: boolean }) => Promise<FakeDirectoryHandle>
  removeEntry: (name: string) => Promise<void>
  entries: () => AsyncIterableIterator<[string, FakeFileHandle | FakeDirectoryHandle]>
}

function makeFile(name: string, text = ''): FakeFileHandle {
  const handle: FakeFileHandle = {
    kind: 'file',
    name,
    text,
    getFile: async () => new File([handle.text], name, { type: 'text/markdown' }),
    createWritable: async () => ({
      write: async (value: string) => { handle.text = value },
      close: async () => undefined,
    }),
  }
  return handle
}

function makeDirectory(name: string, entriesMap = new Map<string, FakeFileHandle | FakeDirectoryHandle>()): FakeDirectoryHandle {
  const directory: FakeDirectoryHandle = {
    kind: 'directory',
    name,
    entriesMap,
    getFileHandle: async (entryName, options) => {
      const existing = directory.entriesMap.get(entryName)
      if (existing?.kind === 'file') return existing
      if (!options?.create) throw new Error('not found')
      const file = makeFile(entryName)
      directory.entriesMap.set(entryName, file)
      return file
    },
    getDirectoryHandle: async (entryName, options) => {
      const existing = directory.entriesMap.get(entryName)
      if (existing?.kind === 'directory') return existing
      if (!options?.create) throw new Error('not found')
      const child = makeDirectory(entryName)
      directory.entriesMap.set(entryName, child)
      return child
    },
    removeEntry: async (entryName) => {
      if (!directory.entriesMap.delete(entryName)) throw new Error('not found')
    },
    async *entries() {
      yield* directory.entriesMap.entries()
    },
  }
  return directory
}

afterEach(() => {
  clearBrowserFileSession()
  vi.unstubAllGlobals()
})

describe('browser file system session adapter', () => {
  it('lists, reads, writes, creates and removes entries without persisting handles', async () => {
    const rootHandle = makeDirectory('workspace', new Map([
      ['notes.md', makeFile('notes.md', '# old')],
      ['assets', makeDirectory('assets')],
    ]))
    const root = registerBrowserDirectoryHandle(rootHandle)
    const workspaceRootPath = root.path.replace(/\/$/, '')

    await expect(listBrowserDirectory(workspaceRootPath)).resolves.toEqual([
      { name: 'notes.md', isDirectory: false, isFile: true },
      { name: 'assets', isDirectory: true, isFile: false },
    ])
    const filePath = `${root.path}notes.md`
    await expect(readBrowserFile(filePath)).resolves.toBe('# old')
    await writeBrowserFile(filePath, '# new')
    await expect(readBrowserFile(filePath)).resolves.toBe('# new')

    const folderPath = await createBrowserFolder(root.path, 'drafts')
    const createdPath = await createBrowserFile(folderPath, 'todo.md')
    await writeBrowserFile(createdPath, '- item')
    await expect(browserFileExists(createdPath)).resolves.toBe(true)
    await writeBrowserBinaryFile(createdPath, new Uint8Array([35, 32, 98, 105, 110]))
    await expect(readBrowserFile(createdPath)).resolves.toContain('# bin')
    await removeBrowserEntry(createdPath)
    await expect(browserFileExists(createdPath)).resolves.toBe(false)
  })

  it('only renames when the browser exposes FileSystemHandle.move', async () => {
    const rootEntries = new Map<string, FakeFileHandle | FakeDirectoryHandle>()
    const file = makeFile('before.md', 'content')
    rootEntries.set(file.name, file)
    const rootHandle = makeDirectory('workspace', rootEntries)
    file.move = async (nextName) => {
      rootEntries.delete(file.name)
      file.name = nextName
      rootEntries.set(nextName, file)
    }
    vi.stubGlobal('FileSystemHandle', { prototype: { move: vi.fn() } })
    const root = registerBrowserDirectoryHandle(rootHandle)
    const nextPath = await renameBrowserFile(`${root.path}before.md`, 'after.md')
    expect(supportsBrowserFileRename()).toBe(true)
    expect(nextPath).toBe(`${root.path}after.md`)
    await expect(readBrowserFile(nextPath)).resolves.toBe('content')

    vi.stubGlobal('FileSystemHandle', undefined)
    await expect(renameBrowserFile(nextPath, 'final.md')).rejects.toThrow('不支持安全重命名')
  })

  it('clears all virtual paths and handles at session end', async () => {
    const root = registerBrowserDirectoryHandle(makeDirectory('workspace'))
    clearBrowserFileSession()
    await expect(listBrowserDirectory(root.path)).rejects.toThrow('工作区已失效')
  })

  it('falls back to a single-file picker when File System Access is unavailable', async () => {
    Object.defineProperty(window, 'showOpenFilePicker', { configurable: true, value: undefined })
    const file = new File(['# fallback'], 'fallback.md', { type: 'text/markdown' })
    vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function (this: HTMLInputElement) {
      Object.defineProperty(this, 'files', { configurable: true, value: [file] })
      this.onchange?.(new Event('change'))
    })

    await expect(openBrowserFile()).resolves.toMatchObject({ name: 'fallback.md', content: '# fallback' })
  })
})
