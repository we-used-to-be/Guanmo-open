import type { ChatMessage } from '@/services/ai/types'
import type { Memory } from '@/services/database/persistence'
import {
  persistMemory,
  loadAllMemories,
  removeMemory,
  updateMemoryContent,
  removeOldestAutoMemories,
} from '@/services/database/persistence'

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

interface ExtractedMemory {
  action: 'add' | 'update' | 'delete'
  id?: string
  content: string
  category: string
}

interface ExtractionOptions {
  triggerReason?: string
}

interface ValidationResult {
  valid: boolean
  reason?: string
}

type MemoryRetrievalMode = 'light' | 'strong'
export type MemoryRetrievalIntent = 'none' | 'weak' | 'strong'

export interface MemorySearchOptions {
  mode?: MemoryRetrievalMode
  topK?: number
  threshold?: number
  embedding?: (text: string, signal?: AbortSignal) => Promise<number[]>
  batchEmbedding?: (texts: string[], signal?: AbortSignal) => Promise<number[][]>
  signal?: AbortSignal
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

function lexicalSimilarity(query: string, content: string): number {
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

function sortMemoryScores<T extends { memory: Memory; similarity: number }>(items: T[]): T[] {
  return items.sort((a, b) => {
    const priorityDiff = categoryPriority(a.memory.category) - categoryPriority(b.memory.category)
    if (priorityDiff !== 0) return priorityDiff
    return b.similarity - a.similarity
  })
}

function isDuplicateMemory(newContent: string, existing: Memory[]): boolean {
  const newTerms = tokenizeMemoryText(newContent)
  if (newTerms.size === 0) return false

  for (const memory of existing) {
    const existingTerms = tokenizeMemoryText(memory.content)
    if (existingTerms.size === 0) continue

    let overlap = 0
    for (const term of newTerms) {
      if (existingTerms.has(term)) overlap += 1
    }
    const similarity = overlap / Math.max(newTerms.size, existingTerms.size)
    if (similarity > 0.7) return true
  }

  return false
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
    .map((memory) => ({ memory, similarity: lexicalSimilarity(content, memory.content) }))
    .filter((item) => item.similarity >= threshold)
    .sort((a, b) => b.similarity - a.similarity)[0]?.memory
}

function shouldAttemptMemoryCandidateExtraction(messages: ChatMessage[]): boolean {
  const recentUserText = messages
    .filter((message) => message.role === 'user' && !message.hidden)
    .slice(-3)
    .map((message) => message.displayContent || message.content)
    .join('\n')
    .trim()

  if (!recentUserText) return false

  return [
    /(?:记住|记下来|保存为长期记忆|以后记得|以后都|之后都)/,
    /(?:我喜欢|我偏好|我的习惯|我的风格|默认用|每次都|总是)/,
    /(?:称呼我|叫我|我的称呼|用中文|中文回答)/,
    /(?:项目约定|项目规则|长期项目|目录职责|工程边界|技术栈)/,
    /(?:我正在学|我开始学|我学完了|学习进度|学习路线)/,
    /(?:我的背景|我的身份|我是.+(?:工程师|学生|设计师|作者|开发者))/,
  ].some((pattern) => pattern.test(recentUserText))
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

禁止提取：
- 一次性任务、当前这轮要做的动作、短期计划
- 临时情绪、感叹、礼貌客套、随口评价
- AI 自己的总结、推断、建议或工具结果
- 文档正文、代码片段、RAG 检索结果、搜索结果
- 已有记忆的重复改写

分类规则：
- preference: 偏好、习惯、称呼、语言风格
- project: 长期项目、技术栈、目录职责、工程边界
- learning: 学习进度、学习路线、阶段变化
- profile: 稳定身份、背景信息
- instruction: 长期指令、协作规则、输出格式

请只输出 JSON 数组，每项格式：
{"action":"add","content":"记忆内容","category":"preference|project|learning|profile|instruction"}

拿不准时输出空数组 []。不要输出任何解释。${existingBlock}`
}

function validateExtractedMemoryCandidate(item: ExtractedMemory): ValidationResult {
  const content = item.content.trim()
  if (content.length < 6) {
    return { valid: false, reason: 'too_short' }
  }

  if (/^(好的|收到|明白|辛苦了|谢谢|哈哈|好的呢|行|嗯)$/.test(content)) {
    return { valid: false, reason: 'ephemeral_tone' }
  }

  if (/(这轮|本轮|今天|现在|待会|马上|稍后|先|接下来|这一版|当前任务)/.test(content)) {
    return { valid: false, reason: 'one_off_task' }
  }

  if (/(我有点|我很|我太|我今天|心情|开心|难受|生气|焦虑|困|累)/.test(content)) {
    return { valid: false, reason: 'temporary_emotion' }
  }

  if (/(```|function\s|\bconst\b|\bSELECT\b|\bINSERT\b|<[^>]+>)/i.test(content)) {
    return { valid: false, reason: 'looks_like_source_text' }
  }

