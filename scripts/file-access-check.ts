import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  collectLegacyFileAccessPaths,
  isFileAccessAuthorizationError,
  recoverRememberedAccess,
} from '@/services/persistedFileAccess'

async function run() {
  const legacyPaths = collectLegacyFileAccessPaths({
    workspacePath: 'D:\\workspace',
    recentFiles: [{ path: 'D:\\notes\\recent.md' }],
    favorites: ['D:\\notes\\favorite.md'],
    tabs: [
      { filePath: 'D:\\notes\\tab.md' },
      { filePath: null },
      { filePath: 'd:\\NOTES\\RECENT.md' },
    ],
    documentPaths: ['D:\\knowledge\\rag.md'],
    chatSourcePaths: ['D:\\archive\\chat-source.md'],
  })
  assert.deepEqual(legacyPaths.workspacePaths, ['D:\\workspace'])
  assert.deepEqual(legacyPaths.filePaths, [
    'D:\\notes\\recent.md',
    'D:\\notes\\favorite.md',
    'D:\\notes\\tab.md',
    'D:\\knowledge\\rag.md',
    'D:\\archive\\chat-source.md',
  ])

  assert.equal(isFileAccessAuthorizationError('file is outside the selected workspace'), true)
  assert.equal(isFileAccessAuthorizationError('workspace was not selected by the user'), true)
  assert.equal(isFileAccessAuthorizationError('The system cannot find the file specified'), false)

  let attempts = 0
  let prompts = 0
  const recovered = await recoverRememberedAccess(
    'D:\\notes\\draft.md',
    async () => {
      attempts++
      if (attempts === 1) throw new Error('file is outside the selected workspace')
      return 'content'
    },
    async () => {
      prompts++
      return true
    }
  )
  assert.equal(recovered, 'content')
  assert.equal(attempts, 2)
  assert.equal(prompts, 1)

  let nonAuthorizationPrompts = 0
  await assert.rejects(
    recoverRememberedAccess(
      'D:\\notes\\missing.md',
      async () => {
        throw new Error('The system cannot find the file specified')
      },
      async () => {
        nonAuthorizationPrompts++
        return true
      }
    ),
    /cannot find/
  )
  assert.equal(nonAuthorizationPrompts, 0)

  let cancelledAttempts = 0
  await assert.rejects(
    recoverRememberedAccess(
      'D:\\notes\\legacy.md',
      async () => {
        cancelledAttempts++
        throw new Error('file is outside the selected workspace')
      },
      async () => false
    ),
    /重新授权已取消/
  )
  assert.equal(cancelledAttempts, 1)

  const shortcutSources = [
    'src/components/layout/Sidebar.tsx',
    'src/components/layout/FullscreenFileDrawer.tsx',
    'src/components/ai/AiPanel.tsx',
  ]
  for (const sourcePath of shortcutSources) {
    const source = readFileSync(sourcePath, 'utf8')
    assert.match(source, /readRememberedFile/)
    assert.doesNotMatch(source, /authorizeSelectedPath\(/)
  }

  const sessionRestore = readFileSync('src/services/sessionRestore.ts', 'utf8')
  const externalOpen = readFileSync('src/services/externalFileOpen.ts', 'utf8')
  const workspaceTree = readFileSync('src/hooks/useWorkspaceFileTree.ts', 'utf8')
  const tauriAdapter = readFileSync('src/hooks/useTauri.ts', 'utf8')
  const rustGateway = readFileSync('src-tauri/src/lib.rs', 'utf8')
  const app = readFileSync('src/App.tsx', 'utf8')
  const persistedAccess = readFileSync('src/services/persistedFileAccess.ts', 'utf8')
  assert.doesNotMatch(sessionRestore, /authorizeSelectedPath\(/)
  assert.match(sessionRestore, /readRememberedFile/)
  assert.doesNotMatch(externalOpen, /authorizeSelectedPath\(/)
  assert.match(workspaceTree, /recoverRememberedWorkspace/)
  assert.doesNotMatch(tauriAdapter, /export async function authorize(?:Selected|Workspace)Path/)
  assert.match(rustGateway, /file-access-grants\.json/)
  assert.match(rustGateway, /restore_persisted_file_access/)
  assert.match(rustGateway, /legacy_migration_completed/)
  assert.match(rustGateway, /pending_legacy_workspaces/)
  assert.match(rustGateway, /pending_legacy_files/)
  assert.match(rustGateway, /retry_pending_legacy_file_access/)
  assert.match(rustGateway, /migrate_legacy_file_access/)
  const migrationCommandStart = rustGateway.indexOf('async fn migrate_legacy_file_access(')
  const nextCommandStart = rustGateway.indexOf('\n#[tauri::command]', migrationCommandStart + 1)
  const migrationCommand = rustGateway.slice(migrationCommandStart, nextCommandStart)
  assert.ok(migrationCommandStart >= 0)
  assert.match(migrationCommand, /tauri::async_runtime::spawn_blocking/)
  assert.match(migrationCommand, /migrate_legacy_file_access_blocking/)
  const setupStart = rustGateway.indexOf('.setup(|app|')
  const handlerStart = rustGateway.indexOf('.invoke_handler', setupStart)
  const setupBlock = rustGateway.slice(setupStart, handlerStart)
  assert.ok(setupStart >= 0)
  assert.match(setupBlock, /tauri::async_runtime::spawn_blocking/)
  assert.match(setupBlock, /restore_persisted_file_access/)
  assert.match(persistedAccess, /Promise\.all\(\[\s*persistence\.loadDocumentFilePaths\(\),\s*persistence\.loadChatSourceFilePaths\(\)/)
  const databaseInitIndex = app.indexOf('await initDatabase()')
  const migrationIndex = app.indexOf('await migrateLegacyFileAccess()')
  const businessHydrationIndex = app.indexOf('await hydrateBusinessData()')
  assert.ok(databaseInitIndex >= 0 && migrationIndex > databaseInitIndex)
  assert.match(app, /function hydrateBusinessData[\s\S]*await restorePersistedTabs/)
  assert.ok(businessHydrationIndex >= 0 && migrationIndex < businessHydrationIndex)

  console.log('File access recovery checks passed')
}

void run()
