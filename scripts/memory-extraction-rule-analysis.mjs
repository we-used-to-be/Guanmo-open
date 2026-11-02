import { readFileSync } from 'node:fs'
import process from 'node:process'
import { shouldExtractMemoryCandidate, isExplicitMemoryWriteIntent } from '../src/services/memory/memoryPolicy.ts'

const read = path => readFileSync(path, 'utf8').trim().split('\n').map(line => JSON.parse(line))
const root = 'docs/memory/evaluation/extraction-v1/'
const cases = read(root + 'cases.jsonl').filter(item => item.split === 'development' && item.schedule === 'S1')
const gold = new Map(read(root + 'gold-structured.jsonl').map(item => [item.id, item]))
let total = 0, admitted = 0, explicit = 0, rejected = 0
const rejectedIds = []
for (const item of cases) {
  for (const fact of gold.get(item.id).facts) {
    const source = item.messages.find(message => message.id === fact.primary)
    if (!source) throw new Error(`Missing primary source in ${item.id}`)
    total++
    if (isExplicitMemoryWriteIntent(source.text)) explicit++
    else if (source.text.length <= 6000 && shouldExtractMemoryCandidate(source.text)) admitted++
    else { rejected++; rejectedIds.push(`${item.id}:${fact.identity}`) }
  }
}
process.stdout.write(JSON.stringify({ status: 'draft_unreviewed_not_recall', scripts: cases.length, facts: total,
  automaticPrimaryAdmitted: admitted, explicitPath: explicit, automaticPrimaryRejected: rejected, rejectedIds }, null, 2) + '\n')
