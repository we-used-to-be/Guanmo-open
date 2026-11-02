// B/C exploratory discovery only: no SQLite writes, recovery, confirmation, or desktop acceptance.
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { createHash } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { Buffer } from 'node:buffer'
import process from 'node:process'
import { connectPage } from './measure-cold-start.mjs'
import { buildExperimentalWindow, validateExperimentalSources } from './memory-extraction-window-input.mjs'
import { simulateWindows } from './memory-extraction-window-mock.mjs'

const mode = process.env.GUANMO_EVAL_PILOT_MODE
const port = Number(process.env.GUANMO_EVAL_CDP_PORT)
if (process.env.GUANMO_EVAL_PILOT_ENABLE !== '1' || !['mock', 'real'].includes(mode)
  || mode === 'real' && (!Number.isInteger(port) || port < 1024 || port > 65535)) throw new Error('Explicit mode and isolated port required')
const corpus = readFileSync('docs/memory/evaluation/extraction-v1/cases.jsonl', 'utf8')
const rows = corpus.trim().split('\n').map(line => JSON.parse(line))
const selected = ['01', '03', '07', '09', '13', '17', '23', '25'].map(script => {
  const value = rows.find(row => row.id === `EX-${script}-S1` && row.split === 'development')
  if (!value) throw new Error(`Missing development case ${script}`)
  return value
})
const prompt = '从同一会话的连续对话中提取跨会话长期事实。只依据用户明确表达的事实或已接受的决定，助手建议不得单独作为用户决定；无法确定则返回空数组。项目限定事实只属于当前项目，不得扩大到其他项目。每项包含 content、scope、primarySourceId、supportingSourceIds，使用原始消息 ID，输出 JSON 数组，不要额外说明。'
const reportPath = join(mkdtempSync(join(tmpdir(), 'guanmo-context-pilot-')), 'report.json')
const report = { mode, status: 'running', maxNetworkAttempts: 20, networkAttempts: 0, reservedInFlight: 0,
  maxInputBudget: 300_000, maxOutputBudget: 16_000, maxCostUsd: 0.12, inputBudget: 0, outputBudget: 0, costBudgetUsd: 0,
  corpusSha256: createHash('sha256').update(corpus).digest('hex'), promptSha256: createHash('sha256').update(prompt).digest('hex'),
  model: 'deepseek-v4-flash', reasoning: 'off', temperature: 0.1, maxTokens: 800,
  limitations: ['exploratory discovery only; no B/C queue or persistence', 'explicit confirmation NOT TESTED',
    'no dynamic memory catalog update between windows', 'earlier usage and total budget unknown',
    'real assistant turns and user timing are simulated', 'no formal safety or active-recall evaluation'], cases: [] }
