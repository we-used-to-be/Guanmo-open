// Isolated Windows Debug check for the v2 atomic memory write. No model or network calls.
import { connectPage } from './measure-cold-start.mjs'
import process from 'node:process'

const port = Number(process.env.GUANMO_EVAL_CDP_PORT)
if (process.env.GUANMO_EVAL_SOURCE_GUARD !== '1' || !Number.isInteger(port) || port < 1024 || port > 65535) {
  throw new Error('Explicit isolated test opt-in and CDP port required')
}

const cdp = await connectPage(port, { exitCode: null })
try {
  const result = await cdp.evaluate(`(async () => {
    let stage = 'profile'
    try {
    const dir = await window.__TAURI_INTERNALS__.invoke('plugin:path|resolve_directory', { directory: 13 })
    if (String(dir).replaceAll(String.fromCharCode(92), '/').split('/').filter(Boolean).at(-1) !== 'com.guanmo.memory-eval-20261031') throw Error('non-isolated target')
    const dbApi = await import('/src/services/database/db.ts')
    const intakeApi = await import('/src/services/memory/memoryIntake.ts?writeCheck=' + Date.now())
    const ledger = await import('/src/services/memory/memoryWindowLedger.ts?writeCheck=' + Date.now())
    const inputApi = await import('/src/services/memory/memoryWindowInput.ts?writeCheck=' + Date.now())
    const writer = await import('/src/services/memory/memoryWindowPersistence.ts?writeCheck=' + Date.now())
    const persistence = await import('/src/services/database/persistence.ts?writeCheck=' + Date.now())
    const memoryService = await import('/src/services/memory/memoryService.ts?writeCheck=' + Date.now())
    if (!dbApi.isDatabaseReady()) throw Error('database not ready')
    const db = dbApi.getDatabase(), prefix = 'window-write-' + crypto.randomUUID(), sessionId = prefix + '-s', now = Date.now()
    const source = { id: prefix + '-u1', sessionId, content: '我长期喜欢长篇回答先列结论。', metadata: null, createdAt: now }
    stage = 'insert-session'
    await db.execute('INSERT INTO chat_sessions (id, title) VALUES ($1, $2)', [sessionId, '匿名窗口原子写入'])
    stage = 'intake'
    await intakeApi.persistMemoryIntake(source, null)
    stage = 'claim'
    const claimResult = await ledger.acquireMemoryWindow({ sessionId, scopeKey: null, epoch: 0 }, 'C', 'desktop-write-check',
      { now: now + 61_000, lastActivityAt: now, foregroundBusy: false })
    if (claimResult.kind !== 'claimed') throw Error('window claim unavailable: ' + claimResult.kind)
    stage = 'build-input'
    const built = await inputApi.buildMemoryWindowInput(claimResult.claim)
    if (built.kind !== 'ready' || built.packets.length !== 1) throw Error('window input unavailable')
    const candidate = { content: '长篇回答先列结论', category: 'preference', kind: 'semantic', scope: 'global',
      primarySourceId: source.id, supportingSourceIds: [], subject: 'evaluation-user', factKey: 'eval-answer-style-' + prefix,
      factValue: '先列结论', confidence: 0.95, segmented: false, requiresSemanticReview: true }
    stage = 'prepare-write'
    const request = await writer.prepareMemoryWindowWrite(claimResult.claim, built.packets[0], { candidate, supported: true }, [], now)
    stage = 'write'
    const first = await writer.persistMemoryWindowCandidate(request)
    stage = 'retry'
    const retry = await writer.persistMemoryWindowCandidate(request)
    stage = 'verify-and-delete'
    const beforeDelete = await db.select('SELECT id, status, scope_type, scope_key, evidence FROM memories WHERE id = $1', [request.memory.id])
    if (beforeDelete.length !== 1) throw Error('inserted memory missing')
    const evidence = JSON.parse(beforeDelete[0].evidence)
    stage = 'confirm-and-recall'
    const confirmed = await persistence.confirmMemoryCandidate(request.memory.id)
    const activeRows = await db.select('SELECT id, status FROM memories WHERE id = $1', [request.memory.id])
    const recalled = await memoryService.searchMemories('长篇回答先列结论', { scopeType: 'global', topK: 5, threshold: 0 })
    const injected = memoryService.buildMemoryContextWithSources(recalled, 250)
    await db.execute('DELETE FROM memories WHERE id = $1', [request.memory.id])
    const afterDeleteRetry = await writer.persistMemoryWindowCandidate(request)
    const afterDelete = await db.select('SELECT id FROM memories WHERE id = $1', [request.memory.id])
    const operationReceipt = await db.select('SELECT value FROM settings WHERE key = $1', ['memory-extraction:v2:op:' + request.operationId])
    stage = 'settle'
    const settled = await ledger.finishMemoryWindow(claimResult.claim, { [source.id]: 'completed' }, Date.now())
    return { sessionId, sourceId: source.id, memoryId: request.memory.id, first, retry, afterDeleteRetry, confirmed,
      stateBeforeConfirm: beforeDelete[0].status, stateAfterConfirm: activeRows[0]?.status ?? null,
      recalledIds: recalled.map(memory => memory.id), injectedIds: injected.sources.map(source => source.memoryId),
      injectedContent: injected.context.includes('长篇回答先列结论'), scopeType: beforeDelete[0].scope_type, scopeKey: beforeDelete[0].scope_key,
      evidenceVersion: evidence.version, evidenceSourceId: evidence.sourceId, afterDeleteCount: afterDelete.length,
      operationReceiptCount: operationReceipt.length, receiptContainsSourceText: JSON.stringify(operationReceipt).includes(source.content), settled }
    } catch (error) { throw Error(stage + ': ' + String(error)) }
  })()`)
  process.stdout.write(JSON.stringify(result, null, 2) + '\n')
  if (result.first !== 'inserted' || result.retry !== 'already_applied' || result.afterDeleteRetry !== 'already_applied'
    || !result.confirmed || result.stateBeforeConfirm !== 'candidate' || result.stateAfterConfirm !== 'active'
    || !result.recalledIds.includes(result.memoryId) || !result.injectedIds.includes(result.memoryId) || !result.injectedContent
    || result.scopeType !== 'global' || result.scopeKey !== null
    || result.evidenceVersion !== 2 || result.evidenceSourceId !== result.sourceId || result.afterDeleteCount !== 0
    || result.operationReceiptCount !== 1 || result.receiptContainsSourceText || !result.settled) {
    throw new Error('memory window desktop write check failed')
  }
} finally {
  cdp.close()
}
