import type { ActionProposal, ChatMessage } from '@/services/ai/types'
import { useChatStore } from '@/stores/chatStore'
import { useReadingArtifactsStore } from '@/stores/readingArtifactsStore'
import { saveAssistantMessageAsMarkdown } from '@/services/assistantMessageExport'
import { upsertExplicitMemory } from '@/services/memory/memoryService'
import { selectPrimaryWorkspacePath, useAppStore } from '@/stores/appStore'
import type { ReadingArtifactType } from '@/services/database/readingArtifacts'
import { createReadingReminder } from '@/services/readingReminders'
import {
  READING_REMINDER_DEVELOPMENT_MESSAGE,
  READING_REMINDER_FEATURE_AVAILABLE,
} from '@/services/readingReminderFeature'

export interface ActionExecutionResult {
  status: 'completed' | 'cancelled'
}

type ActionExecutor = (proposal: ActionProposal, sourceMessage?: ChatMessage) => Promise<ActionExecutionResult>

const actionExecutors = new Map<ActionProposal['kind'], ActionExecutor>()

export function registerActionExecutor(kind: ActionProposal['kind'], executor: ActionExecutor) {
  actionExecutors.set(kind, executor)
}

function payloadString(proposal: ActionProposal, field: string): string {
  const value = proposal.payload[field]
  if (typeof value !== 'string' || !value.trim()) throw new Error(`行动字段 ${field} 已失效`)
  return value
}

registerActionExecutor('save_memory', async (proposal) => {
  await upsertExplicitMemory(
    payloadString(proposal, 'content'),
    payloadString(proposal, 'category'),
    { workspacePath: selectPrimaryWorkspacePath(useAppStore.getState()) },
  )
  return { status: 'completed' }
})

registerActionExecutor('save_reading_artifact', async (proposal, sourceMessage) => {
  await useReadingArtifactsStore.getState().saveArtifactFromMessage({
    type: payloadString(proposal, 'artifactType') as ReadingArtifactType,
    title: payloadString(proposal, 'title'),
    content: payloadString(proposal, 'content'),
    sources: sourceMessage?.sources,
    contextScope: sourceMessage?.contextMeta?.readingScope,
    messageId: sourceMessage?.id,
  })
  return { status: 'completed' }
})

registerActionExecutor('create_markdown_note', async (proposal, sourceMessage) => {
  const title = payloadString(proposal, 'title')
  const content = `# ${title}\n\n${payloadString(proposal, 'content')}`
  const result = await saveAssistantMessageAsMarkdown(content, sourceMessage?.sources)
  return { status: result.saved ? 'completed' : 'cancelled' }
})

registerActionExecutor('create_reading_reminder', async (proposal) => {
  if (!READING_REMINDER_FEATURE_AVAILABLE) throw new Error(READING_REMINDER_DEVELOPMENT_MESSAGE)
  const dueAtUtc = Date.parse(payloadString(proposal, 'dueAt'))
  if (!Number.isFinite(dueAtUtc) || dueAtUtc <= Date.now()) {
    throw new Error('提醒时间已失效')
  }
  await createReadingReminder({
    id: `reminder-${proposal.id}`,
    title: payloadString(proposal, 'title'),
    description: typeof proposal.payload.description === 'string'
      ? proposal.payload.description
      : null,
    dueAtUtc,
    createdTimezone: payloadString(proposal, 'timezone'),
    sourceMessageId: typeof proposal.payload.sourceMessageId === 'string'
      ? proposal.payload.sourceMessageId
      : proposal.messageId ?? null,
  })
  return { status: 'completed' }
})

function findSourceMessage(proposal: ActionProposal): ChatMessage | undefined {
  const sourceMessageId = proposal.payload.sourceMessageId
  if (sourceMessageId === undefined) return undefined
  if (typeof sourceMessageId !== 'string') throw new Error('来源消息字段已失效')
  const message = useChatStore.getState().messages.find((item) => item.id === sourceMessageId)
  if (!message || message.role !== 'assistant') throw new Error('来源消息已变化')
  return message
}

export async function executeActionProposalCommand(proposal: ActionProposal): Promise<ActionExecutionResult> {
  if (proposal.version !== 1) throw new Error('行动提案版本不受支持')
  if (proposal.status !== 'executing') throw new Error('行动提案不在可执行状态')
  if (Date.now() > proposal.expiresAt) throw new Error('行动提案已过期')
  const executor = actionExecutors.get(proposal.kind)
  if (!executor) throw new Error('行动执行器尚未注册')
  return executor(proposal, findSourceMessage(proposal))
}

export async function confirmActionProposalCommand(id: string): Promise<void> {
  let executing: ActionProposal | undefined
  const proposal = useChatStore.getState().messages.find((item) => item.actionProposal?.id === id)?.actionProposal
  if (proposal?.status === 'pending') {
    const now = Date.now()
    executing = {
      ...proposal,
      status: now > proposal.expiresAt ? 'expired' : 'executing',
      updatedAt: now,
      ...(now > proposal.expiresAt ? { errorCategory: 'expired' as const } : {}),
    }
    useChatStore.getState().updateMessageActionProposal(proposal.messageId, executing)
  }
  if (!executing || executing.status !== 'executing') {
    await useChatStore.getState().saveCurrentSession().catch(() => undefined)
    return
  }
  try {
    const result = await executeActionProposalCommand(executing)
    const completed: ActionProposal = {
      ...executing,
      status: result.status === 'completed' ? 'completed' : 'rejected',
      updatedAt: Date.now(),
      ...(result.status === 'cancelled' ? { errorCategory: 'cancelled' as const } : {}),
    }
    useChatStore.getState().updateMessageActionProposal(completed.messageId, completed)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const errorCategory: ActionProposal['errorCategory'] = /来源消息已变化/.test(message)
      ? 'target_changed'
      : /尚未注册|功能开发中/.test(message)
        ? 'unsupported'
        : 'execution_failed'
    const failed: ActionProposal = {
      ...executing,
      status: 'failed',
      updatedAt: Date.now(),
      errorCategory,
    }
    useChatStore.getState().updateMessageActionProposal(failed.messageId, failed, `行动未执行：${message}`)
  }
  await useChatStore.getState().saveCurrentSession().catch((error) => {
    console.warn('[Chat] save action confirmation failed:', error)
  })
}

export function rejectActionProposalCommand(id: string): void {
  const proposal = useChatStore.getState().messages.find((item) => item.actionProposal?.id === id)?.actionProposal
  if (proposal?.status === 'pending') {
    const rejected: ActionProposal = { ...proposal, status: 'rejected', updatedAt: Date.now() }
    useChatStore.getState().updateMessageActionProposal(rejected.messageId, rejected)
  }
  void useChatStore.getState().saveCurrentSession().catch((error) => {
    console.warn('[Chat] save action rejection failed:', error)
  })
}
