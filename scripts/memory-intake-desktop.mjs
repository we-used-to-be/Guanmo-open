// Opt-in anonymous Windows Debug transaction check. It leaves only isolated evaluation data.
import { connectPage } from './measure-cold-start.mjs'
import process from 'node:process'

const port = Number(process.env.GUANMO_EVAL_CDP_PORT)
if (process.env.GUANMO_EVAL_SOURCE_GUARD !== '1' || !Number.isInteger(port) || port < 1024 || port > 65535) {
  throw new Error('Explicit isolated test opt-in and CDP port required')
}
const cdp = await connectPage(port, { exitCode: null })
try {
  const result = await cdp.evaluate(`(async () => {
    let stage = 'setup'
    try {
    const dir = await window.__TAURI_INTERNALS__.invoke('plugin:path|resolve_directory', { directory: 13 })
    if (String(dir).replaceAll(String.fromCharCode(92), '/').split('/').filter(Boolean).at(-1) !== 'com.guanmo.memory-eval-20261031') throw Error('non-isolated target')
    const d = await import('/src/services/database/db.ts'), api = await import('/src/services/memory/memoryIntake.ts?nativeCheck=' + Date.now())
    const reader = await import('/src/services/memory/memoryIntakeSource.ts?nativeCheck=' + Date.now())
    if (!d.isDatabaseReady()) throw Error('database not ready')
    const db = d.getDatabase(), prefix = 'intake-' + crypto.randomUUID(), sessionId = prefix + '-s'
    await db.execute('INSERT INTO chat_sessions (id, title) VALUES ($1, $2)', [sessionId, '匿名登记事务'])
    const items = [1, 2, 3].map(index => ({ id: prefix + '-u' + index, sessionId, content: '匿名消息 ' + index, metadata: null, createdAt: Date.now() + index }))
    const writes = []
    for (let i = 0; i < items.length; i++) { stage = 'intake-' + i; writes.push(await api.persistMemoryIntake(items[i], ['P', 'Q', 'P'][i])) }
    stage = 'duplicate'
    const key = 'memory-extraction:v2:intake:' + items[0].id
    await db.execute("UPDATE settings SET value = json_set(value, '$.status', 'completed') WHERE key = $1", [key])
    const duplicate = await api.persistMemoryIntake(items[0], 'P')
    stage = 'delete-test-source'
    await db.execute('DELETE FROM chat_messages WHERE id = $1 AND session_id = $2', [items[1].id, sessionId])
    let deletedRetryRejected = false
    try { await api.persistMemoryIntake(items[1], 'Q') } catch { deletedRetryRejected = true }
    const sourceRows = await db.select('SELECT id FROM chat_messages WHERE id = $1', [items[1].id])
    const rows = await db.select('SELECT value FROM settings WHERE key IN ($1, $2, $3)', items.map(item => 'memory-extraction:v2:intake:' + item.id))
    const rawReceipts = rows.map(row => JSON.parse(row.value)).sort((a, b) => a.sequence - b.sequence)
    const sourceStates = []
    for (const receipt of rawReceipts) sourceStates.push((await reader.readMemoryIntakeSource(receipt)).kind)
    await db.execute('UPDATE chat_messages SET metadata = $1 WHERE id = $2', ['{"hidden":true}', items[2].id])
    const changedSourceState = (await reader.readMemoryIntakeSource(rawReceipts[2])).kind
    const receipts = rawReceipts.map(row => ({ sequence: row.sequence, epoch: row.epoch, scopeKey: row.scopeKey, status: row.status,
        hasFingerprint: /^[0-9a-f]{64}$/.test(row.sourceFingerprint), hasText: JSON.stringify(row).includes('匿名消息') }))
    return { sessionId, writes, duplicate, deletedRetryRejected, deletedSourceCount: sourceRows.length, receipts, sourceStates, changedSourceState }
    } catch (error) { throw Error(stage + ': ' + String(error)) }
  })()`)
  process.stdout.write(JSON.stringify(result, null, 2) + '\n')
  if (result.writes.some(value => value !== true) || result.duplicate !== false || !result.deletedRetryRejected
    || result.deletedSourceCount !== 0 || result.receipts.length !== 3
    || result.receipts.some((row, index) => row.sequence !== index + 1 || row.epoch !== index || row.scopeKey !== ['p', 'q', 'p'][index] || !row.hasFingerprint || row.hasText)
    || result.receipts[0].status !== 'completed' || result.sourceStates.join(',') !== 'ready,invalidated,ready'
    || result.changedSourceState !== 'invalidated') throw new Error('intake desktop verification failed')
} finally {
  cdp.close()
}
