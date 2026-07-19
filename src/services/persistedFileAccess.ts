import {
  migrateLegacyFileAccessPaths,
  readFile,
  requestSelectedPathAccess,
  requestWorkspacePathAccess,
} from '@/hooks/useTauri'
import { normalizeFilePath } from '@/services/pathIdentity'

interface LegacyFileAccessSources {
  workspacePath: string | null
  recentFiles: Array<{ path: string }>
  favorites: string[]
  tabs: Array<{ filePath: string | null }>
  documentPaths: string[]
  chatSourcePaths: string[]
}

export function collectLegacyFileAccessPaths(sources: LegacyFileAccessSources): {
  workspacePaths: string[]
  filePaths: string[]
} {
  const paths = [
    ...sources.recentFiles.map((file) => file.path),
    ...sources.favorites,
    ...sources.tabs.map((tab) => tab.filePath),
    ...sources.documentPaths,
    ...sources.chatSourcePaths,
  ]
  const seen = new Set<string>()
  const filePaths: string[] = []
  for (const path of paths) {
    const normalized = normalizeFilePath(path)
    if (!path || !normalized || seen.has(normalized)) continue
    seen.add(normalized)
    filePaths.push(path)
  }
  return {
    workspacePaths: sources.workspacePath ? [sources.workspacePath] : [],
    filePaths,
  }
}

export async function migrateLegacyFileAccess(): Promise<void> {
  const [{ useAppStore }, { useEditorStore }, persistence] = await Promise.all([
    import('@/stores/appStore'),
    import('@/stores/editorStore'),
    import('@/services/database/persistence'),
  ])
  const appState = useAppStore.getState()
  const editorState = useEditorStore.getState()
  const [documentPaths, chatSourcePaths] = await Promise.all([
    persistence.loadDocumentFilePaths(),
    persistence.loadChatSourceFilePaths(),
  ])
  const paths = collectLegacyFileAccessPaths({
    workspacePath: appState.workspacePath,
    recentFiles: editorState.recentFiles,
    favorites: editorState.favorites,
    tabs: editorState.tabs,
    documentPaths,
    chatSourcePaths,
  })
  await migrateLegacyFileAccessPaths(paths.workspacePaths, paths.filePaths)
}

export function isFileAccessAuthorizationError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  const lower = message.toLowerCase()
  return (
    lower.includes('outside the selected workspace') ||
    lower.includes('was not selected by the user')
  )
}

export async function recoverRememberedAccess<T>(
  path: string,
  operation: () => Promise<T>,
  requestAccess: (path: string) => Promise<boolean>
): Promise<T> {
  try {
    return await operation()
  } catch (err) {
    if (!isFileAccessAuthorizationError(err)) throw err
    const granted = await requestAccess(path)
    if (!granted) throw new Error(`重新授权已取消：${path}`)
    return operation()
  }
}

export function readRememberedFile(path: string): Promise<string> {
  return recoverRememberedAccess(path, () => readFile(path), requestSelectedPathAccess)
}

export function recoverRememberedWorkspace<T>(
  path: string,
  operation: () => Promise<T>
): Promise<T> {
  return recoverRememberedAccess(path, operation, requestWorkspacePathAccess)
}