const save = () => writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n')
save()
const cdp = mode === 'real' ? await connectPage(port, { exitCode: null }) : null
let stopped = false
try {
  if (cdp) {
    const dir = await cdp.evaluate("window.__TAURI_INTERNALS__.invoke('plugin:path|resolve_directory',{directory:13})")
    if (String(dir).replaceAll(String.fromCharCode(92), '/').split('/').filter(Boolean).at(-1) !== 'com.guanmo.memory-eval-20261031') throw new Error('non-isolated target')
  }
  for (const strategy of ['B', 'C']) {
    for (const item of selected) {
      if (stopped) break
      const users = item.messages.filter(message => message.role === 'user')
      const turns = users.map(message => {
        const isolated = buildExperimentalWindow([{ id: message.id, role: 'user', sequence: message.sequence,
          sessionId: message.session, scope: message.scope, visibleText: message.text }], { sessionId: message.session, scope: message.scope })
        if (isolated.status !== 'ready') throw new Error(`oversize ${item.id}`)
        return { id: message.id, session: message.session, scope: message.scope, at: Date.parse(message.at) + 1000,
          kind: isolated.window[0].gap || 'visible' }
      })
      const planned = simulateWindows(turns, strategy, turns.at(-1).at + 120_000)
      const start = performance.now(), base = turns[0].at, traces = []
      const caseReport = { id: item.id, strategy, traces, pendingTurns: planned.pendingTurns,
        explicitConfirmation: item.id.startsWith('EX-25-') ? 'NOT TESTED' : 'not applicable',
        observation: '120-second future is planned, not awaited; no background persistence is simulated' }
      report.cases.push(caseReport); save()
      for (const batch of planned.batches) {
        if (mode === 'real') {
          const due = start + batch.at - base + 500
          while (performance.now() < due) await sleep(Math.min(10_000, due - performance.now()))
        }
        const ids = new Set([...batch.prefixIds, ...batch.newIds, ...batch.gapIds])
        const messages = item.messages.filter(message => message.session === batch.session && message.scope === batch.scope
          && (ids.has(message.id) || message.role === 'assistant' && ids.has(message.parentId)))
        const built = buildExperimentalWindow(messages.map(message => ({ id: message.id, sequence: message.sequence,
          sessionId: message.session, scope: message.scope, role: message.role, parentId: message.parentId, visibleText: message.text })),
        { sessionId: batch.session, scope: batch.scope })
        if (built.status !== 'ready') { report.status = 'oversize'; stopped = true; break }
        const existing = item.id.startsWith('EX-17-') ? [{ id: 'initial-language', content: '回答语言使用中文',
          category: 'preference', status: 'active', source: 'auto_extracted', locked: false, subject: 'user', factKey: 'language', factValue: '中文' }] : []
        const request = { messages: [{ role: 'system', content: prompt }, { role: 'user', content: JSON.stringify({
          sessionId: batch.session, scope: batch.scope === 'global' ? 'global' : 'project',
          scopeKey: batch.scope === 'global' ? null : batch.scope, existing, turns: built.window }) }], temperature: 0.1, maxTokens: 800, reasoningMode: 'off' }
        const inputBytes = Buffer.byteLength(JSON.stringify(request), 'utf8') + 512
        const reserveCost = 2 * (inputBytes * 0.30 + 800 * 1.20) / 1_000_000
        if (inputBytes > 15_000 || report.networkAttempts + 2 > report.maxNetworkAttempts
          || report.inputBudget + inputBytes * 2 > report.maxInputBudget || report.outputBudget + 1600 > report.maxOutputBudget
          || report.costBudgetUsd + reserveCost > report.maxCostUsd) { report.status = 'budget_stopped'; stopped = true; break }
        report.reservedInFlight = 2; save()
        const expression = `(async()=>{const a=await import('/src/services/ai/aiClient.ts');const r=await import('/src/services/ai/reasoningAdapter.ts');const cfg=a.getAiConfig(),body={};if(!cfg||new URL(cfg.baseUrl).hostname!=='api.deepseek.com'||!r.applyReasoningMode('deepseek','deepseek-v4-flash',body,'off')||body.thinking?.type!=='disabled')throw Error('config guard');const c=a.createChatProvider({...cfg,provider:'deepseek',chatModel:'deepseek-v4-flash'});let attempts=0;const original=c.fetch;c.fetch=function(...args){if(++attempts>2)throw Error('attempt budget');return original.apply(this,args)};const ctl=new AbortController(),timer=setTimeout(()=>ctl.abort(),20000),start=performance.now();try{const out=await c.chat({...${JSON.stringify(request)},signal:ctl.signal});return {ok:true,output:out.content,usage:out.usage||null,networkAttempts:attempts,elapsedMs:Math.round(performance.now()-start)}}catch{return {ok:false,networkAttempts:attempts,elapsedMs:Math.round(performance.now()-start)}}finally{clearTimeout(timer)}})()`
        let response
        try { response = cdp ? await cdp.evaluate(expression) : { ok: true, output: '[]', usage: null, networkAttempts: 0, elapsedMs: 0 } }
        catch { report.status = 'connection_failed_with_reservation'; stopped = true; save(); break }
        if (!Number.isInteger(response.networkAttempts) || response.networkAttempts < (cdp ? 1 : 0) || response.networkAttempts > 2) {
          report.status = 'invalid_attempt_count_with_reservation'; stopped = true; save(); break
        }
        report.reservedInFlight = 0
        report.networkAttempts += response.networkAttempts
        report.inputBudget += inputBytes * response.networkAttempts
        report.outputBudget += 800 * response.networkAttempts
        report.costBudgetUsd += response.networkAttempts * (inputBytes * 0.30 + 800 * 1.20) / 1_000_000
        let parseStatus = 'invalid', sourceChecks = []
        try {
          const text = response.output.trim(), fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
          const body = (fenced ? fenced[1] : text).trim(), first = body.indexOf('['), last = body.lastIndexOf(']')
          if (first < 0 || last < first) throw new Error('missing array')
          const parsed = JSON.parse(body.slice(first, last + 1))
          if (Array.isArray(parsed) && parsed.every(value => value && typeof value === 'object' && !Array.isArray(value))) {
            parseStatus = 'array'
            sourceChecks = validateExperimentalSources(built.window, parsed).map((check, index) => ({ ...check,
              freshPrimary: batch.newIds.includes(parsed[index].primarySourceId),
              scopeMatches: parsed[index].scope === (batch.scope === 'global' ? 'global' : 'project') }))
          }
        } catch { /* Invalid model output is a failure, never NOOP. */ }
        traces.push({ reason: batch.reason, inputHash: createHash('sha256').update(JSON.stringify(request)).digest('hex'),
          newIds: batch.newIds, prefixIds: batch.prefixIds, gapIds: batch.gapIds, parseStatus, sourceChecks, response })
        save()
        if (!response.ok || parseStatus !== 'array') { report.status = 'model_or_parse_failure'; stopped = true; break }
      }
      if (mode === 'real' && !stopped) {
        const finalUser = start + turns.at(-1).at - base
        while (performance.now() < finalUser) await sleep(Math.min(10_000, finalUser - performance.now()))
      }
      save()
      process.stdout.write(`${strategy} ${item.id}: ${traces.length} model requests\n`)
    }
    if (stopped) break
  }
  if (!stopped) report.status = 'completed'
  save()
  process.stdout.write(`Context pilot report: ${reportPath}\n`)
} finally { cdp?.close() }
