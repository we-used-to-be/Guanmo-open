import { describe, expect, it, vi } from 'vitest'
import type { ContextTag } from '@/types/contextTag'
import { prepareConversationContext, prepareConversationRouting } from '@/services/agent/conversationRequest'

const selectionTag: ContextTag = {
  type: 'selection',
  title: '当前选区',
  filePath: 'D:/Anonymous/note.md',
  content: '需要解释的上下文',
  selectionFrom: 10,
  selectionTo: 20,
}

describe('conversation request preparation', () => {
  it('builds tagged context and preserves user message metadata', async () => {
    const readFile = vi.fn(async () => 'unused')
    const prepared = await prepareConversationContext({
      content: '请解释',
      contextTags: [selectionTag],
      readFile,
    })

    expect(readFile).not.toHaveBeenCalled()
    expect(prepared.tagContext).toContain('需要解释的上下文')
    expect(prepared.tagMetadata).toEqual([
      expect.objectContaining({
        type: 'selection',
        title: '当前选区',
        filePath: 'D:/Anonymous/note.md',
        selectionFrom: 10,
        selectionTo: 20,
      }),
    ])
    expect(prepared.userMessage).toEqual(expect.objectContaining({
      role: 'user',
      content: expect.stringContaining('请解释'),
      displayContent: '请解释',
    }))
  })

  it('delegates file context reads and keeps no-tag requests side-effect free', async () => {
    const readFile = vi.fn(async () => '文件内容')
    const prepared = await prepareConversationContext({
      content: '总结文件',
      contextTags: [{ type: 'file', title: '文档', filePath: 'D:/Anonymous/note.md' }],
      readFile,
    })
    expect(readFile).toHaveBeenCalledWith('D:/Anonymous/note.md')
    expect(prepared.tagContext).toContain('文件内容')

    const noTags = await prepareConversationContext({ content: '你好', readFile })
    expect(noTags.tagContext).toBe('')
    expect(noTags.tagMetadata).toEqual([])
  })

  it('passes app context and route options through the unified route boundary', () => {
    const routing = prepareConversationRouting({
      content: '你好',
      contextTags: [selectionTag],
      forceAgent: false,
      manualCapabilities: [],
      agentTaskContext: null,
      hasRecentEditContext: false,
      messages: [],
    })

    expect(routing.mode).toBe('direct')
    expect(routing.selectionRequestKind).toBe('none')
    expect(routing.reasonCodes).toContain('no_candidates')
  })
})
