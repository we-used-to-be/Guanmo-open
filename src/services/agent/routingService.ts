/**
 * 统一路由决策服务。
 *
 * 职责：
 * 1. 一次调用生成完整的 RoutingDecision，消除 useAiChat 与 executor 的重复判断。
 * 2. 收紧弱信号阈值，单一弱关键词不能独立决定进入 Agent 模式。
 * 3. 记录路由原因码，用于测试和匿名诊断。
 */

import type { ChatMessage } from '@/services/ai/types'
import type { ManualCapability } from '@/components/ai/ManualToolToggle'
import type { AgentTaskContext } from './types'
import type { RoutingDecision, RoutingReasonCode } from './types'
import {
  detectIntentScores,
  classifySelectionRequest,
  shouldAllowMemoryWrite,
  isImplicitEditContinuation,
  isLocalResearchIntent,
  isWebComparisonIntent,
  isFileSummaryIntent,
  isSectionReadingIntent,
  isDocumentRewriteIntent,
  isReminderCreationIntent,
  type Capability,
  type AppContext,
} from './intentDetector'
import { buildCandidateTools } from './toolSelector'
import type { AgentToolName } from './toolSelector'
import { resolveAgentContextContinuation } from './session'
import { classifyMemoryRetrievalIntent, isPersonalizedRewriteMemoryIntent } from '@/services/memory/memoryService'
import {
  LOCAL_RESEARCH_ANSWER_PROMPT,
  WEB_COMPARISON_ANSWER_PROMPT,
  FILE_SUMMARY_ANSWER_PROMPT,
  SECTION_READING_ANSWER_PROMPT,
} from './answerInstructions'

/**
 * 判断是否应该进入 Agent 模式（收紧弱信号）。
 *
 * 规则：
 * - 无候选能力 → direct
 * - 有强信号（strong keyword / regex / classifier / context）→ agent
 * - 手动覆盖 → agent
 * - 短指令续接 → agent
 * - 多个不同能力的弱信号（≥2 个不同 capability）→ agent
 * - 单一弱关键词 → direct（这是收紧的核心）
 */
function computeAgentMode(
  candidates: Capability[],
  required: Capability[],
  hasManualOverride: boolean,
  hasContinuation: boolean,
  hasStrongSignal: boolean,
  hasCancelEdit: boolean,
  hasWeakCombo: boolean,
): { mode: 'direct' | 'agent'; reasonCodes: RoutingReasonCode[] } {
  const reasonCodes: RoutingReasonCode[] = []

  if (hasCancelEdit) {
    reasonCodes.push('cancel_last_edit')
    return { mode: 'agent', reasonCodes }
  }

  if (hasManualOverride) {
    reasonCodes.push('manual_override')
    return { mode: 'agent', reasonCodes }
  }

  if (hasContinuation) {
    reasonCodes.push('continuation')
    return { mode: 'agent', reasonCodes }
  }

  if (candidates.length === 0) {
    reasonCodes.push('no_candidates')
    return { mode: 'direct', reasonCodes }
  }

  // 有强依赖能力（score >= 4）→ agent
  if (required.length > 0) {
    reasonCodes.push('strong_signal')
    return { mode: 'agent', reasonCodes }
  }

  if (hasStrongSignal) {
    reasonCodes.push('strong_signal')
    return { mode: 'agent', reasonCodes }
  }

  // 多个不同弱关键词（≥2 个不同的弱关键词）→ agent
  if (hasWeakCombo) {
    reasonCodes.push('weak_combo')
    return { mode: 'agent', reasonCodes }
  }

  // 单一弱关键词 → direct
  reasonCodes.push('no_candidates')
  return { mode: 'direct', reasonCodes }
}

function isCancelLastAppliedEdit(content: string, history: ChatMessage[]): boolean {
  const text = content.trim()
  if (!/^(算了|不改了|还是不改了|别改了|不用改了|先不改了|先别改了)/.test(text)) {
    return false
  }
  return history.some((msg) =>
    msg.content.includes('用户确认并应用了对文件') &&
    msg.content.includes('原文：') &&
    msg.content.includes('新文本：')
  )
}

/**
 * 生成统一路由决策。
 *
 * @param query 用户查询文本
 * @param appContext 应用上下文
 * @param options 附加选项
 * @returns 统一路由决策对象
 */
