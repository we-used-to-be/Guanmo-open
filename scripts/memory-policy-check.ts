import { strict as assert } from 'node:assert'
import {
  areMemoryFactsEquivalent,
  classifyMemoryRetrievalIntent,
  chooseCanonicalMemoryContent,
  contentHash,
  filterInjectableMemories,
  findActiveFactConflict,
  findMergeableMemoryCandidate,
  findSimilarMemoryRecord,
  hasReusableEmbedding,
  inferMemoryScope,
  isPersonalizedRewriteMemoryIntent,
  isMemoryVisibleInScope,
  normalizeMemoryCandidate,
  normalizeMemoryScopeKey,
  resolveMemoryCandidateDecision,
  shouldExtractMemoryCandidate,
  validateMemoryCandidate,
} from '../src/services/memory/memoryPolicy'
import { DB_MIGRATIONS, DB_SCHEMA } from '../src/services/database/schema'

assert.equal(classifyMemoryRetrievalIntent('你还记得我的偏好吗'), 'strong')
assert.equal(classifyMemoryRetrievalIntent('查询一下我的长期记忆'), 'strong')
assert.equal(classifyMemoryRetrievalIntent('按照上次的方案继续'), 'weak')
assert.equal(classifyMemoryRetrievalIntent('老规矩，回答简洁一点'), 'weak')
assert.equal(classifyMemoryRetrievalIntent('还是按原来的格式'), 'weak')
assert.equal(classifyMemoryRetrievalIntent('继续沿用之前的方案'), 'weak')
assert.equal(classifyMemoryRetrievalIntent('像平时一样处理'), 'weak')
assert.equal(classifyMemoryRetrievalIntent('按常用方式输出'), 'weak')
assert.equal(isPersonalizedRewriteMemoryIntent('帮我按我的风格改写这段'), true)
assert.equal(classifyMemoryRetrievalIntent('帮我按我的风格改写这段'), 'weak')
assert.equal(classifyMemoryRetrievalIntent('把这段按上次的语气重写'), 'weak')
assert.equal(classifyMemoryRetrievalIntent('照旧润色这段话'), 'weak')
assert.equal(isPersonalizedRewriteMemoryIntent('帮我改写这段'), false)
assert.equal(classifyMemoryRetrievalIntent('帮我改写这段'), 'none')
assert.equal(classifyMemoryRetrievalIntent('把这段改写成简洁风格'), 'none')
assert.equal(classifyMemoryRetrievalIntent('帮我总结这段文字'), 'none')
assert.equal(classifyMemoryRetrievalIntent('总结上次会议'), 'none')
assert.equal(classifyMemoryRetrievalIntent('解释之前的代码'), 'none')
assert.equal(classifyMemoryRetrievalIntent('把“你还记得我的偏好吗”翻译成英文'), 'none')
assert.equal(classifyMemoryRetrievalIntent('分析这段代码'), 'none')
assert.equal(classifyMemoryRetrievalIntent('上次会议安排了三个任务'), 'none')
assert.equal(normalizeMemoryScopeKey('project', 'D:\\React\\观墨\\'), 'd:/react/观墨')
assert.deepEqual(inferMemoryScope('preference', 'D:\\React\\观墨'), { scopeType: 'global', scopeKey: null })
assert.deepEqual(inferMemoryScope('project', 'D:\\React\\观墨'), { scopeType: 'project', scopeKey: 'd:/react/观墨' })
assert.equal(contentHash('稳定内容'), contentHash('稳定内容'))

const globalMemory = { id: 'global', content: '全局', status: 'active', scopeType: 'global' as const }
const projectMemory = { id: 'project', content: '项目', status: 'active', scopeType: 'project' as const, scopeKey: 'd:/react/观墨' }
assert.equal(isMemoryVisibleInScope(globalMemory, null), true)
assert.equal(isMemoryVisibleInScope(globalMemory, 'D:\\Other'), true)
assert.equal(isMemoryVisibleInScope(projectMemory, null), false)
assert.equal(isMemoryVisibleInScope(projectMemory, 'D:\\React\\观墨\\'), true)
assert.equal(isMemoryVisibleInScope(projectMemory, 'D:\\React\\Other'), false)

