import type { AiProvider, ChatMessageSource, ChatResponse, ChatTool, ModelMessage } from '@/services/ai/types'
import { buildContextResult, searchRelevant } from '@/services/rag/pipeline'
import type { SearchResult } from '@/services/rag/types'
import type { ContextTag } from '@/types/contextTag'
import { resolveScopeFilePaths } from '@/services/aiScope'
import { hideLikelyToolJsonPrefix } from '@/services/agent/toolCallParser'
import type { RagSearchProgress } from '@/services/rag/nativeIndex'
import { withContextOverflowRecovery } from '@/services/ai/contextBudget'
import { createSourceReferenceRegistry, parseSourceReferences, type SourceReferenceRegistry } from '@/services/ai/sourceReferences'

function createStreamContentFlusher(
  onUpdate: (content: string) => void,
  isCancelled: () => boolean,
  transform: (content: string) => string = (value) => value
): { schedule: (content: string) => void; flush: () => void } {
  let latestContent = ''
  let committedContent = ''
  let frame: number | null = null

  const commit = () => {
    frame = null
    if (isCancelled()) return
    const nextContent = transform(latestContent)
    if (nextContent === committedContent) return
    committedContent = nextContent
    onUpdate(nextContent)
  }

  return {
    schedule(content) {
      latestContent = content
      if (frame === null) {
        frame = requestAnimationFrame(commit)
      }
    },
    flush() {
      if (frame !== null) {
        cancelAnimationFrame(frame)
        frame = null
      }
      commit()
    },
  }
}

export function toRagSources(results: SearchResult[]) {
  return results.map((result) => ({
    title: result.document.title || result.document.filePath,
    filePath: result.document.filePath,
    fileName: result.document.filePath.split(/[/\\]/).pop() || result.document.title || result.document.filePath,
    titlePath: result.chunk.titlePath,
    heading: result.chunk.heading,
    score: result.score,
    startLine: result.chunk.startLine,
    endLine: result.chunk.endLine,
  }))
}

function toLocalChatMessageSources(sources: ReturnType<typeof toRagSources>): ChatMessageSource[] {
  return sources.map((source) => ({
    kind: 'local',
    filePath: source.filePath,
    fileName: source.fileName,
    titlePath: source.titlePath,
    heading: source.heading,
    startLine: source.startLine,
    endLine: source.endLine,
  }))
}

export function resolveDirectRagSources(
  content: string,
  registry: SourceReferenceRegistry,
  fallbackSources: ChatMessageSource[],
) {
  const parsed = parseSourceReferences(content, registry)
  return {
    ...parsed,
    sources: parsed.hasValidReferences ? parsed.referencedSources : fallbackSources,
  }
}

/**
 * 从模型回答末尾解析 [有效来源] 标记块。
 * 返回有效来源序号数组（1-based）和去除标记后的内容。
 * 解析失败时 indices 为 null，strippedContent 为原始内容。
 */
const EFFECTIVE_SOURCE_REGEX = /\[有效来源\]\s*\n\s*(\[[\d,\s]*\])\s*$/m

export function parseEffectiveSourceIndices(content: string): { indices: number[] | null; strippedContent: string } {
  const match = content.match(EFFECTIVE_SOURCE_REGEX)
  if (!match?.[1]) return { indices: null, strippedContent: content }

  try {
    const parsed = JSON.parse(match[1])
    if (!Array.isArray(parsed) || !parsed.every((n: unknown) => typeof n === 'number' && Number.isInteger(n) && n > 0)) {
      return { indices: null, strippedContent: content }
    }
    const stripped = content.slice(0, match.index!).trimEnd()
    return { indices: parsed, strippedContent: stripped }
  } catch {
    return { indices: null, strippedContent: content }
  }
}

/**
 * 按有效来源序号筛选 RagSource 数组，保持模型指定的顺序。
 * @param sources 原始来源数组（1-based 索引对应数组位置）
 * @param indices 有效来源序号（1-based）
 */
