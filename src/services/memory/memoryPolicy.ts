export type MemoryRetrievalIntent = 'none' | 'weak' | 'strong'
export type MemoryScopeType = 'global' | 'project'

export interface MemoryPolicyRecord {
  id: string
  content: string
  status: string
  category?: string
  scopeType?: MemoryScopeType
  scopeKey?: string | null
  supersedesId?: string | null
  contentHash?: string | null
  embedding?: number[] | null
  embeddingModel?: string | null
  subject?: string | null
  factKey?: string | null
}

export interface MemoryCandidateInput {
  content: string
  category: string
  subject?: string
  factKey?: string
  factValue?: string
  confidence?: number
  kind?: 'semantic' | 'episodic'
}

export function containsSensitiveMemoryText(text: string): boolean {
  return /(?:密码|口令|验证码|密钥|私钥|助记词|身份证|银行卡|信用卡|病历|诊断|过敏|疾病|患有|病情|慢性病|高血压|糖尿病|哮喘|心脏病|用药|治疗|就医|健康状况|健康|财务状况|经济状况|财务|收入|工资|月薪|年薪|负债|债务|欠款|存款|投资|资产|住址|家庭地址|电话号码|手机号|api[_ -]?key|password|secret|token\s*[:=])|\b(?:sk-[a-z0-9_-]{10,}|1[3-9]\d{9}|\d{17}[\dXx])\b/i.test(text)
}

/** Credentials, identifying numbers, addresses and contact details are never sent for extraction. */
export function containsForbiddenMemorySecret(text: string): boolean {
  return /(?:密码|口令|验证码|密钥|私钥|助记词|身份证|银行卡|信用卡|账号|账户号码|卡号|住址|家庭地址|详细地址|门牌号|电话号码|手机号|联系方式|电子邮箱|邮箱地址|微信号|QQ号|api[_ -]?key|password|secret|token\s*[:=]|access[_ -]?token|account\s*(?:number|no\.?))|\b(?:sk-[a-z0-9_-]{10,}|1[3-9]\d{9}|\d{17}[\dXx])\b|[\w.+-]{1,64}@[\w.-]+\.[a-z]{2,}/i.test(text)
}

export function containsReviewableMemorySensitivity(text: string): boolean {
  return containsSensitiveMemoryText(text) && !containsForbiddenMemorySecret(text)
}

export function isExplicitMemoryWriteIntent(text: string): boolean {
  if (/(?:不要|别|无需|不必|不用|禁止).{0,8}(?:记住|记下|记忆|保存)|(?:不|别)要?存入/.test(text)) return false
  if (/^(?:翻译|改写|解释|总结|分析|引用|虚构|假设|举例)/.test(text.trim())) return false
  if (/(?:你还?|还|是否|有没有).{0,5}记住|记住.{0,20}(?:了吗|过吗|了没|没有[?？]?$)/.test(text)) return false
  return /(?:记住|记下来|添加(?:到|进|为)?(?:长期)?记忆|保存(?:到|进|为)?(?:长期)?记忆|以后记得|remember\s)/i.test(text.trim())
}

export interface MemoryCandidateRecord extends MemoryPolicyRecord {
  category: string
  source?: string
  locked?: boolean
  factValue?: string | null
}

export interface MemoryCandidateValidationResult {
  valid: boolean
  reason?: string
}

export function normalizeMemoryScopeKey(scopeType: MemoryScopeType, scopeKey?: string | null): string | null {
  if (scopeType === 'global') return null
  const normalized = (scopeKey || '').trim().replace(/\\/g, '/').replace(/\/$/, '').toLowerCase()
  return normalized || null
}

