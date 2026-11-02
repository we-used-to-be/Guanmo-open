// Expand the fixed plan, preserving its gold text for independent review.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import process from 'node:process'
import { shouldExtractMemoryCandidate, isExplicitMemoryWriteIntent } from '../src/services/memory/memoryPolicy.ts'

const planPath = 'docs/plans/memory-extraction-optimization.md'
const out = 'docs/memory/evaluation/extraction-v1'
const plan = readFileSync(planPath, 'utf8')
const section = plan.split('### 5.2 固定脚本及 Gold')[1].split('显式E脚本')[0]
const rows = [...section.matchAll(/^\| (\d{2}) \| (.*?) \|\s*$/gm)]
if (rows.length !== 40 || rows.some((r, i) => Number(r[1]) !== i + 1)) throw new Error('Expected scripts 01–40')

const cases = [], gold = []
for (const [, script, row] of rows) {
  const [body, label] = row.split(' G=')
  if (!label) throw new Error(`Missing gold ${script}`)
  const roleMatches = [...body.matchAll(/([UA]):/g)]
  const base = roleMatches.map((match, i) => {
    let value = body.slice(match.index + 2, roleMatches[i + 1]?.index ?? body.length)
      .replace(/→.*$/s, '').trim()
    if (script === '37' && i === 2) value = '谢谢。'.repeat(3500) + '我的长期目标是研究数论。'
    if (script === '38' && i === 2) value = '普通填充。'.repeat(2500)
    return { role: match[1] === 'U' ? 'user' : 'assistant', text: value }
  })
  if (base.some(m => !m.text)) throw new Error(`Empty message ${script}`)
  for (let schedule = 1; schedule <= 5; schedule++) {
    const id = `EX-${script}-S${schedule}`
    let messages = base.map(m => ({ ...m }))
    if ([1, 2, 5].includes(schedule)) for (let n = 0; n < 3; n++) messages.push({ role: 'user', text: '谢谢' }, { role: 'assistant', text: '不客气' })
    if (schedule === 4) messages = messages.slice(0, messages.findLastIndex(m => m.role === 'user') + 1)
    let userIndex = -1, parentId = null
    const interval = schedule === 2 ? 90_000 : 10_000
    const expanded = messages.map((m, i) => {
      if (m.role === 'user') userIndex++
      const msgId = `${id}-M${i + 1}`
      const changedScope = script === '29' && i >= 2 || script === '30' && i >= 1
      const scope = changedScope ? 'Q' : /^(?:07|08|21|26|29|30|36|38|40)$/.test(script) ? 'P' : 'global'
      const session = script === '30' && i >= 1 ? 'T' : 'S'
      const result = { id: msgId, role: m.role, text: m.text, session, scope, sequence: i + 1,
        at: new Date(Date.parse('2026-10-31T00:00:00Z') + userIndex * interval + (m.role === 'assistant' ? 1000 : 0)).toISOString(),
        parentId: m.role === 'assistant' ? parentId : null }
      if (m.role === 'user') parentId = msgId
      return result
    })
    cases.push({ id, script, schedule: `S${schedule}`, split: Number(script) % 2 ? 'development' : 'holdout',
      messages: expanded, initialStateDescription: body.split(/(?:P会话S |P )?U:/)[0].trim(),
      events: { waitAfterMs: 120_000, restartAfterLastUser: schedule === 4, restartDelayMs: schedule === 4 ? 60_000 : null,
        firstRequest503: schedule === 5, sourceMutation: script === '39' ? 'delete M1' : script === '40' ? 'replace M1 displayContent only' : null } })
    gold.push({ id, script, description: label, originalRow: row, reviewStatus: 'pending_independent_review' })
  }
}
mkdirSync(out, { recursive: true })
const jsonl = data => data.map(x => JSON.stringify(x)).join('\n') + '\n'
const files = { 'cases.jsonl': jsonl(cases), 'gold.jsonl': jsonl(gold) }
for (const name of Object.keys(files)) if (existsSync(`${out}/${name}`)) throw new Error(`Refusing to overwrite ${name}`)
for (const [name, content] of Object.entries(files)) writeFileSync(`${out}/${name}`, content)
const sha256 = content => createHash('sha256').update(content).digest('hex')
const manifest = { status: 'DRAFT_NOT_FROZEN', planSectionSha256: sha256(section), count: cases.length,
  development: cases.filter(c => c.split === 'development').map(c => c.id), holdout: cases.filter(c => c.split === 'holdout').map(c => c.id),
  files: Object.fromEntries(Object.entries(files).map(([name, content]) => [name, sha256(content)])),
  limitations: ['Gold is verbatim plan text, not structured atomic labels.', 'Independent review pending.', 'No A/B/C execution.'] }
writeFileSync(`${out}/manifest.json`, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' })
// This measures rule admission only, never calls a model or measures extraction quality.
const stats = cases.filter(c => c.split === 'development').map(c => ({ id: c.id,
  messages: c.messages.filter(m => m.role === 'user').map(m => ({ id: m.id, admitted: m.text.length <= 6000 && shouldExtractMemoryCandidate(m.text) && !isExplicitMemoryWriteIntent(m.text) })) }))
writeFileSync(`${out}/rule-development.json`, JSON.stringify(stats, null, 2) + '\n', { flag: 'wx' })
process.stdout.write(`Created ${cases.length} draft cases; development rule traces: ${stats.length}.\n`)
