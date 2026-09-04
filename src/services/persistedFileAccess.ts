import {
  migrateLegacyFileAccessPaths,
  readFile,
  type ReadFileOptions,
  requestSelectedPathAccess,
  requestWorkspacePathAccess,
  waitForFileAccessRestore,
} from '@/hooks/useTauri'
import { normalizeFilePath } from '@/services/pathIdentity'

interface LegacyFileAccessSources {
  workspacePaths: string[]
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
    workspacePaths: sources.workspacePaths,
    filePaths,
  }
}

const LEGACY_MIGRATION_DONE_KEY = 'guanmo-legacy-file-access-done'

// 仅兼容旧版本；迁移是否需要执行由 Rust 授权状态决定。
export function markLegacyFileAccessMigrationDone(): void {
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem(LEGACY_MIGRATION_DONE_KEY, '1')
  }
}

export async function migrateLegacyFileAccess(): Promise<void> {
  const restoreStatus = await waitForFileAccessRestore()
  if (restoreStatus.restoreSucceeded && restoreStatus.legacyMigrationCompleted) {
    markLegacyFileAccessMigrationDone()
    return
  }

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
    workspacePaths: appState.workspaceRoots.map((root) => root.path),
    recentFiles: editorState.recentFiles,
    favorites: editorState.favorites,
    tabs: editorState.tabs,
    documentPaths,
    chatSourcePaths,
  })
  await migrateLegacyFileAccessPaths(paths.workspacePaths, paths.filePaths)

  markLegacyFileAccessMigrationDone()
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

export function readRememberedFile(path: string, options: ReadFileOptions = {}): Promise<string> {
  return waitForFileAccessRestore().then(() =>
    recoverRememberedAccess(path, () => readFile(path, options), requestSelectedPathAccess)
  )
}

export function recoverRememberedWorkspace<T>(
  path: string,
  operation: () => Promise<T>
): Promise<T> {
  return waitForFileAccessRestore().then(() =>
    recoverRememberedAccess(path, operation, requestWorkspacePathAccess)
  )
}
