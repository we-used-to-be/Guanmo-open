/**
 * Tauri API integration layer.
 * Uses @tauri-apps/plugin-fs and @tauri-apps/plugin-dialog in Tauri.
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

async function authorizeWorkspacePath(path: string): Promise<void> {
  if (!isTauri()) return
  const { invoke } = await import('@tauri-apps/api/core')
  await invoke('authorize_workspace_path', { path })
}

async function authorizeSelectedPath(path: string): Promise<void> {
  if (!isTauri()) return
  const { invoke } = await import('@tauri-apps/api/core')
  await invoke('authorize_selected_path', { path })
}

function toNativeFilePath(path: string): string {
  if (/^[a-zA-Z]:[\\/]/.test(path) || /^\\\\/.test(path) || /^\/\//.test(path)) {
    return path.replace(/\//g, '\\')
  }
  return path
}

export async function readFile(path: string): Promise<string> {
  if (!isTauri()) throw new Error('Not running in Tauri')
  const nativePath = toNativeFilePath(path)
  await authorizeSelectedPath(nativePath)
  const { invoke } = await import('@tauri-apps/api/core')
  try {
    return await invoke<string>('read_text_file_by_path', { path: nativePath })
  } catch (commandErr) {
    try {
      const { readTextFile } = await import('@tauri-apps/plugin-fs')
      return await readTextFile(nativePath)
    } catch {
      throw commandErr
    }
  }
}

export async function writeFile(path: string, content: string): Promise<void> {
  if (!isTauri()) throw new Error('Not running in Tauri')
  const nativePath = toNativeFilePath(path)
  await authorizeSelectedPath(nativePath)
  const { invoke } = await import('@tauri-apps/api/core')
  try {
    return await invoke<void>('write_text_file_by_path', { path: nativePath, content })
  } catch (commandErr) {
    try {
      const { writeTextFile } = await import('@tauri-apps/plugin-fs')
      return await writeTextFile(nativePath, content)
    } catch {
      throw commandErr
    }
  }
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
  try {
    const { writeTextFile } = await import('@tauri-apps/plugin-fs')
    return await writeTextFile(nativePath, '', { createNew: true })
  } catch (err) {
    const { invoke } = await import('@tauri-apps/api/core')
    return invoke<void>('create_text_file_by_path', { path: nativePath }).catch((fallbackErr) => {
      throw fallbackErr || err
    })
  }
}

export interface DirEntry {
  name: string
  isDirectory: boolean
  isFile: boolean
}

export async function readDir(path: string): Promise<DirEntry[]> {
  if (!isTauri()) throw new Error('Not running in Tauri')
  await authorizeWorkspacePath(path)
  const nativePath = toNativeFilePath(path)
  let entries: DirEntry[]
  try {
    const { readDir: tauriReadDir } = await import('@tauri-apps/plugin-fs')
    entries = await tauriReadDir(nativePath)
  } catch (err) {
    const { invoke } = await import('@tauri-apps/api/core')
    entries = await invoke<DirEntry[]>('read_dir_by_path', { path: nativePath }).catch(() => {
      throw err
    })
  }
  return entries.map((e) => ({
    name: e.name,
    isDirectory: e.isDirectory,
    isFile: e.isFile,
  }))
}

export async function fileExists(path: string): Promise<boolean> {
  if (!isTauri()) return false
  const nativePath = toNativeFilePath(path)
  try {
    const { exists } = await import('@tauri-apps/plugin-fs')
    return await exists(nativePath)
  } catch {
    return false
  }
}

export async function createDir(path: string): Promise<void> {
  if (!isTauri()) throw new Error('Not running in Tauri')
  const nativePath = toNativeFilePath(path)
  try {
    const { mkdir } = await import('@tauri-apps/plugin-fs')
    return await mkdir(nativePath)
  } catch (err) {
    const { invoke } = await import('@tauri-apps/api/core')
    return invoke<void>('create_dir_by_path', { path: nativePath }).catch((fallbackErr) => {
      throw fallbackErr || err
    })
  }
}

export async function removeFile(path: string): Promise<void> {
  if (!isTauri()) throw new Error('Not running in Tauri')
  const nativePath = toNativeFilePath(path)
  const { remove } = await import('@tauri-apps/plugin-fs')
  return remove(nativePath)
}

export async function renameFile(oldPath: string, newPath: string): Promise<void> {
  if (!isTauri()) throw new Error('Not running in Tauri')
  const nativeOldPath = toNativeFilePath(oldPath)
  const nativeNewPath = toNativeFilePath(newPath)
  try {
    const { rename } = await import('@tauri-apps/plugin-fs')
    return await rename(nativeOldPath, nativeNewPath)
  } catch (err) {
    const { invoke } = await import('@tauri-apps/api/core')
    return invoke<void>('rename_text_file_by_path', { oldPath: nativeOldPath, newPath: nativeNewPath }).catch((fallbackErr) => {
      throw fallbackErr || err
    })
  }
}

// --- Dialogs ---

export interface DialogFilter {
  name: string
  extensions: string[]
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
  const paths = Array.isArray(result) ? result : result ? [result] : []
  await Promise.all(paths.map(authorizeSelectedPath))
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
  const path = typeof result === 'string' ? result : Array.isArray(result) ? result[0] ?? null : null
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
