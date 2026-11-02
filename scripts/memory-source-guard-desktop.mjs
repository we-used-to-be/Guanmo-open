// Opt-in Windows Debug check; creates only uniquely named anonymous records in the dedicated evaluation database.
import { connectPage } from './measure-cold-start.mjs'
import process from 'node:process'

const port = Number(process.env.GUANMO_EVAL_CDP_PORT)
if (process.env.GUANMO_EVAL_SOURCE_GUARD !== '1' || !Number.isInteger(port) || port < 1024 || port > 65535) {
  throw new Error('Explicit source-guard opt-in and isolated CDP port required')
}
const cdp = await connectPage(port, { exitCode: null })
try {
  const result = await cdp.evaluate(`(async () => {
    const dir = await window.__TAURI_INTERNALS__.invoke('plugin:path|resolve_directory', { directory: 13 })
    if (String(dir).replaceAll(String.fromCharCode(92), '/').split('/').filter(Boolean).at(-1) !== 'com.guanmo.memory-eval-20261031') throw Error('non-isolated target')
    const d = await import('/src/services/database/db.ts')
    const p = await import('/src/services/database/persistence.ts?sourceGuardCheck=' + Date.now())
    if (!d.isDatabaseReady() || !String(p.persistMemory).includes('sourceSnapshotsCondition')) throw Error('database or module not ready')
    const db = d.getDatabase(), prefix = 'guard-' + crypto.randomUUID(), sessionId = prefix + '-s', userId = prefix + '-u', assistantId = prefix + '-a', sourceTime = Date.now()
    await db.execute('INSERT INTO chat_sessions (id, title) VALUES ($1, $2)', [sessionId, '匿名来源校验'])
    await db.execute('INSERT INTO chat_messages (id, session_id, role, content, metadata, created_at) VALUES ($1, $2, $3, $4, $5, $6)', [userId, sessionId, 'user', '我选择 PostgreSQL', null, sourceTime])
    await db.execute('INSERT INTO chat_messages (id, session_id, role, parent_id, content, metadata, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)', [assistantId, sessionId, 'assistant', userId, '已记录', '{}', sourceTime + 1])
    const snapshots = [
      { id: userId, sessionId, role: 'user', parentId: null, content: '我选择 PostgreSQL', metadata: null, createdAt: sourceTime },
      { id: assistantId, sessionId, role: 'assistant', parentId: userId, content: '已记录', metadata: '{}', createdAt: sourceTime + 1 },
    ]
    const guard = { id: userId, content: snapshots[0].content, snapshots }, now = Date.now()
    const memory = { id: prefix + '-m', content: '选择 PostgreSQL', category: 'project', source: 'auto_extracted',
      locked: false, status: 'candidate', scopeType: 'project', scopeKey: 'anonymous-project', createdAt: now, updatedAt: now }
    const initialWrite = await p.persistMemory(memory, true, guard)
    await db.execute('UPDATE chat_messages SET metadata = $1 WHERE id = $2', ['{"hidden":true}', assistantId])
    const staleInsert = await p.persistMemory({ ...memory, id: prefix + '-stale' }, true, guard)
    const staleUpdate = await p.updateMemoryIfUnchanged({ ...memory, content: '不应写入', updatedAt: now + 1000 }, memory, guard)
    const staleDelete = await p.removeMemoryIfUnchanged(memory, guard)
    const rows = await db.select('SELECT id, content, status FROM memories WHERE id IN ($1, $2)', [memory.id, prefix + '-stale'])
    return { sessionId, initialWrite, staleInsert, staleUpdate, staleDelete, rows }
  })()`)
  process.stdout.write(JSON.stringify(result, null, 2) + '\n')
  if (!result.initialWrite || result.staleInsert || result.staleUpdate || result.staleDelete
    || result.rows.length !== 1 || result.rows[0].content !== '选择 PostgreSQL') throw new Error('source guard failed')
} finally {
  cdp.close()
}
