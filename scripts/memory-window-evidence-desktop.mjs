// Isolated Windows Debug evidence/confirmation check; no model or network calls.
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
    const d = await import('/src/services/database/db.ts'), api = await import('/src/services/memory/memoryIntake.ts?evidenceCheck=' + Date.now())
    const ledger = await import('/src/services/memory/memoryWindowLedger.ts?evidenceCheck=' + Date.now())
    const input = await import('/src/services/memory/memoryWindowInput.ts?evidenceCheck=' + Date.now())
    const evidenceApi = await import('/src/services/memory/memoryEvidence.ts?evidenceCheck=' + Date.now())
    const p = await import('/src/services/database/persistence.ts?evidenceCheck=' + Date.now())
    if (!d.isDatabaseReady()) throw Error('database not ready')
    const db = d.getDatabase(), prefix = 'evidence-' + crypto.randomUUID(), sessionId = prefix + '-s', at = Date.now()
    await db.execute('INSERT INTO chat_sessions (id, title) VALUES ($1, $2)', [sessionId, '匿名证据确认'])
    const texts = ['数据库在 SQLite 和 PostgreSQL 中选择。', '定第二个。', '谢谢。', '好的。']
    const sources = [1, 2, 3, 4].map(i => ({ id: prefix + '-u' + i, sessionId, content: texts[i - 1], createdAt: at + i }))
    for (const source of sources) await api.persistMemoryIntake(source, 'P')
    await db.execute('INSERT INTO chat_messages (id, session_id, role, parent_id, content, created_at) VALUES ($1, $2, $3, $4, $5, $6)',
      [prefix + '-a1', sessionId, 'assistant', sources[0].id, '第二个是 PostgreSQL。', at + 20])
    const group = { sessionId, scopeKey: 'p', epoch: 0 }
    const acquired = await ledger.acquireMemoryWindow(group, 'B', 'evidence-worker', { now: Date.now(), lastActivityAt: at, foregroundBusy: false })
    if (acquired.kind !== 'claimed') throw Error('claim unavailable')
    const built = await input.buildMemoryWindowInput(acquired.claim)
    if (built.kind !== 'ready' || built.packets.length !== 1) throw Error('input unavailable')
    const candidate = { content: '项目数据库选择 PostgreSQL', category: 'project', kind: 'episodic', scope: 'project',
      primarySourceId: sources[1].id, supportingSourceIds: [sources[0].id, prefix + '-a1'], subject: 'project',
      factKey: 'database', factValue: 'PostgreSQL', confidence: 0.9, segmented: false, requiresSemanticReview: true }
    const evidence = await evidenceApi.encodeWindowMemoryEvidence(acquired.claim, built.packets[0], candidate)
    const decoded = evidenceApi.decodeMemoryEvidence(evidence)
    const sourceIds = decoded?.sources?.map(source => source.id) || []
    const guard = { id: sources[1].id, content: sources[1].content, snapshots: built.packets[0].snapshots,
      lease: { key: acquired.claim.key, value: acquired.claim.value } }
    const base = { category: 'project', source: 'manual_created', locked: false, status: 'active', scopeType: 'project',
      scopeKey: 'p', subject: 'project', factKey: 'database', factValue: 'SQLite', content: '项目数据库选择 SQLite', createdAt: at, updatedAt: at }
    const old1 = { ...base, id: prefix + '-old1' }, old2 = { ...base, id: prefix + '-old2' }
    if (!await p.persistMemory(old1, true) || !await p.persistMemory(old2, true)) throw Error('fixture insert failed')
    const makeCandidate = (id, old) => ({ ...base, id, content: candidate.content, source: 'auto_extracted', status: 'candidate',
      factValue: candidate.factValue, supersedesId: old.id, evidence: evidenceApi.withMemoryReplacement(evidence, old) })
    const c1 = makeCandidate('mem-v2-' + prefix + '-stale', old1), c2 = makeCandidate('mem-v2-' + prefix + '-valid', old2)
    if (!await p.persistMemory(c1, true, guard) || !await p.persistMemory(c2, true, guard)) throw Error('candidate insert failed')
    await db.execute('UPDATE memories SET content = $1, updated_at = $2 WHERE id = $3', ['用户修改后的数据库', at + 1000, old1.id])
    const staleConfirmed = await p.confirmMemoryCandidate(c1.id), validConfirmed = await p.confirmMemoryCandidate(c2.id)
    const invalid = { ...c2, id: 'mem-v2-' + prefix + '-bad', supersedesId: null, evidence: '{"version":2}' }
    if (!await p.persistMemory(invalid, true, guard)) throw Error('invalid fixture insert failed')
    const malformedConfirmed = await p.confirmMemoryCandidate(invalid.id)
    const rows = await db.select('SELECT id, status FROM memories WHERE id IN ($1, $2, $3, $4, $5)', [old1.id, c1.id, old2.id, c2.id, invalid.id])
    const statuses = Object.fromEntries(rows.map(row => [row.id, row.status]))
    return { sessionId, version: decoded?.version, sourceCount: sourceIds.length, orderedSources: sourceIds.join(',') === [sources[0].id, prefix + '-a1', sources[1].id].join(','),
      staleConfirmed, validConfirmed, malformedConfirmed, staleOld: statuses[old1.id], staleCandidate: statuses[c1.id],
      validOld: statuses[old2.id], validCandidate: statuses[c2.id], malformedCandidate: statuses[invalid.id] }
  })()`)
  process.stdout.write(JSON.stringify(result, null, 2) + '\n')
  if (result.version !== 2 || result.sourceCount !== 3 || !result.orderedSources || result.staleConfirmed || !result.validConfirmed
    || result.malformedConfirmed || result.staleOld !== 'active' || result.staleCandidate !== 'candidate'
    || result.validOld !== 'superseded' || result.validCandidate !== 'active' || result.malformedCandidate !== 'candidate') {
    throw new Error('evidence desktop verification failed')
  }
} finally {
  cdp.close()
}