assert.deepEqual(
  filterInjectableMemories([
    globalMemory,
    { ...projectMemory, id: 'candidate', status: 'candidate' },
    { ...projectMemory, id: 'ignored', status: 'ignored' },
    { ...projectMemory, id: 'archived', status: 'archived' },
    { ...projectMemory, id: 'superseded', status: 'superseded' },
    { ...projectMemory, id: 'replacement', supersedesId: 'global' },
  ]).map((memory) => memory.id),
  ['replacement']
)
assert.equal(findActiveFactConflict([
  { ...projectMemory, subject: 'user', factKey: 'theme' },
  { ...globalMemory, subject: 'user', factKey: 'theme' },
], { subject: 'user', factKey: 'theme', scopeType: 'project', scopeKey: 'd:/react/观墨' })?.id, 'project')
assert.equal(findActiveFactConflict([
  { ...projectMemory, subject: 'user', factKey: 'theme' },
], { subject: 'user', factKey: 'theme', scopeType: 'project', scopeKey: 'd:/react/other' }), undefined)

assert.equal(shouldExtractMemoryCandidate('我喜欢简洁的回答'), true)
assert.equal(shouldExtractMemoryCandidate('今天我喜欢喝咖啡'), false)
assert.equal(shouldExtractMemoryCandidate('把“我喜欢蓝色”翻译成英文'), false)
assert.equal(shouldExtractMemoryCandidate('虚构一个我是工程师的故事'), false)
assert.equal(shouldExtractMemoryCandidate('记住：我喜欢蓝色'), true)

const normalizedCandidate = normalizeMemoryCandidate({
  content: '  用户偏好   简洁回答  ',
  category: ' preference ',
  subject: ' user ',
  factKey: ' response_style ',
  factValue: ' 简洁回答 ',
  confidence: 2,
})
assert.deepEqual(normalizedCandidate, {
  content: '用户偏好 简洁回答',
  category: 'preference',
  subject: 'user',
  factKey: 'response_style',
  factValue: '简洁回答',
  confidence: 1,
})
assert.equal(validateMemoryCandidate({ content: '用户偏好简洁回答', category: 'preference' }).valid, true)
assert.equal(validateMemoryCandidate({ content: '称呼用户为 boss', category: 'preference' }).valid, true)
assert.equal(validateMemoryCandidate({ content: '当前任务先调整按钮颜色', category: 'project' }).valid, false)
assert.equal(validateMemoryCandidate({ content: '把这段文字翻译成英文', category: 'instruction' }).valid, false)
assert.equal(validateMemoryCandidate({ content: '虚构用户是一名工程师', category: 'profile' }).valid, false)
assert.equal(validateMemoryCandidate({ content: '根据对话，用户偏好简洁回答', category: 'preference' }).valid, false)
assert.equal(validateMemoryCandidate({ content: '用户偏好简洁回答。用户偏好中文回答', category: 'preference' }).valid, false)
assert.equal(validateMemoryCandidate({ content: '用'.repeat(81), category: 'instruction' }).valid, false)

const existingCandidate = {
  id: 'candidate-1',
  content: '用户偏好简洁的回答',
  category: 'preference',
  source: 'auto_extracted',
  locked: false,
  status: 'candidate',
  scopeType: 'global' as const,
  subject: 'user',
  factKey: 'response_style',
  factValue: '简洁回答',
}
const shorterCandidate = {
  id: 'incoming',
  content: '用户偏好简洁回答',
  category: 'preference',
  source: 'auto_extracted',
  locked: false,
  status: 'candidate',
  scopeType: 'global' as const,
  subject: 'user',
  factKey: 'response_style',
  factValue: '简洁回答',
}
assert.equal(findMergeableMemoryCandidate([existingCandidate], shorterCandidate)?.id, 'candidate-1')
assert.equal(areMemoryFactsEquivalent(existingCandidate, shorterCandidate), true)
assert.equal(chooseCanonicalMemoryContent(existingCandidate.content, shorterCandidate.content), shorterCandidate.content)
assert.equal(
  findMergeableMemoryCandidate([{ ...existingCandidate, locked: true }], shorterCandidate),
  undefined
)
assert.equal(
  findMergeableMemoryCandidate([{ ...existingCandidate, category: 'instruction' }], shorterCandidate),
  undefined
)
assert.equal(
  findSimilarMemoryRecord(
    [{ ...existingCandidate, content: '用户偏好简洁回答。', subject: null, factKey: null }],
    { ...shorterCandidate, subject: null, factKey: null }
  )?.id,
  'candidate-1'
)

