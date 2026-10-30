import { describe, expect, it, vi } from 'vitest'
import { encodeChatMessageMetadata, sanitizeSourceReferenceIds, useChatStore } from '@/stores/chatStore'
import type { ChatMessage } from '@/services/ai/types'

const history = vi.hoisted(() => vi.fn())
vi.mock('@/services/agent/conversationCommands', async importOriginal => ({
  ...await importOriginal<typeof import('@/services/agent/conversationCommands')>(), loadRecentConversationTurns: history,
}))

describe('chat message source metadata compatibility', () => {
  it('restores memory snapshots through the persisted history decoder', async () => {
    const memory = { kind: 'memory' as const, memoryId: 'anonymous-memory', content: '偏好中文回答' }
    history.mockResolvedValue([
      { id: 'question', session_id: 'anonymous-session', role: 'user', content: '匿名问题', created_at: 1 },
      { id: 'answer', parent_id: 'question', session_id: 'anonymous-session', role: 'assistant', content: '匿名回答', created_at: 2,
        metadata: encodeChatMessageMetadata({ role: 'assistant', content: '匿名回答', sources: [memory], referencedSourceIds: ['S1'] }) },
    ])
    useChatStore.setState({ messages: [], hasMoreHistory: true, historyOffset: 0 })
    await useChatStore.getState().loadMoreHistory()
    expect(useChatStore.getState().messages.find(message => message.id === 'answer')).toMatchObject({ sources: [memory], referencedSourceIds: ['S1'] })
  })
  it('保存完整候选来源和可选已引用 ID，不覆盖来源快照', () => {
    const message: ChatMessage = {
      role: 'assistant',
      content: '匿名回答 [S2]',
      sources: [
        {
          kind: 'local',
          filePath: 'C:\\Temp\\candidate.md',
          fileName: 'candidate.md',
          startLine: 1,
          endLine: 2,
        },
        {
          kind: 'web',
          title: '匿名网页',
          url: 'https://example.com/anonymous',
        },
      ],
      referencedSourceIds: ['S2'],
    }

    expect(JSON.parse(encodeChatMessageMetadata(message)!)).toEqual({
      sources: message.sources,
      referencedSourceIds: ['S2'],
    })
  })

  it('旧 metadata 缺少引用字段且异常 ID 会安全降级', () => {
    expect(sanitizeSourceReferenceIds(undefined)).toBeUndefined()
    expect(sanitizeSourceReferenceIds(['S2', 'S2', 'S0', 'S01', 'Sx', 3])).toEqual(['S2'])
  })
})
