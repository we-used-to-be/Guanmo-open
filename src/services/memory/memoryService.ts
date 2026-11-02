import type { ChatMessage, MemoryChatMessageSource } from '@/services/ai/types'
import type { Memory, MemorySourceGuard, MemorySourceSnapshot } from '@/services/database/persistence'
import {
  persistMemory,
  loadMemories,
  loadMemoryEmbeddings,
  updateMemoryIfUnchanged,
  removeMemoryIfUnchanged,
  persistMemoryEmbedding,
  loadMemorySourceMessages,
  loadMemoryCount,
} from '@/services/database/persistence'
import {
  classifyMemoryRetrievalIntent,
  chooseCanonicalMemoryContent,
  contentHash,
  filterInjectableMemories,
  hasReusableEmbedding,
  inferMemoryScope,
  isMemoryVisibleInScope,
  lexicalMemorySimilarity,
  normalizeMemoryCandidate,
  normalizeMemoryScopeKey,
  resolveMemoryCandidateDecision,
  shouldExtractMemoryCandidate,
  validateMemoryCandidate,
  containsSensitiveMemoryText,
  shouldActivateAutomaticMemory,
  findActiveFactConflict,
  areMemoryFactsEquivalent,
} from './memoryPolicy'
import type { MemoryCandidateInput, MemoryScopeType } from './memoryPolicy'
import { decodeMemoryEvidence, encodeMemoryEvidence, memoryEvidenceUserReferences, withMemoryReplacement } from './memoryEvidence'
import { idleScheduler } from '@/services/idleScheduler'

export { classifyMemoryRetrievalIntent } from './memoryPolicy'
export { isPersonalizedRewriteMemoryIntent } from './memoryPolicy'
export type { MemoryRetrievalIntent } from './memoryPolicy'

const AUTO_CATEGORIES = ['preference', 'project', 'learning', 'profile', 'instruction'] as const
const MAX_CANDIDATES = 200
export class MemoryCandidateCapacityError extends Error {
  constructor() { super('memory_candidate_capacity') }
}
const LIGHT_MEMORY_TOP_K = 3
const STRONG_MEMORY_TOP_K = 10
const LIGHT_EMBEDDING_CANDIDATE_LIMIT = 12
const STRONG_EMBEDDING_CANDIDATE_LIMIT = 40
// Read only a bounded, recent cache window; never generate memory vectors on the request path.
const LIGHT_SEMANTIC_CACHE_LIMIT = 256
const STRONG_SEMANTIC_CACHE_LIMIT = 1024
const SEMANTIC_ONLY_THRESHOLD = 0.7
const LIGHT_MEMORY_THRESHOLD = 0.3
const STRONG_MEMORY_THRESHOLD = 0.2
const pendingVectorFills = new Set<string>()

function scheduleMemoryVectorFill(memories: Memory[], options: MemorySearchOptions) {
  if (!options.batchEmbedding || options.signal?.aborted) return
  const pending = memories.filter(memory => !hasReusableEmbedding(memory, options.embeddingModel)
    && !pendingVectorFills.has(`${memory.id}:${contentHash(memory.content)}:${options.embeddingModel || ''}`)).slice(0, 8)
  if (!pending.length) return
  const keys = pending.map(memory => `${memory.id}:${contentHash(memory.content)}:${options.embeddingModel || ''}`)
  keys.forEach(key => pendingVectorFills.add(key))
  idleScheduler.enqueueOptional(async () => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 20_000)
    try {
      if (options.signal?.aborted) return
      const current = await loadMemories({ ids: pending.map(memory => memory.id), statuses: ['active'], includeEmbedding: false })
      const eligible = pending.filter(memory => current.some(row => row.id === memory.id
        && row.content === memory.content && row.contentHash === memory.contentHash))
      if (!eligible.length || controller.signal.aborted) return
      const generated = await Promise.race([
        options.batchEmbedding!(eligible.map(memory => memory.content), controller.signal),
        new Promise<never>((_, reject) => controller.signal.addEventListener('abort', () => reject(new Error('memory_fill_timeout')), { once: true })),
      ])
      if (controller.signal.aborted) return
      for (let index = 0; index < eligible.length; index++) {
        const vector = generated[index]
        if (Array.isArray(vector)) await persistMemoryEmbedding(eligible[index], vector, options.embeddingModel || null, contentHash(eligible[index].content))
      }
    } catch { console.info('[Memory] vector cache fill deferred', { count: pending.length }) }
    finally { clearTimeout(timer); keys.forEach(key => pendingVectorFills.delete(key)) }
  }, 70, '长期记忆向量缓存')
}
const CATEGORY_PRIORITY: Record<string, number> = {
  project_memory: 0,
  project: 0,
  profile_memory: 1,
  instruction: 1,
  preference: 2,
  profile: 2,
  learning: 3,
  session_memory: 4,
  context: 4,
  general: 5,
}

