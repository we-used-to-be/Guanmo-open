import { describe, expect, it } from 'vitest'
import { buildMessagesForModel, countRagSourcesInContext, prepareChatHistoryForModel } from '@/services/aiChatMessages'
import type { ChatMessage } from '@/services/ai/types'

describe('aiChatMessages natural history', () => {
  it('prepareChatHistoryForModel keeps plain messages without contextKind tags', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
    ]
    const result = prepareChatHistoryForModel(messages)
    expect(result).toEqual([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
    ])
    expect(result[0]).not.toHaveProperty('contextKind')
  })

  it('buildMessagesForModel uses a single supplemental context message', () => {
    const history: ChatMessage[] = [{ role: 'assistant', content: 'previous' }]
    const userMessage: ChatMessage = { role: 'user', content: 'question' }
    const messages = buildMessagesForModel({
      history,
      userMessage,
      supplementalContext: 'knowledge result\n\nmemory result',
    })

    const systemMessages = messages.filter((m) => m.role === 'system')
    const userMessages = messages.filter((m) => m.role === 'user')
    expect(systemMessages.length).toBeGreaterThanOrEqual(1)
    expect(userMessages.length).toBe(2)
    expect(userMessages[0].content).toContain('knowledge result')
    expect(userMessages[0].content).toContain('memory result')
    expect(userMessages[1]).toEqual({ role: 'user', content: 'question' })
  })

  it('keeps system messages stable when preferences and selection mode change', () => {
    const base = { history: [] as ChatMessage[], userMessage: { role: 'user' as const, content: 'question' } }
    const ordinary = buildMessagesForModel(base)
    const selected = buildMessagesForModel({ ...base, customPreferencePrompt: '简短回答', answerMode: 'selection_direct' })
    expect(selected.filter(message => message.role === 'system')).toEqual(ordinary.filter(message => message.role === 'system'))
    expect(selected.at(-2)?.content).toContain('简短回答')
    expect(selected.at(-2)?.content).toContain('唯一主要对象')
  })

  it('counts stable RAG references without counting repeated inline citations twice', () => {
    expect(countRagSourcesInContext('【知识库检索结果】\n[S1] 内容\n---\n[S2] 内容\n正文再次提到 [S1]')).toBe(2)
  })
})
