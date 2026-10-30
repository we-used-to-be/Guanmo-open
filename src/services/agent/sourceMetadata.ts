import type {
  ChatMessageSource,
  ReadingScope,
  ReadingSourceCoverage,
} from '@/services/ai/types'
import type { ContextTag } from '@/types/contextTag'
import type { AgentResult, AgentStep } from './types'
import { stripToolCallJson } from './toolCallParser'
import { createContextMeta } from '@/services/aiChatMessages'
import { parseSourceReferences, type SourceReferenceRegistry } from '@/services/ai/sourceReferences'

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function sourceFileName(filePath: string, fallback?: string): string {
  return filePath.split(/[/\\]/).pop() || fallback || filePath
}

export function extractKnowledgeSourcesFromSteps(steps: AgentStep[]): ChatMessageSource[] {
  const sources: ChatMessageSource[] = []
  const seen = new Set<string>()

  for (const step of steps) {
    if (step.type !== 'observation') continue
    try {
      const parsed = JSON.parse(step.content)
      if (!isPlainObject(parsed) || !Array.isArray(parsed.results)) continue

      for (const item of parsed.results) {
        if (!isPlainObject(item)) continue
        if (
          typeof item.filePath !== 'string'
          || typeof item.startLine !== 'number'
          || typeof item.endLine !== 'number'
        ) {
          continue
        }
        const key = `${item.filePath}:${item.startLine}:${item.endLine}`
        if (seen.has(key)) continue
        seen.add(key)
        sources.push({
          kind: 'local',
          filePath: item.filePath,
          fileName: sourceFileName(item.filePath, typeof item.title === 'string' ? item.title : undefined),
          titlePath: Array.isArray(item.titlePath)
            ? item.titlePath.filter((part): part is string => typeof part === 'string')
            : undefined,
          heading: typeof item.heading === 'string' ? item.heading : undefined,
          startLine: item.startLine,
          endLine: item.endLine,
        })
      }
    } catch {
      // 非知识库 observation 不携带 JSON 结果。
    }
  }

  return sources
}

export function buildAgentResultPresentation(result: AgentResult, tagCount: number) {
  const candidateSources = result.sources?.length
    ? result.sources
    : result.sourceRegistry
      ? result.sourceRegistry.entries.map((entry) => entry.source)
      : extractKnowledgeSourcesFromSteps(result.steps)
  const resolved = resolveAgentAnswerSources(result.answer, result.sourceRegistry, candidateSources)
  const sources = candidateSources
  return {
    sources,
    referencedSourceIds: resolved.referencedIds,
    contextMeta: createContextMeta({
      tagCount,
      ragSourceCount: sources.filter(source => source.kind !== 'memory').length,
      webSearchUsed: result.steps.some(
        (step) => step.type === 'action' && step.toolName === 'web_search'
      ),
    }),
    answer: stripToolCallJson(result.answer) || '已生成修改确认卡片，请在下方确认。',
  }
}

export function resolveAgentAnswerSources(
  content: string,
  registry: SourceReferenceRegistry | undefined,
  fallbackSources: ChatMessageSource[],
) {
  if (!registry) {
    return {
      content,
      referencedIds: [],
      referencedSources: [],
      hasValidReferences: false,
      sources: fallbackSources,
    }
  }

  const parsed = parseSourceReferences(content, registry)
  return {
    ...parsed,
    sources: parsed.hasValidReferences ? parsed.referencedSources : fallbackSources,
  }
}

function hasTruncatedDocumentResult(steps: AgentStep[]): boolean {
  return steps.some((step) => {
    if (step.type !== 'observation' || step.toolName !== 'read_context_file') return false
    try {
      const parsed = JSON.parse(step.content)
      return isPlainObject(parsed)
        && isPlainObject(parsed.source)
        && parsed.source.truncated === true
    } catch {
      return false
    }
  })
}

export function resolveReadingSourceCoverage(
  readingScope: ReadingScope | undefined,
  steps: AgentStep[],
  sourceCount: number,
): ReadingSourceCoverage | undefined {
  if (!readingScope) return undefined
  if (readingScope === 'selection') return sourceCount > 0 ? 'selected_range' : 'none'
  if (readingScope === 'section') return sourceCount > 0 ? 'section_chunks' : 'none'
  if (readingScope === 'workspace') return sourceCount > 0 ? 'workspace_topk' : 'none'
  if (sourceCount === 0) return 'none'
  return hasTruncatedDocumentResult(steps) ? 'document_partial' : 'document_full'
}

export function buildScopedAgentResultPresentation(
  result: AgentResult,
  tagCount: number,
  readingScope?: ReadingScope,
) {
  const presentation = buildAgentResultPresentation(result, tagCount)
  return {
    ...presentation,
    contextMeta: createContextMeta({
      ...presentation.contextMeta,
      readingScope,
      sourceCoverage: resolveReadingSourceCoverage(readingScope, result.steps, presentation.sources.filter(source => source.kind !== 'memory').length),
    }),
  }
}

export function toLocalMessageSources(sources: Array<{
  filePath: string
  fileName: string
  titlePath?: string[]
  heading?: string
  startLine: number
  endLine: number
}>): ChatMessageSource[] {
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

export function toContextTagSources(tags: ContextTag[]): ChatMessageSource[] {
  return tags.flatMap((tag): ChatMessageSource[] => {
    if (
      tag.type !== 'selection'
      || typeof tag.filePath !== 'string'
      || typeof tag.startLine !== 'number'
      || typeof tag.endLine !== 'number'
    ) {
      return []
    }
    return [{
      kind: 'local',
      filePath: tag.filePath,
      fileName: sourceFileName(tag.filePath, tag.title),
      startLine: tag.startLine,
      endLine: tag.endLine,
    }]
  })
}