export function filterRagSourcesByIndices<T>(
  sources: T[],
  indices: number[],
): T[] {
  const result: T[] = []
  const seen = new Set<number>()
  for (const idx of indices) {
    if (idx < 1 || idx > sources.length || seen.has(idx)) continue
    seen.add(idx)
    result.push(sources[idx - 1])
  }
  return result
}

export interface ScopedKnowledgeResult {
  status: 'found' | 'empty'
  context: string
  sources: ReturnType<typeof toRagSources>
  sourceRegistry: SourceReferenceRegistry
  searchedFilePaths?: string[]
  includedChunks?: Array<{ id: string; contentHash?: string | null }>
  emptyReason?: string
  coverage: ReturnType<typeof buildContextResult>['coverage']
}

export async function searchScopedKnowledge(
  query: string,
  contextTags: ContextTag[],
  signal?: AbortSignal,
  onProgress?: (progress: RagSearchProgress) => void,
  maxContextBudget?: number | { maxChars?: number; maxTokens?: number },
): Promise<ScopedKnowledgeResult> {
  const scopeFilePaths = resolveScopeFilePaths(contextTags)
  if (scopeFilePaths.length === 0) {
    return {
      status: 'empty',
      context: '',
      sources: [],
      sourceRegistry: createSourceReferenceRegistry(),
      searchedFilePaths: [],
      emptyReason: 'ContextTag 没有引用可检索文件',
      coverage: { requested: 0, included: 0, skipped: 0 },
    }
  }

  const results = await searchRelevant(query, {
    topK: 3,
    similarityThreshold: 0.5,
    filePaths: scopeFilePaths,
    currentFilePath: scopeFilePaths[0],
    signal,
    onProgress,
  })

  if (results.length === 0) {
    return {
      status: 'empty',
      context: '',
      sources: [],
      sourceRegistry: createSourceReferenceRegistry(),
      searchedFilePaths: scopeFilePaths,
      coverage: { requested: 0, included: 0, skipped: 0 },
    }
  }

  const requestedBudget = typeof maxContextBudget === 'number'
    ? maxContextBudget
    : maxContextBudget?.maxTokens ?? maxContextBudget?.maxChars
  // buildContextResult 的旧接口仍使用 UTF-16 字符；一字符一 token 是中文场景的保守换算。
  const contextResult = buildContextResult(
    results,
    requestedBudget && requestedBudget > 0 ? Math.floor(requestedBudget) : 6000,
    { referenceIds: true },
  )
  const includedResults = contextResult.includedSources.map((source) => source.result)
  const sources = toRagSources(includedResults)

  return {
    status: contextResult.text ? 'found' : 'empty',
    context: contextResult.text,
    sources,
    sourceRegistry: createSourceReferenceRegistry(toLocalChatMessageSources(sources)),
    searchedFilePaths: scopeFilePaths,
    includedChunks: includedResults.map(result => ({ id: result.chunk.id, contentHash: result.chunk.contentHash })),
    emptyReason: contextResult.text ? undefined : '检索结果均超出上下文预算',
    coverage: contextResult.coverage,
  }
}

export function shouldTriggerScopedRag(query: string, contextTags: ContextTag[]): boolean {
  const hasFileOrFolder = contextTags.some((tag) => tag.type === 'file' || tag.type === 'folder')
  if (!hasFileOrFolder) return false

  const text = query.trim()
  const patterns = [
    /根据.*(?:文件|文档|笔记|内容)/,
    /基于.*(?:文件|文档|笔记|内容)/,
    /总结.*(?:文件|文档|笔记|内容|这篇)/,
    /解释.*(?:文件|文档|笔记|内容|这篇)/,
    /分析.*(?:文件|文档|笔记|内容|这篇)/,
    /概述.*(?:文件|文档|笔记|内容|这篇)/,
    /review/i,
    /这个文件.*(?:什么|说|讲|内容)/,
    /这篇.*(?:什么|说|讲|内容)/,
    /(?:什么|说|讲|内容).*这个文件/,
    /(?:什么|说|讲|内容).*这篇/,
  ]

  return patterns.some((pattern) => pattern.test(text))
}