interface ExtractedMemory extends MemoryCandidateInput {
  action: 'add' | 'update' | 'delete'
  id?: string
  sourceId?: string
}

export interface ExtractionOptions {
  triggerReason?: string
  workspacePath?: string | null
  signal?: AbortSignal
  sourceId?: string
  isValid?: () => boolean
  isSourceValid?: () => Promise<boolean>
  throwOnFailure?: boolean
  sourceContents?: Readonly<Record<string, string>>
  sourceSnapshots?: Readonly<Record<string, MemorySourceSnapshot>>
}

interface ExtractionClient {
  chat(req: { messages: ChatMessage[]; temperature?: number; signal?: AbortSignal; maxTokens?: number; reasoningMode?: 'off' | 'on' }): Promise<{ content: string }>
}

type MemoryRetrievalMode = 'light' | 'strong'

export interface MemorySearchOptions {
  mode?: MemoryRetrievalMode
  topK?: number
  threshold?: number
  embedding?: (text: string, signal?: AbortSignal) => Promise<number[]>
  batchEmbedding?: (texts: string[], signal?: AbortSignal) => Promise<number[][]>
  signal?: AbortSignal
  scopeType?: MemoryScopeType
  scopeKey?: string | null
  embeddingModel?: string
  categories?: readonly string[]
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  if (normA === 0 || normB === 0) return 0
  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}

function categoryPriority(category: string): number {
  return CATEGORY_PRIORITY[category] ?? 4
}

function sortMemoryScores<T extends { memory: Memory; similarity: number }>(
  items: T[],
  requestedScopeKey?: string | null
): T[] {
  return items.sort((a, b) => {
    const scopeRank = (memory: Memory) => (
      requestedScopeKey && memory.scopeType === 'project' && memory.scopeKey === requestedScopeKey ? 0 : 1
    )
    const similarityDiff = (b.similarity + (scopeRank(b.memory) === 0 ? 0.04 : 0))
      - (a.similarity + (scopeRank(a.memory) === 0 ? 0.04 : 0))
    if (similarityDiff !== 0) return similarityDiff
    const priorityDiff = categoryPriority(a.memory.category) - categoryPriority(b.memory.category)
    if (priorityDiff !== 0) return priorityDiff
    return b.memory.updatedAt - a.memory.updatedAt
  })
}

function normalizeMemoryCategory(category: string | undefined): string {
  const normalized = (category || '').trim()
  if (AUTO_CATEGORIES.includes(normalized as (typeof AUTO_CATEGORIES)[number])) return normalized
  if (normalized === 'context' || normalized === 'general') return 'project'
  return 'preference'
}

function findSimilarMemory(
  content: string,
  category: string,
  existing: Memory[],
  threshold = 0.72
): Memory | undefined {
  return existing
    .filter((memory) => memory.category === category && !memory.locked)
    .map((memory) => ({ memory, similarity: lexicalMemorySimilarity(content, memory.content) }))
    .filter((item) => item.similarity >= threshold)
    .sort((a, b) => b.similarity - a.similarity)[0]?.memory
}

function shouldAttemptMemoryCandidateExtraction(messages: ChatMessage[]): boolean {
  const recentUserText = messages
    .filter((message) => message.role === 'user' && !message.hidden)
    .slice(-1)
    .map((message) => message.displayContent || message.content)
    .join('\n')
    .trim()

  if (!recentUserText) return false

  return shouldExtractMemoryCandidate(recentUserText)
}

