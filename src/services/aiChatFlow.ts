import type { AiProvider, ChatMessage } from '@/services/ai/types'
import { buildContext, searchRelevant } from '@/services/rag/pipeline'
import type { SearchResult } from '@/services/rag/types'
import type { ContextTag } from '@/types/contextTag'
import { resolveScopeFilePaths } from '@/services/aiScope'
import { hideLikelyToolJsonPrefix } from '@/services/agent/toolCallParser'

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
    const transform = (content: string) => filter ? hideLikelyToolJsonPrefix(content) : content
    const flusher = createStreamContentFlusher(options.onUpdate, options.isCancelled, transform)

    try {
      for await (const chunk of stream) {
        if (options.isCancelled()) break
        accumulated += chunk.content
        flusher.schedule(accumulated)
        if (chunk.done) break
      }
    } finally {
      flusher.flush()
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