  return { valid: true }
}

export async function extractMemories(
  messages: ChatMessage[],
  client: { chat: (req: { messages: ChatMessage[]; temperature?: number }) => Promise<{ content: string }> },
  temperature?: number
): Promise<ExtractedMemory[]> {
  const recentMessages = messages
    .filter((message) => message.role === 'user' && !message.hidden)
    .slice(-6)
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
  console.info('[Memory] extraction triggered', {
    triggerReason,
    visibleUserMessages: messages.filter((msg) => msg.role === 'user' && !msg.hidden).length,
    extractedCount: extracted.length,
  })
  if (extracted.length === 0) return 0

  const allMemories = await loadAllMemories(undefined, ['active', 'candidate'])
  let saved = 0

  for (const item of extracted) {
    try {
      const validation = validateExtractedMemoryCandidate(item)
      if (!validation.valid) {
        console.info('[Memory] candidate rejected', {
          triggerReason,
          reason: validation.reason,
          content: item.content,
        })
        continue
      }

      if (item.action === 'add') {
        item.category = normalizeMemoryCategory(item.category)
        const similar = findSimilarMemory(item.content, item.category, allMemories)
        if (similar && similar.source === 'auto_extracted' && similar.status === 'candidate') {
          await updateMemoryContent(similar.id, item.content.trim())
          saved += 1
          continue
        }

        if (isDuplicateMemory(item.content, allMemories)) {
          console.info('[Memory] candidate skipped as duplicate', {
            triggerReason,
            content: item.content,
          })
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
          content: item.content.trim(),
          category: item.category,
          source: 'auto_extracted',
          locked: false,
          status: 'candidate',
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
          await updateMemoryContent(item.id, item.content.trim())
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
  category: string
): Promise<ExplicitMemoryUpsertResult> {
  const normalizedContent = content.trim()
  const normalizedCategory = normalizeMemoryCategory(category)
  const allMemories = await loadAllMemories(undefined, ['active', 'candidate'])
  const similar = findSimilarMemory(normalizedContent, normalizedCategory, allMemories, 0.68)
  const now = Date.now()

  if (similar) {
    const memory: Memory = {
      ...similar,
      content: normalizedContent,
      category: normalizedCategory,
      source: 'user_explicit',
      status: 'active',
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
    createdAt: now,
    updatedAt: now,
  }
  await persistMemory(memory)
  return { memory, action: 'created' }
}

export function isStrongMemoryRetrievalQuery(query: string): boolean {
  return classifyMemoryRetrievalIntent(query) === 'strong'
}

export function classifyMemoryRetrievalIntent(query: string): MemoryRetrievalIntent {
  const normalized = query.trim().toLowerCase()
  if (!normalized) return 'none'

  const strongSignals = [
    '我的偏好',
    '我的习惯',
    '我的风格',
    '我的地址',
    '我的住址',
    '我的位置',
    '我的称呼',
    '我的记忆',
    '我的项目约定',
    '我的长期目标',
    '你记得我',
    '你还记得我',
    '还记得我',
    '查询记忆',
    '搜索记忆',
    '检索记忆',
    '查看记忆',
    '调取记忆',
    'remember me',
  ]
  if (strongSignals.some((signal) => normalized.includes(signal))) return 'strong'

  const strongPatterns = [
    /我的(?:偏好|习惯|风格|地址|住址|位置|个人信息|称呼|长期目标|项目约定)(?:是|有|在哪里|什么|哪些|吗)?/,
    /(?:查询|搜索|检索|查看|调取).*记忆/,
    /你还?记得.*我/,
  ]
  if (strongPatterns.some((pattern) => pattern.test(normalized))) return 'strong'

  const weakSignals = [
    '之前',
    '上次',
    '以前',
    '曾经',
    '按我的习惯',
    '按我的偏好',
    '按我的风格',
    '项目约定',
    '这个项目的设定',
    '项目设定',
    '按照之前讨论的',
    '之前讨论的',
    '之前告诉过你',
    '记忆',
    '城市',
  ]
  if (weakSignals.some((signal) => normalized.includes(signal))) return 'weak'

  const weakPatterns = [
    /我(?:以前|曾经|之前)(说过|提过|告诉|建议|做过)/,
    /按(?:照)?我(?:之前|以前|上次).*?(?:说的|讨论的|方案|要求)/,
    /按我的(?:偏好|习惯|风格|方式)/,
    /上次.*(?:方案|说过|提过|告诉|建议)/,
    /你还?记得.*(?:我们|项目)/,
  ]

  return weakPatterns.some((pattern) => pattern.test(normalized)) ? 'weak' : 'none'
}

export async function searchMemories(
  query: string,
  topKOrOptions: number | MemorySearchOptions = 5
): Promise<Memory[]> {
  if (!query.trim()) return []

  const allMemories = await loadAllMemories(undefined, ['active'])
  if (allMemories.length === 0) return []

  const legacyTopKOnly = typeof topKOrOptions === 'number'
  const options: MemorySearchOptions = legacyTopKOnly
    ? { topK: topKOrOptions, threshold: 0 }
    : topKOrOptions
  const mode = options.mode || 'light'
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
    similarity: lexicalSimilarity(query, memory.content),
  }))
  const lexicalMatches = sortMemoryScores(lexicalScored.filter((item) => item.similarity > 0))
  const candidates = options.embedding
    ? (
      lexicalMatches.length > 0
        ? lexicalMatches
        : (mode === 'strong' ? sortMemoryScores([...lexicalScored]) : [])
    ).slice(0, mode === 'strong' ? STRONG_EMBEDDING_CANDIDATE_LIMIT : LIGHT_EMBEDDING_CANDIDATE_LIMIT)
    : lexicalScored

  // 使用batchEmbedding批量获取embedding，减少HTTP请求
  if (queryEmbedding && options.batchEmbedding && candidates.length > 0) {
    try {
      const texts = candidates.map(c => c.memory.content)
      const embeddings = await options.batchEmbedding(texts, options.signal)

      const scored: Array<{ memory: Memory; similarity: number }> = []
      for (let i = 0; i < candidates.length; i++) {
        const similarity = cosineSimilarity(queryEmbedding, embeddings[i])
        if (similarity >= threshold && (!legacyTopKOnly || similarity > 0)) {
          scored.push({ memory: candidates[i].memory, similarity })
        }
      }

      return sortMemoryScores(scored)
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
        const memoryEmbedding = await options.embedding(candidate.memory.content, options.signal)
        similarity = cosineSimilarity(queryEmbedding, memoryEmbedding)
      } catch (err) {
        console.warn('[Memory] memory embedding failed, using lexical similarity:', err)
      }
    }

    if (similarity >= threshold && (!legacyTopKOnly || similarity > 0)) {
      scored.push({ memory: candidate.memory, similarity })
    }
  }

  return sortMemoryScores(scored)
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
      `内容：${memory.content}`,
    ].join('\n')
  })

  return `【长期记忆】\n${parts.join('\n\n')}`
}
