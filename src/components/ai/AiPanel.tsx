import { memo, useState, useRef, useEffect, useCallback, useMemo, type PointerEventHandler } from 'react'
import { useAppStore } from '@/stores/appStore'
import { useChatStore } from '@/stores/chatStore'
import type { RagSource, RagStatus, TimelineItem, PendingEdit } from '@/stores/chatStore'
import { useAiChat } from '@/hooks/useAiChat'
import { Button, Icon } from 'animal-island-ui'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { PromptComposer } from '@/components/ai/PromptComposer'
import type { ManualCapability } from '@/components/ai/ManualToolToggle'
import { authorizeSelectedPath, readFile } from '@/hooks/useTauri'
import { useEditorStore } from '@/stores/editorStore'
import { deleteChatSession } from '@/services/database/persistence'
import { isSameFilePath } from '@/services/pathIdentity'
import { toast } from '@/services/toast'
import type { ChatMessageSource } from '@/services/ai/types'
import { AI_SHORTCUT_SUBMIT_EVENT } from '@/services/aiContext'

type AiPanelProps = {
  fullscreenDragHandleProps?: {
    onPointerDown: PointerEventHandler<HTMLDivElement>
    onPointerMove: PointerEventHandler<HTMLDivElement>
    onPointerUp: PointerEventHandler<HTMLDivElement>
    onPointerCancel: PointerEventHandler<HTMLDivElement>
  }
}

const STREAM_START_FOLLOW_PX = 180
const STREAM_GROWTH_FOLLOW_PX = 120
const STREAM_BOTTOM_GAP_PX = 96