function buildExtractPrompt(existingMemories: Memory[]): string {
  const safeExisting = existingMemories.filter(memory => !containsSensitiveMemoryText([memory.content, memory.factKey, memory.factValue].filter(Boolean).join(' ')))
  const existingBlock = safeExisting.length > 0
    ? `\n\n当前作用域已有记忆（用于复用事实身份和避免重复；锁定/手动记录不可自动修改）：\n${safeExisting.map(item => JSON.stringify({ id: item.id, content: item.content, category: item.category, status: item.status, source: item.source, locked: item.locked, subject: item.subject, factKey: item.factKey, factValue: item.factValue })).join('\n')}`
    : ''

  return `你是一个长期记忆提取器。你的任务是从用户消息中找出适合跨会话长期保留的事实，由应用校验后决定自动生效或等待确认。

只允许提取：
- 用户明确表达的稳定偏好、习惯、称呼、语言或格式要求
- 用户明确说明会长期沿用的项目约定、技术栈、目录职责或工程边界
- 用户明确表达的长期工作方式或长期目标

候选格式要求：
- 每项只表达一个原子事实；多个事实必须拆成多项
- content 使用中性、稳定、无解释的单句，最多 80 个 Unicode 字符
- 删除“用户表示”“根据对话”等转述前缀，不附带理由、示例或当前任务背景
- subject/factKey/factValue 必须能由用户原文直接支持，值应短小且可稳定比较

禁止提取：
- 一次性任务、当前这轮要做的动作、短期计划
- 临时情绪、感叹、礼貌客套、随口评价
- AI 自己的总结、推断、建议或工具结果
- 文档正文、代码片段、RAG 检索结果、搜索结果
- 翻译、总结、改写、代码解释、虚构或示例请求中的待处理文本
- 已有记忆的重复改写

分类规则：
- preference: 偏好、习惯、称呼、语言风格
- project: 长期项目、技术栈、目录职责、工程边界
- learning: 学习进度、学习路线、阶段变化
- profile: 稳定身份、背景信息
- instruction: 长期指令、协作规则、输出格式

已确定的重要事件、项目决策或学习里程碑可标为 kind=episodic，保留具体决定和时间背景；不得从助手建议推断用户已决定。其他事实 kind=semantic。
支持 add/update/delete/noop；update/delete 只允许目录内的自动未锁候选，不能删除已确认或手动事实；拿不准使用 noop。
请只输出 JSON 数组，每项格式：
{"action":"add","content":"记忆内容","category":"preference|project|learning|profile|instruction","kind":"semantic|episodic","sourceId":"用户消息ID","subject":"user|项目名","factKey":"稳定属性名","factValue":"用户原文中的短值","confidence":0.0}

subject/factKey/factValue 只能来自用户原文可直接支持的事实；无法结构化时可省略。confidence 表示用户表达的明确程度，不得表示模型猜测。
同一事实必须沿用已有 subject/factKey/category；已确认事实的新值只能提出 add 替代候选，不得直接 update/delete。新事实若结构完整、非敏感且明确，将由应用自动生效；任何冲突仍等待确认。

拿不准时输出空数组 []。不要输出任何解释。${existingBlock}`
}

export async function extractMemories(
  messages: ChatMessage[],
  client: ExtractionClient,
  temperature?: number,
  options?: ExtractionOptions,
): Promise<ExtractedMemory[]> {
  const recentMessages = messages
    .filter((message) => message.role === 'user' && !message.hidden)
    .slice(-3)
  if (recentMessages.length < 1) return []

  if (options?.signal?.aborted || options?.isValid?.() === false) return []
  const existingMemories = await loadMemories({
    statuses: ['active', 'candidate'], includeEmbedding: false,
    scopeType: options?.workspacePath ? 'project' : 'global', scopeKey: normalizeMemoryScopeKey('project', options?.workspacePath),
    limit: 40,
  })
  const systemPrompt = buildExtractPrompt(existingMemories)
  const chatMessages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    ...recentMessages.map(message => ({ role: 'user' as const, content: JSON.stringify({
      sourceId: message.id || options?.sourceId || '',
      text: (message.displayContent || message.content).slice(0, 6000),
    }) })),
    {
      role: 'user',
      content: '请基于以上用户消息提取长期记忆候选。只输出 JSON 数组。',
    },
  ]

  try {
    const response = await client.chat({ messages: chatMessages, temperature, signal: options?.signal, maxTokens: 800, reasoningMode: 'off' })
    if (options?.signal?.aborted || options?.isValid?.() === false) return []
    const text = response.content.trim()
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
    const jsonText = fenced ? fenced[1].trim() : text
    const start = jsonText.indexOf('[')
    const end = jsonText.lastIndexOf(']')
    if (start < 0 || end < 0) throw new Error('invalid_memory_extraction')

    const parsed = JSON.parse(jsonText.slice(start, end + 1))
    if (!Array.isArray(parsed)) throw new Error('invalid_memory_extraction')

    return parsed.map((item: unknown) => {
      if (typeof item !== 'object' || item === null) return item
      const record = item as Record<string, unknown>
      return { ...record, action: typeof record.action === 'string' ? record.action.toLowerCase() : '' }
    })
      .filter((item: unknown): item is ExtractedMemory => {
        if (typeof item !== 'object' || item === null) return false
        const record = item as ExtractedMemory
        return (
          ['add', 'update', 'delete'].includes(record.action)
          && typeof record.content === 'string'
          && typeof record.category === 'string'
          && AUTO_CATEGORIES.includes(record.category as (typeof AUTO_CATEGORIES)[number])
          && (record.kind === undefined || record.kind === 'semantic' || record.kind === 'episodic')
        )
      })
      .slice(0, 6)
  } catch (err) {
    if (options?.throwOnFailure) throw err
    console.warn('[Memory] extraction request or parse failed')
    return []
  }
}

function hasMaterialMemoryChange(existing: Memory, next: Memory): boolean {
  return existing.content !== next.content || existing.status !== next.status
    || (existing.subject || null) !== (next.subject || null)
    || (existing.factKey || null) !== (next.factKey || null)
    || (existing.factValue || null) !== (next.factValue || null)
    || (existing.confidence ?? 0.7) !== (next.confidence ?? 0.7)
    || (existing.evidence || null) !== (next.evidence || null)
    || (existing.supersedesId || null) !== (next.supersedesId || null)
}

