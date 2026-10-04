import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useChatStore } from '@/stores/chatStore'
import {
  __resetAssistantStateForTests,
  getAssistantState,
  isProgressPlaceholder,
  subscribeAssistantState,
  type AssistantState,
} from '@/services/assistantState'

const PLACEHOLDER = '正在准备 AI 请求...'

function resetChatStore() {
  useChatStore.setState({
    messages: [],
    streaming: false,
    error: null,
    ragStatus: 'idle',
    timeline: [],
    agentSteps: [],
  })
}

function seedConversation() {
  useChatStore.getState().addMessage({ id: 'user-1', role: 'user', content: '帮我总结这篇文档', timestamp: 1 })
  useChatStore.getState().addMessage({
    id: 'assistant-1',
    parentId: 'user-1',
    role: 'assistant',
    content: PLACEHOLDER,
    timestamp: 2,
  })
}

function trackEvents() {
  const events: AssistantState[] = []
  const unsubscribe = subscribeAssistantState(() => {
    events.push(getAssistantState())
  })
  return { events, unsubscribe }
}

describe('AI 助手状态派生（assistantState）', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    resetChatStore()
    __resetAssistantStateForTests()
  })

  afterEach(() => {
    __resetAssistantStateForTests()
    vi.useRealTimers()
  })

  it('初始为 idle，且无关字段更新不触发任何通知', () => {
    const { events, unsubscribe } = trackEvents()
    expect(getAssistantState()).toBe('idle')
    useChatStore.getState().setDraftInput('随手输入')
    useChatStore.getState().setRagSources([])
    expect(events).toEqual([])
    unsubscribe()
  })

  it('请求开始进入 reading', () => {
    seedConversation()
    const { events, unsubscribe } = trackEvents()
    useChatStore.getState().setStreaming(true)
    expect(getAssistantState()).toBe('reading')
    expect(events).toEqual(['reading'])
    unsubscribe()
  })

  it('RAG 检索期间保持 retrieving，结束后回落 thinking', () => {
    seedConversation()
    const { events, unsubscribe } = trackEvents()
    useChatStore.getState().setStreaming(true)
    useChatStore.getState().setRagStatus('initializing')
    expect(getAssistantState()).toBe('retrieving')
    useChatStore.getState().setRagStatus('searching')
    expect(getAssistantState()).toBe('retrieving')
    useChatStore.getState().updateMessageContent('assistant-1', '索引库已就绪，正在检索…')
    expect(getAssistantState()).toBe('retrieving')
    useChatStore.getState().setRagStatus('fallback')
    expect(getAssistantState()).toBe('retrieving')
    useChatStore.getState().setRagStatus('found')
    expect(getAssistantState()).toBe('thinking')
    expect(events).toEqual(['reading', 'retrieving', 'thinking'])
    unsubscribe()
  })

  it('联网搜索开始进入 searching，搜索完成回落 thinking', () => {
    seedConversation()
    const { events, unsubscribe } = trackEvents()
    useChatStore.getState().setStreaming(true)
    useChatStore.getState().addTimelineItem({ type: 'web_search_start', label: '执行联网搜索' })
    expect(getAssistantState()).toBe('searching')
    useChatStore.getState().addTimelineItem({ type: 'web_search_done', label: '联网搜索已完成' })
    expect(getAssistantState()).toBe('thinking')
    expect(events).toEqual(['reading', 'searching', 'thinking'])
    unsubscribe()
  })

  it('首个真实流式 Token 进入 generating，动态拼接占位文案不误判', () => {
    seedConversation()
    const { events, unsubscribe } = trackEvents()
    useChatStore.getState().setStreaming(true)
    useChatStore.getState().updateMessageContent('assistant-1', '正在判断处理方式...')
    expect(getAssistantState()).toBe('thinking')
    useChatStore.getState().updateMessageContent('assistant-1', '好的，我来帮你总结这份文档')
    expect(getAssistantState()).toBe('generating')
    useChatStore.getState().updateMessageContent('assistant-1', '本地知识库检索已完成，正在整理下一步...')
    expect(getAssistantState()).toBe('thinking')
    expect(events).toEqual(['reading', 'thinking', 'generating', 'thinking'])
    unsubscribe()
  })

  it('工具行动说明保持执行中的助手状态，最终回答开始后才进入 generating', () => {
    seedConversation()
    const { events, unsubscribe } = trackEvents()
    useChatStore.getState().setStreaming(true)
    useChatStore.getState().addAgentStep({
      type: 'action',
      content: '调用工具: web_search',
      toolName: 'web_search',
      actionMessage: '我会先搜索相关资料',
      timestamp: 3,
    })
    useChatStore.getState().updateMessageContent('assistant-1', '我会先搜索相关资料')
    expect(getAssistantState()).toBe('thinking')
    useChatStore.getState().addTimelineItem({ type: 'answer_streaming', label: '生成最终回答' })
    expect(getAssistantState()).toBe('thinking')
    useChatStore.getState().updateMessageContent('assistant-1', '搜索结果表明，文档主题是……')
    expect(getAssistantState()).toBe('generating')
    expect(events).toEqual(['reading', 'thinking', 'generating'])
    unsubscribe()
  })

  it('完成后短暂 success 展示并自动回 idle，通知仅为相位变化', () => {
    seedConversation()
    const { events, unsubscribe } = trackEvents()
    useChatStore.getState().setStreaming(true)
    useChatStore.getState().addTimelineItem({ type: 'done', label: '生成回答完成' })
    useChatStore.getState().setStreaming(false)
    expect(getAssistantState()).toBe('success')
    vi.advanceTimersByTime(1399)
    expect(getAssistantState()).toBe('success')
    vi.advanceTimersByTime(1)
    expect(getAssistantState()).toBe('idle')
    // done 写入时仍为占位内容，先派生 thinking
    expect(events).toEqual(['reading', 'thinking', 'success', 'idle'])
    unsubscribe()
  })

  it('失败进入 error 展示后恢复 idle', () => {
    seedConversation()
    const { events, unsubscribe } = trackEvents()
    useChatStore.getState().setStreaming(true)
    useChatStore.getState().setError('请求失败：网络异常')
    useChatStore.getState().addTimelineItem({ type: 'error', label: 'AI 请求失败' })
    useChatStore.getState().setStreaming(false)
    expect(getAssistantState()).toBe('error')
    vi.advanceTimersByTime(1799)
    expect(getAssistantState()).toBe('error')
    vi.advanceTimersByTime(1)
    expect(getAssistantState()).toBe('idle')
    // setError 写入时仍为占位内容，先派生 thinking
    expect(events).toEqual(['reading', 'thinking', 'error', 'idle'])
    unsubscribe()
  })

  it('用户取消直接回 idle，不闪临时状态', () => {
    seedConversation()
    const { events, unsubscribe } = trackEvents()
    useChatStore.getState().setStreaming(true)
    useChatStore.getState().addTimelineItem({ type: 'answer_streaming', label: '生成回答' })
    useChatStore.getState().setStreaming(false)
    expect(getAssistantState()).toBe('idle')
    vi.advanceTimersByTime(5000)
    expect(getAssistantState()).toBe('idle')
    expect(events).toEqual(['reading', 'thinking', 'idle'])
    unsubscribe()
  })

  it('success 窗口内发起新请求会清除旧定时器，旧状态不覆盖新请求', () => {
    seedConversation()
    const { events, unsubscribe } = trackEvents()
    useChatStore.getState().setStreaming(true)
    useChatStore.getState().addTimelineItem({ type: 'done', label: '生成回答完成' })
    useChatStore.getState().setStreaming(false)
    expect(getAssistantState()).toBe('success')

    // 上一轮 success 未到期时立刻发起下一轮请求
    useChatStore.getState().setError(null)
    useChatStore.setState({ timeline: [] })
    seedConversation()
    useChatStore.getState().setStreaming(true)
    expect(getAssistantState()).toBe('reading')
    vi.advanceTimersByTime(3000)
    expect(getAssistantState()).toBe('reading')

    useChatStore.getState().addTimelineItem({ type: 'done', label: '生成回答完成' })
    useChatStore.getState().setStreaming(false)
    expect(getAssistantState()).toBe('success')
    vi.advanceTimersByTime(1400)
    expect(getAssistantState()).toBe('idle')

    const successCount = events.filter((event) => event === 'success').length
    expect(successCount).toBe(2)
    unsubscribe()
  })

  it('后台标签页定时器被节流时，重新可见会对超时的临时态补一刀回 idle', () => {
    seedConversation()
    const { unsubscribe } = trackEvents()
    useChatStore.getState().setStreaming(true)
    useChatStore.getState().addTimelineItem({ type: 'done', label: '生成回答完成' })
    useChatStore.getState().setStreaming(false)
    expect(getAssistantState()).toBe('success')

    // 仅推进系统时间、不触发定时器，模拟后台节流
    vi.setSystemTime(Date.now() + 2000)
    document.dispatchEvent(new Event('visibilitychange'))
    expect(getAssistantState()).toBe('idle')
    unsubscribe()
  })
})

