// @vitest-environment node
// Explicit opt-in pilot: real A queue + anonymous in-memory SQLite + isolated desktop model proxy.
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as sleep } from 'node:timers/promises'
import { expect, it, vi } from 'vitest'
import { DB_SCHEMA, splitDatabaseSchemaStatements } from '@/services/database/schema'
import { loadMemories, persistMemory, type Memory } from '@/services/database/persistence'
import { MemoryExtractionQueue } from '@/services/memory/memoryExtractionQueue'
import type { ChatRequest } from '@/services/ai/types'
import { connectPage } from './measure-cold-start.mjs'

const adapter = vi.hoisted(() => ({ execute: vi.fn(), select: vi.fn() }))
vi.mock('@/services/database/db', () => ({ isDatabaseReady: () => true, getDatabase: () => adapter }))
vi.mock('@/services/idleScheduler', () => ({ idleScheduler: { enqueueOptional: vi.fn() } }))

type Message = { id: string; role: 'user' | 'assistant'; text: string; session: string; scope: string; parentId: string | null }
type Case = { id: string; split: string; messages: Message[] }
const bind = (params: unknown[]) => Object.fromEntries(params.map((value, index) => [`$${index + 1}`, value]))
const cases = readFileSync('docs/memory/evaluation/extraction-v1/cases.jsonl', 'utf8').trim().split('\n').map(line => JSON.parse(line) as Case)
const chosen = ['01', '03', '07', '09', '13', '17', '23', '25'].map(script => {
  const item = cases.find(candidate => candidate.id === `EX-${script}-S1` && candidate.split === 'development')
  if (!item) throw new Error(`Missing development case ${script}`)
  return item
})
const port = Number(process.env.GUANMO_EVAL_CDP_PORT)
const mode = process.env.GUANMO_EVAL_PILOT_MODE
if (process.env.GUANMO_EVAL_PILOT_ENABLE !== '1' || !['mock', 'real'].includes(mode || '')
  || mode === 'real' && (!Number.isInteger(port) || port < 1024 || port > 65535)) {
  throw new Error('Explicit pilot enable and isolated CDP port are required')
}

