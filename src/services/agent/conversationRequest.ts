import type { ManualCapability } from '@/components/ai/ManualToolToggle'
import { shouldIncludeFullDocumentContext } from '@/services/agent/intentDetector'
import { makeRoutingDecision } from '@/services/agent/routingService'
import type { AgentTaskContext, RoutingDecision } from '@/services/agent/types'
import type { ChatMessage } from '@/services/ai/types'
import { buildChatMessageTags, createUserChatMessage } from '@/services/aiChatMessages'
import { buildContextFromTags } from '@/services/contextBuilder'
import type { ContextTag } from '@/types/contextTag'
import { buildRoutingAppContext } from './requestBuilder'

export interface ConversationContextPreparationInput {
  content: string
  contextTags?: ContextTag[]
  readFile: (path: string) => Promise<string>
}

export interface PreparedConversationContext {
  tagContext: string
  tagMetadata: ReturnType<typeof buildChatMessageTags>
  userMessage: ChatMessage
}

export async function prepareConversationContext(
  input: ConversationContextPreparationInput,
): Promise<PreparedConversationContext> {
  const contextTags = input.contextTags || []
  const tagContext = contextTags.length > 0
    ? await buildContextFromTags({
      tags: contextTags,
      readFile: input.readFile,
      maxChars: shouldIncludeFullDocumentContext(input.content) ? 30000 : 8000,
    })
    : ''
  const tagMetadata = buildChatMessageTags(contextTags)
  const userMessage = createUserChatMessage(input.content, tagContext, tagMetadata)

  return { tagContext, tagMetadata, userMessage }
}

export interface ConversationRoutingPreparationInput {
  content: string
  contextTags?: ContextTag[]
  forceAgent?: boolean
  manualCapabilities?: ManualCapability[]
  agentTaskContext?: AgentTaskContext | null
  hasRecentEditContext: boolean
  messages: ChatMessage[]
}

export function prepareConversationRouting(
  input: ConversationRoutingPreparationInput,
): RoutingDecision {
  const contextTags = input.contextTags || []
  const appContext = buildRoutingAppContext(contextTags, input.hasRecentEditContext)

  return makeRoutingDecision(input.content.trim(), appContext, {
    forceAgent: input.forceAgent,
    manualCapabilities: input.manualCapabilities,
    agentTaskContext: input.agentTaskContext,
    hasRecentEditContext: input.hasRecentEditContext,
    contextTagCount: contextTags.length,
    messages: input.messages,
  })
}