export function isPersonalizedRewriteMemoryIntent(query: string): boolean {
  const normalized = query.trim().toLowerCase()
  if (!/(?:翻译|改写|润色|重写)/.test(normalized)) return false
  return [
    /(?:翻译|改写|润色|重写).{0,8}我(?:平时|常用|喜欢|偏好).{0,8}(?:风格|语气|表达|格式)/,
    /(?:按|按照|沿用|继续(?:使用|采用)?).{0,12}(?:我的|之前|上次|原来|原先|平时|常用).{0,8}(?:风格|语气|措辞|表达|格式|方式|习惯|偏好|约定)/,
    /(?:照旧|老规矩|像平时一样)/,
    /(?:用|采用).{0,8}我(?:平时|常用|惯用|喜欢|偏好).{0,8}(?:风格|语气|措辞|表达|格式|方式)/,
  ].some((pattern) => pattern.test(normalized))
}

export function classifyMemoryRetrievalIntent(query: string): MemoryRetrievalIntent {
  const normalized = query.trim().toLowerCase()
  if (!normalized) return 'none'
  if (/(?:不要|不用|无需|不必|别).{0,8}(?:查|检索|搜索|回忆|翻).{0,8}(?:记忆|历史)|(?:不要|别).{0,4}按我的/.test(normalized)) return 'none'
  // A reference explicitly tied to this turn is short-term context, not a reason to scan personal history.
  if (/(?:刚才|刚刚|刚说|刚贴|本轮|这轮|本次聊天|上一条|上条消息|上文|上面给|当前这份|眼前这份)/.test(normalized)
    && !/(?:长期记忆|跨会话|检索记忆|旧记忆)/.test(normalized)) return 'none'
  if (/^(?:请|帮我)?(?:翻译|改写|总结|解释|分析|引用|虚构|假设|举例).{0,16}[:：“「"‘]/.test(normalized)) return 'none'
  if (isPersonalizedRewriteMemoryIntent(normalized)) return 'weak'
  if (/^(?:翻译|解释|分析|引用|虚构|假设|举例)/.test(normalized)
    || /(?:什么是|原理|概念|登录选项|表结构|模拟用户|词性)/.test(normalized)) return 'none'
  if (/(?:查询|检索|查看|搜索|调取|回忆).{0,16}(?:我的|本项目|当前项目|已保存|之前|上次|旧项目|旧记忆)/.test(normalized)) return 'strong'
  if (/(?:根据|结合|参考|考虑|按照?|依|用|沿用|基于).{0,8}我(?:的|平时|之前|喜欢|常用).{0,12}(?:偏好|习惯|风格|文风|背景|目标|进度|经历|语气|表达|格式|专业|限制|约定|语言|边界|身份|方式)/.test(normalized)) return 'weak'

  const transformationTask = [
    /(?:帮我|请|把).{0,120}(?:翻译|改写|润色|重写)(?:成|为|一下)?/,
    /(?:总结|概括|解释|讲解|分析)(?:一下)?(?:这|以下|上次|之前|那|一段|这段|代码|文本|内容|会议|句子|句话)/,
  ]
  if (transformationTask.some((pattern) => pattern.test(normalized))) return 'none'

  const strongSignals = [
    '我的偏好', '我的习惯', '我的风格', '我的地址', '我的住址', '我的位置',
    '我的称呼', '我的记忆', '我的项目约定', '我的长期目标', '你记得我', '你还记得我',
    '还记得我', '查询记忆', '搜索记忆', '检索记忆', '查看记忆', '调取记忆', 'remember me',
  ]
  if (strongSignals.some((signal) => normalized.includes(signal))) return 'strong'
  if (/(?:查询|搜索|检索|查看|调取).*记忆|你还?记得.*我/.test(normalized)) return 'strong'
  if (/(?:还?记(?:得|的)|回忆|记着).{0,12}(?:我|俺|我们|咱)|(?:我|俺).{0,12}(?:身份|背景|专业|职业|学习进度|长期目标).{0,8}(?:是什么|是啥|来着|呢|吗)/.test(normalized)) return 'strong'
  if (/(?:已保存|已记住|已经记住|保存过|记忆中|记忆里|存过).{0,20}(?:个人|偏好|背景|习惯|约定|项目|路线|目标|规则|时间|结论|技术栈)/.test(normalized)) return 'strong'
  const history = /(?:之前|以前|上次|上回|当初|当时|原先|原来|曾经)/.test(normalized)
  const personal = /(?:我|我们|咱|俺|项目|工程)/.test(normalized)
  const fact = /(?:决定|决策|约定|规则|方案|格式|风格|习惯|偏好|背景|身份|技术栈|数据库|框架|专业|职业|住|学习|目标|部署|称呼|边界|发布|备份|打包|规范|目录职责|时间安排|经历|架构|选择|选定|记录|安排)/.test(normalized)
  if (history && personal && /(?:为什么|怎么|哪|什么|啥).{0,8}(?:选|采用|放弃)|(?:记的|记住的|说过的)/.test(normalized)) return 'strong'
  if (personal && fact && /(?:说过|提过|告诉过)/.test(normalized)) return 'strong'
  if (history && fact && (personal || /(?:定的|确定|记录|保存|决定|结论|原因|约定|选)/.test(normalized))) return 'strong'
  if (/我.{0,16}(?:偏好|习惯|喜欢|格式|饮食|称呼|学习|进度).{0,16}(?:什么|啥|再说|知道|禁忌)/.test(normalized)) return 'strong'
  if (/(?:旧|原来的|之前的).{0,10}(?:风格|偏好|约定|规则|地址|记忆).{0,16}(?:是什么|还有|吗|来着|查看)|(?:你|还).{0,5}记(?:得|着).{0,10}(?:旧|原来|之前)/.test(normalized)) return 'strong'
  if (/(?:老规[矩距]|老样子|按惯例|按我那套|照咱原先|咱上回|按之前约好|上次那事|之前那约定)/.test(normalized)) return 'weak'

  const weakSignals = [
    '照旧', '老规矩', '还是按原来', '继续沿用', '像平时一样', '按常用方式',
    '按我的习惯', '按我的偏好', '按我的风格', '按照之前讨论的', '之前告诉过你',
  ]
  if (weakSignals.some((signal) => normalized.includes(signal))) return 'weak'
  return [
    /(?:沿用|继续(?:使用|采用)?|还是按|仍然按|依旧按).{0,12}(?:之前|上次|原来|原先|以往|平时|常用|惯例|方案|格式|风格|方式|约定)/,
    /(?:之前|上次|原来|原先|以往).{0,12}(?:方案|格式|风格|方式|约定|规则).{0,8}(?:继续|沿用|执行|处理|来|做)/,
    /我(?:以前|曾经|之前)(?:说过|提过|告诉过你).{0,12}(?:继续|沿用|按|照)/,
  ].some((pattern) => pattern.test(normalized))
    ? 'weak'
    : 'none'
}

export function inferMemoryScope(category: string, workspacePath?: string | null): { scopeType: MemoryScopeType; scopeKey: string | null } {
  if (category === 'project' && workspacePath) {
    return { scopeType: 'project', scopeKey: normalizeMemoryScopeKey('project', workspacePath) }
  }
  return { scopeType: 'global', scopeKey: null }
}

/** Only concrete, matching user assertions can satisfy a personal fact from the current conversation. */
export function isMemorySatisfiedByCurrentContext(query: string, userTexts: readonly string[]): boolean {
  if (/全部|所有|长期记忆|跨会话|历史记录|之前保存|旧记忆/.test(query)) return false
  const attributes: Array<[RegExp, RegExp]> = [
    [/称呼|叫我什么/, /(?:叫我|称呼我|我的称呼是)[^，。！？\n]{1,20}/],
    [/语言|中文还是英文/, /(?:使用|用|喜欢|偏好)[^，。！？\n]{0,15}(?:中文|英文|英语|汉语)/],
    [/专业/, /我的专业是[^，。！？\n]{2,30}/],
    [/数据库/, /(?:本项目|项目)(?:使用|采用|选定)[^，。！？\n]{0,10}(?:SQLite|MySQL|PostgreSQL)/i],
  ]
  return attributes.some(([question, statement]) => question.test(query)
    && userTexts.slice(-2).some(text => !/翻译|假设|虚构|示例|```/.test(text) && statement.test(text)))
}

export function isMemoryVisibleInScope(
  memory: Pick<MemoryPolicyRecord, 'scopeType' | 'scopeKey'>,
  workspacePath?: string | null
): boolean {
  if (memory.scopeType !== 'project') return true
  const currentScopeKey = normalizeMemoryScopeKey('project', workspacePath)
  return Boolean(currentScopeKey && memory.scopeKey === currentScopeKey)
}

export function filterInjectableMemories<T extends MemoryPolicyRecord>(memories: T[]): T[] {
  const supersededIds = new Set(
    memories
      .filter((memory) => memory.status === 'active' && memory.supersedesId)
      .map((memory) => memory.supersedesId as string)
  )
  return memories.filter((memory) => memory.status === 'active' && !supersededIds.has(memory.id))
}

export function findActiveFactConflict<T extends MemoryPolicyRecord>(
  memories: T[],
  fact: Pick<MemoryPolicyRecord, 'category' | 'subject' | 'factKey' | 'scopeType' | 'scopeKey'>
): T | undefined {
  if (!fact.subject || !fact.factKey) return undefined
  return memories.find((memory) => (
    memory.status === 'active'
    && (!fact.category || memory.category === fact.category)
    && normalizeFactPart(memory.subject) === normalizeFactPart(fact.subject)
    && normalizeFactPart(memory.factKey) === normalizeFactPart(fact.factKey)
    && (memory.scopeType || 'global') === (fact.scopeType || 'global')
    && (memory.scopeKey || null) === (fact.scopeKey || null)
  ))
}

function normalizeFactPart(value?: string | null): string {
  return (value || '').trim().replace(/\s+/g, ' ').toLowerCase()
}

function normalizeFactValue(value?: string | null): string {
  return normalizeFactPart(value).replace(/[，。！？；：,.!?;:\s]+/g, '')
}

function sameMemoryScope(
  left: Pick<MemoryPolicyRecord, 'scopeType' | 'scopeKey'>,
  right: Pick<MemoryPolicyRecord, 'scopeType' | 'scopeKey'>
): boolean {
  const leftType = left.scopeType || 'global'
  const rightType = right.scopeType || 'global'
  return leftType === rightType
    && normalizeMemoryScopeKey(leftType, left.scopeKey) === normalizeMemoryScopeKey(rightType, right.scopeKey)
}

function hasStructuredIdentity(memory: Pick<MemoryPolicyRecord, 'subject' | 'factKey'>): boolean {
  return Boolean(normalizeFactPart(memory.subject) && normalizeFactPart(memory.factKey))
}

export function isSameMemoryFactIdentity(
  left: Pick<MemoryCandidateRecord, 'category' | 'scopeType' | 'scopeKey' | 'subject' | 'factKey'>,
  right: Pick<MemoryCandidateRecord, 'category' | 'scopeType' | 'scopeKey' | 'subject' | 'factKey'>
): boolean {
  return left.category === right.category
    && sameMemoryScope(left, right)
    && hasStructuredIdentity(left)
    && hasStructuredIdentity(right)
    && normalizeFactPart(left.subject) === normalizeFactPart(right.subject)
    && normalizeFactPart(left.factKey) === normalizeFactPart(right.factKey)
}

export function areMemoryFactsEquivalent(
  left: Pick<MemoryCandidateRecord, 'content' | 'factValue'>,
  right: Pick<MemoryCandidateRecord, 'content' | 'factValue'>
): boolean {
  const leftValue = normalizeFactValue(left.factValue)
  const rightValue = normalizeFactValue(right.factValue)
  if (leftValue && rightValue) return leftValue === rightValue
  return normalizeFactValue(left.content) === normalizeFactValue(right.content)
    || lexicalMemorySimilarity(left.content, right.content) >= 0.86
}

function tokenizeMemoryText(content: string): Set<string> {
  return new Set(
    content
      .toLowerCase()
      .split(/[\s，。、“”‘’；：,.!?;:()（）【】\[\]\-_/]+/)
      .filter((term) => term.length >= 2)
  )
}

function buildSimilarityTerms(content: string): Set<string> {
  const normalized = content.toLowerCase().replace(/[，。！？；：,.!?;:\s]+/g, '')
  const terms = tokenizeMemoryText(content)
  for (let i = 0; i < normalized.length - 1; i += 1) {
    terms.add(normalized.slice(i, i + 2))
  }
  return terms
}

export function lexicalMemorySimilarity(query: string, content: string): number {
  const queryTerms = buildSimilarityTerms(query)
  const contentTerms = buildSimilarityTerms(content)
  if (queryTerms.size === 0 || contentTerms.size === 0) return 0

  let overlap = 0
  for (const term of queryTerms) {
    if (contentTerms.has(term)) overlap += 1
  }

  const cosineLike = overlap / Math.sqrt(queryTerms.size * contentTerms.size)
  const normalizedQuery = query.toLowerCase().replace(/[，。！？；：,.!?;:\s]+/g, '')
  const normalizedContent = content.toLowerCase().replace(/[，。！？；：,.!?;:\s]+/g, '')
  const containsBoost = normalizedQuery.length >= 4 && normalizedContent.includes(normalizedQuery) ? 0.2 : 0
  return Math.min(1, cosineLike + containsBoost)
}

export function findMergeableMemoryCandidate<T extends MemoryCandidateRecord>(
  memories: T[],
  candidate: MemoryCandidateRecord
): T | undefined {
  return memories
    .filter((memory) => (
      memory.status === 'candidate'
      && memory.source === 'auto_extracted'
      && !memory.locked
      && memory.category === candidate.category
      && sameMemoryScope(memory, candidate)
    ))
    .map((memory) => ({
      memory,
      structuredMatch: isSameMemoryFactIdentity(memory, candidate),
      similarity: lexicalMemorySimilarity(memory.content, candidate.content),
    }))
    .filter(({ memory, structuredMatch, similarity }) => (
      structuredMatch || (!hasStructuredIdentity(memory) || !hasStructuredIdentity(candidate)) && similarity >= 0.72
    ))
    .sort((left, right) => Number(right.structuredMatch) - Number(left.structuredMatch) || right.similarity - left.similarity)[0]?.memory
}

export function findSimilarMemoryRecord<T extends MemoryCandidateRecord>(
  memories: T[],
  candidate: MemoryCandidateRecord,
  statuses: string[] = ['active', 'candidate'],
  threshold = 0.72
): T | undefined {
  return memories
    .filter((memory) => (
      statuses.includes(memory.status)
      && memory.category === candidate.category
      && sameMemoryScope(memory, candidate)
      && (!hasStructuredIdentity(memory) || !hasStructuredIdentity(candidate) || isSameMemoryFactIdentity(memory, candidate))
    ))
    .map((memory) => ({ memory, similarity: lexicalMemorySimilarity(memory.content, candidate.content) }))
    .filter(({ similarity }) => similarity >= threshold)
    .sort((left, right) => right.similarity - left.similarity)[0]?.memory
}

export type MemoryCandidateDecision<T extends MemoryCandidateRecord> =
  | { action: 'create' }
  | { action: 'skip'; reason: 'active_duplicate' | 'protected_candidate' | 'similar_duplicate' | 'duplicate_replacement'; target: T }
  | { action: 'merge'; target: T; equivalent: boolean; supersedes?: T }
  | { action: 'replace'; target: T }

export function resolveMemoryCandidateDecision<T extends MemoryCandidateRecord>(
  memories: T[],
  candidate: MemoryCandidateRecord
): MemoryCandidateDecision<T> {
  const activeFact = findActiveFactConflict(memories, candidate)
  if (activeFact && areMemoryFactsEquivalent(activeFact, candidate)) {
    return { action: 'skip', reason: 'active_duplicate', target: activeFact }
  }

  const mergeable = findMergeableMemoryCandidate(memories, candidate)
  if (mergeable) {
    return {
      action: 'merge',
      target: mergeable,
      equivalent: areMemoryFactsEquivalent(mergeable, candidate),
      supersedes: activeFact,
    }
  }

  const protectedCandidate = memories.find((memory) => (
    memory.status === 'candidate' && isSameMemoryFactIdentity(memory, candidate)
  ))
  if (protectedCandidate) {
    return { action: 'skip', reason: 'protected_candidate', target: protectedCandidate }
  }

  if (activeFact) {
    const replacement = memories.find((memory) => (
      memory.status === 'candidate'
      && memory.supersedesId === activeFact.id
      && areMemoryFactsEquivalent(memory, candidate)
    ))
    if (replacement) {
      return { action: 'skip', reason: 'duplicate_replacement', target: replacement }
    }
    return { action: 'replace', target: activeFact }
  }

  const similar = findSimilarMemoryRecord(memories, candidate)
  return similar
    ? { action: 'skip', reason: 'similar_duplicate', target: similar }
    : { action: 'create' }
}

export function chooseCanonicalMemoryContent(existingContent: string, incomingContent: string): string {
  const existing = existingContent.trim().replace(/\s+/g, ' ')
  const incoming = incomingContent.trim().replace(/\s+/g, ' ')
  return Array.from(incoming).length < Array.from(existing).length ? incoming : existing
}

export function normalizeMemoryCandidate<T extends MemoryCandidateInput>(candidate: T): T {
  const normalizeOptional = (value?: string): string | undefined => {
    const normalized = value?.trim().replace(/\s+/g, ' ')
    return normalized || undefined
  }
  const confidence = Number.isFinite(candidate.confidence)
    ? Math.max(0, Math.min(1, candidate.confidence as number))
    : undefined

  return {
    ...candidate,
    content: candidate.content.trim().replace(/\s+/g, ' '),
    category: candidate.category.trim(),
    subject: normalizeOptional(candidate.subject),
    factKey: normalizeOptional(candidate.factKey),
    factValue: normalizeOptional(candidate.factValue),
    confidence,
  }
}

export function validateMemoryCandidate(candidate: MemoryCandidateInput, options: { allowSensitive?: boolean } = {}): MemoryCandidateValidationResult {
  const content = candidate.content.trim()
  if (!options.allowSensitive && containsSensitiveMemoryText(content)) return { valid: false, reason: 'sensitive' }
  const contentLength = Array.from(content).length
  if (contentLength < 6) return { valid: false, reason: 'too_short' }
  if (contentLength > 80) return { valid: false, reason: 'too_long' }
  if (/^(好的|收到|明白|辛苦了|谢谢|哈哈|好的呢|行|嗯|嗨)$/.test(content)) {
    return { valid: false, reason: 'ephemeral_tone' }
  }
  if (/^(用户表示|根据(?:对话|用户消息)|从对话中得知)/.test(content)) {
    return { valid: false, reason: 'unstable_restatement' }
  }
  if (candidate.kind !== 'episodic' && /(这轮|本轮|今天|现在|待会|马上|稍后|刚才|接下来|这一版|当前任务|临时|暂时)/.test(content)) {
    return { valid: false, reason: 'one_off_task' }
  }
  if (/(翻译|改写|润色|重写|仿写|编写|生成|创作|虚构|假设|举例|示例|角色扮演|总结|概括|解释代码|分析代码)/.test(content)) {
    return { valid: false, reason: 'transformation_task' }
  }
  if (/(我(?:有点|很|太)(?:开心|难受|生气|焦虑|困|累)|我今天|心情(?:开心|难受|低落)|感到(?:开心|难受|生气|焦虑|困|累))/.test(content)) {
    return { valid: false, reason: 'temporary_emotion' }
  }
  if (/(```|function\s|\bconst\b|\bSELECT\b|\bINSERT\b|<[^>]+>)/i.test(content)) {
    return { valid: false, reason: 'looks_like_source_text' }
  }
  const sentenceBody = content.replace(/[。！？!?]+$/, '')
  if (/[\r\n]|[。！？!?；;]/.test(sentenceBody)) {
    return { valid: false, reason: 'multiple_sentences' }
  }
  return { valid: true }
}

export function shouldExtractMemoryCandidate(userText: string): boolean {
  const text = userText.trim()
  if (!text) return false
  if (/^(?:引用|原文|文章|文档|书中|摘录|示例|小说|角色)(?:里|中|写|说|提到|内容|记录|[：:\s])|^[“「"]/.test(text)) return false
  if (/^(?:请|帮我|麻烦|能否)?(?:翻译|改写|润色|重写|总结|概括|解释|分析|生成|编写|仿写|创作|虚构|假设|举例)/.test(text)) return false
  if (containsSensitiveMemoryText(text) || /(?:不要|别|无需|不必|不用|禁止).{0,8}(?:记住|记下|记忆|保存)/.test(text)) return false
  const explicitSave = isExplicitMemoryWriteIntent(text) || /(?:以后都|之后都)/.test(text)
  const assertion = /我(?:喜欢|偏好|习惯)(?!什么|哪|啥|吗)[^?？]{2,}|我的(?:习惯|风格|背景|身份|专业|称呼)是(?!什么|哪|啥|否)[^?？]{2,}/.test(text)
  if (!explicitSave && !assertion && /[?？]|(?:是什么|有哪些|什么来着|还记得|还记住|怎么约定|怎么决定)/.test(text)) return false
  const event = /(?:我们|项目|团队|我).{0,40}(?:决定|确定|定下|选定|达成|完成|毕业|入职|迁移到|改用)/.test(text)
    && !/(?:假设|虚构|示例|如果|打算|准备|可能|计划)/.test(text)
  if (!explicitSave && event && !/(?:```|翻译|改写|角色扮演)/.test(text)) return true
  if (!explicitSave && /(?:今天|现在|这次|这轮|本轮|当前任务|临时|暂时|待会|稍后|马上)/.test(text)) {
    return false
  }
  if (!explicitSave && /(?:翻译|改写|润色|重写|仿写|编写|生成|创作|虚构|假设|举例|示例|角色扮演)/.test(text)) {
    return false
  }
  return [
    /(?:记住|记下来|保存为长期记忆|以后记得|以后都|之后都)/,
    /(?:我喜欢|我偏好|我的习惯|我的风格|默认用|每次都|总是)/,
    /(?:称呼我|叫我|我的称呼|用中文|中文回答)/,
    /(?:项目约定|项目规则|长期项目|目录职责|工程边界|技术栈)/,
    /(?:我正在学|我开始学|我学完了|学习进度|学习路线)/,
    /(?:我的背景|我的身份|我是.+(?:工程师|学生|设计师|作者|开发者))/,
    /我的(?:长期目标|专业|职业|称呼|学习方向)(?:是|为)/,
  ].some((pattern) => pattern.test(text))
}

/** Confidence alone never activates a fact: identity, literal evidence and conservative source admission are mandatory. */
export function shouldActivateAutomaticMemory(candidate: MemoryCandidateInput, sourceText: string): boolean {
  if (!validateMemoryCandidate(candidate).valid || !shouldExtractMemoryCandidate(sourceText)
    || !candidate.subject || !candidate.factKey || !candidate.factValue
    || !Number.isFinite(candidate.confidence) || (candidate.confidence ?? 0) < 0.85
    || !sourceText.toLowerCase().includes(candidate.factValue.toLowerCase())) return false
  const genericSubject = /^(?:user|用户|project|项目)$/i.test(candidate.subject)
  if (!genericSubject && !sourceText.toLowerCase().includes(candidate.subject.toLowerCase())) return false
  const negative = /不(?:再|要|允许|使用|采用|喜欢|是)|禁止|避免|只允许|不得/
  return negative.test(sourceText) === negative.test(candidate.content)
}

export function hasReusableEmbedding(
  memory: Pick<MemoryPolicyRecord, 'content' | 'contentHash' | 'embedding' | 'embeddingModel'>,
  embeddingModel?: string
): boolean {
  return Boolean(
    memory.embedding?.length
    && memory.contentHash === contentHash(memory.content)
    && memory.embeddingModel === (embeddingModel || null)
  )
}

export function contentHash(content: string): string {
  let hash = 2166136261
  for (let i = 0; i < content.length; i += 1) {
    hash ^= content.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16)
}
