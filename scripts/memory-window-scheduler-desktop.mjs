// Isolated Windows Debug integration check for the B scheduler with a Mock model client.
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
      const scheduler = await import('/src/services/memory/memoryWindowScheduler.ts?schedulerCheck=' + Date.now())
      const persistence = await import('/src/services/database/persistence.ts?schedulerCheck=' + Date.now())
      const memoryService = await import('/src/services/memory/memoryService.ts?schedulerCheck=' + Date.now())
      if (!dbApi.isDatabaseReady()) throw Error('database not ready')
      const db = dbApi.getDatabase(), prefix = 'window-scheduler-' + crypto.randomUUID(), sessionId = prefix + '-s', now = Date.now()
      await db.execute('INSERT INTO chat_sessions (id, title) VALUES ($1, $2)', [sessionId, '匿名窗口调度'])
      const texts = [
        '回答风格有几种常见安排。',
        '我还在比较哪一种更适合自己。',
        '先讨论长期偏好，不要求这次回复采用某种格式。',
        '我长期偏好回答先给结论。',
      ]
      const messages = texts.map((content, index) => ({ id: prefix + '-u' + (index + 1), sessionId, content, metadata: null, createdAt: now + index + 1 }))
      for (let index = 0; index < messages.length; index++) {
        stage = 'persist-' + index
        await db.execute('INSERT INTO chat_messages (id, session_id, role, parent_id, content, metadata, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)',
          [messages[index].id, sessionId, 'user', null, messages[index].content, null, messages[index].createdAt])
        await db.execute('INSERT INTO chat_messages (id, session_id, role, parent_id, content, created_at) VALUES ($1, $2, $3, $4, $5, $6)',
          [prefix + '-a' + (index + 1), sessionId, 'assistant', messages[index].id, '已了解。', now + index + 100])
      }
      let modelCalls = 0
      const modelStages = []
      const mockClient = { chat: async request => {
        modelCalls++
        const system = request.messages[0]?.content || ''
        if (system.includes('逐项核对')) {
          modelStages.push({ stage: 'verify' })
          return { content: '[{"index":0,"supported":true}]', usage: { promptTokens: 100, completionTokens: 3 } }
        }
        const payload = JSON.parse(request.messages[1].content)
        modelStages.push({ stage: 'extract', turns: payload.turns.map(turn => ({ id: turn.id, role: turn.role, text: turn.text, gap: turn.gap })) })
        const primary = payload.turns.find(turn => turn.role === 'user' && turn.text?.includes('我长期偏好回答先给结论'))
        if (!primary) return { content: '[]', usage: { promptTokens: 100, completionTokens: 1 } }
        return { content: JSON.stringify([{ content: '回答偏好：先给结论', category: 'preference', kind: 'semantic', scope: 'global',
          primarySourceId: primary.id, supportingSourceIds: [], subject: 'evaluation-user', factKey: 'evaluation-response-order-' + prefix,
          factValue: '先给结论', confidence: 0.95, segmented: false }]), usage: { promptTokens: 120, completionTokens: 45 } }
      } }
      stage = 'schedule'
      for (const message of messages) {
        await scheduler.schedulePersistedWindowExtraction(message.id, sessionId, null, 'C', mockClient)
      }
      stage = 'wait-for-window'
      const receiptKeys = messages.map(message => 'memory-extraction:v2:intake:' + message.id)
      let states = []
      for (let attempt = 0; attempt < 1000; attempt++) {
        const rows = await db.select('SELECT key, value FROM settings WHERE key IN ($1, $2, $3, $4)', receiptKeys)
        states = rows.map(row => JSON.parse(row.value).status)
        if (states.length === 4 && states.every(status => status !== 'pending')) break
        await new Promise(resolve => setTimeout(resolve, 100))
      }
      const memories = await db.select('SELECT id, status, fact_key, evidence FROM memories WHERE fact_key = $1', ['evaluation-response-order-' + prefix])
      if (memories.length !== 1) throw Error('expected one persisted proposal; found ' + memories.length + ', receipts=' + states.join(',') + ', modelCalls=' + modelCalls + ', modelStages=' + JSON.stringify(modelStages))
      const evidence = JSON.parse(memories[0].evidence)
      stage = 'confirm-and-recall'
      const confirmed = memories[0].status === 'active' || await persistence.confirmMemoryCandidate(memories[0].id)
      const recalled = await memoryService.searchMemories('我的回答偏好是什么？先给结论', { scopeType: 'global', topK: 5, threshold: 0 })
      const injected = memoryService.buildMemoryContextWithSources(recalled, 250)
      return { sessionId, sourceIds: messages.map(message => message.id), receiptStates: states, modelCalls,
        memoryId: memories[0].id, proposalStatus: memories[0].status, confirmed,
        evidenceSourceId: evidence.sourceId, evidenceSources: evidence.sources.map(source => source.id),
        recalledIds: recalled.map(memory => memory.id), injectedIds: injected.sources.map(source => source.memoryId),
        injectedContent: injected.context.includes('先给结论') }
    } catch (error) { throw Error(stage + ': ' + String(error)) }
  })()`)
  process.stdout.write(JSON.stringify(result, null, 2) + '\n')
  if (result.receiptStates.length !== 4 || result.receiptStates.some(status => !['completed', 'noop'].includes(status))
    || result.modelCalls !== 2 || !result.confirmed || !result.sourceIds.includes(result.evidenceSourceId)
    || !result.recalledIds.includes(result.memoryId) || !result.injectedIds.includes(result.memoryId) || !result.injectedContent) {
    throw new Error('memory window scheduler desktop check failed')
  }
} finally {
  cdp.close()
}
