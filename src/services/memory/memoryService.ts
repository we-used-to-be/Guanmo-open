import type { ChatMessage } from '@/services/ai/types'
import type { Memory } from '@/services/database/persistence'
import {
  persistMemory,
  loadAllMemories,
  removeMemory,
  removeOldestAutoMemories,
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
} from './memoryPolicy'
import type { MemoryCandidateInput, MemoryScopeType } from './memoryPolicy'

export { classifyMemoryRetrievalIntent } from './memoryPolicy'
export { isPersonalizedRewriteMemoryIntent } from './memoryPolicy'
export type { MemoryRetrievalIntent } from './memoryPolicy'

const AUTO_CATEGORIES = ['preference', 'project', 'learning', 'profile', 'instruction'] as const
const MAX_MEMORIES = 200
const LIGHT_MEMORY_TOP_K = 3
const STRONG_MEMORY_TOP_K = 10
const LIGHT_EMBEDDING_CANDIDATE_LIMIT = 12
const STRONG_EMBEDDING_CANDIDATE_LIMIT = 40
const LIGHT_MEMORY_THRESHOLD = 0.3
const STRONG_MEMORY_THRESHOLD = 0.2
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
}

interface ExtractionOptions {
  triggerReason?: string
  workspacePath?: string | null
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
    const scopeDiff = scopeRank(a.memory) - scopeRank(b.memory)
    if (scopeDiff !== 0) return scopeDiff
    const similarityDiff = b.similarity - a.similarity
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
  const existingBlock = existingMemories.length > 0
    ? `\n\n当前已有记忆（用于避免重复）：\n${existingMemories.map((item) => `- [${item.id}] ${item.content}`).join('\n')}`
    : ''

  return `你是一个长期记忆候选提取器。你的任务是从用户消息中找出“适合跨会话长期保留、但仍需要用户确认”的候选记忆。

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

请只输出 JSON 数组，每项格式：
{"action":"add","content":"记忆内容","category":"preference|project|learning|profile|instruction","subject":"user|项目名","factKey":"稳定属性名","factValue":"属性值","confidence":0.0}

subject/factKey/factValue 只能来自用户原文可直接支持的事实；无法结构化时可省略。confidence 表示用户表达的明确程度，不得表示模型猜测。

拿不准时输出空数组 []。不要输出任何解释。${existingBlock}`
}

export async function extractMemories(
  messages: ChatMessage[],
  client: { chat: (req: { messages: ChatMessage[]; temperature?: number }) => Promise<{ content: string }> },
  temperature?: number
): Promise<ExtractedMemory[]> {
  const recentMessages = messages
    .filter((message) => message.role === 'user' && !message.hidden)
    .slice(-1)
  if (recentMessages.length < 1) return []

  const existingMemories = await loadAllMemories(undefined, ['active', 'candidate'])
  const systemPrompt = buildExtractPrompt(existingMemories)
  const chatMessages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    ...recentMessages,
    {
      role: 'user',
      content: '请基于以上用户消息提取长期记忆候选。只输出 JSON 数组。',
    },
  ]

  try {
    const response = await client.chat({ messages: chatMessages, temperature })
    const text = response.content.trim()
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
    const jsonText = fenced ? fenced[1].trim() : text
    const start = jsonText.indexOf('[')
    const end = jsonText.lastIndexOf(']')
    if (start < 0 || end < 0) return []

    const parsed = JSON.parse(jsonText.slice(start, end + 1))
    if (!Array.isArray(parsed)) return []

    return parsed
      .filter((item: unknown): item is ExtractedMemory => {
        if (typeof item !== 'object' || item === null) return false
        const record = item as ExtractedMemory
        return (
          ['add', 'update', 'delete'].includes(record.action)
          && typeof record.content === 'string'
          && typeof record.category === 'string'
          && AUTO_CATEGORIES.includes(record.category as (typeof AUTO_CATEGORIES)[number])
        )
      })
      .slice(0, 3)
  } catch (err) {
    console.warn('[Memory] extractMemories parse failed:', err)
    return []
  }
}

