import type { ActionProposal, EditConfirmation } from '@/services/ai/types'
import { decodePendingAction } from './actionProposal'
import type { Capability } from './intentDetector'
import type { AgentToolName } from './toolSelector'
import type { AgentProgressStage, AgentResult, AgentStep, AgentTaskContext } from './types'

type PendingEditPayload = Omit<EditConfirmation, 'id' | 'messageId' | 'status'>
type PendingActionPayload = Omit<ActionProposal, 'id' | 'messageId' | 'status' | 'createdAt' | 'expiresAt' | 'updatedAt'>

export type AgentSessionEvent =
  | { type: 'thought'; step: AgentStep }
  | { type: 'action'; step: AgentStep; toolName?: string }
  | { type: 'observation'; step: AgentStep; toolName?: string; pendingEdit?: PendingEditPayload; pendingAction?: PendingActionPayload }
  | { type: 'progress'; step: AgentStep; stage: AgentProgressStage }

export interface AgentSessionState {
  steps: AgentStep[]
  pendingEdits: PendingEditPayload[]
  pendingActions: PendingActionPayload[]
}

export interface AgentContextContinuation {
  intent: Capability[]
  requiredCapabilities: Capability[]
  toolNames: AgentToolName[]
  originalRequest: string
  query: string
}

const AGENT_CONTINUATION_PATTERN = /^(?:再试(?:一次|试)?|再来一次|重试|重新(?:来|试(?:一次)?)?|继续(?:一下|吧|找|搜索)?|换(?:一个|个方法|一种方法)|刚才那个|还是不行|再找找|再搜搜|retry|continue)$/i
const RESULT_SUMMARY_LIMIT = 500

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizeContinuationQuery(query: string): string {
  return query.trim().replace(/[，。！？!?；;、\s]+$/g, '')
}

function uniqueToolNames(steps: AgentStep[], candidateToolNames: readonly AgentToolName[]): AgentToolName[] {
  const candidates = new Set<string>(candidateToolNames)
  return Array.from(new Set(
    steps
      .map((step) => step.toolName)
      .filter((name): name is AgentToolName => Boolean(name && candidates.has(name))),
  ))
}

function summarizeAgentResult(result: AgentResult): string | undefined {
  const observation = [...result.steps].reverse().find((step) => step.type === 'observation')
  const summary = observation?.content.trim() || result.answer.trim()
  return summary ? summary.slice(0, RESULT_SUMMARY_LIMIT) : undefined
}

function isFailedObservation(content: string): boolean {
  const normalized = content.trim()
  if (/^(?:错误：|工具执行(?:出错|失败|已取消)|保存被拒绝)/.test(normalized)) return true
  try {
    const parsed = JSON.parse(normalized)
    return isRecord(parsed) && ['error', 'failed'].includes(String(parsed.status))
  } catch {
    return false
  }
}

export function resolveAgentContextContinuation(
  query: string,
  context?: AgentTaskContext | null,
): AgentContextContinuation | null {
  if (!context || !AGENT_CONTINUATION_PATTERN.test(normalizeContinuationQuery(query))) {
    return null
  }

  const toolNames = context.usedToolNames.length > 0
    ? context.usedToolNames
    : context.candidateToolNames
  if (context.intent.length === 0 || toolNames.length === 0) return null

  return {
    intent: context.intent,
    requiredCapabilities: context.requiredCapabilities,
    toolNames,
    originalRequest: context.originalRequest,
    query: [
      `上一轮任务：${context.originalRequest}`,
      `本轮要求：${query.trim()}`,
    ].join('\n'),
  }
}

export function createAgentTaskContext({
  originalRequest,
  intent,
  requiredCapabilities,
  candidateToolNames,
  result,
}: {
  originalRequest: string
  intent: Capability[]
  requiredCapabilities: Capability[]
  candidateToolNames: AgentToolName[]
  result: AgentResult
}): AgentTaskContext {
  const toolObservations = result.steps.filter(
    (step) => step.type === 'observation' && Boolean(step.toolName),
  )
  const toolExecutionFailed = toolObservations.length > 0
    && toolObservations.every((step) => isFailedObservation(step.content))

  return {
    intent,
    requiredCapabilities,
    candidateToolNames,
    usedToolNames: uniqueToolNames(result.steps, candidateToolNames),
    originalRequest,
    status: result.reason === 'error' || toolExecutionFailed ? 'failed' : 'success',
    resultSummary: summarizeAgentResult(result),
  }
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function decodePendingEdit(value: unknown): PendingEditPayload | undefined {
  if (!isRecord(value) || value.__pendingEdit !== true) return undefined
  if (
    typeof value.oldText !== 'string'
    || typeof value.newText !== 'string'
    || typeof value.tabId !== 'string'
    || typeof value.tabTitle !== 'string'
  ) return undefined

  return {
    oldText: value.oldText,
    newText: value.newText,
    tabId: value.tabId,
    tabTitle: value.tabTitle,
    replaceFrom: optionalNumber(value.replaceFrom),
    replaceTo: optionalNumber(value.replaceTo),
    replaceWholeDocument: typeof value.replaceWholeDocument === 'boolean' ? value.replaceWholeDocument : undefined,
    changeSummary: typeof value.changeSummary === 'string' ? value.changeSummary : undefined,
    selectionFrom: optionalNumber(value.selectionFrom),
    selectionTo: optionalNumber(value.selectionTo),
  }
}

export function decodeAgentStepEvent(step: AgentStep): AgentSessionEvent {
  if (step.type === 'progress') {
    const stages: AgentProgressStage[] = ['rag_initializing', 'rag_ready', 'rag_searching', 'rag_fallback']
    if (!step.progressStage || !stages.includes(step.progressStage)) {
      throw new Error('Agent progress event is invalid')
    }
    return { type: 'progress', step, stage: step.progressStage }
  }
  if (step.type === 'thought') return { type: 'thought', step }
  if (step.type === 'action') return { type: 'action', step, toolName: step.toolName }
  if (step.externalMcp || step.toolName?.startsWith('mcp_')) {
    return { type: 'observation', step, toolName: step.toolName }
  }

  let pendingEdit: PendingEditPayload | undefined
  let pendingAction: PendingActionPayload | undefined
  try {
    const parsed = JSON.parse(step.content)
    pendingEdit = decodePendingEdit(parsed)
    pendingAction = decodePendingAction(parsed)
  } catch {
    pendingEdit = undefined
    pendingAction = undefined
  }
  return { type: 'observation', step, toolName: step.toolName, pendingEdit, pendingAction }
}

export function decodeKnowledgeSearchOutcome(
  event: AgentSessionEvent,
): 'found' | 'empty' | 'error' | undefined {
  if (event.type !== 'observation' || event.toolName !== 'search_knowledge') return undefined
  try {
    const parsed = JSON.parse(event.step.content)
    if (!isRecord(parsed)) return 'error'
    if (parsed.status === 'ok' && Array.isArray(parsed.results) && parsed.results.length > 0) return 'found'
    if (parsed.status === 'empty' && Array.isArray(parsed.results) && parsed.results.length === 0) return 'empty'
    return 'error'
  } catch {
    return 'error'
  }
}

export function reduceAgentSession(state: AgentSessionState, event: AgentSessionEvent): AgentSessionState {
  return {
    steps: [...state.steps, event.step],
    pendingEdits: event.type === 'observation' && event.pendingEdit
      ? [...state.pendingEdits, event.pendingEdit]
      : state.pendingEdits,
    pendingActions: event.type === 'observation' && event.pendingAction
      ? [...state.pendingActions, event.pendingAction]
      : state.pendingActions,
  }
}
