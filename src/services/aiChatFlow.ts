import type { AiProvider, ChatMessage } from '@/services/ai/types'
import { buildContext, searchRelevant } from '@/services/rag/pipeline'
import type { SearchResult } from '@/services/rag/types'
import type { ContextTag } from '@/types/contextTag'
import { resolveScopeFilePaths } from '@/services/aiScope'
import { hideLikelyToolJsonPrefix } from '@/services/agent/toolCallParser'

const STREAM_SMOOTH_MIN_CHARS = 4
const STREAM_SMOOTH_MAX_FRAMES = 40
const STREAM_SMOOTH_DELAY_MS = 8

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function emitSmoothContent(
  content: string,
  renderedLength: number,
  onUpdate: (content: string) => void,
  isCancelled: () => boolean,
  transform: (content: string) => string = (value) => value
): Promise<number> {
  if (isCancelled()) return renderedLength

  const deltaLength = content.length - renderedLength
  if (deltaLength <= STREAM_SMOOTH_MIN_CHARS * 2) {
    onUpdate(transform(content))
    return content.length
  }

  const step = Math.max(
    STREAM_SMOOTH_MIN_CHARS,
    Math.ceil(deltaLength / STREAM_SMOOTH_MAX_FRAMES)
  )

  for (let end = renderedLength + step; end < content.length; end += step) {
    if (isCancelled()) return end
    onUpdate(transform(content.slice(0, end)))
    // 使用 requestAnimationFrame 替代 setTimeout，更流畅
    await new Promise<void>((resolve) => {
      if (typeof requestAnimationFrame !== 'undefined') {
        requestAnimationFrame(() => resolve())
      } else {
        setTimeout(resolve, STREAM_SMOOTH_DELAY_MS)
      }
    })
  }

  if (!isCancelled()) onUpdate(transform(content))
  return content.length
}

export function toRagSources(results: SearchResult[]) {
  return results.map((result) => ({
    title: result.document.title || result.document.filePath,
    filePath: result.document.filePath,
    score: result.score,
    startLine: result.chunk.startLine,
    endLine: result.chunk.endLine,
  }))
}

export interface ScopedKnowledgeResult {
  status: 'found' | 'empty'
  context: string
  sources: ReturnType<typeof toRagSources>
  searchedFilePaths?: string[]
  emptyReason?: string
}

export async function searchScopedKnowledge(
  query: string,
  contextTags: ContextTag[],
  signal?: AbortSignal
): Promise<ScopedKnowledgeResult> {
  const scopeFilePaths = resolveScopeFilePaths(contextTags)
  if (scopeFilePaths.length === 0) {
    return {
      status: 'empty',
      context: '',
      sources: [],
      searchedFilePaths: [],
      emptyReason: 'ContextTag 没有引用可检索文件',
    }
  }

  const results = await searchRelevant(query, {
    topK: 3,
    similarityThreshold: 0.5,
    filePaths: scopeFilePaths,
    currentFilePath: scopeFilePaths[0],
    signal,
  })

  if (results.length === 0) {
    return {
      status: 'empty',
      context: '',
      sources: [],
      searchedFilePaths: scopeFilePaths,
    }
  }

  return {
    status: 'found',
    context: buildContext(results),
    sources: toRagSources(results),
    searchedFilePaths: scopeFilePaths,
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

export async function streamFinalAnswer(options: {
  client: AiProvider
  messages: ChatMessage[]
  streamEnabled: boolean
  onUpdate: (content: string) => void
  isCancelled: () => boolean
  filterToolJson?: boolean
  signal?: AbortSignal
  temperature?: number
}): Promise<void> {
  const filter = options.filterToolJson ?? false

  if (options.streamEnabled) {
    const stream = options.client.streamChat({
      messages: options.messages,
      signal: options.signal,
      temperature: options.temperature,
    })
    let accumulated = ''
    let renderedLength = 0
    const transform = (content: string) => filter ? hideLikelyToolJsonPrefix(content) : content

    for await (const chunk of stream) {
      if (options.isCancelled()) break
      accumulated += chunk.content
      renderedLength = await emitSmoothContent(
        accumulated,
        renderedLength,
        options.onUpdate,
        options.isCancelled,
        transform
      )
      if (chunk.done) break
    }
    return
  }

  const response = await options.client.chat({
    messages: options.messages,
    signal: options.signal,
    temperature: options.temperature,
  })
  if (!options.isCancelled()) {
    options.onUpdate(filter ? hideLikelyToolJsonPrefix(response.content) : response.content)
  }
}
