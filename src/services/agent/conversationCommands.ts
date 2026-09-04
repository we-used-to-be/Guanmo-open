import {
  deleteChatSession,
  loadRecentChatTurns,
  persistChatMessage,
  persistChatSession,
} from '@/services/database/persistence'

export interface ConversationSessionInput {
  id: string
  title: string
}

export interface ConversationMessageInput {
  id: string
  sessionId: string
  parentId?: string
  role: string
  content: string
  metadata?: string
  createdAt?: number
}

export type LoadedConversationMessageRow = Awaited<ReturnType<typeof loadRecentChatTurns>>[number]

/**
 * Conversation persistence command.
 *
 * The store owns in-memory message state and normalization; this command owns
 * the existing SQLite write/read/delete sequence without changing its format.
 */
export async function persistConversationSession(
  session: ConversationSessionInput,
  messages: readonly ConversationMessageInput[],
): Promise<void> {
  await persistChatSession(session)
  for (const message of messages) {
    await persistChatMessage(message)
  }
}

export function loadRecentConversationTurns(offset: number, limit: number) {
  return loadRecentChatTurns(offset, limit)
}

export function deleteConversationSession(sessionId: string): Promise<void> {
  return deleteChatSession(sessionId)
}