function replaceMemorySnapshot(memories: Memory[], next: Memory): void {
  const index = memories.findIndex((memory) => memory.id === next.id)
  if (index >= 0) memories[index] = next
}

async function persistAutomaticRecord(memory: Memory, expected?: Memory, source?: MemorySourceGuard): Promise<Memory | null> {
  const write = (next: Memory) => expected ? updateMemoryIfUnchanged(next, expected, source) : persistMemory(next, true, source)
  if (await write(memory)) return memory
  if (memory.status !== 'active') return null
  const latest = await loadMemories({ statuses: ['active'], category: memory.category, includeEmbedding: false,
    scopeType: memory.scopeType || 'global', scopeKey: memory.scopeKey, includeGlobalForProject: false })
  const conflict = findActiveFactConflict(latest, memory)
  if (!conflict || areMemoryFactsEquivalent(conflict, memory)) return null
  const candidate: Memory = { ...memory, status: 'candidate', supersedesId: conflict.id,
    evidence: withMemoryReplacement(memory.evidence || '', conflict) }
  return await write(candidate) ? candidate : null
}

export async function processMemoryCandidateExtraction(
  messages: ChatMessage[],
  client: ExtractionClient,
  temperature?: number,
  options?: ExtractionOptions
): Promise<number> {
  const triggerReason = options?.triggerReason || 'unknown'
  if (!shouldAttemptMemoryCandidateExtraction(messages)) {
    console.info('[Memory] extraction skipped: no long-term signal', { triggerReason })
    return 0
  }

  const pendingCount = await loadMemoryCount({ statuses: ['candidate'],
    scopeType: options?.workspacePath ? 'project' : 'global', scopeKey: normalizeMemoryScopeKey('project', options?.workspacePath) })
  if (pendingCount >= MAX_CANDIDATES) {
    if (options?.throwOnFailure) throw new MemoryCandidateCapacityError()
    return 0
  }

  const extracted = await extractMemories(messages, client, temperature, options)
  if (options?.signal?.aborted || options?.isValid?.() === false) return 0
  const userEvidence = [...messages]
    .reverse()
    .find((message) => message.role === 'user' && !message.hidden)
  console.info('[Memory] extraction triggered', {
    triggerReason,
    visibleUserMessages: messages.filter((msg) => msg.role === 'user' && !msg.hidden).length,
    extractedCount: extracted.length,
  })
  if (extracted.length === 0) return 0

  const allMemories = await loadMemories({
    statuses: ['active', 'candidate', 'ignored', 'archived'], includeEmbedding: false,
    scopeType: options?.workspacePath ? 'project' : 'global', scopeKey: normalizeMemoryScopeKey('project', options?.workspacePath),
  })
  let saved = 0

  for (const rawItem of extracted) {
    try {
      if (options?.signal?.aborted || options?.isValid?.() === false) break
      if (options?.isSourceValid && !await options.isSourceValid()) break
      let item = normalizeMemoryCandidate(rawItem)
      const source = rawItem.sourceId
        ? messages.find(message => message.role === 'user' && !message.hidden && message.id === rawItem.sourceId)
        : messages.filter(message => message.role === 'user' && !message.hidden).length === 1 ? userEvidence : undefined
      if (!source) continue
      const sourceText = (source.displayContent || source.content).trim()
      if (containsSensitiveMemoryText(sourceText) || !shouldExtractMemoryCandidate(sourceText)) continue
      if (item.factValue && !sourceText.toLowerCase().includes(item.factValue.toLowerCase())) continue
      const evidence = encodeMemoryEvidence(source, item.kind)
      const sourceGuard = source.id && options?.sourceContents?.[source.id] !== undefined
        ? { id: source.id, content: options.sourceContents[source.id],
          ...(options.sourceSnapshots?.[source.id] ? { snapshots: [options.sourceSnapshots[source.id]] } : {}) } : undefined
      const sourceIdentity = source.id || options?.sourceId
      const candidateId = sourceIdentity
        ? `mem-auto-${sourceIdentity}-${Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(item.content)))).map(byte => byte.toString(16).padStart(2, '0')).join('')}`
        : `mem-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
      const validation = validateMemoryCandidate(item)
      if (!validation.valid) {
        console.info('[Memory] candidate rejected', {
          triggerReason,
          reason: validation.reason,
          contentLength: item.content.length,
        })
        continue
      }
      const activeUpdate = item.action === 'update' && item.id ? allMemories.find(memory => memory.id === item.id && memory.status === 'active') : undefined
      if (activeUpdate) {
        const scope = inferMemoryScope(item.category, options?.workspacePath)
        if (activeUpdate.category !== item.category || (activeUpdate.scopeType || 'global') !== scope.scopeType || (activeUpdate.scopeKey || null) !== scope.scopeKey) continue
        item = { ...item, action: 'add', subject: activeUpdate.subject || item.subject || undefined, factKey: activeUpdate.factKey || item.factKey || undefined }
      }
      const canActivate = shouldActivateAutomaticMemory(item, sourceText)

      if (item.action === 'add') {
        const category = normalizeMemoryCategory(item.category)
        const itemScope = inferMemoryScope(category, options?.workspacePath)
        if (allMemories.some(memory => ['ignored', 'archived'].includes(memory.status)
          && memory.scopeType === itemScope.scopeType && memory.scopeKey === itemScope.scopeKey
          && lexicalMemorySimilarity(memory.content, item.content) >= 0.86)) continue
        const candidateRecord = {
          id: 'incoming-candidate',
          content: item.content,
          category,
          source: 'auto_extracted',
          locked: false,
          status: 'candidate',
          ...itemScope,
          subject: item.subject || null,
          factKey: item.factKey || null,
          factValue: item.factValue || null,
        }
        const decision = resolveMemoryCandidateDecision(allMemories, candidateRecord)
        if (decision.action === 'skip') {
          console.info('[Memory] candidate skipped', {
            triggerReason,
            reason: decision.reason,
            contentLength: item.content.length,
          })
          continue
        }
        if (decision.action === 'merge') {
          const mergeable = decision.target
          const equivalent = decision.equivalent
          const mergedContent = equivalent
            ? chooseCanonicalMemoryContent(mergeable.content, item.content)
            : item.content
          const contentChanged = mergedContent !== mergeable.content
          const merged: Memory = {
            ...mergeable,
            status: canActivate && !decision.supersedes && !mergeable.supersedesId ? 'active' : 'candidate',
            content: mergedContent,
            subject: item.subject || mergeable.subject || null,
            factKey: item.factKey || mergeable.factKey || null,
            factValue: equivalent
              ? item.factValue || mergeable.factValue || null
              : item.factValue || null,
            confidence: Math.max(item.confidence ?? 0.7, mergeable.confidence ?? 0.7),
            evidence: decision.supersedes ? withMemoryReplacement(evidence, decision.supersedes) : evidence,
            supersedesId: decision.supersedes?.id || mergeable.supersedesId,
            embedding: contentChanged ? null : mergeable.embedding,
            embeddingModel: contentChanged ? null : mergeable.embeddingModel,
            contentHash: contentChanged ? contentHash(mergedContent) : mergeable.contentHash,
            updatedAt: Date.now(),
          }
          if (!hasMaterialMemoryChange(mergeable, merged)) {
            console.info('[Memory] candidate skipped as unchanged', {
              triggerReason,
              contentLength: item.content.length,
            })
            continue
          }
          const stored = await persistAutomaticRecord(merged, mergeable, sourceGuard)
          if (!stored) continue
          replaceMemorySnapshot(allMemories, stored)
          saved += 1
          continue
        }

        if (decision.action === 'replace') {
          const sameFact = decision.target
          const replacement: Memory = {
            id: candidateId,
            content: item.content,
            category,
            source: 'auto_extracted',
            locked: false,
            status: 'candidate',
            scopeType: sameFact.scopeType,
            scopeKey: sameFact.scopeKey,
            subject: item.subject || null,
            factKey: item.factKey || null,
            factValue: item.factValue || null,
            confidence: item.confidence ?? 0.7,
            evidence: withMemoryReplacement(evidence, sameFact),
            supersedesId: sameFact.id,
            contentHash: contentHash(item.content),
            createdAt: Date.now(),
            updatedAt: Date.now(),
          }
          if (!await persistMemory(replacement, true, sourceGuard)) continue
          allMemories.push(replacement)
          saved += 1
          continue
        }

        const memory: Memory = {
          id: candidateId,
          content: item.content,
          category,
          source: 'auto_extracted',
          locked: false,
          status: canActivate ? 'active' : 'candidate',
          ...itemScope,
          subject: item.subject || null,
          factKey: item.factKey || null,
          factValue: item.factValue || null,
          confidence: item.confidence ?? 0.7,
          evidence,
          contentHash: contentHash(item.content),
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }
        const stored = await persistAutomaticRecord(memory, undefined, sourceGuard)
        if (!stored) continue
        allMemories.push(stored)
        saved += 1
        continue
      }

      if (item.action === 'update' && item.id) {
        const existing = allMemories.find((memory) => memory.id === item.id)
        const scope = inferMemoryScope(item.category, options?.workspacePath)
        if (existing && existing.source === 'auto_extracted' && existing.status === 'candidate' && !existing.locked
          && (existing.scopeType || 'global') === scope.scopeType && (existing.scopeKey || null) === scope.scopeKey) {
          const contentChanged = existing.content !== item.content
          const updated: Memory = {
            ...existing,
            content: item.content,
            subject: item.subject || existing.subject || null,
            factKey: item.factKey || existing.factKey || null,
            factValue: item.factValue || existing.factValue || null,
            confidence: Math.max(item.confidence ?? 0.7, existing.confidence ?? 0.7),
            evidence,
            embedding: contentChanged ? null : existing.embedding,
            embeddingModel: contentChanged ? null : existing.embeddingModel,
            contentHash: contentChanged ? contentHash(item.content) : existing.contentHash,
            updatedAt: Date.now(),
          }
          if (!hasMaterialMemoryChange(existing, updated)) continue
          if (!await updateMemoryIfUnchanged(updated, existing, sourceGuard)) continue
          replaceMemorySnapshot(allMemories, updated)
          saved += 1
        }
        continue
      }

      if (item.action === 'delete' && item.id) {
        const existing = allMemories.find((memory) => memory.id === item.id)
        const scope = inferMemoryScope(item.category, options?.workspacePath)
        if (existing && existing.source === 'auto_extracted' && existing.status === 'candidate' && !existing.locked
          && (existing.scopeType || 'global') === scope.scopeType && (existing.scopeKey || null) === scope.scopeKey) {
          if (await removeMemoryIfUnchanged(existing, sourceGuard)) saved += 1
        }
      }
    } catch (err) {
      if (options?.throwOnFailure) throw err
      console.warn('[Memory] candidate persistence failed')
    }
  }

  console.info('[Memory] extraction finished', {
    triggerReason,
    saved,
  })
  return saved
}

export interface ExplicitMemoryUpsertResult {
  memory: Memory
  action: 'created' | 'updated'
}

export async function upsertExplicitMemory(
  content: string,
  category: string,
  options?: {
    workspacePath?: string | null
    subject?: string | null
    factKey?: string | null
    factValue?: string | null
  }
): Promise<ExplicitMemoryUpsertResult> {
  const normalizedContent = content.trim()
  const normalizedCategory = normalizeMemoryCategory(category)
  const now = Date.now()
  const scope = inferMemoryScope(normalizedCategory, options?.workspacePath)
  const allMemories = await loadMemories({
    statuses: ['active', 'candidate'], includeEmbedding: false, category: normalizedCategory,
    scopeType: scope.scopeType, scopeKey: scope.scopeKey, includeGlobalForProject: false,
  })
  const similar = findSimilarMemory(normalizedContent, normalizedCategory, allMemories, 0.68)

  if (similar) {
    const memory: Memory = {
      ...similar,
      content: normalizedContent,
      category: normalizedCategory,
      source: 'user_explicit',
      status: 'active',
      ...scope,
      subject: options?.subject || similar.subject || null,
      factKey: options?.factKey || similar.factKey || null,
      factValue: options?.factValue || normalizedContent,
      confidence: 1,
      evidence: normalizedContent,
      embedding: null,
      embeddingModel: null,
      contentHash: contentHash(normalizedContent),
      updatedAt: now,
    }
    if (!await persistMemory(memory)) throw new Error('记忆未写入，数据库尚未就绪')
    return { memory, action: 'updated' }
  }

  const memory: Memory = {
    id: `mem-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    content: normalizedContent,
    category: normalizedCategory,
    source: 'user_explicit',
    locked: false,
    status: 'active',
    ...scope,
    subject: options?.subject || null,
    factKey: options?.factKey || null,
    factValue: options?.factValue || normalizedContent,
    confidence: 1,
    evidence: normalizedContent,
    contentHash: contentHash(normalizedContent),
    createdAt: now,
    updatedAt: now,
  }
  if (!await persistMemory(memory)) throw new Error('记忆未写入，数据库尚未就绪')
  return { memory, action: 'created' }
}

export function isStrongMemoryRetrievalQuery(query: string): boolean {
  return classifyMemoryRetrievalIntent(query) === 'strong'
}

export async function searchMemories(
  query: string,
  topKOrOptions: number | MemorySearchOptions = 5
): Promise<Memory[]> {
  if (!query.trim()) return []

  const legacyTopKOnly = typeof topKOrOptions === 'number'
  const options: MemorySearchOptions = legacyTopKOnly
    ? { topK: topKOrOptions, threshold: 0 }
    : topKOrOptions
  const requestedScopeKey = normalizeMemoryScopeKey(options.scopeType || 'global', options.scopeKey)
  const allMemories = filterInjectableMemories(
    await loadMemories({
      statuses: ['active'],
      scopeType: options.scopeType === 'project' ? 'project' : 'global',
      scopeKey: options.scopeType === 'project' ? requestedScopeKey : null,
      categories: options.categories,
      includeEmbedding: false,
    })
  ).filter((memory) => isMemoryVisibleInScope(
    memory,
    options.scopeType === 'project' ? options.scopeKey : null
  )).filter(memory => !containsSensitiveMemoryText([memory.content, memory.factKey, memory.factValue].filter(Boolean).join(' '))
    || /地址|住址|手机|电话|邮箱|证件|密码|密钥|过敏|诊断|敏感/.test(query))
  if (allMemories.length === 0) return []

  const mode = options.mode || 'light'
  const topK = options.topK ?? (mode === 'strong' ? STRONG_MEMORY_TOP_K : LIGHT_MEMORY_TOP_K)
  const threshold = options.threshold ?? (mode === 'strong' ? STRONG_MEMORY_THRESHOLD : LIGHT_MEMORY_THRESHOLD)
  // BGE Chinese scores are lower than the generic gate; calibrated against real provider vectors.
  const semanticOnlyThreshold = options.embeddingModel === 'BAAI/bge-large-zh-v1.5' ? 0.4 : SEMANTIC_ONLY_THRESHOLD
  const lexicalScored = allMemories.map((memory) => ({
    memory,
    similarity: Math.min(1, lexicalMemorySimilarity(query, memory.content) + (
      [memory.subject, memory.factKey, memory.factValue].some((value) => value && query.includes(value)) ? 0.2 : 0
    ) + (
      /偏好|习惯|风格|语气|语言|称呼|格式/.test(query) && ['preference', 'instruction'].includes(memory.category) ? 0.22 : 0
    ) + (
      /背景|身份|专业|职业/.test(query) && memory.category === 'profile' ? 0.22 : 0
    ) + (
      /之前|上次|当时|决定|决策/.test(query) && decodeMemoryEvidence(memory.evidence)?.kind === 'episodic' ? 0.18 : 0
    )),
  }))
  const lexicalMatches = sortMemoryScores(lexicalScored.filter((item) => item.similarity > 0), requestedScopeKey)
  const lexicalCandidates = lexicalMatches.slice(0,
    mode === 'strong' ? STRONG_EMBEDDING_CANDIDATE_LIMIT : LIGHT_EMBEDDING_CANDIDATE_LIMIT)
  const lexicalCandidateIds = new Set(lexicalCandidates.map(({ memory }) => memory.id))
  const vectorFillCandidates = mode === 'strong' && lexicalMatches.length === 0
    ? sortMemoryScores([...lexicalScored], requestedScopeKey).slice(0, STRONG_EMBEDDING_CANDIDATE_LIMIT)
    : lexicalCandidates
  const semanticCandidates = options.embedding ? lexicalScored.filter(({ memory }) =>
    memory.contentHash === contentHash(memory.content)
    && memory.embeddingModel === (options.embeddingModel || null)
  ).slice(0, mode === 'strong' ? STRONG_SEMANTIC_CACHE_LIMIT : LIGHT_SEMANTIC_CACHE_LIMIT) : []
  const vectorCandidates = [...new Map([...vectorFillCandidates, ...semanticCandidates]
    .map(candidate => [candidate.memory.id, candidate])).values()]

  if (options.signal?.aborted) return []
  if (options.embedding) {
    try {
      for (let offset = 0; offset < vectorCandidates.length; offset += 64 * 4) {
        if (options.signal?.aborted) return []
        const batches = []
        for (let start = offset; start < Math.min(offset + 64 * 4, vectorCandidates.length); start += 64) {
          batches.push(vectorCandidates.slice(start, start + 64))
        }
        const storedBatches = await Promise.all(batches.map(batch =>
          loadMemoryEmbeddings(batch.map(({ memory }) => memory.id))))
        if (options.signal?.aborted) return []
        for (const [index, batch] of batches.entries()) {
          for (const { memory } of batch) {
            const stored = storedBatches[index].get(memory.id)
            if (stored) Object.assign(memory, stored)
          }
        }
      }
    } catch {
      console.info('[Memory] vector cache unavailable; using lexical retrieval')
      // A partial cache read must not trigger a provider call after a cache failure.
      for (const { memory } of vectorCandidates) memory.embedding = null
    }
  }

  if (options.signal?.aborted) return []
  let queryEmbedding: number[] | null = null
  if (options.embedding && vectorCandidates.some(({ memory }) => hasReusableEmbedding(memory, options.embeddingModel))) {
    const controller = new AbortController()
    const stop = () => controller.abort()
    options.signal?.addEventListener('abort', stop, { once: true })
    const timer = setTimeout(stop, 1200)
    try {
      queryEmbedding = await Promise.race([
        options.embedding(query, controller.signal),
        new Promise<never>((_, reject) => controller.signal.addEventListener('abort', () => reject(new Error('memory_embedding_timeout')), { once: true })),
      ])
    } catch {
      console.info('[Memory] using lexical retrieval')
    } finally {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', stop)
    }
  }
  if (options.signal?.aborted) return []
  scheduleMemoryVectorFill(vectorFillCandidates.map(candidate => candidate.memory), options)
  const scored: Array<{ memory: Memory; similarity: number }> = []
  for (const candidate of lexicalScored) {
    const semantic = queryEmbedding && hasReusableEmbedding(candidate.memory, options.embeddingModel)
      ? cosineSimilarity(queryEmbedding, candidate.memory.embedding || []) : 0
    const admittedSemantic = lexicalCandidateIds.has(candidate.memory.id) || semantic >= semanticOnlyThreshold
      ? semantic : 0
    const similarity = Math.max(candidate.similarity, admittedSemantic * 0.75 + candidate.similarity * 0.25)
    if (similarity >= threshold && (!legacyTopKOnly || similarity > 0)) {
      const importance = candidate.memory.source === 'auto_extracted' ? 0 : 0.02
      const ageDays = Math.max(0, Date.now() - candidate.memory.updatedAt) / 86400_000
      const recency = 0.02 / (1 + ageDays / 90)
      scored.push({ memory: candidate.memory, similarity: similarity + importance + recency })
    }
  }

  return sortMemoryScores(scored, requestedScopeKey)
    .slice(0, topK)
    .map((item) => item.memory)
}

/** Byte-based estimate, not provider tokenizer usage. Default targets roughly 250 tokens. */
export function buildMemoryContext(memories: Memory[], maxTokens = 250, sourceDetails = ''): string {
  return buildMemoryContextWithSources(memories, maxTokens, sourceDetails).context
}

export function buildMemoryContextWithSources(memories: Memory[], maxTokens = 250, sourceDetails = '') {
  const sources: MemoryChatMessageSource[] = []
  if (memories.length === 0) return { context: '', sources }
  const byteLimit = Math.max(0, Math.min(1000, Number.isFinite(maxTokens) ? maxTokens : 250)) * 3
  const encoder = new TextEncoder()
  let context = '【长期记忆】\n'
  for (const [index, memory] of filterInjectableMemories(memories).entries()) {
    const categoryLabel = {
      profile_memory: '用户画像',
      project_memory: '项目',
      session_memory: '会话',
      preference: '偏好',
      project: '项目',
      learning: '学习进度',
      profile: '用户画像',
      instruction: '长期指令',
      context: '上下文',
      general: '其他',
    }[memory.category] || memory.category
    const evidence = decodeMemoryEvidence(memory.evidence)
    const recordedAt = evidence?.recordedAt ?? evidence?.occurredAt
    let part = [
      `[记忆 ${index + 1}]`,
      `分类：${categoryLabel}`,
      `作用域：${memory.scopeType === 'project' ? '当前项目' : '全局'}`,
      ...(evidence?.kind === 'episodic' && recordedAt ? [`记录时间：${new Date(recordedAt).toISOString()}`] : []),
      `内容：${memory.content}`,
    ].join('\n')
    if (encoder.encode(context + part + '\n\n').length > byteLimit) {
      let truncated = ''
      for (const character of part) {
        if (encoder.encode(context + truncated + character + '…\n\n').length > byteLimit) break
        truncated += character
      }
      if (!truncated.includes('内容：') || truncated.endsWith('内容：')) break
      part = truncated + '…'
    }
    context += part + '\n\n'
    sources.push({ kind: 'memory', memoryId: memory.id, content: part.slice(part.indexOf('内容：') + 3) })
  }
  if (context === '【长期记忆】\n') return { context: '', sources }
  if (sourceDetails) {
    for (const character of '\n【原始用户记录，按来源 ID 补查】\n' + sourceDetails) {
      if (encoder.encode(context + character).length > byteLimit) break
      context += character
    }
  }
  return { context: context.trimEnd(), sources }
}

export async function loadMemorySourceContext(memories: Memory[], query: string): Promise<string> {
  if (!/原话|原始|细节|为什么|原因|来源|经过/.test(query)) return ''
  const references = filterInjectableMemories(memories).flatMap(memory => {
    const evidence = decodeMemoryEvidence(memory.evidence)
    return evidence ? memoryEvidenceUserReferences(evidence) : []
  })
  const unique = new Map<string, { id: string; sessionId: string; hashes: Set<string> }>()
  for (const reference of references) {
    const key = JSON.stringify([reference.sessionId, reference.id])
    if (!unique.has(key)) unique.set(key, { id: reference.id, sessionId: reference.sessionId, hashes: new Set() })
    if (reference.textHash) unique.get(key)!.hashes.add(reference.textHash)
  }
  const selected = [...unique.values()].slice(0, 2)
  const rows = await loadMemorySourceMessages(selected)
  const order = new Map(selected.map((reference, index) => [reference.id, index]))
  rows.sort((a, b) => (order.get(a.id) ?? Infinity) - (order.get(b.id) ?? Infinity))
  const verified = await Promise.all(rows.map(async row => {
    const reference = selected.find(item => item.id === row.id)
    if (!reference || !row.content || containsSensitiveMemoryText(row.content)) return null
    if (reference.hashes.size) {
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(row.content))
      const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
      if ([...reference.hashes].some(expected => expected !== hash)) return null
    }
    return `用户原话（${row.id}）：${row.content.slice(0, 1600)}`
  }))
  return verified.filter((text): text is string => text !== null).join('\n')
}