const activePreference = { ...existingCandidate, id: 'active-1', status: 'active' }
assert.equal(areMemoryFactsEquivalent(activePreference, shorterCandidate), true)
assert.equal(areMemoryFactsEquivalent(activePreference, { ...shorterCandidate, factValue: '详细回答' }), false)
assert.deepEqual(resolveMemoryCandidateDecision([activePreference], shorterCandidate), {
  action: 'skip',
  reason: 'active_duplicate',
  target: activePreference,
})
const changedPreference = {
  ...shorterCandidate,
  content: '用户偏好详细回答',
  factValue: '详细回答',
}
assert.deepEqual(resolveMemoryCandidateDecision([activePreference], changedPreference), {
  action: 'replace',
  target: activePreference,
})
const pendingReplacement = {
  ...existingCandidate,
  content: '用户偏好详细的回答',
  factValue: '详细回答',
}
assert.deepEqual(resolveMemoryCandidateDecision(
  [activePreference, pendingReplacement],
  changedPreference
), {
  action: 'merge',
  target: pendingReplacement,
  equivalent: true,
  supersedes: activePreference,
})
assert.deepEqual(resolveMemoryCandidateDecision(
  [{ ...activePreference, category: 'project', scopeType: 'project', scopeKey: 'd:/react/观墨' }],
  { ...changedPreference, category: 'project', scopeType: 'project', scopeKey: 'd:/react/other' }
), { action: 'create' })
assert.equal(findActiveFactConflict(
  [activePreference],
  { category: 'preference', subject: 'user', factKey: 'response_style', scopeType: 'global', scopeKey: null }
)?.id, 'active-1')
assert.equal(findActiveFactConflict(
  [{ ...activePreference, category: 'instruction' }],
  { category: 'preference', subject: 'user', factKey: 'response_style', scopeType: 'global', scopeKey: null }
), undefined)
assert.equal(findActiveFactConflict(
  [{ ...activePreference, scopeType: 'project', scopeKey: 'd:/react/观墨' }],
  { category: 'preference', subject: 'user', factKey: 'response_style', scopeType: 'project', scopeKey: 'd:/react/other' }
), undefined)

const cached = { content: '稳定内容', contentHash: contentHash('稳定内容'), embedding: [1, 0], embeddingModel: 'model-a' }
assert.equal(hasReusableEmbedding(cached, 'model-a'), true)
assert.equal(hasReusableEmbedding({ ...cached, content: '内容已变' }, 'model-a'), false)
assert.equal(hasReusableEmbedding(cached, 'model-b'), false)
assert.equal(hasReusableEmbedding({ ...cached, embedding: null }, 'model-a'), false)

const requiredMemoryColumns = [
  'scope_type', 'scope_key', 'subject', 'fact_key', 'fact_value', 'confidence',
  'evidence', 'supersedes_id', 'embedding', 'embedding_model', 'content_hash',
]
for (const column of requiredMemoryColumns) {
  assert.match(DB_SCHEMA, new RegExp(`\\b${column}\\b`), `base schema missing ${column}`)
  assert.equal(
    DB_MIGRATIONS.some((migration) => migration.table === 'memories' && migration.column === column),
    true,
    `legacy migration missing ${column}`
  )
}
assert.match(DB_SCHEMA, /scope_type TEXT NOT NULL DEFAULT 'global'/)
assert.match(DB_SCHEMA, /confidence REAL NOT NULL DEFAULT 1/)
console.log('memory policy checks passed')