export function AiPanel({ fullscreenDragHandleProps }: AiPanelProps = {}) {
  const toggleAiPanel = useAppStore((s) => s.toggleAiPanel)
  const { messages, streaming, error, ragStatus, ragSources, timeline, sendMessage, cancelStream } = useAiChat()
  const setDraftInput = useChatStore((s) => s.setDraftInput)
  const clearMessages = useChatStore((s) => s.clearMessages)
  const hasMoreHistory = useChatStore((s) => s.hasMoreHistory)
  const loadMoreHistory = useChatStore((s) => s.loadMoreHistory)
  const [loadingHistory, setLoadingHistory] = useState(false)
  const chatContainerRef = useRef<HTMLDivElement>(null)
  const autoFollowRef = useRef(true)
  const scrollFrameRef = useRef<number | null>(null)
  const streamingMessageIdRef = useRef<string | null>(null)
  const streamingStartScrollTopRef = useRef(0)
  const programmaticScrollUntilRef = useRef(0)
  const streamingRef = useRef(streaming)
  const streamScrollInterruptedRef = useRef(false)
  const pendingOutgoingMessageCountRef = useRef<number | null>(null)
  const visibleMessages = useMemo(() => messages.filter((msg) => !msg.hidden), [messages])
  const [manualCapabilities, setManualCapabilities] = useState<ManualCapability[]>([])
  const [resetManualToggle, setResetManualToggle] = useState(0)

  // 检测是否在底部（距离底部 50px 以内视为底部）
  const isAtBottom = useCallback(() => {
    const el = chatContainerRef.current
    if (!el) return true
    return el.scrollHeight - el.scrollTop - el.clientHeight < 50
  }, [])

  useEffect(() => {
    streamingRef.current = streaming
    if (!streaming) {
      streamScrollInterruptedRef.current = false
    }
  }, [streaming])

  // 监听用户手动滚动：滚到底部恢复跟随，滚离底部关闭跟随
  useEffect(() => {
    const el = chatContainerRef.current
    if (!el) return
    const stopStreamingFollow = () => {
      if (!streamingRef.current) return
      autoFollowRef.current = false
      streamScrollInterruptedRef.current = true
      if (scrollFrameRef.current !== null) {
        cancelAnimationFrame(scrollFrameRef.current)
        scrollFrameRef.current = null
      }
    }
    const handleScroll = () => {
      if (streamingRef.current && streamScrollInterruptedRef.current) return
      if (Date.now() < programmaticScrollUntilRef.current) return
      autoFollowRef.current = isAtBottom()
    }
    el.addEventListener('wheel', stopStreamingFollow, { passive: true })
    el.addEventListener('touchstart', stopStreamingFollow, { passive: true })
    el.addEventListener('pointerdown', stopStreamingFollow, { passive: true })
    el.addEventListener('scroll', handleScroll, { passive: true })
    return () => {
      el.removeEventListener('wheel', stopStreamingFollow)
      el.removeEventListener('touchstart', stopStreamingFollow)
      el.removeEventListener('pointerdown', stopStreamingFollow)
      el.removeEventListener('scroll', handleScroll)
    }
  }, [isAtBottom])

  // 合并同一帧内的滚动，避免长文本流式更新时反复触发布局。
  useEffect(() => {
    if (streaming && streamScrollInterruptedRef.current) return
    if (!autoFollowRef.current) return
    const container = chatContainerRef.current
    if (!container) return
    if (streaming && pendingOutgoingMessageCountRef.current !== null) {
      if (visibleMessages.length <= pendingOutgoingMessageCountRef.current) return
      pendingOutgoingMessageCountRef.current = null
      streamingMessageIdRef.current = null
    }
    const lastMessage = visibleMessages[visibleMessages.length - 1]
    const lastMessageKey = lastMessage
      ? lastMessage.id || `${lastMessage.role}-${lastMessage.sessionId || 'live'}-${lastMessage.timestamp || visibleMessages.length - 1}`
      : null
    const isAssistantStreaming = Boolean(streaming && lastMessage?.role === 'assistant' && lastMessageKey)

    if (scrollFrameRef.current !== null) cancelAnimationFrame(scrollFrameRef.current)
    scrollFrameRef.current = requestAnimationFrame(() => {
      scrollFrameRef.current = null
      if (isAssistantStreaming && lastMessageKey) {
        const streamingEl = container.querySelector<HTMLElement>('[data-chat-streaming="true"]')
        if (!streamingEl) return

        const isNewStreamingMessage = streamingMessageIdRef.current !== lastMessageKey
        if (isNewStreamingMessage) {
          streamingMessageIdRef.current = lastMessageKey
          streamingStartScrollTopRef.current = container.scrollTop
        }

        const containerRect = container.getBoundingClientRect()
        const messageRect = streamingEl.getBoundingClientRect()
        const desiredTop = container.scrollTop + messageRect.top - containerRect.top - 12
        const followLimit = streamingStartScrollTopRef.current + STREAM_START_FOLLOW_PX + (isNewStreamingMessage ? 0 : STREAM_GROWTH_FOLLOW_PX)
        const bottomGap = container.scrollHeight - container.scrollTop - container.clientHeight
        const growthTarget = bottomGap > STREAM_BOTTOM_GAP_PX
          ? container.scrollTop + Math.min(bottomGap - STREAM_BOTTOM_GAP_PX, STREAM_GROWTH_FOLLOW_PX)
          : container.scrollTop
        const nextTop = Math.min(Math.max(desiredTop, growthTarget), followLimit)

        programmaticScrollUntilRef.current = Date.now() + 120
        container.scrollTo({ top: nextTop })
        return
      }

      streamingMessageIdRef.current = null
      programmaticScrollUntilRef.current = Date.now() + 120
      container.scrollTo({ top: container.scrollHeight })
    })
    return () => {
      if (scrollFrameRef.current !== null) {
        cancelAnimationFrame(scrollFrameRef.current)
        scrollFrameRef.current = null
      }
    }
  }, [visibleMessages, streaming])

  const handleSend = useCallback(() => {
    const chatState = useChatStore.getState()
    const currentDraft = chatState.draftInput
    const currentContextTags = chatState.contextTags
    if ((!currentDraft.trim() && currentContextTags.length === 0) || chatState.streaming) return
    autoFollowRef.current = true
    streamScrollInterruptedRef.current = false
    pendingOutgoingMessageCountRef.current = chatState.messages.filter((msg) => !msg.hidden).length
    streamingMessageIdRef.current = null
    streamingStartScrollTopRef.current = 0
    sendMessage(currentDraft, undefined, currentContextTags.length > 0 ? currentContextTags : undefined, manualCapabilities)
    setDraftInput('')
    chatState.clearContextTags()
    // 重置手动工具开关
    setManualCapabilities([])
    setResetManualToggle((prev) => prev + 1)
  }, [manualCapabilities, sendMessage, setDraftInput])

  useEffect(() => {
    window.addEventListener(AI_SHORTCUT_SUBMIT_EVENT, handleSend)
    return () => window.removeEventListener(AI_SHORTCUT_SUBMIT_EVENT, handleSend)
  }, [handleSend])

  const handleRetry = () => {
    // Find the last user message and resend it
    for (let i = visibleMessages.length - 1; i >= 0; i--) {
      if (visibleMessages[i].role === 'user') {
        // Remove the last assistant message (the failed one)
        useChatStore.getState().removeLastMessage()
        useChatStore.getState().setError(null)
        sendMessage(visibleMessages[i].content)
        return
      }
    }
  }

  const handleLoadHistory = async () => {
    setLoadingHistory(true)
    try {
      await loadMoreHistory()
    } finally {
      setLoadingHistory(false)
    }
  }

  const handleOpenRagSource = useCallback(async (source: Pick<RagSource, 'filePath' | 'startLine' | 'endLine'>) => {
    try {
      const editorState = useEditorStore.getState()
      const existing = editorState.tabs.find((tab) => isSameFilePath(tab.filePath, source.filePath))
      let tabId = existing?.id
      if (!tabId) {
        await authorizeSelectedPath(source.filePath)
        const content = await readFile(source.filePath)
        const name = source.filePath.split(/[/\\]/).pop() || source.filePath
        editorState.addTab(source.filePath, name, content)
        tabId = useEditorStore.getState().activeTabId || undefined
      } else {
        editorState.setActiveTab(tabId)
      }
      if (!tabId) return
      editorState.setViewMode('edit')
      editorState.requestReveal(tabId, source.startLine, source.endLine)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '打开来源失败')
    }
  }, [])

  const handleDeleteSession = useCallback(async (sessionId: string) => {
    const confirmed = window.confirm('确认删除这组历史会话吗？删除后不可恢复。')
    if (!confirmed) return
    try {
      await deleteChatSession(sessionId)
      useChatStore.setState((state) => ({
        messages: state.messages.filter((message) => message.sessionId !== sessionId),
      }))
      toast.success('历史会话已删除')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '删除历史会话失败')
    }
  }, [])

  return (
    <div className="gm-instant-color h-full min-h-0 flex flex-col relative">
      {/* Header */}
      <div
        className={`flex items-center border-b border-gm-border-subtle bg-gm-surface relative z-10 ${
          fullscreenDragHandleProps ? 'h-9 cursor-grab touch-none px-3 active:cursor-grabbing' : 'h-11 px-4'
        }`}
        aria-label={fullscreenDragHandleProps ? '拖动 AI 助手' : undefined}
        {...fullscreenDragHandleProps}
      >
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 rounded-lg flex items-center justify-center">
            <Icon name="icon-chat" size={18} bounce={streaming} className="gm-ai-chat-icon" />
          </div>
          <span className="text-body font-bold text-gm-text">
            AI 助手
          </span>
          {streaming && (
            <span className="text-caption text-gm-primary animate-pulse">生成中...</span>
          )}
        </div>
        <div className="flex-1" />
        <div className="flex items-center" onPointerDown={(e) => e.stopPropagation()}>
          {messages.length > 0 && (
            <Button
              type="text"
              size="small"
              onClick={clearMessages}
              title="清空对话"
              icon={
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
                </svg>
              }
            />
          )}
          <Button
            type="text"
            size="small"
            onClick={toggleAiPanel}
            title="关闭面板"
            icon={
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            }
          />
        </div>
      </div>

      <AgentTimeline timeline={timeline} />
      <RagTrace status={ragStatus} sources={ragSources} onOpenSource={handleOpenRagSource} />

      {/* Chat Content - 可以滚动到控制栏下面 */}
      <div ref={chatContainerRef} className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden min-w-0 pb-32 bg-gm-surface">
        {visibleMessages.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full p-6 animate-fadeIn">
            {hasMoreHistory && (
              <button
                onClick={handleLoadHistory}
                disabled={loadingHistory}
                className="mb-4 px-4 py-1.5 rounded-full border border-gm-border text-caption text-gm-text-secondary hover:text-gm-text hover:bg-gm-surface-hover disabled:opacity-50"
              >
                {loadingHistory ? '加载中...' : '加载历史记录'}
              </button>
            )}
            <div className="w-16 h-16 rounded-2xl flex items-center justify-center mb-4">
              <Icon name="icon-chat" size={38} />
            </div>
            <p className="text-body font-bold text-gm-text mb-1">开始对话</p>
            <p className="text-caption text-gm-text-secondary text-center leading-relaxed">
              选择文档中的文字，或直接提问
            </p>
          </div>
        ) : (
          <div className="p-4 space-y-4">
            {hasMoreHistory && (
              <div className="flex justify-center">
                <button
                  onClick={handleLoadHistory}
                  disabled={loadingHistory}
                  className="px-4 py-1.5 rounded-full border border-gm-border text-caption text-gm-text-secondary hover:text-gm-text hover:bg-gm-surface-hover disabled:opacity-50"
                >
                  {loadingHistory ? '加载中...' : '加载更早的记录'}
                </button>
              </div>
            )}
            {visibleMessages.map((msg, i) => {
              const prevMsg = i > 0 ? visibleMessages[i - 1] : null
              const messageKey = msg.id || `${msg.role}-${msg.sessionId || 'live'}-${msg.timestamp || i}`
              // 历史会话之间的分隔线
              const showSessionDivider = Boolean(msg.sessionId && msg.sessionId !== prevMsg?.sessionId)
              // 历史消息 → 当前消息的分隔线
              const showHistoryBoundary = !msg.sessionId && prevMsg?.sessionId
              return (
              <div
                key={messageKey}
                data-chat-message-id={messageKey}
                data-chat-streaming={msg.role === 'assistant' && i === visibleMessages.length - 1 && streaming ? 'true' : undefined}
              >
                {showSessionDivider && (
                  <SessionDivider title={msg.sessionTitle} timestamp={msg.timestamp} sessionId={msg.sessionId} onDelete={handleDeleteSession} />
                )}
                {showHistoryBoundary && (
                  <SessionDivider title="以上为历史对话" />
                )}
                <ChatBubble
                  role={msg.role}
                  content={msg.displayContent ?? msg.content}
                  isLast={i === visibleMessages.length - 1}
                  streaming={streaming}
                  sources={msg.sources}
                  onOpenSource={handleOpenRagSource}
                />
                {msg.role === 'assistant' && msg.editConfirmation && (
                  <div className="mt-2">
                    <PendingEditCard
                      edit={msg.editConfirmation}
                      actionable={msg.editConfirmation.status === 'pending'}
                    />
                  </div>
                )}
                {msg.tags && msg.tags.length > 0 && (
                  <div className={`flex flex-wrap gap-1 mt-1 ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                    {msg.tags.map((tag, j) => (
                      <span key={`${tag.type}-${tag.filePath ?? tag.folderPath ?? tag.title}-${j}`} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-gm-surface-elevated border border-gm-border text-micro text-gm-text-tertiary">
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          {tag.type === 'file'
                            ? <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
                            : <path d="M4 7V4h16v3M9 20h6M12 4v16" />}
                        </svg>
                        {tag.title}
                      </span>
                    ))}
                  </div>
                )}
              </div>
              )
            })}
            {error && (
              <div className="flex items-start gap-2 animate-slideInUp">
                <div className="flex-1 px-3 py-2 rounded-xl bg-gm-error/10 border border-gm-error/20 text-caption text-gm-error">
                  {error}
                </div>
                <button
                  onClick={handleRetry}
                  className="flex-shrink-0 px-2 py-1 rounded-lg text-micro text-gm-text-secondary hover:text-gm-text hover:bg-gm-surface-hover border border-gm-border"
                  title="重试"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M1 4v6h6" />
                    <path d="M3.51 15a9 9 0 102.13-9.36L1 10" />
                  </svg>
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Prompt Composer */}
      <PromptComposer
        onSend={handleSend}
        streaming={streaming}
        onCancel={cancelStream}
        onManualCapabilitiesChange={setManualCapabilities}
        resetManualToggle={resetManualToggle}
      />
    </div>
  )
}

function RagTrace({ status, sources, onOpenSource }: { status: RagStatus; sources: RagSource[]; onOpenSource: (source: RagSource) => void }) {
  if (status === 'idle') return null

  const statusText = {
    searching: '正在检索本地知识库',
    found: `已命中 ${sources.length} 个本地片段`,
    empty: '本地资料不足，将直接回答',
    error: '本地知识库检索失败，已降级回答',
  }[status]

  return (
    <div className="border-b border-gm-border-subtle px-4 py-2 bg-gm-surface-elevated/50">
      <div className="flex items-center gap-2 text-micro text-gm-text-secondary">
        <span className={`w-1.5 h-1.5 rounded-full ${
          status === 'found' ? 'bg-gm-success' :
          status === 'error' ? 'bg-gm-error' :
          status === 'searching' ? 'bg-gm-primary animate-pulse' :
          'bg-gm-text-tertiary'
        }`} />
        <span>{statusText}</span>
      </div>
      {sources.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {sources.map((source, index) => (
            <button
              key={`${source.filePath}-${source.startLine}-${index}`}
              type="button"
              onClick={() => onOpenSource(source)}
              className="max-w-full truncate rounded-md border border-gm-border bg-gm-surface px-2 py-0.5 text-micro text-gm-text-tertiary hover:border-gm-primary/40 hover:text-gm-primary"
              title={`打开原文 ${source.filePath}:${source.startLine}-${source.endLine}（已按授权范围检索）`}
            >
              {index + 1}. {source.title}:{source.startLine}-{source.endLine} · scope
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function AgentTimeline({ timeline }: { timeline: TimelineItem[] }) {
  if (timeline.length === 0) return null

  const [collapsed, setCollapsed] = useState(true)
  const latest = timeline[timeline.length - 1]

  const tone = {
    local_search_start: 'bg-gm-primary',
    local_search_found: 'bg-gm-success',
    local_search_empty: 'bg-gm-text-tertiary',
    web_search_start: 'bg-[#f5c31c]',
    web_search_done: 'bg-[#6fba2c]',
    answer_streaming: 'bg-gm-primary',
    done: 'bg-gm-success',
    error: 'bg-gm-error',
  } satisfies Record<TimelineItem['type'], string>

  return (
    <div className="border-b border-gm-border-subtle bg-gm-surface px-4 py-2">
      <button
        onClick={() => setCollapsed(!collapsed)}
        className="w-full flex items-center gap-2 text-micro font-bold text-gm-text-tertiary"
      >
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={`flex-shrink-0 transition-transform ${collapsed ? '' : 'rotate-90'}`}>
          <path d="M9 18l6-6-6-6" />
        </svg>
        <span>Agent 状态链路</span>
        {collapsed && (
          <span className={`ml-auto flex-shrink-0 h-2 w-2 rounded-full ${tone[latest.type]} ${latest.type === 'answer_streaming' ? 'animate-pulse' : ''}`} />
        )}
      </button>
      {collapsed ? (
        <div className="mt-1 grid grid-cols-[10px_minmax(0,1fr)] gap-2 text-micro pl-0.5">
          <span className={`mt-1.5 h-2 w-2 rounded-full ${tone[latest.type]} ${latest.type === 'answer_streaming' ? 'animate-pulse' : ''}`} />
          <div className="min-w-0">
            <span className="font-bold text-gm-text-secondary">{latest.label}</span>
            {latest.detail && (
              <div className="mt-0.5 truncate text-gm-text-tertiary" title={latest.detail}>
                {latest.detail}
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="mt-2 space-y-2">
          {timeline.map((item) => (
            <div key={item.id} className="grid grid-cols-[10px_minmax(0,1fr)] gap-2 text-micro">
              <span className={`mt-1.5 h-2 w-2 rounded-full ${tone[item.type]} ${item.type === 'answer_streaming' ? 'animate-pulse' : ''}`} />
              <div className="min-w-0">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-bold text-gm-text-secondary">{item.label}</span>
                  <span className="text-gm-text-disabled">{new Date(item.timestamp).toLocaleTimeString()}</span>
                </div>
                {item.detail && (
                  <div className="mt-0.5 truncate text-gm-text-tertiary" title={item.detail}>
                    {item.detail}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

const ChatBubble = memo(function ChatBubble({
  role,
  content,
  isLast,
  streaming,
  sources,
  onOpenSource,
}: {
  role: 'system' | 'user' | 'assistant'
  content: string
  isLast: boolean
  streaming: boolean
  sources?: ChatMessageSource[]
  onOpenSource?: (source: ChatMessageSource) => void
}) {
  const isUser = role === 'user'
  const isEmpty = !content && isLast && streaming
  const isAssistantStreaming = !isUser && isLast && streaming

  return (
    <div className={`flex min-w-0 ${isUser ? 'justify-end' : 'justify-start'} animate-slideInUp`}>
      {!isUser && (
        <div className="w-8 h-8 rounded-xl bg-gm-primary-subtle flex items-center justify-center mr-2 flex-shrink-0 mt-1">
          <Icon name="icon-chat" size={20} bounce={isEmpty} className="gm-ai-chat-icon" />
        </div>
      )}
      <div
        className={`max-w-[80%] min-w-0 rounded-2xl px-4 py-2.5 text-body ${
          isUser
            ? 'rounded-br-md'
            : 'bg-gm-surface-elevated text-gm-text border border-gm-border rounded-bl-md'
        } ${isAssistantStreaming ? 'gm-streaming-bubble' : ''}`}
        style={isUser ? { backgroundColor: 'var(--gm-user-bubble-bg)', color: 'var(--gm-user-bubble-text)' } : undefined}
      >
        {isEmpty ? (
          <div className="gm-typing-loader" aria-label="正在生成">
            <span style={{ animationDelay: '0ms' }} />
            <span style={{ animationDelay: '140ms' }} />
            <span style={{ animationDelay: '280ms' }} />
          </div>
        ) : isUser || (isLast && streaming) ? (
          <div className={`whitespace-pre-wrap overflow-wrap-anywhere ${isAssistantStreaming ? 'gm-streaming-text' : ''}`} style={{ wordBreak: 'normal' }}>
            <span>{content}</span>
            {isAssistantStreaming && <span className="gm-streaming-caret" aria-hidden="true" />}
          </div>
        ) : (
          <AssistantMarkdown content={content} />
        )}
        {!isUser && sources && sources.length > 0 && onOpenSource && (
          <MessageSources sources={sources} onOpenSource={onOpenSource} />
        )}
      </div>
    </div>
  )
})

function MessageSources({ sources, onOpenSource }: { sources: ChatMessageSource[]; onOpenSource: (source: ChatMessageSource) => void }) {
  const [expanded, setExpanded] = useState(false)

  return (
    <div className="mt-3 border-t border-gm-border-subtle pt-2">
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        className="flex w-full items-center gap-1.5 text-left text-micro font-bold text-gm-text-tertiary hover:text-gm-primary"
      >
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={`flex-shrink-0 transition-transform ${expanded ? 'rotate-90' : ''}`}>
          <path d="M9 18l6-6-6-6" />
        </svg>
        <span>参考来源 {sources.length} 个</span>
      </button>
      {expanded && (
        <div className="mt-2 space-y-1">
          {sources.map((source, index) => (
            <button
              key={`${source.filePath}-${source.startLine}-${source.endLine}-${index}`}
              type="button"
              onClick={() => onOpenSource(source)}
              className="block w-full rounded-lg px-2 py-1 text-left text-micro leading-relaxed text-gm-text-secondary hover:bg-gm-surface hover:text-gm-primary"
              title={`打开 ${source.filePath}:${source.startLine}-${source.endLine}`}
            >
              <span className="font-bold">{source.fileName}</span>
              {formatSourceHeading(source) && (
                <span> · {formatSourceHeading(source)}</span>
              )}
              <span> · 第 {source.startLine}-{source.endLine} 行</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function formatSourceHeading(source: ChatMessageSource): string {
  if (source.titlePath?.length) return source.titlePath.join(' / ')
  return source.heading || ''
}

const ASSISTANT_MARKDOWN_REMARK_PLUGINS = [remarkGfm]

const ASSISTANT_MARKDOWN_COMPONENTS: Components = {
  p: ({ children }) => <p className="my-1.5 leading-relaxed">{children}</p>,
  strong: ({ children }) => <strong className="font-bold">{children}</strong>,
  em: ({ children }) => <em className="italic">{children}</em>,
  code: ({ children, className }) => {
    const isBlock = className?.includes('language-')
    if (isBlock) {
      return (
        <div className="my-2 rounded-xl bg-gm-canvas border border-gm-border overflow-hidden max-w-full">
          {className && (
            <div className="px-3 py-1 border-b border-gm-border text-micro text-gm-text-secondary font-mono">
              {className.replace('language-', '')}
            </div>
          )}
          <pre className="p-3 m-0 max-w-full overflow-x-auto">
            <code className="text-[12px] font-mono leading-5 whitespace-pre-wrap">{children}</code>
          </pre>
        </div>
      )
    }
    return (
      <code className="px-1.5 py-0.5 rounded bg-gm-canvas text-gm-accent text-[12px] font-mono whitespace-pre-wrap">
        {children}
      </code>
    )
  },
  blockquote: ({ children }) => (
    <blockquote className="pl-3 border-l-3 border-gm-primary my-2 text-gm-text-secondary italic">
      {children}
    </blockquote>
  ),
  ul: ({ children }) => <ul className="my-1.5 pl-4 space-y-0.5 list-disc">{children}</ul>,
  ol: ({ children }) => <ol className="my-1.5 pl-4 space-y-0.5 list-decimal">{children}</ol>,
  li: ({ children }) => <li className="leading-relaxed">{children}</li>,
  a: ({ href, children }) => (
    <a href={href} className="text-gm-primary hover:underline" target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ),
  hr: () => <hr className="my-3 border-gm-border" />,
  table: ({ children }) => (
    <div className="my-2 overflow-x-auto rounded-lg border border-gm-border">
      <table className="w-full border-collapse text-caption">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="px-2 py-1 text-left font-bold border-b border-gm-border">{children}</th>
  ),
  td: ({ children }) => (
    <td className="px-2 py-1 border-b border-gm-border-subtle">{children}</td>
  ),
  del: ({ children }) => <del className="text-gm-text-tertiary">{children}</del>,
}

const AssistantMarkdown = memo(function AssistantMarkdown({ content }: { content: string }) {
  return (
    <div className="ai-message-content max-w-none min-w-0 overflow-wrap-anywhere [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
      <ReactMarkdown
        remarkPlugins={ASSISTANT_MARKDOWN_REMARK_PLUGINS}
        components={ASSISTANT_MARKDOWN_COMPONENTS}
      >
        {content}
      </ReactMarkdown>
    </div>
  )
})

function PendingEditCard({ edit, actionable }: { edit: PendingEdit; actionable: boolean }) {
  const applyPendingEdit = useChatStore((s) => s.applyPendingEdit)
  const rejectPendingEdit = useChatStore((s) => s.rejectPendingEdit)
  const createUndoPendingEdit = useChatStore((s) => s.createUndoPendingEdit)

  return (
    <div className="animate-slideInUp">
      <div className="rounded-xl p-3" style={{ border: '1px solid var(--gm-warning)', backgroundColor: 'color-mix(in srgb, var(--gm-warning) 8%, transparent)' }}>
        <div className="flex items-center gap-2 mb-2">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" style={{ stroke: 'var(--gm-warning)' }} strokeWidth="2">
            <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
            <line x1="12" y1="9" x2="12" y2="13" />
            <line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
          <span className="text-caption font-bold" style={{ color: 'var(--gm-warning)' }}>文件修改确认</span>
        </div>
        <p className="text-micro text-gm-text-secondary mb-2">
          AI 要求修改文件「{edit.tabTitle}」中的文本
        </p>
        {edit.changeSummary && (
          <div className="mb-2 rounded-lg border border-gm-border bg-gm-surface px-2 py-1 text-micro text-gm-text-secondary">
            {edit.changeSummary}
          </div>
        )}
        <details className="mb-2">
          <summary className="text-micro text-gm-text-tertiary cursor-pointer hover:text-gm-text-secondary">
            查看变更详情
          </summary>
          <div className="mt-1 rounded-lg bg-gm-canvas border border-gm-border p-2 text-micro font-mono max-h-[150px] overflow-auto">
            <div style={{ color: 'var(--gm-error)' }}>- {edit.oldText.slice(0, 200)}</div>
            <div style={{ color: 'var(--gm-success)' }}>+ {edit.newText.slice(0, 200)}</div>
          </div>
        </details>
        {edit.status === 'applied' ? (
          <div className="space-y-2">
            <div className="rounded-lg bg-gm-surface-elevated border border-gm-border px-3 py-1.5 text-caption text-gm-text-secondary">
              已确认应用
            </div>
            <button
              onClick={() => createUndoPendingEdit(edit.id)}
              className="w-full rounded-lg border border-gm-border px-3 py-1.5 text-caption text-gm-text-secondary hover:bg-gm-surface-hover"
            >
              生成撤销确认卡片
            </button>
          </div>
        ) : edit.status === 'rejected' ? (
          <div className="rounded-lg bg-gm-surface-elevated border border-gm-border px-3 py-1.5 text-caption text-gm-text-secondary">
            已拒绝修改
          </div>
        ) : actionable ? (
          <div className="flex gap-2">
          <button onClick={() => applyPendingEdit(edit.id)}
            className="flex-1 px-3 py-1.5 rounded-lg bg-gm-primary text-white text-caption font-bold hover:opacity-90 transition-opacity">
            确认应用
          </button>
          <button onClick={() => rejectPendingEdit(edit.id)}
            className="flex-1 px-3 py-1.5 rounded-lg border border-gm-border text-caption text-gm-text-secondary hover:bg-gm-surface-hover">
            拒绝
          </button>
          </div>
        ) : (
          <div className="rounded-lg bg-gm-surface-elevated border border-gm-border px-3 py-1.5 text-caption text-gm-text-secondary">
            待确认的历史修改
          </div>
        )}
      </div>
    </div>
  )
}

function SessionDivider({
  title,
  timestamp,
  sessionId,
  onDelete,
}: {
  title?: string
  timestamp?: number
  sessionId?: string
  onDelete?: (sessionId: string) => void
}) {
  const timeStr = timestamp
    ? new Date(timestamp).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    : ''
  return (
    <div className="flex items-center gap-3 py-2">
      <div className="flex-1 h-px bg-gm-border-subtle" />
      <div className="flex items-center gap-2 whitespace-nowrap">
        <span className="text-micro text-gm-text-disabled">
          {title || '历史对话'}{timeStr ? ` · ${timeStr}` : ''}
        </span>
        {sessionId && onDelete && (
          <button
            type="button"
            onClick={() => onDelete(sessionId)}
            className="rounded-full border border-gm-border px-2 py-0.5 text-micro text-gm-text-tertiary hover:border-gm-error/40 hover:text-gm-error"
            title="删除这组历史会话"
          >
            删除
          </button>
        )}
      </div>
      <div className="flex-1 h-px bg-gm-border-subtle" />
    </div>
  )
}
