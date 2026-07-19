import type { EditConfirmation } from '@/services/ai/types'
import type { AgentStep } from './types'

type PendingEditPayload = Omit<EditConfirmation, 'id' | 'messageId' | 'status'>

export type AgentSessionEvent =
  | { type: 'thought'; step: AgentStep }
  | { type: 'action'; step: AgentStep; toolName?: string }
  | { type: 'observation'; step: AgentStep; pendingEdit?: PendingEditPayload }

export interface AgentSessionState {
  steps: AgentStep[]
  pendingEdits: PendingEditPayload[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
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
  if (step.type === 'thought') return { type: 'thought', step }
  if (step.type === 'action') return { type: 'action', step, toolName: step.toolName }

  let pendingEdit: PendingEditPayload | undefined
  try {
    pendingEdit = decodePendingEdit(JSON.parse(step.content))
  } catch {
    pendingEdit = undefined
  }
  return { type: 'observation', step, pendingEdit }
}

export function reduceAgentSession(state: AgentSessionState, event: AgentSessionEvent): AgentSessionState {
  return {
    steps: [...state.steps, event.step],
    pendingEdits: event.type === 'observation' && event.pendingEdit
      ? [...state.pendingEdits, event.pendingEdit]
      : state.pendingEdits,
  }
}
