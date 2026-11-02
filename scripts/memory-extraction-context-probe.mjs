// Single-call exploratory probe through the isolated desktop's Tauri proxy.
// This is not B/C's queue, persistence, security acceptance, or a formal A/B runner.
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import process from 'node:process'
import { connectPage } from './measure-cold-start.mjs'
import { buildExperimentalWindow, validateExperimentalSources } from './memory-extraction-window-input.mjs'

const caseId = process.argv[2]
const port = Number(process.env.GUANMO_EVAL_CDP_PORT)
if (!/^EX-(?:0[13579]|1[13579]|2[13579]|3[13579])-S3$/.test(caseId || '')
  || !Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Expected a development S3 case and explicit isolated CDP port')
const rows = readFileSync('docs/memory/evaluation/extraction-v1/cases.jsonl', 'utf8').trim().split('\n').map(line => JSON.parse(line))
const item = rows.find(row => row.id === caseId && row.split === 'development')
if (!item) throw new Error('Missing development case')
const first = item.messages[0]
const built = buildExperimentalWindow(item.messages.map(message => ({ id: message.id, sequence: message.sequence,
  sessionId: message.session, scope: message.scope, role: message.role, parentId: message.parentId, visibleText: message.text })),
{ sessionId: first.session, scope: first.scope })
if (built.status !== 'ready' || !built.window.some(message => message.role === 'user' && message.text)) throw new Error('No safe complete window')
const system = '从同一会话的连续对话中提取跨会话长期事实。只依据用户明确表达的事实或已接受的决定，助手建议不得单独作为用户决定；无法确定则返回空数组。项目限定事实只属于当前项目，不得扩大到其他项目。每项包含 content、scope、primarySourceId、supportingSourceIds，使用原始消息 ID，输出 JSON 数组，不要额外说明。'
const request = { messages: [{ role: 'system', content: system }, { role: 'user', content: JSON.stringify({ sessionId: first.session, scope: first.scope, turns: built.window }) }],
  temperature: 0.1, maxTokens: 800, reasoningMode: 'off' }
const inputHash = createHash('sha256').update(JSON.stringify(request)).digest('hex')
const cdp = await connectPage(port, { exitCode: null })
try {
  const dir = await cdp.evaluate("window.__TAURI_INTERNALS__.invoke('plugin:path|resolve_directory',{directory:13})")
  if (String(dir).replaceAll(String.fromCharCode(92), '/').split('/').filter(Boolean).at(-1) !== 'com.guanmo.memory-eval-20261031') throw new Error('Refusing non-isolated target')
  const expression = `(async()=>{const a=await import('/src/services/ai/aiClient.ts');const r=await import('/src/services/ai/reasoningAdapter.ts');const body={};if(!r.applyReasoningMode('deepseek','deepseek-v4-flash',body,'off')||body.thinking?.type!=='disabled')throw Error('reasoning guard');const config=a.getAiConfig();if(!config||new URL(config.baseUrl).hostname!=='api.deepseek.com')throw Error('unexpected configured origin');const client=a.createChatProvider({...config,provider:'deepseek',chatModel:'deepseek-v4-flash'});const ctl=new AbortController(),timer=setTimeout(()=>ctl.abort(),20000),start=performance.now();try{const out=await client.chat({...${JSON.stringify(request)},signal:ctl.signal});return {output:out.content,usage:out.usage||null,elapsedMs:Math.round(performance.now()-start)}}finally{clearTimeout(timer)}})()`
  const response = await cdp.evaluate(expression)
  let parseStatus = 'invalid', sourceChecks = []
  try {
    const parsed = JSON.parse(response.output)
    if (Array.isArray(parsed) && parsed.every(value => value && typeof value === 'object' && !Array.isArray(value))) {
      parseStatus = 'array'
      sourceChecks = validateExperimentalSources(built.window, parsed).map((result, index) => ({ ...result,
        scopeMatches: parsed[index].scope === (first.scope === 'global' ? 'global' : 'project') }))
    }
  } catch { /* Invalid output is reported, never retried or treated as NOOP. */ }
  process.stdout.write(JSON.stringify({ caseId, mode: 'exploratory-context-only-no-write', model: 'deepseek-v4-flash',
    logicalRequestLimit: 1, providerMayRetryOnce: true, inputHash, parseStatus, sourceChecks, response }) + '\n')
} finally { cdp.close() }
