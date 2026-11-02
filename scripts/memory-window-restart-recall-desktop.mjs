// Isolated Windows Debug restart check for a persisted, confirmed memory and retrieval ID.
import { connectPage } from './measure-cold-start.mjs'
import process from 'node:process'

const port = Number(process.env.GUANMO_EVAL_CDP_PORT)
const memoryId = process.env.GUANMO_EVAL_MEMORY_ID
if (process.env.GUANMO_EVAL_SOURCE_GUARD !== '1' || !Number.isInteger(port) || port < 1024 || port > 65535
  || !memoryId || !/^mem-v2-[0-9a-f]{64}$/.test(memoryId)) {
  throw new Error('Explicit isolated test opt-in, CDP port, and memory ID required')
}

const cdp = await connectPage(port, { exitCode: null })
try {
  const result = await cdp.evaluate(`(async () => {
    const dir = await window.__TAURI_INTERNALS__.invoke('plugin:path|resolve_directory', { directory: 13 })
    if (String(dir).replaceAll(String.fromCharCode(92), '/').split('/').filter(Boolean).at(-1) !== 'com.guanmo.memory-eval-20261031') throw Error('non-isolated target')
    const dbApi = await import('/src/services/database/db.ts')
    const service = await import('/src/services/memory/memoryService.ts?restartCheck=' + Date.now())
    for (let attempt = 0; attempt < 100 && !dbApi.isDatabaseReady(); attempt++) {
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    if (!dbApi.isDatabaseReady()) throw Error('database not ready after restart timeout')
    const id = ${JSON.stringify(memoryId)}
    const [row] = await dbApi.getDatabase().select('SELECT id, status, evidence FROM memories WHERE id = $1', [id])
    if (!row) throw Error('persisted memory missing after restart')
    const evidence = JSON.parse(row.evidence)
    const recalled = await service.searchMemories('我的回答偏好是什么？先给结论', { scopeType: 'global', topK: 5, threshold: 0 })
    const context = service.buildMemoryContextWithSources(recalled, 250)
    const source = evidence.sourceId ? await dbApi.getDatabase().select('SELECT id, session_id, role FROM chat_messages WHERE id = $1', [evidence.sourceId]) : []
    return { memoryId: id, status: row.status, evidenceSourceId: evidence.sourceId, sourceCount: source.length,
      sourceId: source[0]?.id ?? null, sourceSessionId: source[0]?.session_id ?? null, sourceRole: source[0]?.role ?? null,
      recalledIds: recalled.map(memory => memory.id), injectedMemoryIds: context.sources.map(memory => memory.memoryId),
      contextContainsFact: context.context.includes('先给结论') }
  })()`)
  process.stdout.write(JSON.stringify(result, null, 2) + '\n')
  if (result.status !== 'active' || result.sourceCount !== 1 || result.sourceRole !== 'user'
    || result.sourceId !== result.evidenceSourceId || !result.sourceSessionId
    || !result.recalledIds.includes(memoryId) || !result.injectedMemoryIds.includes(memoryId) || !result.contextContainsFact) {
    throw new Error('memory restart recall check failed')
  }
} finally {
  cdp.close()
}
