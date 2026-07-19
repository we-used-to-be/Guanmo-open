/**
 * File system service.
 * Handles open/save/new file operations.
 * In Tauri: uses native FS + dialog plugins.
 * In web: uses in-memory storage with download fallback.
 */

import {
  isTauri,
  readFile,
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

export interface FileHandle {
  path: string
  name: string
  content: string
}

export async function openFile(): Promise<FileHandle | null> {
  if (isTauri()) {
    const result = await openFileDialog()
    if (!result) return null
    const path = Array.isArray(result) ? result[0] : result
    if (!isWorkspaceDisplayFile(path)) return null
    const content = await readFile(path)
    const name = path.split(/[/\\]/).pop() || 'untitled.md'
    return { path, name, content }
  }

  // Web fallback: use input element
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.md,.markdown,.mdx,.txt'
    input.onchange = async () => {
      const file = input.files?.[0]
      if (!file) {
        resolve(null)
        return
      }
      if (!isWorkspaceDisplayFile(file.name)) {
        resolve(null)
        return
      }
      const content = await file.text()
      resolve({ path: file.name, name: file.name, content })
    }
    input.click()
  })
}

export async function saveFile(path: string, content: string): Promise<void> {
  if (isTauri()) {
    await writeFile(path, content)
    return
  }

  // Web fallback: trigger download
  const blob = new Blob([content], { type: 'text/markdown' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = path || 'untitled.md'
  a.click()
  URL.revokeObjectURL(url)
}

export async function saveFileAs(content: string): Promise<FileHandle | null> {
  if (isTauri()) {
    const path = await saveFileDialog()
    if (!path) return null
    await writeFile(path, content)
    const name = path.split(/[/\\]/).pop() || 'untitled.md'
    return { path, name, content }
  }

  // Web fallback
  const name = prompt('文件名:', 'untitled.md')
  if (!name) return null
  await saveFile(name, content)
  return { path: name, name, content }
}

export async function listDirectory(dirPath: string): Promise<DirEntry[]> {
  if (isTauri()) {
    return readDir(dirPath)
  }
  throw new Error('目录浏览仅在桌面模式下可用')
}

export async function pickDirectory(): Promise<string | null> {
  if (isTauri()) {
    return openDirectoryDialog()
  }
  return null
}

/**
 * 在指定目录下创建新文件
 */
export async function createFile(dirPath: string, fileName: string): Promise<string> {
  if (!isTauri()) {
    throw new Error('浏览器模式下无法创建文件，请下载桌面版')
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
    throw new Error('浏览器模式下无法创建文件夹，请下载桌面版')
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
