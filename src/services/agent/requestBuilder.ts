import type { ChatMessage } from '@/services/ai/types'
import type { ContextTag } from '@/types/contextTag'
import type { AgentEditTarget } from '@/services/aiScope'
import { prepareChatHistoryForModel } from '@/services/aiChatMessages'
import { annotateMemoryContext, createSourceReferenceRegistry } from '@/services/ai/sourceReferences'
import type { AppContext } from './intentDetector'
import type { AgentRunRequest, AgentStep, RoutingDecision } from './types'

export function buildRoutingAppContext(
  contextTags: ContextTag[] = [],
  hasRecentEditContext: boolean,
): AppContext {
  return {
    hasRecentEdit: hasRecentEditContext,
    hasOpenFile: contextTags.some((tag) => tag.type === 'file'),
    hasSelection: contextTags.some((tag) => tag.type === 'selection'),
    hasContextTags: contextTags.length > 0,
  }
}

export function buildEditTargets(tags: ContextTag[] = []): AgentEditTarget[] {
  return tags
    .filter((tag) =>
      (tag.type === 'selection' || tag.type === 'file')
      && typeof tag.filePath === 'string'
      && tag.filePath.trim().length > 0
    )
    .map((tag, index) => ({
      id: `edit-target-${index + 1}`,
      type: tag.type as 'selection' | 'file',
      title: tag.title,
      filePath: tag.filePath as string,
      selectionFrom: tag.selectionFrom,
      selectionTo: tag.selectionTo,
    }))
}

export function buildEditTargetsContext(editTargets: AgentEditTarget[]): string {
  if (editTargets.length === 0) {
    return [
      '【本轮可编辑目标】',
      '无。本轮没有新的 selection 或 file 标签；如用户要求修改文本，只能提示重新添加目标标签。',
    ].join('\n')
  }

  return [
    '【本轮可编辑目标】',
    '以下 targetId 由系统根据本轮新增标签生成，是本轮唯一可用于文本修改确认卡的写授权。需要修改时调用 replace_current_tab_text，并优先传 targetId。',
    ...editTargets.map((target) => [
      `- targetId: ${target.id}`,
      `  type: ${target.type}`,
      `  path: ${target.filePath}`,
      `  title: ${target.title}`,
      typeof target.selectionFrom === 'number' && typeof target.selectionTo === 'number'
        ? `  selectionRange: ${target.selectionFrom}-${target.selectionTo}`
        : '',
    ].filter(Boolean).join('\n')),
  ].join('\n')
}

export function buildAgentRunRequest(options: {
  content: string
  messages: ChatMessage[]
  modelHistory?: ChatMessage[]
  contextTags?: ContextTag[]
  tagContext: string
  memoryContext: string
  routingDecision: RoutingDecision
  hasRecentEditContext: boolean
  hasPrefetchedMemoryLookup: boolean
  prefetchedMemory?: AgentRunRequest['prefetchedMemory']
  signal: AbortSignal
  temperature: number
  onStep: (step: AgentStep) => void
  onStreamContent?: (content: string) => void
  customPreferencePrompt?: string
  streamEnabled: boolean
}): {
  request: AgentRunRequest
  editTargets: AgentEditTarget[]
  originalRequest: string
} {
  const content = options.content.trim()
  const contextTags = options.contextTags || []
  const editTargets = buildEditTargets(contextTags)
  const currentEditTargetCount = contextTags.filter(
    (tag) => tag.type === 'selection' || tag.type === 'file'
  ).length
  const editTargetsContext = buildEditTargetsContext(editTargets)
  const memorySources = options.prefetchedMemory?.sources || []
  const memoryContext = annotateMemoryContext(options.memoryContext, memorySources, createSourceReferenceRegistry(memorySources))
  const untrustedContexts = [options.tagContext, editTargetsContext, memoryContext].filter(Boolean)
  const untrustedContext = untrustedContexts.join('\n\n')
  const currentUserIntent = options.routingDecision.explicitMemoryWriteIntent
    ? `记住：${content}`
    : content
  const normalizedUserIntent = options.routingDecision.inheritedQuery || currentUserIntent
  const query = options.routingDecision.inheritedQuery || content || '请根据我提供的上下文继续。'
  const originalRequest = options.routingDecision.inheritedOriginalRequest || content

  return {
    editTargets,
    originalRequest,
    request: {
      query,
      chatHistory: options.modelHistory || prepareChatHistoryForModel(options.messages),
      rawQuery: normalizedUserIntent,
      hasRecentEditContext: options.hasRecentEditContext,
      hasCurrentEditTarget: currentEditTargetCount > 0,
      currentEditTargetCount,
      candidateToolNames: options.routingDecision.candidateTools,
      hasPrefetchedMemoryLookup: options.hasPrefetchedMemoryLookup,
      prefetchedMemory: options.prefetchedMemory,
      signal: options.signal,
      temperature: options.temperature,
      onStep: options.onStep,
      onStreamContent: options.onStreamContent,
      requiredCapabilities: options.routingDecision.required,
      untrustedContext,
      customPreferencePrompt: options.customPreferencePrompt,
      streamEnabled: options.streamEnabled,
      routingDecision: options.routingDecision,
    },
  }
}