export interface StreamAnswerOptions {
  client: AiProvider
  messages: ModelMessage[]
  streamEnabled: boolean
  onUpdate: (content: string) => void
  isCancelled: () => boolean
  filterToolJson?: boolean
  signal?: AbortSignal
  temperature?: number
  reasoningMode?: 'off' | 'on'
  tools?: ChatTool[]
  onUsage?: (usage: NonNullable<ChatResponse['usage']>) => void
  onRequest?: () => void
}

/** Shared text streaming, native tool-call collection and one context-overflow retry. */
export async function streamChatResponse(options: StreamAnswerOptions): Promise<ChatResponse> {
  const filter = options.filterToolJson ?? false
  let hasPublishedContent = false

  const sendOnce = async (messages: ModelMessage[]): Promise<ChatResponse> => {
    options.onRequest?.()
    if (options.streamEnabled) {
      const stream = options.client.streamChat({
        messages,
        signal: options.signal,
        temperature: options.temperature,
        reasoningMode: options.reasoningMode,
        ...(options.tools?.length ? { tools: options.tools, toolChoice: 'auto' as const } : {}),
      })
      let accumulated = ''
      const calls = new Map<number, { id?: string; name: string; arguments: string }>()
      let usage: ChatResponse['usage']
      const transform = (content: string) => filter ? hideLikelyToolJsonPrefix(content) : content
      const flusher = createStreamContentFlusher((content) => {
        hasPublishedContent = hasPublishedContent || Boolean(content)
        options.onUpdate(content)
      }, () => options.isCancelled() || Boolean(options.signal?.aborted), transform)
      try {
        for await (const chunk of stream) {
          if (options.isCancelled() || options.signal?.aborted) break
          if (chunk.usage) {
            usage = chunk.usage
          }
          for (const delta of chunk.toolCallDeltas || []) {
            const call = calls.get(delta.index) || { name: '', arguments: '' }
            calls.set(delta.index, { id: delta.id || call.id, name: call.name + (delta.name || ''), arguments: call.arguments + (delta.arguments || '') })
          }
          accumulated += chunk.content
          // A tool action is provisional; do not keep its text as the final answer.
          if (!options.tools?.length || !calls.size) flusher.schedule(accumulated)
          if (chunk.done) break
        }
      } finally {
        flusher.flush()
      }
      if (usage) options.onUsage?.(usage)
      return { id: '', role: 'assistant', content: accumulated, usage,
        toolCalls: [...calls.values()].map(call => {
          let args: Record<string, unknown> = {}
          try { args = JSON.parse(call.arguments) } catch { /* validated before dispatch */ }
          return { id: call.id, name: call.name, args }
        }) }
    }

    const response = await options.client.chat({
      messages,
      signal: options.signal,
      temperature: options.temperature,
      reasoningMode: options.reasoningMode,
      ...(options.tools?.length ? { tools: options.tools, toolChoice: 'auto' as const } : {}),
    })
    if (response.usage) options.onUsage?.(response.usage)
    if (!options.isCancelled() && !options.signal?.aborted) {
      if (!options.tools?.length || !response.toolCalls?.length) options.onUpdate(filter ? hideLikelyToolJsonPrefix(response.content) : response.content)
    }
    return response
  }

  return withContextOverflowRecovery(options.messages, sendOnce, {
    isCancelled: () => options.isCancelled() || Boolean(options.signal?.aborted),
    onRetry: () => {
      if (hasPublishedContent) options.onUpdate('')
      hasPublishedContent = false
    },
  })
}

export async function streamFinalAnswer(options: StreamAnswerOptions): Promise<void> {
  await streamChatResponse(options)
}
