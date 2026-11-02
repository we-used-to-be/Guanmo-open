import { readFileSync, writeFileSync } from 'node:fs'
import process from 'node:process'

// Semantic descriptions only. Production category/fact keys are intentionally
// unspecified until the independent label review determines their mapping.
const states = {
  '17': [{ identity: '回答语言', value: '中文', scope: 'global', status: 'active', source: 'automatic' }],
  '18': [{ identity: '称呼', value: '小林', scope: 'global', status: 'active', source: 'manual', locked: true }],
  '19': [{ identity: '回答顺序', value: '先结论后依据', scope: 'global', status: 'active', source: 'automatic' }],
  '21': [{ identity: '技术栈', value: 'React', scope: 'P', status: 'active', source: 'manual' }],
  '22': [{ identity: '习惯', value: '早起', scope: 'global', status: 'candidate', locked: true }],
}
const cases = readFileSync('docs/memory/evaluation/extraction-v1/cases.jsonl', 'utf8').trim().split('\n').map(line => JSON.parse(line))
const result = cases.map(item => ({ id: item.id, reviewStatus: 'pending_independent_review', memories: states[item.script] || [] }))
writeFileSync('docs/memory/evaluation/extraction-v1/initial-states.jsonl', result.map(item => JSON.stringify(item)).join('\n') + '\n', { flag: 'wx' })
process.stdout.write(`Created ${result.length} draft initial states.\n`)
