// Isolated Windows Debug queue test with a delayed Mock model response; no network request.
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
    const q = await import('/src/services/memory/memoryExtractionQueue.ts?barrierCheck=' + Date.now())
    if (!d.isDatabaseReady() || !String(q.MemoryExtractionQueue.prototype.drain).includes('sourceSnapshots')) throw Error('database or module not ready')
    const db = d.getDatabase()
    const pending = await db.select("SELECT COUNT(*) AS n FROM settings WHERE key LIKE 'memory-extraction:v1:%' AND CASE WHEN json_valid(value) THEN json_extract(value, '$.status') END IN ('pending', 'running')")
    if (Number(pending[0]?.n) !== 0) throw Error('isolated queue not empty')
    const prefix = 'barrier-' + crypto.randomUUID(), sessionId = prefix + '-s', sourceId = prefix + '-u'
    const content = '我喜欢所有技术问题使用中文回答'
    await db.execute('INSERT INTO chat_sessions (id, title) VALUES ($1, $2)', [sessionId, '匿名队列屏障'])
    await db.execute('INSERT INTO chat_messages (id, session_id, role, content) VALUES ($1, $2, $3, $4)', [sourceId, sessionId, 'user', content])
    const queue = new q.MemoryExtractionQueue()
    const enqueued = await queue.enqueue({ id: sourceId, role: 'user', content }, sessionId)
    let start, release, calls = 0
    const started = new Promise(resolve => { start = resolve })
    const client = { chat: () => { calls++; start(); return new Promise(resolve => { release = resolve }) } }
    const work = queue.drain(client)
    let timer
    try {
      await Promise.race([started, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('model barrier timeout')), 5000) })])
      await db.execute('UPDATE chat_messages SET metadata = $1 WHERE id = $2', ['{"hidden":true}', sourceId])
    } finally {
      clearTimeout(timer)
      if (release) release({ content: JSON.stringify([{ action: 'add', content: '技术问题使用中文回答', category: 'preference',
        subject: 'user', factKey: 'language', factValue: '中文', confidence: 0.95, sourceId }]) })
    }
    await work
    const rows = await db.select('SELECT id FROM memories WHERE id LIKE $1', ['mem-auto-' + sourceId + '-%'])
    const jobs = await db.select('SELECT value FROM settings WHERE key = $1', ['memory-extraction:v1:' + sourceId])
    return { sessionId, sourceId, enqueued, calls, memories: rows.length, job: jobs[0] ? JSON.parse(jobs[0].value).status : null }
  })()`)
  process.stdout.write(JSON.stringify(result, null, 2) + '\n')
  if (!result.enqueued || result.calls !== 1 || result.memories !== 0 || result.job !== 'completed') throw new Error('queue barrier failed')
} finally {
  cdp.close()
}
