/**
 * Tauri API integration layer.
 * Uses policy-checked Rust commands and @tauri-apps/plugin-dialog in Tauri.
 * Falls back gracefully when running in web browser.
 */

let _isTauri = false

export function isTauri(): boolean {
  _isTauri =
    typeof window !== 'undefined' &&
    (typeof (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ !== 'undefined' ||
      typeof (window as unknown as Record<string, unknown>).__TAURI__ !== 'undefined')
  return _isTauri
}

// --- File System ---

function toNativeFilePath(path: string): string {
  if (/^[a-zA-Z]:[\\/]/.test(path) || /^\\\\/.test(path) || /^\/\//.test(path)) {
    return path.replace(/\//g, '\\')
  }
  return path
}

export async function readFile(path: string): Promise<string> {
  if (!isTauri()) throw new Error('Not running in Tauri')
  const nativePath = toNativeFilePath(path)
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<string>('read_text_file_by_path', { path: nativePath })
}

export interface LegacyFileAccessMigrationResult {
  status: 'migrated' | 'already_migrated'
  workspaceCount: number
  fileCount: number
  ignoredCount: number
  pendingCount: number
}

export async function migrateLegacyFileAccessPaths(
  workspacePaths: string[],
  filePaths: string[]
): Promise<LegacyFileAccessMigrationResult> {
  if (!isTauri()) throw new Error('Not running in Tauri')
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<LegacyFileAccessMigrationResult>('migrate_legacy_file_access', {
    workspacePaths: workspacePaths.map(toNativeFilePath),
    filePaths: filePaths.map(toNativeFilePath),
  })
}

async function authorizeSelectedPath(path: string): Promise<void> {
  if (!isTauri()) throw new Error('Not running in Tauri')
  const nativePath = toNativeFilePath(path)
  const { invoke } = await import('@tauri-apps/api/core')
  await invoke<void>('authorize_selected_path', { path: nativePath })
}

async function authorizeWorkspacePath(path: string): Promise<void> {
  if (!isTauri()) throw new Error('Not running in Tauri')
  const nativePath = toNativeFilePath(path)
  const { invoke } = await import('@tauri-apps/api/core')
  await invoke<void>('authorize_workspace_path', { path: nativePath })
}

export async function prepareMarkdownAssetsDir(markdownPath: string): Promise<void> {
  if (!isTauri()) throw new Error('Not running in Tauri')
  const nativePath = toNativeFilePath(markdownPath)
  const { invoke } = await import('@tauri-apps/api/core')
  await invoke<void>('prepare_markdown_assets_dir', { markdownPath: nativePath })
}

export async function writeFile(path: string, content: string): Promise<void> {
  if (!isTauri()) throw new Error('Not running in Tauri')
  const nativePath = toNativeFilePath(path)
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<void>('write_text_file_by_path', { path: nativePath, content })
}

export async function readBinaryFile(path: string): Promise<Uint8Array> {
  if (!isTauri()) throw new Error('Not running in Tauri')
  const nativePath = toNativeFilePath(path)
  const { invoke } = await import('@tauri-apps/api/core')
  const bytes = await invoke<number[]>('read_binary_file_by_path', { path: nativePath })
  return new Uint8Array(bytes)
}

export async function writeBinaryFile(path: string, content: Uint8Array): Promise<void> {
  if (!isTauri()) throw new Error('Not running in Tauri')
  const nativePath = toNativeFilePath(path)
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<void>('write_binary_file_by_path', { path: nativePath, content: Array.from(content) })
}

export async function readBinaryFile(path: string): Promise<Uint8Array> {
  if (!isTauri()) throw new Error('Not running in Tauri')
  const nativePath = toNativeFilePath(path)
  await authorizeSelectedPath(nativePath)
  try {
    const { readFile: tauriReadFile } = await import('@tauri-apps/plugin-fs')
    return await tauriReadFile(nativePath)
  } catch (pluginErr) {
    const { invoke } = await import('@tauri-apps/api/core')
    const bytes = await invoke<number[]>('read_binary_file_by_path', { path: nativePath }).catch(() => {
      throw pluginErr
    })
    return new Uint8Array(bytes)
  }
}

export async function writeBinaryFile(path: string, content: Uint8Array): Promise<void> {
  if (!isTauri()) throw new Error('Not running in Tauri')
  const nativePath = toNativeFilePath(path)
  await authorizeSelectedPath(nativePath)
  try {
    const { writeFile: tauriWriteFile } = await import('@tauri-apps/plugin-fs')
    return await tauriWriteFile(nativePath, content)
  } catch (pluginErr) {
    const { invoke } = await import('@tauri-apps/api/core')
    return invoke<void>('write_binary_file_by_path', { path: nativePath, content: Array.from(content) }).catch(() => {
      throw pluginErr
    })
  }
}

export async function createTextFile(path: string): Promise<void> {
  if (!isTauri()) throw new Error('Not running in Tauri')
  const nativePath = toNativeFilePath(path)
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<void>('create_text_file_by_path', { path: nativePath })
}

export interface DirEntry {
  name: string
  isDirectory: boolean
  isFile: boolean
}

export async function readDir(path: string): Promise<DirEntry[]> {
  if (!isTauri()) throw new Error('Not running in Tauri')
  const nativePath = toNativeFilePath(path)
  const { invoke } = await import('@tauri-apps/api/core')
  const entries = await invoke<DirEntry[]>('read_dir_by_path', { path: nativePath })
  return entries.map((e) => ({
    name: e.name,
    isDirectory: e.isDirectory,
    isFile: e.isFile,
  }))
}

export async function fileExists(path: string): Promise<boolean> {
  if (!isTauri()) return false
  const nativePath = toNativeFilePath(path)
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<boolean>('path_exists', { path: nativePath })
}

export async function revealFileInFolder(path: string): Promise<void> {
  if (!isTauri()) throw new Error('Not running in Tauri')
  const nativePath = toNativeFilePath(path)
  const { invoke } = await import('@tauri-apps/api/core')
  await invoke<void>('reveal_file_in_folder', { path: nativePath })
}

export async function createDir(path: string): Promise<void> {
  if (!isTauri()) throw new Error('Not running in Tauri')
  const nativePath = toNativeFilePath(path)
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<void>('create_dir_by_path', { path: nativePath })
}

export async function removeFile(path: string): Promise<void> {
  if (!isTauri()) throw new Error('Not running in Tauri')
  const nativePath = toNativeFilePath(path)
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<void>('remove_file_by_path', { path: nativePath })
}

export async function renameFile(oldPath: string, newPath: string): Promise<void> {
  if (!isTauri()) throw new Error('Not running in Tauri')
  const nativeOldPath = toNativeFilePath(oldPath)
  const nativeNewPath = toNativeFilePath(newPath)
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<void>('rename_text_file_by_path', { oldPath: nativeOldPath, newPath: nativeNewPath })
}

// --- Dialogs ---

export interface DialogFilter {
  name: string
  extensions: string[]
}

function normalizeSelectedPath(path: string): string {
  const normalized = toNativeFilePath(path).replace(/[\\/]+$/, '')
  return /^[a-zA-Z]:\\|^\\\\/.test(normalized) ? normalized.toLowerCase() : normalized
}

function isSameSelectedPath(expected: string, selected: string): boolean {
  return normalizeSelectedPath(expected) === normalizeSelectedPath(selected)
}

export async function requestSelectedPathAccess(
  path: string,
  filters?: DialogFilter[]
): Promise<boolean> {
  if (!isTauri()) throw new Error('Not running in Tauri')
  const { open } = await import('@tauri-apps/plugin-dialog')
  const selected = await open({
    multiple: false,
    defaultPath: toNativeFilePath(path),
    filters: filters ?? [
      { name: 'Markdown', extensions: ['md', 'markdown', 'mdx'] },
      { name: 'Text and Code', extensions: ['txt', 'json', 'html', 'css', 'js', 'ts', 'jsx', 'tsx'] },
    ],
  })
  if (typeof selected !== 'string') return false
  if (!isSameSelectedPath(path, selected)) {
    throw new Error('请选择原文件以恢复访问权限')
  }
  await authorizeSelectedPath(selected)
  return true
}

export async function requestWorkspacePathAccess(path: string): Promise<boolean> {
  if (!isTauri()) throw new Error('Not running in Tauri')
  const { open } = await import('@tauri-apps/plugin-dialog')
  const selected = await open({
    directory: true,
    multiple: false,
    defaultPath: toNativeFilePath(path),
  })
  if (typeof selected !== 'string') return false
  if (!isSameSelectedPath(path, selected)) {
    throw new Error('请选择原工作区以恢复访问权限')
  }
  await authorizeWorkspacePath(selected)
  return true
}

export async function openFileDialog(
  filters?: DialogFilter[]
): Promise<string | string[] | null> {
  if (!isTauri()) throw new Error('Not running in Tauri')
  const { open } = await import('@tauri-apps/plugin-dialog')
  const result = await open({
    multiple: false,
    filters: filters ?? [
      { name: 'Markdown', extensions: ['md', 'markdown', 'mdx'] },
      { name: 'Text and Code', extensions: ['txt', 'json', 'html', 'css', 'js', 'ts', 'jsx', 'tsx'] },
    ],
  })
  if (typeof result === 'string') {
    await authorizeSelectedPath(result)
  }
  return result
}

export async function saveFileDialog(
  defaultPath?: string,
  filters?: DialogFilter[]
): Promise<string | null> {
  if (!isTauri()) throw new Error('Not running in Tauri')
  const { save } = await import('@tauri-apps/plugin-dialog')
  const result = await save({
    defaultPath,
    filters: filters ?? [
      { name: 'Markdown', extensions: ['md', 'markdown', 'mdx'] },
      { name: 'Text', extensions: ['txt'] },
    ],
  })
  if (result) await authorizeSelectedPath(result)
  return result
}

export async function openDirectoryDialog(): Promise<string | null> {
  if (!isTauri()) throw new Error('Not running in Tauri')
  const { open } = await import('@tauri-apps/plugin-dialog')
  const result = await open({
    directory: true,
    multiple: false,
  })
  const path = typeof result === 'string' ? result : null
  if (path) await authorizeWorkspacePath(path)
  return path
}

// --- Path utilities (Tauri v2 path API) ---

export async function joinPath(...paths: string[]): Promise<string> {
  if (!isTauri()) return paths.join('/')
  const { join } = await import('@tauri-apps/api/path')
  return join(...paths)
}

export async function dirnamePath(path: string): Promise<string> {
  if (!isTauri()) {
    const idx = path.lastIndexOf('/')
    return idx > 0 ? path.slice(0, idx) : '.'
  }
  const { dirname } = await import('@tauri-apps/api/path')
  return dirname(path)
}

export async function basenamePath(path: string): Promise<string> {
  if (!isTauri()) {
    const idx = path.lastIndexOf('/')
    return idx >= 0 ? path.slice(idx + 1) : path
  }
  const { basename } = await import('@tauri-apps/api/path')
  return basename(path)
}