describe('进度占位文案识别（isProgressPlaceholder）', () => {
  it('识别固定与动态拼接的占位文案', () => {
    expect(isProgressPlaceholder('')).toBe(true)
    expect(isProgressPlaceholder('正在准备 AI 请求...')).toBe(true)
    expect(isProgressPlaceholder('Agent 正在规划工具链路...')).toBe(true)
    expect(isProgressPlaceholder('正在分析文档修改要求...')).toBe(true)
    expect(isProgressPlaceholder('正在确定上下文读取范围...')).toBe(true)
    expect(isProgressPlaceholder('AI 正在判断下一步处理方式...')).toBe(true)
    expect(isProgressPlaceholder('索引库初始化失败，正在使用关键词检索…')).toBe(true)
    expect(isProgressPlaceholder('正在执行工具：web_search...')).toBe(true)
    expect(isProgressPlaceholder('本地知识库检索已完成，正在整理下一步...')).toBe(true)
    expect(isProgressPlaceholder('工具结果已返回，正在整理下一步...')).toBe(true)
  })

  it('不把真实回答误判为占位文案', () => {
    expect(isProgressPlaceholder('你好，世界')).toBe(false)
    expect(isProgressPlaceholder('这份文档的核心观点是……')).toBe(false)
    expect(isProgressPlaceholder('# 标题\n正文内容')).toBe(false)
    expect(isProgressPlaceholder('正在学习 Markdown 的第一天')).toBe(false)
  })
})
