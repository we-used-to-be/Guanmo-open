import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  deleteChatSession: vi.fn(),
  loadRecentChatTurns: vi.fn(),
  persistChatMessage: vi.fn(),
  persistChatSession: vi.fn(),
}))

vi.mock('@/services/database/persistence', () => ({
  deleteChatSession: mocks.deleteChatSession,
  loadRecentChatTurns: mocks.loadRecentChatTurns,
  persistChatMessage: mocks.persistChatMessage,
  persistChatSession: mocks.persistChatSession,
}))

import {
  deleteConversationSession,
  loadRecentConversationTurns,
  persistConversationSession,
} from '@/services/agent/conversationCommands'

describe('conversation persistence commands', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.loadRecentChatTurns.mockResolvedValue([])
    mocks.deleteChatSession.mockResolvedValue(undefined)
    mocks.persistChatSession.mockResolvedValue(undefined)
    mocks.persistChatMessage.mockResolvedValue(undefined)
  })

  it('preserves session-before-message persistence order and payloads', async () => {
    const callOrder: string[] = []
    mocks.persistChatSession.mockImplementation(async () => { callOrder.push('session') })
    mocks.persistChatMessage.mockImplementation(async () => { callOrder.push('message') })
    const messages = [{
      id: 'assistant-1',
      sessionId: 'session-1',
      parentId: 'user-1',
      role: 'assistant',
      content: '匿名回答',
      metadata: '{"sources":[]}',
      createdAt: 2,
    }]

    await persistConversationSession({ id: 'session-1', title: '匿名问题' }, messages)

    expect(callOrder).toEqual(['session', 'message'])
    expect(mocks.persistChatSession).toHaveBeenCalledWith({ id: 'session-1', title: '匿名问题' })
    expect(mocks.persistChatMessage).toHaveBeenCalledWith(messages[0])
  })

  it('keeps history pagination and deletion behind the command boundary', async () => {
    const rows = [{ id: 'assistant-1' }]
    mocks.loadRecentChatTurns.mockResolvedValue(rows)

    await expect(loadRecentConversationTurns(5, 3)).resolves.toEqual(rows)
    await deleteConversationSession('session-1')

    expect(mocks.loadRecentChatTurns).toHaveBeenCalledWith(5, 3)
    expect(mocks.deleteChatSession).toHaveBeenCalledWith('session-1')
  })
})