function hasMaterialMemoryChange(existing: Memory, next: Memory): boolean {
  return existing.content !== next.content
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

export async function processMemoryCandidateExtraction(
  messages: ChatMessage[],
  client: { chat: (req: { messages: ChatMessage[]; temperature?: number }) => Promise<{ content: string }> },
  temperature?: number,
  options?: ExtractionOptions
): Promise<number> {
  const triggerReason = options?.triggerReason || 'unknown'
  if (!shouldAttemptMemoryCandidateExtraction(messages)) {
    console.info('[Memory] extraction skipped: no long-term signal', { triggerReason })
    return 0
  }

  const extracted = await extractMemories(messages, client, temperature)
  const userEvidence = [...messages]
    .reverse()
    .find((message) => message.role === 'user' && !message.hidden)
  const evidence = (userEvidence?.displayContent || userEvidence?.content || '').trim()
  console.info('[Memory] extraction triggered', {
    triggerReason,
    visibleUserMessages: messages.filter((msg) => msg.role === 'user' && !msg.hidden).length,
    extractedCount: extracted.length,
  })
  if (extracted.length === 0) return 0

  const allMemories = await loadAllMemories(undefined, ['active', 'candidate'])
  let saved = 0

  for (const rawItem of extracted) {
    try {
      const item = normalizeMemoryCandidate(rawItem)
      const validation = validateMemoryCandidate(item)
      if (!validation.valid) {
        console.info('[Memory] candidate rejected', {
          triggerReason,
          reason: validation.reason,
          content: item.content,
        })
        continue
      }

      if (item.action === 'add') {
        const category = normalizeMemoryCategory(item.category)
        const itemScope = inferMemoryScope(category, options?.workspacePath)
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
            content: item.content,
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
            content: mergedContent,
            subject: item.subject || mergeable.subject || null,
            factKey: item.factKey || mergeable.factKey || null,
            factValue: equivalent
              ? item.factValue || mergeable.factValue || null
              : item.factValue || null,
            confidence: Math.max(item.confidence ?? 0.7, mergeable.confidence ?? 0.7),
            evidence,
            supersedesId: decision.supersedes?.id || mergeable.supersedesId,
            embedding: contentChanged ? null : mergeable.embedding,
            embeddingModel: contentChanged ? null : mergeable.embeddingModel,
            contentHash: contentChanged ? contentHash(mergedContent) : mergeable.contentHash,
            updatedAt: Date.now(),
          }
          if (!hasMaterialMemoryChange(mergeable, merged)) {
            console.info('[Memory] candidate skipped as unchanged', {
              triggerReason,
              content: item.content,
            })
            continue
          }
          await persistMemory(merged)
          replaceMemorySnapshot(allMemories, merged)
          saved += 1
          continue
        }

        if (decision.action === 'replace') {
          const sameFact = decision.target
          const replacement: Memory = {
            id: `mem-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
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
            evidence,
            supersedesId: sameFact.id,
            contentHash: contentHash(item.content),
            createdAt: Date.now(),
            updatedAt: Date.now(),
          }
          await persistMemory(replacement)
          allMemories.push(replacement)
          saved += 1
          continue
        }

        if (allMemories.length >= MAX_MEMORIES) {
          await removeOldestAutoMemories(10)
          const refreshed = await loadAllMemories(undefined, ['active', 'candidate'])
          allMemories.length = 0
          allMemories.push(...refreshed)
        }

        const memory: Memory = {
          id: `mem-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          content: item.content,
          category,
          source: 'auto_extracted',
          locked: false,
          status: 'candidate',
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
        await persistMemory(memory)
        allMemories.push(memory)
        saved += 1
        continue
      }

      if (item.action === 'update' && item.id) {
        const existing = allMemories.find((memory) => memory.id === item.id)
        if (existing && existing.source === 'auto_extracted' && existing.status === 'candidate' && !existing.locked) {
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
          await persistMemory(updated)
          replaceMemorySnapshot(allMemories, updated)
          saved += 1
        }
        continue
      }

      if (item.action === 'delete' && item.id) {
        const existing = allMemories.find((memory) => memory.id === item.id)
        if (existing && existing.source === 'auto_extracted' && existing.status === 'candidate' && !existing.locked) {
          await removeMemory(item.id)
          saved += 1
        }
      }
    } catch (err) {
      console.warn('[Memory] candidate persistence failed:', err)
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
  const allMemories = await loadAllMemories(undefined, ['active', 'candidate'])
  const similar = findSimilarMemory(normalizedContent, normalizedCategory, allMemories, 0.68)
  const now = Date.now()
  const scope = inferMemoryScope(normalizedCategory, options?.workspacePath)

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
    await persistMemory(memory)
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
  await persistMemory(memory)
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
  const allowedCategories = options.categories ? new Set(options.categories) : null
  const allMemories = filterInjectableMemories(
    await loadAllMemories(undefined, ['active'])
  ).filter((memory) => isMemoryVisibleInScope(
    memory,
    options.scopeType === 'project' ? options.scopeKey : null
  ) && (!allowedCategories || allowedCategories.has(memory.category)))
  if (allMemories.length === 0) return []

  const mode = options.mode || 'light'
  const requestedScopeKey = normalizeMemoryScopeKey(options.scopeType || 'global', options.scopeKey)
  const topK = options.topK ?? (mode === 'strong' ? STRONG_MEMORY_TOP_K : LIGHT_MEMORY_TOP_K)
  const threshold = options.threshold ?? (mode === 'strong' ? STRONG_MEMORY_THRESHOLD : LIGHT_MEMORY_THRESHOLD)
  let queryEmbedding: number[] | null = null

  if (options.embedding) {
    try {
      queryEmbedding = await options.embedding(query, options.signal)
    } catch (err) {
      console.warn('[Memory] query embedding failed, falling back to lexical similarity:', err)
    }
  }

  const lexicalScored = allMemories.map((memory) => ({
    memory,
    similarity: Math.min(1, lexicalMemorySimilarity(query, memory.content) + (
      [memory.subject, memory.factKey, memory.factValue].some((value) => value && query.includes(value)) ? 0.2 : 0
    )),
  }))
  const lexicalMatches = sortMemoryScores(lexicalScored.filter((item) => item.similarity > 0), requestedScopeKey)
  const candidates = options.embedding
    ? (
      lexicalMatches.length > 0
        ? lexicalMatches
        : (mode === 'strong' ? sortMemoryScores([...lexicalScored], requestedScopeKey) : [])
    ).slice(0, mode === 'strong' ? STRONG_EMBEDDING_CANDIDATE_LIMIT : LIGHT_EMBEDDING_CANDIDATE_LIMIT)
    : lexicalScored

  // 使用batchEmbedding批量获取embedding，减少HTTP请求
  if (queryEmbedding && options.batchEmbedding && candidates.length > 0) {
    try {
      const uncached = candidates.filter(({ memory }) => !hasReusableEmbedding(memory, options.embeddingModel))
      if (uncached.length > 0) {
        const generated = await options.batchEmbedding(uncached.map(({ memory }) => memory.content), options.signal)
        await Promise.all(uncached.map(({ memory }, index) => {
          memory.embedding = generated[index]
          memory.embeddingModel = options.embeddingModel || null
          memory.contentHash = contentHash(memory.content)
          return persistMemory(memory)
        }))
      }

      const scored: Array<{ memory: Memory; similarity: number }> = []
      for (let i = 0; i < candidates.length; i++) {
        const similarity = cosineSimilarity(queryEmbedding, candidates[i].memory.embedding || [])
        if (similarity >= threshold && (!legacyTopKOnly || similarity > 0)) {
          scored.push({ memory: candidates[i].memory, similarity })
        }
      }

      return sortMemoryScores(scored, requestedScopeKey)
        .slice(0, topK)
        .map((item) => item.memory)
    } catch (err) {
      console.warn('[Memory] batch embedding failed, falling back to single embedding:', err)
    }
  }

  // 降级：逐条调用embedding
  const scored: Array<{ memory: Memory; similarity: number }> = []
  for (const candidate of candidates) {
    let similarity = candidate.similarity
    if (queryEmbedding && options.embedding) {
      try {
        const memoryEmbedding = hasReusableEmbedding(candidate.memory, options.embeddingModel)
          ? candidate.memory.embedding as number[]
          : await options.embedding(candidate.memory.content, options.signal)
        if (!hasReusableEmbedding(candidate.memory, options.embeddingModel)) {
          candidate.memory.embedding = memoryEmbedding
          candidate.memory.embeddingModel = options.embeddingModel || null
          candidate.memory.contentHash = contentHash(candidate.memory.content)
          await persistMemory(candidate.memory)
        }
        similarity = cosineSimilarity(queryEmbedding, memoryEmbedding)
      } catch (err) {
        console.warn('[Memory] memory embedding failed, using lexical similarity:', err)
      }
    }

    if (similarity >= threshold && (!legacyTopKOnly || similarity > 0)) {
      scored.push({ memory: candidate.memory, similarity })
    }
  }

  return sortMemoryScores(scored, requestedScopeKey)
    .slice(0, topK)
    .map((item) => item.memory)
}

export function buildMemoryContext(memories: Memory[]): string {
  if (memories.length === 0) return ''

  const parts = memories.map((memory, index) => {
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
    return [
      `[记忆 ${index + 1}]`,
      `分类：${categoryLabel}`,
      `作用域：${memory.scopeType === 'project' ? '当前项目' : '全局'}`,
      ...(memory.subject && memory.factKey ? [`事实：${memory.subject}.${memory.factKey} = ${memory.factValue || memory.content}`] : []),
      ...((memory.evidence && memory.evidence !== memory.content) ? [`依据：${memory.evidence}`] : []),
      `内容：${memory.content}`,
    ].join('\n')
  })

  return `【长期记忆】\n${parts.join('\n\n')}`
}
