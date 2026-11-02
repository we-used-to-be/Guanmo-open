// Isolated Windows startup-recovery check using a refusal source that must never reach a model.
import { connectPage } from './measure-cold-start.mjs'
import process from 'node:process'

const port = Number(process.env.GUANMO_EVAL_CDP_PORT)
const action = process.env.GUANMO_EVAL_RECOVERY_ACTION
const sourceId = process.env.GUANMO_EVAL_RECOVERY_SOURCE_ID
if (process.env.GUANMO_EVAL_SOURCE_GUARD !== '1' || !Number.isInteger(port) || port < 1024 || port > 65535
  || !['seed', 'assert'].includes(action) || action === 'assert' && !sourceId) {
  throw new Error('Explicit isolated test opt-in, CDP port, recovery action, and source ID required')
}

const cdp = await connectPage(port, { exitCode: null })
try {
  const result = await cdp.evaluate(`(async () => {
    let stage = 'profile'
    try {
      const dir = await window.__TAURI_INTERNALS__.invoke('plugin:path|resolve_directory', { directory: 13 })
      if (String(dir).replaceAll(String.fromCharCode(92), '/').split('/').filter(Boolean).at(-1) !== 'com.guanmo.memory-eval-20261031') throw Error('non-isolated target')
      const dbApi = await import('/src/services/database/db.ts')
      const ledger = await import('/src/services/memory/memoryWindowLedger.ts?recoveryCheck=' + Date.now())
      for (let attempt = 0; attempt < 200 && !dbApi.isDatabaseReady(); attempt++) await new Promise(resolve => setTimeout(resolve, 100))
      if (!dbApi.isDatabaseReady()) throw Error('database not ready')
      const db = dbApi.getDatabase()
      if (${JSON.stringify(action)} === 'seed') {
        const prefix = 'window-recovery-' + crypto.randomUUID(), sessionId = prefix + '-s'
        const createdAt = Date.now() - 120_000
        const source = { id: prefix + '-u1', sessionId, content: '不要记住这段临时回答。', metadata: null, createdAt }
        stage = 'seed-session'
        await db.execute('INSERT INTO chat_sessions (id, title) VALUES ($1, $2)', [sessionId, '匿名启动恢复'])
        await db.execute('INSERT INTO chat_messages (id, session_id, role, parent_id, content, metadata, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)',
          [source.id, sessionId, 'user', null, source.content, null, source.createdAt])
        stage = 'persist-pending-receipt'
        const intake = await import('/src/services/memory/memoryIntake.ts?recoveryCheck=' + Date.now())
        await intake.persistMemoryIntake(source, null)
        const groups = await ledger.listPendingMemoryWindowGroups()
        const [receipt] = await db.select('SELECT value FROM settings WHERE key = $1', ['memory-extraction:v2:intake:' + source.id])
        const value = JSON.parse(receipt.value)
        if (value.status !== 'pending' || !groups.some(group => group.group.sessionId === sessionId && group.pendingCount === 1)) throw Error('pending receipt not durably recoverable')
        return { action: 'seed', sourceId: source.id, sessionId, createdAt: source.createdAt, initialStatus: value.status }
      }

      stage = 'wait-for-startup-recovery'
      const id = ${JSON.stringify(sourceId)}
      let status = 'missing'
      for (let attempt = 0; attempt < 300; attempt++) {
        const [receipt] = await db.select('SELECT value FROM settings WHERE key = $1', ['memory-extraction:v2:intake:' + id])
        status = receipt ? JSON.parse(receipt.value).status : 'missing'
        if (status !== 'pending') break
        await new Promise(resolve => setTimeout(resolve, 100))
      }
      const [receipt] = await db.select('SELECT value FROM settings WHERE key = $1', ['memory-extraction:v2:intake:' + id])
      const value = receipt ? JSON.parse(receipt.value) : null
      const session = value ? value.sessionId : ''
      const windows = await db.select("SELECT value FROM settings WHERE key LIKE 'memory-extraction:v2:window:%'")
      const matchingWindow = windows.map(row => JSON.parse(row.value)).find(window => window.sessionId === session)
      const memoryRows = await db.select("SELECT id FROM memories WHERE evidence LIKE $1", ['%' + id + '%'])
      return { action: 'assert', sourceId: id, status, windowStatus: matchingWindow?.status ?? null,
        attempts: matchingWindow?.attempts ?? null, memoryCount: memoryRows.length }
    } catch (error) { throw Error(stage + ': ' + String(error)) }
  })()`)
  process.stdout.write(JSON.stringify(result, null, 2) + '\n')
  if (action === 'seed' && result.initialStatus !== 'pending'
    || action === 'assert' && (result.status !== 'noop' || result.windowStatus !== 'finished' || result.attempts !== 1 || result.memoryCount !== 0)) {
    throw new Error('memory startup recovery desktop check failed')
  }
} finally {
  cdp.close()
}