it('runs the bounded eight-case A development pilot', async () => {
  const runDir = mkdtempSync(join(tmpdir(), 'guanmo-a-pilot-'))
  const reportPath = join(runDir, 'report.json')
  const report: { status: string; limitations: string[]; logicalCalls: number; reservedNetworkCalls: number; reservedInputTokens: number;
    reservedOutputTokens: number; reservedCostUsd: number; cases: unknown[]; fatal?: string } = {
    status: 'running', limitations: [mode === 'real' ? 'hybrid Node SQLite and desktop model proxy' : 'NOOP mock; timing compressed', 'explicit confirmation not tested',
      'earlier provider usage and network retries unknown', 'no formal B/C comparison'], logicalCalls: 0,
    reservedNetworkCalls: 0, reservedInputTokens: 0, reservedOutputTokens: 0, reservedCostUsd: 0, cases: [],
  }
  const save = () => writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n')
  save()
  const cdp = mode === 'real' ? await connectPage(port, { exitCode: null }) : null
  try {
    if (cdp) {
      const dir = await cdp.evaluate("window.__TAURI_INTERNALS__.invoke('plugin:path|resolve_directory',{directory:13})")
      if (String(dir).replaceAll(String.fromCharCode(92), '/').split('/').filter(Boolean).at(-1) !== 'com.guanmo.memory-eval-20261031') throw new Error('non-isolated target')
      const ready = await cdp.evaluate("(async()=>{const a=await import('/src/services/ai/aiClient.ts');const r=await import('/src/services/ai/reasoningAdapter.ts');const c=a.getAiConfig();const body={};return Boolean(c&&new URL(c.baseUrl).hostname==='api.deepseek.com'&&r.applyReasoningMode('deepseek','deepseek-v4-flash',body,'off')&&body.thinking?.type==='disabled')})()")
      if (!ready) throw new Error('unexpected connection or reasoning configuration')
    }
    for (const item of chosen) {
      if (report.fatal) break
      const db = new DatabaseSync(':memory:')
      let scheduled = false, active = 0, timer: ReturnType<typeof setTimeout> | undefined
      try {
        for (const sql of splitDatabaseSchemaStatements(DB_SCHEMA)) {
          if (/^CREATE TABLE IF NOT EXISTS (?:memories|settings|chat_sessions|chat_messages)\b/.test(sql)) db.exec(sql)
        }
        adapter.execute.mockImplementation(async (sql: string, params: unknown[] = []) => ({ rowsAffected: Number(db.prepare(sql).run(bind(params)).changes) }))
        adapter.select.mockImplementation(async (sql: string, params: unknown[] = []) => db.prepare(sql).all(bind(params)))
        if (item.id.startsWith('EX-17-')) {
          const initial: Memory = { id: 'initial-language', content: '回答语言使用中文', category: 'preference', source: 'auto_extracted',
            status: 'active', locked: false, scopeType: 'global', scopeKey: null, subject: 'user', factKey: 'language', factValue: '中文',
            createdAt: 1_700_000_000_000, updatedAt: 1_700_000_000_000 }
          expect(await persistMemory(initial)).toBe(true)
        }
        const queue = new MemoryExtractionQueue(), traces: unknown[] = []
        const client = { chat: async (request: ChatRequest) => {
          if (report.fatal) throw new Error('pilot stopped')
          const payload = { messages: request.messages, temperature: request.temperature, maxTokens: request.maxTokens, reasoningMode: request.reasoningMode }
          const reservedInput = (Buffer.byteLength(JSON.stringify(payload), 'utf8') + 512) * 2
          const reservedOutput = Number(request.maxTokens || 800) * 2
          const reservedCost = reservedInput * 0.30 / 1_000_000 + reservedOutput * 1.20 / 1_000_000
          if (report.logicalCalls >= 6 || report.reservedNetworkCalls + 2 > 12 || report.reservedInputTokens + reservedInput > 150_000
            || report.reservedOutputTokens + reservedOutput > 9_600 || report.reservedCostUsd + reservedCost > 0.06) {
            report.fatal = 'pilot_budget_exhausted'; save(); throw new Error('pilot budget exhausted')
          }
          report.logicalCalls++; report.reservedNetworkCalls += 2; report.reservedInputTokens += reservedInput
          report.reservedOutputTokens += reservedOutput; report.reservedCostUsd += reservedCost; save()
          const started = performance.now()
          try {
            const expression = `(async()=>{const a=await import('/src/services/ai/aiClient.ts');const c=a.createChatProvider({...a.getAiConfig(),provider:'deepseek',chatModel:'deepseek-v4-flash'});const ctl=new AbortController(),timer=setTimeout(()=>ctl.abort(),19000);try{const out=await c.chat({...${JSON.stringify(payload)},signal:ctl.signal});return {content:out.content,usage:out.usage||null}}finally{clearTimeout(timer)}})()`
            const response = cdp ? await cdp.evaluate(expression) as { content: string; usage: unknown } : { content: '[]', usage: null }
            const fenced = response.content.match(/```(?:json)?\s*([\s\S]*?)```/)
            const text = (fenced ? fenced[1] : response.content).trim(), start = text.indexOf('['), end = text.lastIndexOf(']')
            if (start < 0 || end < 0 || !Array.isArray(JSON.parse(text.slice(start, end + 1)))) throw new Error('invalid extraction output')
            traces.push({ durationMs: Math.round(performance.now() - started), usage: response.usage, sourceIds: request.messages.flatMap(message => {
              try { const parsed = JSON.parse(message.content); return typeof parsed.sourceId === 'string' ? [parsed.sourceId] : [] } catch { return [] }
            }), content: response.content })
            return response
          } catch {
            report.fatal = 'model_or_parse_failure'; save(); throw new Error('pilot stopped on model or parse failure')
          }
        } }
        const schedule = (delay: number) => {
          if (scheduled) return
          scheduled = true
          timer = setTimeout(() => {
            scheduled = false; active++
            void queue.drain(client).then(next => { if (next !== undefined) schedule(next) })
              .catch(() => { report.fatal = 'queue_failure' }).finally(() => { active-- })
          }, delay)
        }
        const users = item.messages.filter(message => message.role === 'user'), start = performance.now()
        const accepted: boolean[] = []
        for (const [index, source] of users.entries()) {
          const remaining = start + index * (mode === 'real' ? 10_000 : 10) - performance.now()
          if (remaining > 0) await sleep(remaining)
          db.prepare('INSERT OR IGNORE INTO chat_sessions (id, title) VALUES (?, ?)').run(source.session, '匿名试跑')
          db.prepare('INSERT INTO chat_messages (id, session_id, role, content) VALUES (?, ?, ?, ?)').run(source.id, source.session, source.role, source.text)
          await sleep(mode === 'real' ? 1000 : 1)
          const reply = item.messages.find(message => message.role === 'assistant' && message.parentId === source.id)
          if (reply) db.prepare('INSERT INTO chat_messages (id, session_id, parent_id, role, content) VALUES (?, ?, ?, ?, ?)')
            .run(reply.id, reply.session, reply.parentId, reply.role, reply.text)
          const workspace = source.scope === 'global' ? null : `D:/memory-eval/${source.scope}`
          accepted.push(await queue.enqueue({ id: source.id, role: 'user', content: source.text }, source.session, workspace))
          schedule(mode === 'real' ? 500 : 1)
        }
        const deadline = performance.now() + 45_000
        while ((scheduled || active) && performance.now() < deadline) await sleep(100)
        if (scheduled || active) { report.fatal = 'queue_did_not_settle'; throw new Error(report.fatal) }
        const memories = (await loadMemories()).map(memory => ({ id: memory.id, content: memory.content, status: memory.status,
          scopeType: memory.scopeType, scopeKey: memory.scopeKey, evidence: memory.evidence, source: memory.source }))
        const jobs = db.prepare("SELECT key,value FROM settings WHERE key LIKE 'memory-extraction:v1:%'").all()
        report.cases.push({ id: item.id, accepted, traces, memories, jobs,
          explicitConfirmation: item.id.startsWith('EX-25-') ? 'NOT TESTED' : 'not applicable',
          observation: mode === 'real' ? 'stopped after queue settled, not full 120-second window' : 'mock, compressed timing' })
        save()
        process.stdout.write(`${item.id}: ${traces.length} logical model calls\n`)
      } finally {
        if (timer) clearTimeout(timer)
        db.close()
      }
    }
    report.status = report.fatal ? 'stopped' : 'completed'
    save()
    process.stdout.write(`A pilot report: ${reportPath}\n`)
  } finally { cdp?.close() }
})