export function makeRoutingDecision(
  query: string,
  appContext: AppContext,
  options: {
    forceAgent?: boolean
    manualCapabilities?: ManualCapability[]
    agentTaskContext?: AgentTaskContext | null
    hasRecentEditContext?: boolean
    contextTagCount?: number
    messages?: ChatMessage[]
  } = {},
): RoutingDecision {
  const {
    forceAgent = false,
    manualCapabilities = [],
    agentTaskContext = null,
    hasRecentEditContext = false,
    contextTagCount = 0,
    messages = [],
  } = options

  const content = query.trim()

  // 意图检测
  const intentResult = detectIntentScores(content, appContext)
  const inheritedAgentContext = resolveAgentContextContinuation(content, agentTaskContext)
  const selectionRequestKind = classifySelectionRequest(content, appContext)

  // 分类器
  const isDocRewrite = isDocumentRewriteIntent(content)
  const isWebComp = isWebComparisonIntent(content)
  const isLocalRes = !isWebComp && isLocalResearchIntent(content)
  const isFileSum = !isWebComp && isFileSummaryIntent(content, appContext)
  const isSectionReading = isSectionReadingIntent(content, appContext)

  // 答案指令
  let answerInstruction: string | undefined
  if (isSectionReading) {
    answerInstruction = SECTION_READING_ANSWER_PROMPT
  } else if (isWebComp) {
    answerInstruction = WEB_COMPARISON_ANSWER_PROMPT
  } else if (isFileSum) {
    answerInstruction = FILE_SUMMARY_ANSWER_PROMPT
  } else if (isLocalRes) {
    answerInstruction = LOCAL_RESEARCH_ANSWER_PROMPT
  }

  // 记忆相关
  const memoryIntent = classifyMemoryRetrievalIntent(content)
  const personalizedRewriteMemory = isPersonalizedRewriteMemoryIntent(content)
  const shouldLookupMemory = memoryIntent !== 'none' || personalizedRewriteMemory
  const explicitMemoryWriteIntent = shouldAllowMemoryWrite(content)

  // 知识库检索
  const shouldLookupKnowledge = intentResult.candidates.includes('knowledge')
  // 合并手动选择的 capabilities
  const manualCapabilitiesSet = new Set(manualCapabilities)
  let mergedCandidates = Array.from(new Set([
    ...manualCapabilitiesSet,
    ...(inheritedAgentContext?.intent || []),
    ...intentResult.candidates,
  ]))
  let mergedRequired = Array.from(new Set([
    ...manualCapabilitiesSet,
    ...(inheritedAgentContext?.requiredCapabilities || []),
    ...intentResult.required,
  ]))
  if (isSectionReading) {
    mergedCandidates = mergedCandidates.filter((capability) => capability !== 'knowledge' && capability !== 'file_read')
    mergedRequired = mergedRequired.filter((capability) => capability !== 'knowledge' && capability !== 'file_read')
  }
  const scopedShouldLookupKnowledge = shouldLookupKnowledge && !isSectionReading
  const readingScope = isSectionReading
    ? 'section'
    : appContext.hasSelection
      ? 'selection'
      : isFileSum
        ? 'document'
        : (isLocalRes || isWebComp) && scopedShouldLookupKnowledge
          ? 'workspace'
          : undefined

  // 构建候选工具
  let candidateTools = inheritedAgentContext
    ? [...inheritedAgentContext.toolNames]
    : buildCandidateTools(mergedCandidates)

  // 工具列表调整
  if (contextTagCount > 0 && candidateTools.includes('replace_current_tab_text')) {
    candidateTools.unshift('list_current_edit_targets')
  }
  if (candidateTools.includes('read_selection_context')) {
    candidateTools = [
      'read_selection_context',
      ...candidateTools.filter((name) => name !== 'read_selection_context'),
    ]
  }
  if (explicitMemoryWriteIntent && !candidateTools.includes('save_memory')) {
    candidateTools.push('save_memory', 'list_memories')
  }
  if (
    isReminderCreationIntent(content)
    && candidateTools.includes('propose_create_reading_reminder')
    && !candidateTools.includes('get_current_time')
  ) {
    candidateTools.unshift('get_current_time')
  }
  candidateTools = Array.from(new Set(candidateTools))

  // 编辑确认
  const hasCurrentEditTarget = Boolean(
    appContext.hasSelection || appContext.hasOpenFile
  )
  const requiresEditConfirmation = hasCurrentEditTarget && (
    intentResult.candidates.includes('file_write')
    || (hasRecentEditContext && isImplicitEditContinuation(content))
  )

  // 计算是否进入 Agent 模式
  const hasCancelEdit = isCancelLastAppliedEdit(content, messages)
  const hasManualOverride = forceAgent || manualCapabilities.length > 0
  const hasContinuation = Boolean(inheritedAgentContext)

  // 单一弱词（不含空格）不应被 regex 视为强信号
  const isSingleWeakWord = !content.includes(' ')
  const hasStrongSignal = intentResult.scores.some((s) =>
    s.signals.some(
      (sig) => {
        if (sig.startsWith('strong:') || sig.startsWith('classifier:') || sig.startsWith('context:')) {
          return true
        }
        // regex 信号：单一弱词不视为强信号
        if (sig.startsWith('regex:') && !isSingleWeakWord) {
          return true
        }
        return false
      },
    ),
  )

  // 统计不同弱关键词数量（同一词触发多个 capability 只算一个）
  const weakKeywords = new Set<string>()
  for (const s of intentResult.scores) {
    if (s.score > 0 && !s.isRequired) {
      for (const sig of s.signals) {
        if (sig.startsWith('weak:')) {
          weakKeywords.add(sig.slice(5))
        }
      }
    }
  }
  const hasWeakCombo = weakKeywords.size >= 2

  const { mode, reasonCodes } = computeAgentMode(
    mergedCandidates,
    mergedRequired,
    hasManualOverride,
    hasContinuation,
    hasStrongSignal,
    hasCancelEdit,
    hasWeakCombo,
  )

  // 显式记忆写入添加到原因码
  if (explicitMemoryWriteIntent) {
    reasonCodes.push('explicit_memory_write')
  }

  return {
    ruleScores: intentResult.scores,
    selectionSource: 'rules',
    mode,
    reasonCodes,
    candidates: mergedCandidates,
    required: mergedRequired,
    candidateTools: candidateTools as AgentToolName[],
    selectionRequestKind,
    requiresEditConfirmation,
    shouldLookupMemory,
    memoryIntent,
    shouldLookupKnowledge: scopedShouldLookupKnowledge,
    isDocumentRewrite: isDocRewrite,
    isWebComparison: isWebComp,
    isLocalResearch: isLocalRes,
    isFileSummary: isFileSum,
    readingScope,
    answerInstruction,
    explicitMemoryWriteIntent,
    inheritedQuery: inheritedAgentContext?.query,
    inheritedOriginalRequest: inheritedAgentContext?.originalRequest,
    inheritedToolNames: inheritedAgentContext?.toolNames,
  }
}
