/**
 * File system service.
 * Handles open/save/new file operations.
 * In Tauri: uses native FS + dialog plugins.
 * In web: uses in-memory storage with download fallback.
 */

import {
  isTauri,
  writeFile,
  openFileDialog,
  saveFileDialog,
  readDir,
  openDirectoryDialog,
  createTextFile,
  createDir,
  fileExists,
  type DirEntry,
} from '@/hooks/useTauri'
import { isWorkspaceDisplayFile } from '@/services/fileTree'
import { describeFileOperationError } from '@/services/fileOperationErrors'
import { eventMarker } from '@/services/eventMarker'
import { readMarkdownFileForOpen } from '@/services/markdownFileOpenPolicy'
import {
  browserFileExists,
  createBrowserFile,
  createBrowserFolder,
  listBrowserDirectory,
  openBrowserFile,
  pickBrowserDirectory,
  removeBrowserEntry,
  renameBrowserFile,
  saveBrowserFileAs,
  supportsBrowserFileSystem,
  writeBrowserFile,
} from '@/services/browserFileSystem'

export interface FileHandle {
  path: string
  name: string
  content: string
}

export async function openFile(): Promise<FileHandle | null> {
  eventMarker.mark('open-file-start')
  if (isTauri()) {
    const result = await openFileDialog()
    if (!result) {
      eventMarker.mark('open-file-complete', { cancelled: true })
      return null
    }
    const path = Array.isArray(result) ? result[0] : result
    if (!isWorkspaceDisplayFile(path)) {
      eventMarker.mark('open-file-complete', { rejected: true })
      return null
    }
    const content = await readMarkdownFileForOpen(path)
    const name = path.split(/[/\\]/).pop() || 'untitled.md'
    eventMarker.mark('open-file-read-complete', { fileKind: 'disk', charCount: content.length })
    eventMarker.mark('open-file-complete', { fileKind: 'disk' })
    return { path, name, content }
  }

  const result = await openBrowserFile()
  if (!result) return null
  eventMarker.mark('open-file-read-complete', { fileKind: 'browser', charCount: result.content.length })
  eventMarker.mark('open-file-complete', { fileKind: 'browser' })
  return result
}

export async function saveFile(path: string, content: string): Promise<void> {
  if (isTauri()) {
    await writeFile(path, content)
    return
  }

  if (supportsBrowserFileSystem()) {
    try {
      await writeBrowserFile(path, content)
      return
    } catch {
      // Permission may have been revoked; use the safe download fallback.
    }
  }

  // Web fallback: trigger download
  const blob = new Blob([content], { type: 'text/markdown' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  const fallbackName = decodeURIComponent(path.split('/').pop() || '')
  a.download = fallbackName || 'untitled.md'
  a.click()
  URL.revokeObjectURL(url)
}

export async function saveFileAs(content: string): Promise<FileHandle | null> {
  if (isTauri()) {
    const path = await saveFileDialog()
    if (!path) return null
    if (!isWorkspaceDisplayFile(path)) {
      throw new Error('仅支持保存为 .md 文件')
    }
    await writeFile(path, content)
    const name = path.split(/[/\\]/).pop() || 'untitled.md'
    return { path, name, content }
  }

  const picked = await saveBrowserFileAs(content, 'untitled.md')
  if (picked) return picked

  // Web fallback
  const name = prompt('文件名:', 'untitled.md')
  if (!name) return null
  if (!isWorkspaceDisplayFile(name)) {
    throw new Error('仅支持保存为 .md 文件')
  }
  await saveFile(name, content)
  return { path: name, name, content }
}

export async function listDirectory(dirPath: string): Promise<DirEntry[]> {
  if (isTauri()) {
    return readDir(dirPath)
  }
  if (!supportsBrowserFileSystem()) throw new Error('当前浏览器不支持目录浏览')
  return listBrowserDirectory(dirPath)
}

export async function pickDirectory(): Promise<string | null> {
  if (isTauri()) {
    return openDirectoryDialog()
  }
  if (!supportsBrowserFileSystem()) return null
  return (await pickBrowserDirectory())?.path ?? null
}

/**
 * 在指定目录下创建新文件
 */
export async function createFile(dirPath: string, fileName: string): Promise<string> {
  if (!isWorkspaceDisplayFile(fileName)) {
    throw new Error('仅支持创建 .md 文件')
  }
  if (!isTauri()) {
    if (!supportsBrowserFileSystem()) throw new Error('当前浏览器不支持创建文件')
    if (await browserFileExists(`${dirPath}/${fileName}`)) throw new Error('同一文件夹下已存在同名文件或文件夹')
    return createBrowserFile(dirPath, fileName)
  }
  const { join } = await import('@tauri-apps/api/path')
  const fullPath = await join(dirPath, fileName)
  if (await fileExists(fullPath)) {
    throw new Error('同一文件夹下已存在同名文件或文件夹')
  }
  try {
    await createTextFile(fullPath)
  } catch (err) {
    throw new Error(describeFileOperationError(err, '创建文件失败'))
  }
  return fullPath
}

/**
 * 在指定目录下创建新文件夹
 */
export async function createFolder(dirPath: string, folderName: string): Promise<string> {
  if (!isTauri()) {
    if (!supportsBrowserFileSystem()) throw new Error('当前浏览器不支持创建文件夹')
    if (await browserFileExists(`${dirPath}/${folderName}`)) throw new Error('同一文件夹下已存在同名文件或文件夹')
    return createBrowserFolder(dirPath, folderName)
  }
  const { join } = await import('@tauri-apps/api/path')
  const fullPath = await join(dirPath, folderName)
  if (await fileExists(fullPath)) {
    throw new Error('同一文件夹下已存在同名文件或文件夹')
  }
  try {
    await createDir(fullPath)
  } catch (err) {
    throw new Error(describeFileOperationError(err, '创建文件夹失败'))
  }
  return fullPath
}

export async function fileExistsEntry(path: string): Promise<boolean> {
  if (isTauri()) return fileExists(path)
  return supportsBrowserFileSystem() ? browserFileExists(path) : false
}

export async function removeFileEntry(path: string): Promise<void> {
  if (isTauri()) {
    const { removeFile } = await import('@/hooks/useTauri')
    await removeFile(path)
    return
  }
  if (!supportsBrowserFileSystem()) throw new Error('当前浏览器不支持删除文件')
  await removeBrowserEntry(path)
}

export async function renameFileEntryInFileSystem(path: string, nextName: string): Promise<string> {
  if (isTauri()) {
    const { basenamePath, dirnamePath, joinPath, renameFile } = await import('@/hooks/useTauri')
    if (await basenamePath(path) === nextName) return path
    const nextPath = await joinPath(await dirnamePath(path), nextName)
    await renameFile(path, nextPath)
    return nextPath
  }
  return renameBrowserFile(path, nextName)
}
