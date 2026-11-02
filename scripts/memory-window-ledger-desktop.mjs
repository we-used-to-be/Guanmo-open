// Isolated Windows Debug ledger verification; simulated clock, no model or network calls.
import { connectPage } from './measure-cold-start.mjs'
import process from 'node:process'

const port = Number(process.env.GUANMO_EVAL_CDP_PORT)
if (process.env.GUANMO_EVAL_SOURCE_GUARD !== '1' || !Number.isInteger(port) || port < 1024 || port > 65535) {
  throw new Error('Explicit isolated test opt-in and CDP port required')
}
const cdp = await connectPage(port, { exitCode: null })
try {
  const result = await cdp.evaluate(`(async () => {
    const dir = await window.__TAURI_INTERNALS__.invoke('plugin:path|resolve_directory', { directory: 13 })
    if (String(dir).replaceAll(String.fromCharCode(92), '/').split('/').filter(Boolean).at(-1) !== 'com.guanmo.memory-eval-20261031') throw Error('non-isolated target')
    const d = await import('/src/services/database/db.ts'), api = await import('/src/services/memory/memoryIntake.ts?windowCheck=' + Date.now())
    const ledger = await import('/src/services/memory/memoryWindowLedger.ts?windowCheck=' + Date.now())
    const persistence = await import('/src/services/database/persistence.ts?windowCheck=' + Date.now())
    const reader = await import('/src/services/memory/memoryIntakeSource.ts?windowCheck=' + Date.now())
    const inputBuilder = await import('/src/services/memory/memoryWindowInput.ts?windowCheck=' + Date.now())
    const model = await import('/src/services/memory/memoryWindowModel.ts?windowCheck=' + Date.now())
    if (!d.isDatabaseReady()) throw Error('database not ready')
    const db = d.getDatabase(), prefix = 'window-' + crypto.randomUUID(), sessionId = prefix + '-s', at = Date.now()
    await db.execute('INSERT INTO chat_sessions (id, title) VALUES ($1, $2)', [sessionId, '匿名窗口租约'])
    const texts = ['数据库在 SQLite 和 PostgreSQL 中选择。', '定第二个。', '我的密码是匿名口令', '谢谢。']
    const sources = [1, 2, 3, 4].map(i => ({ id: prefix + '-u' + i, sessionId, content: texts[i - 1], createdAt: at + i }))
    for (const source of sources) await api.persistMemoryIntake(source, 'P')
    await db.execute('INSERT INTO chat_messages (id, session_id, role, parent_id, content, created_at) VALUES ($1, $2, $3, $4, $5, $6)',
      [prefix + '-a1', sessionId, 'assistant', sources[0].id, '第二个是 PostgreSQL。', at + 20])
    const group = { sessionId, scopeKey: 'p', epoch: 0 }, options = { now: at + 100, lastActivityAt: at + 4, foregroundBusy: false }
    const contenders = await Promise.all([ledger.acquireMemoryWindow(group, 'B', 'worker-a', options), ledger.acquireMemoryWindow(group, 'B', 'worker-b', options)])
    const winner = contenders.find(item => item.kind === 'claimed')
    if (!winner || contenders.filter(item => item.kind === 'claimed').length !== 1) throw Error('claim collision')
    const receiptRows = await db.select('SELECT value FROM settings WHERE key = $1', ['memory-extraction:v2:intake:' + sources[0].id])
    const source = await reader.readMemoryIntakeSource(JSON.parse(receiptRows[0].value))
    if (source.kind !== 'ready') throw Error('source unavailable')
    const built = await inputBuilder.buildMemoryWindowInput(winner.claim)
    if (built.kind !== 'ready' || built.packets.length !== 1) throw Error('window input unavailable')
    const inputTurns = built.packets[0].turns, inputJson = JSON.stringify(inputTurns)
    const continuous = inputTurns.map(turn => turn.role).join(',') === 'user,assistant,user,user,user'
      && inputTurns[1].parentId === sources[0].id && inputTurns[2].text === '定第二个。'
    const sensitiveHidden = !inputJson.includes('匿名口令') && inputTurns[3].gap === 'sensitive'
    let modelCalls = 0, requestSafe = true
    const mock = { chat: async request => {
      modelCalls++
      const sent = JSON.stringify(request.messages)
      requestSafe = requestSafe && !sent.includes('匿名口令') && !sent.includes('snapshots')
      if (modelCalls === 2) return { content: '[{"index":0,"supported":true}]' }
      return { content: JSON.stringify([{ content: '项目数据库选择 PostgreSQL', category: 'project', kind: 'episodic', scope: 'project',
        primarySourceId: sources[1].id, supportingSourceIds: [sources[0].id, prefix + '-a1'], subject: 'project', factKey: 'database',
        factValue: 'PostgreSQL', confidence: 0.9 }]) }
    } }
    const proposal = await model.requestMemoryWindowProposals(winner.claim, built.packets[0], [], mock, { foregroundBusy: () => false })
    const proposed = proposal.kind === 'proposals' && proposal.candidates.length === 1
      && proposal.candidates[0].primarySourceId === sources[1].id && proposal.candidates[0].requiresSemanticReview === true
    if (!proposed) throw Error('mock proposal rejected')
    const verification = await model.verifyMemoryWindowProposals(winner.claim, built.packets[0], proposal.candidates, mock, { foregroundBusy: () => false })
    const modelChecked = verification.kind === 'verified' && verification.verdicts.length === 1
      && verification.verdicts[0].supported === true && verification.verdicts[0].candidate.requiresSemanticReview === true
    const memory = { id: prefix + '-m', content: '匿名窗口候选', category: 'project', source: 'auto_extracted', locked: false,
      status: 'candidate', scopeType: 'project', scopeKey: 'p', createdAt: at, updatedAt: at }
    const guard = claim => ({ id: sources[0].id, content: source.snapshot.content, snapshots: built.packets[0].snapshots,
      lease: { key: claim.key, value: claim.value } })
    const firstWrite = await persistence.persistMemory(memory, true, guard(winner.claim))
    const deferred = await ledger.deferMemoryWindow(winner.claim, 'retry', at + 101)
    const staleWrite = await persistence.persistMemory({ ...memory, id: prefix + '-stale' }, true, guard(winner.claim))
    const early = await ledger.acquireMemoryWindow(group, 'B', 'worker-c', { ...options, now: at + 2100 })
    const resumed = await ledger.acquireMemoryWindow(group, 'B', 'worker-c', { ...options, now: at + 2101 })
    if (resumed.kind !== 'claimed') throw Error('retry not claimed')
    const staleFinished = await ledger.finishMemoryWindow(winner.claim, Object.fromEntries(sources.map(source => [source.id, 'completed'])), at + 2102)
    const currentWrite = await persistence.persistMemory({ ...memory, id: prefix + '-current' }, true, guard(resumed.claim))
    const completed = await ledger.finishMemoryWindow(resumed.claim, Object.fromEntries(sources.map((source, i) => [source.id, i === 2 ? 'invalidated' : 'completed'])), at + 2102)
    const rows = await db.select('SELECT value FROM settings WHERE key IN ($1, $2, $3, $4)', sources.map(source => 'memory-extraction:v2:intake:' + source.id))
    const receipts = rows.map(row => JSON.parse(row.value)).sort((a, b) => a.sequence - b.sequence).map(row => row.status)
    return { sessionId, contenderKinds: contenders.map(item => item.kind), continuous, sensitiveHidden, modelCalls, requestSafe, proposed, modelChecked,
      firstWrite, deferred, staleWrite, early: early.kind,
      attempts: resumed.claim.record.attempts, staleFinished, currentWrite, completed, receipts }
  })()`)
  process.stdout.write(JSON.stringify(result, null, 2) + '\n')
  if (result.contenderKinds.filter(kind => kind === 'claimed').length !== 1 || !result.continuous || !result.sensitiveHidden
    || result.modelCalls !== 2 || !result.requestSafe || !result.proposed || !result.modelChecked
    || !result.firstWrite || !result.deferred || result.staleWrite || result.early !== 'busy'
    || result.attempts !== 2 || result.staleFinished || !result.currentWrite || !result.completed
    || result.receipts.join(',') !== 'completed,completed,invalidated,completed') throw new Error('ledger desktop verification failed')
} finally {
  cdp.close()
}
