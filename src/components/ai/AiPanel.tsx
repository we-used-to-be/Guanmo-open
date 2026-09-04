import { memo, useState, useRef, useEffect, useCallback, useMemo, type PointerEventHandler } from 'react'
import { useAppStore } from '@/stores/appStore'
import { useChatStore } from '@/stores/chatStore'
import { useSettingsStore } from '@/stores/settingsStore'
import type { RagSource, TimelineItem, PendingEdit } from '@/stores/chatStore'
import { useAiChat } from '@/hooks/useAiChat'
import { Button } from 'animal-island-ui'
import { BookOpen } from 'lucide-react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { AssistantVisual } from '@/components/ai/AssistantVisual'
import { PromptComposer } from '@/components/ai/PromptComposer'
import { readRememberedMarkdownFileForOpen } from '@/services/markdownFileOpenPolicy'
import { describeFileOperationError } from '@/services/fileOperationErrors'
import { useEditorStore } from '@/stores/editorStore'
import { deleteConversationSession } from '@/services/agent/conversationCommands'
import { isSameFilePath } from '@/services/pathIdentity'
import { toast } from '@/services/toast'
import type {
  ChatMessageContextMeta,
  ChatMessage,
  ChatMessageSource,
  LocalChatMessageSource,
  ActionProposal,
} from '@/services/ai/types'
import { resolveStoredSourceReferences, type SourceReferenceId } from '@/services/ai/sourceReferences'
import { AI_SHORTCUT_SUBMIT_EVENT } from '@/services/aiContext'
import {
  consumePendingPanelNavigation,
  OPEN_AI_CHAT_EVENT,
  OPEN_READING_ARTIFACTS_EVENT,
  TOGGLE_AI_CHAT_EVENT,
  TOGGLE_READING_ARTIFACTS_EVENT,
} from '@/services/aiPanelNavigation'
import { applyPendingEditCommand } from '@/services/pendingEditCommand'
import { saveAssistantMessageAsMarkdown } from '@/services/assistantMessageExport'
import { ReadingArtifactCenter } from '@/components/reading-artifacts/ReadingArtifactCenter'
import type { ReadingArtifactDocumentRef } from '@/services/readingArtifactCenter'
import { useReadingArtifactsStore, type ReadingArtifactFilter } from '@/stores/readingArtifactsStore'
import {
  type ReadingArtifact,
  type ReadingArtifactReference,
  type ReadingArtifactType,
  type SourceAnchorStatus,
  type AnnotationStructuredContent,
  getAnnotationStructuredContent,
  getReadingArtifactQuestion,
  getReadingArtifactReferences,
  resolveAnnotationPosition,
} from '@/services/agent/artifactCommands'
import {
  cancelReadingReminder,
  deleteReadingReminder,
  editReadingReminderTime,
  loadReadingRemindersCommand,
  retryReadingReminder,
  type ReadingReminder,
} from '@/services/readingReminders'
import {
  READING_REMINDER_DEVELOPMENT_MESSAGE,
  READING_REMINDER_FEATURE_AVAILABLE,
} from '@/services/readingReminderFeature'
import { getRuntimeCapabilities } from '@/services/runtimeCapabilities'

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
const SAVE_CONTROLS_HIDE_DELAY_MS = 700

export function buildUserQuestionMap(messages: ChatMessage[]): Map<string, string> {
  const questions = new Map<string, string>()
  for (const message of messages) {
    if (message.role !== 'user' || !message.id) continue
    const question = (message.displayContent ?? message.content).trim()
    if (question) questions.set(message.id, question)
  }
  return questions
}

export function AiPanel({ fullscreenDragHandleProps }: AiPanelProps = {}) {
  const toggleAiPanel = useAppStore((s) => s.toggleAiPanel)
  const { messages, streaming, error, timeline, sendMessage, cancelStream } = useAiChat()
  const databaseEnabled = getRuntimeCapabilities().database
  const assistantVisualId = useSettingsStore((s) => s.appearance.assistantVisualId)
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
  const returnToChatScrollFrameRef = useRef<number | null>(null)
  const shouldScrollAfterReturnRef = useRef(false)
  const visibleMessages = useMemo(() => messages.filter((msg) => !msg.hidden), [messages])
  const userQuestionsById = useMemo(() => buildUserQuestionMap(messages), [messages])
  const [reasoningMode, setReasoningMode] = useState<'off' | 'on'>('off')
  const [resetManualToggle, setResetManualToggle] = useState(0)
  const [panelView, setPanelView] = useState<'chat' | 'artifacts' | 'reminders'>('chat')
  const [reminders, setReminders] = useState<ReadingReminder[]>([])
  const [remindersLoading, setRemindersLoading] = useState(false)
  const saveArtifactFromMessage = useReadingArtifactsStore((s) => s.saveArtifactFromMessage)

  useEffect(() => {
    if (panelView !== 'chat' || !shouldScrollAfterReturnRef.current) return
    shouldScrollAfterReturnRef.current = false
    returnToChatScrollFrameRef.current = requestAnimationFrame(() => {
      returnToChatScrollFrameRef.current = null
      const container = chatContainerRef.current
      if (!container) return
      programmaticScrollUntilRef.current = Date.now() + 120
      container.scrollTo({ top: container.scrollHeight })
    })
    return () => {
      if (returnToChatScrollFrameRef.current !== null) {
        cancelAnimationFrame(returnToChatScrollFrameRef.current)
        returnToChatScrollFrameRef.current = null
      }
    }
  }, [panelView])

  const refreshReminders = useCallback(async () => {
    setRemindersLoading(true)
    try {
      setReminders(await loadReadingRemindersCommand())
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '加载提醒失败')
    } finally {
      setRemindersLoading(false)
    }
  }, [])

  useEffect(() => {
    if (databaseEnabled && panelView === 'reminders' && READING_REMINDER_FEATURE_AVAILABLE) void refreshReminders()
  }, [databaseEnabled, panelView, refreshReminders])

  useEffect(() => {
    if (!databaseEnabled && panelView !== 'chat') setPanelView('chat')
  }, [databaseEnabled, panelView])

  useEffect(() => {
    const applyNavigation = (navigation: { mode: 'open' | 'toggle'; view: 'chat' | 'artifacts' }) => {
      if (navigation.view === 'artifacts' && !databaseEnabled) return
      if (navigation.mode === 'open') {
        setPanelView(navigation.view)
      } else if (panelView === navigation.view) {
        useAppStore.getState().closeAiPanel()
      } else {
        setPanelView(navigation.view)
      }
    }
    const handleNavigation = (fallback: { mode: 'open' | 'toggle'; view: 'chat' | 'artifacts' }) => {
      applyNavigation(consumePendingPanelNavigation() ?? fallback)
    }
    const handleOpenAiChat = () => handleNavigation({ mode: 'open', view: 'chat' })
    const handleToggleAiChat = () => handleNavigation({ mode: 'toggle', view: 'chat' })
    const handleOpenReadingArtifacts = () => handleNavigation({ mode: 'open', view: 'artifacts' })
    const handleToggleReadingArtifacts = () => handleNavigation({ mode: 'toggle', view: 'artifacts' })
    const pendingNavigation = consumePendingPanelNavigation()
    if (pendingNavigation) applyNavigation(pendingNavigation)
    window.addEventListener(OPEN_AI_CHAT_EVENT, handleOpenAiChat)
    window.addEventListener(TOGGLE_AI_CHAT_EVENT, handleToggleAiChat)
    window.addEventListener(OPEN_READING_ARTIFACTS_EVENT, handleOpenReadingArtifacts)
    window.addEventListener(TOGGLE_READING_ARTIFACTS_EVENT, handleToggleReadingArtifacts)
    return () => {
      window.removeEventListener(OPEN_AI_CHAT_EVENT, handleOpenAiChat)
      window.removeEventListener(TOGGLE_AI_CHAT_EVENT, handleToggleAiChat)
      window.removeEventListener(OPEN_READING_ARTIFACTS_EVENT, handleOpenReadingArtifacts)
      window.removeEventListener(TOGGLE_READING_ARTIFACTS_EVENT, handleToggleReadingArtifacts)
    }
  }, [databaseEnabled, panelView])

  const handleCancelReminder = useCallback(async (id: string) => {
    try {
      await cancelReadingReminder(id)
      await refreshReminders()
      toast.success('提醒已取消')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '取消提醒失败')
    }
  }, [refreshReminders])

  const handleRetryReminder = useCallback(async (id: string) => {
    try {
      await retryReadingReminder(id)
      await refreshReminders()
      toast.success('提醒已重新安排')
    } catch (error) {
      await refreshReminders()
      toast.error(error instanceof Error ? error.message : '重试提醒失败')
    }
  }, [refreshReminders])

  const handleEditReminder = useCallback(async (id: string, dueAtUtc: number, timezone: string) => {
    try {
      await editReadingReminderTime(id, dueAtUtc, timezone)
      await refreshReminders()
      toast.success('提醒时间已更新')
    } catch (error) {
      await refreshReminders()
      toast.error(error instanceof Error ? error.message : '修改提醒失败')
      throw error
    }
  }, [refreshReminders])

  const handleDeleteReminder = useCallback(async (id: string) => {
    try {
      await deleteReadingReminder(id)
      await refreshReminders()
      toast.success('提醒已删除')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '删除提醒失败')
    }
  }, [refreshReminders])

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
      // 用户刚发送消息，直接跳转到底部，后续流式更新按现有规则跟随
      programmaticScrollUntilRef.current = Date.now() + 120
      container.scrollTo({ top: container.scrollHeight })
      return
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

      if (streamingMessageIdRef.current !== null) {
        streamingMessageIdRef.current = null
        return
      }
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
    sendMessage(currentDraft, undefined, currentContextTags.length > 0 ? currentContextTags : undefined, undefined, reasoningMode)
    setDraftInput('')
    chatState.clearContextTags()
    // 重置深度思考开关
    setReasoningMode('off')
    setResetManualToggle((prev) => prev + 1)
  }, [reasoningMode, sendMessage, setDraftInput])

  useEffect(() => {
    window.addEventListener(AI_SHORTCUT_SUBMIT_EVENT, handleSend)
    return () => window.removeEventListener(AI_SHORTCUT_SUBMIT_EVENT, handleSend)
  }, [handleSend])

  // 挂载时检查是否有待发送的快捷提问（解决首次使用时事件监听器未注册的问题）
  useEffect(() => {
    const chatState = useChatStore.getState()
    if (chatState.draftInput.trim() && useSettingsStore.getState().editor.autoSendAiShortcut) {
      // 延迟发送，确保事件监听器已注册
      window.setTimeout(() => {
        window.dispatchEvent(new Event(AI_SHORTCUT_SUBMIT_EVENT))
      }, 100)
    }
  }, [])

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
        const content = await readRememberedMarkdownFileForOpen(source.filePath)
        const name = source.filePath.split(/[/\\]/).pop() || source.filePath
        editorState.addTab(source.filePath, name, content)
        tabId = useEditorStore.getState().activeTabId || undefined
      } else {
        editorState.setActiveTab(tabId)
      }
      if (!tabId) return
      editorState.setViewMode('preview')
      editorState.requestReveal(tabId, source.startLine, source.endLine, 'preview')
    } catch (err) {
      toast.error(describeFileOperationError(err, '打开来源失败'))
    }
  }, [])

  const handleOpenArtifactSource = useCallback(async (artifact: ReadingArtifact, documentRef: ReadingArtifactDocumentRef) => {
    const location = documentRef.locations[0]
    if (!documentRef.filePath) {
      toast.error('该成果未绑定来源文件')
      return
    }
    const source = artifact.source
    const anchorLines = location?.startLine && location?.endLine
      ? { startLine: location.startLine, endLine: location.endLine }
      : null
    // 批注按 Markdown model/source offset 定位；其他类型直接用锚点行号。
    const annotation = artifact.type === 'annotation' && source?.filePath && isSameFilePath(source.filePath, documentRef.filePath)
      ? getAnnotationStructuredContent(artifact)
      : null
    try {
      const editorState = useEditorStore.getState()
      const existing = editorState.tabs.find((tab) => isSameFilePath(tab.filePath, documentRef.filePath))
      let tabId = existing?.id
      let content = existing?.content ?? ''
      if (!tabId) {
        content = await readRememberedMarkdownFileForOpen(documentRef.filePath)
        editorState.addTab(documentRef.filePath, documentRef.fileName, content)
        tabId = useEditorStore.getState().activeTabId || undefined
      } else {
        editorState.setActiveTab(tabId)
      }
      if (!tabId) return
      editorState.setViewMode('preview')
      // 批注：用当前文档内容解析定位（基于 Markdown model，不遍历 DOM）
      let revealStart = anchorLines?.startLine
      let revealEnd = anchorLines?.endLine
      if (annotation) {
        const position = resolveAnnotationPosition(content, annotation, source)
        if (position) {
          revealStart = position.startLine
          revealEnd = position.endLine
        }
      }
      if (revealStart && revealEnd) {
        editorState.requestReveal(tabId, revealStart, revealEnd, 'preview')
      }
    } catch (err) {
      toast.error(describeFileOperationError(err, '打开来源失败'))
    }
  }, [])

  const handleReturnToChat = useCallback(() => {
    autoFollowRef.current = true
    streamScrollInterruptedRef.current = false
    shouldScrollAfterReturnRef.current = true
    setPanelView('chat')
  }, [])

  const handleSaveAssistantAsMarkdown = useCallback(async (
    content: string,
    sources?: ChatMessageSource[],
    question?: string,
  ) => {
    await saveAssistantMessageAsMarkdown(content, sources, question)
  }, [])

  const handleSaveAssistantAsArtifact = useCallback(async (
    type: ReadingArtifactType,
    content: string,
    sources: ChatMessageSource[] | undefined,
    contextMeta: ChatMessageContextMeta | undefined,
    messageId: string | undefined,
    question: string | undefined,
  ) => {
    if (!databaseEnabled) {
      toast.error('阅读成果仅桌面版可用')
      return
    }
    const trimmed = content.trim()
    if (!trimmed) return

    // 批注：必须有本地来源锚点；批注正文为 AI 回答，引用快照取来源标题或行号
    if (type === 'annotation') {
      const localSource = sources?.find((s): s is LocalChatMessageSource => s.kind !== 'web')
      if (!localSource || !localSource.filePath) {
        toast.error('AI 解读需要绑定本地来源，请先选择带文件来源的回答')
        return
      }
      const quote = localSource.heading
        || formatSourceHeading(localSource)
        || `${localSource.fileName} L${localSource.startLine}-${localSource.endLine}`
      const structured: AnnotationStructuredContent = { quote, note: trimmed }
      const title = quote.length > 40 ? `${quote.slice(0, 40)}…` : quote
      try {
        const saved = await saveArtifactFromMessage({
          type,
          title,
          content: trimmed,
          sources,
          contextScope: contextMeta?.readingScope,
          messageId,
          question,
          structuredContent: structured,
        })
        if (saved) {
          toast.success('已保存为 AI 解读')
        } else {
          toast.error('保存 AI 解读失败')
        }
      } catch (err) {
        toast.error(err instanceof Error ? err.message : '保存 AI 解读失败')
      }
      return
    }

    const title = deriveArtifactTitle(type, trimmed)
    try {
      const saved = await saveArtifactFromMessage({
        type,
        title,
        content: trimmed,
        sources,
        contextScope: contextMeta?.readingScope,
        messageId,
        question,
      })
      if (saved) {
        toast.success(`已保存为${ARTIFACT_TYPE_LABELS[type]}`)
      } else {
        toast.error('保存阅读成果失败')
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '保存阅读成果失败')
    }
  }, [databaseEnabled, saveArtifactFromMessage])

  const handleDeleteSession = useCallback(async (sessionId: string) => {
    if (!databaseEnabled) {
      toast.error('历史会话仅桌面版可用')
      return
    }
    const confirmed = window.confirm('确认删除这组历史会话吗？删除后不可恢复。')
    if (!confirmed) return
    try {
      await deleteConversationSession(sessionId)
      useChatStore.getState().removeSessionMessages(sessionId)
      toast.success('历史会话已删除')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '删除历史会话失败')
    }
  }, [databaseEnabled])

  return (
    <div className="gm-instant-color h-full min-h-0 flex flex-col relative">
      {/* Header */}
      <div
        className={`flex items-center border-b border-gm-border-subtle bg-gm-surface relative z-10 ${
          fullscreenDragHandleProps ? 'h-9 cursor-grab touch-none px-3 active:cursor-grabbing' : 'h-10 px-4'
        }`}
        aria-label={fullscreenDragHandleProps ? '拖动 AI 助手' : undefined}
        {...fullscreenDragHandleProps}
      >
        <div className="flex items-center gap-2">
          <span className="text-body font-bold text-gm-text">
            {panelView === 'artifacts' ? '阅读成果' : panelView === 'reminders' ? '阅读提醒' : 'AI 助手'}
          </span>
          {streaming && (
            <span className="text-caption text-gm-primary animate-pulse">生成中...</span>
          )}
        </div>
        <div className="flex-1" />
        <div className="flex items-center" onPointerDown={(e) => e.stopPropagation()}>
          <Button
            type={panelView === 'artifacts' ? 'default' : 'text'}
            size="small"
            disabled={!databaseEnabled}
            onClick={() => { if (databaseEnabled) setPanelView('artifacts') }}
            title={databaseEnabled ? '阅读成果' : '阅读成果仅桌面版可用'}
            icon={<BookOpen size={15} strokeWidth={1.7} aria-hidden="true" />}
          />
          <Button
            type={panelView === 'reminders' ? 'default' : 'text'}
            size="small"
            disabled={!databaseEnabled}
            onClick={() => { if (databaseEnabled) setPanelView('reminders') }}
            title={databaseEnabled ? '阅读提醒（功能开发中）' : '阅读提醒仅桌面版可用'}
            icon={
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M18 8a6 6 0 00-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9" />
                <path d="M13.73 21a2 2 0 01-3.46 0" />
              </svg>
            }
          />
          {panelView === 'chat' && messages.length > 0 ? (
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
          ) : panelView !== 'chat' ? (
            <Button
              type="text"
              size="small"
              onClick={handleReturnToChat}
              title="返回"
              icon={
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path d="M19 12H5M12 19l-7-7 7-7" />
                </svg>
              }
            />
          ) : null}
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

      {panelView === 'chat' && <AgentTimeline timeline={timeline} />}

      {/* Chat Content - 可以滚动到控制栏下面 */}
      <div ref={chatContainerRef} className={`flex-1 min-h-0 overflow-y-auto overflow-x-hidden min-w-0 bg-gm-surface ${panelView === 'chat' ? 'pb-32' : 'pb-0'}`}>
        {panelView === 'artifacts' ? (
          <ReadingArtifactCenter onOpenAiSource={handleOpenArtifactSource} />
        ) : panelView === 'reminders' ? (
          READING_REMINDER_FEATURE_AVAILABLE ? (
            <ReadingRemindersPanel
              reminders={reminders}
              loading={remindersLoading}
              onCancel={handleCancelReminder}
              onRetry={handleRetryReminder}
              onEdit={handleEditReminder}
              onDelete={handleDeleteReminder}
            />
          ) : (
            <div className="flex h-full flex-col items-center justify-center p-6 text-center">
              <p className="mb-1 font-bold text-gm-text-secondary">提醒功能开发中</p>
              <p className="text-caption text-gm-text-tertiary">{READING_REMINDER_DEVELOPMENT_MESSAGE}</p>
            </div>
          )
        ) : visibleMessages.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full p-6 animate-fadeIn">
            {hasMoreHistory && (
              <button
                onClick={handleLoadHistory}
                disabled={!databaseEnabled || loadingHistory}
                title={!databaseEnabled ? '历史会话仅桌面版可用' : undefined}
                className="mb-4 px-4 py-1.5 rounded-full border border-gm-border text-caption text-gm-text-secondary hover:text-gm-text hover:bg-gm-surface-hover disabled:opacity-50"
              >
                {loadingHistory ? '加载中...' : '加载历史记录'}
              </button>
            )}
            <AiAvatar size="empty" visualId={assistantVisualId} />
            <p className="text-body font-bold text-gm-text mb-1">开始对话</p>
            <p className="text-caption text-gm-text-secondary text-center leading-relaxed">
              选择文档中的文字，或直接提问
            </p>
          </div>
        ) : (
          <div className="p-3 space-y-4">
            {hasMoreHistory && (
              <div className="flex justify-center">
                <button
                  onClick={handleLoadHistory}
                  disabled={!databaseEnabled || loadingHistory}
                  title={!databaseEnabled ? '历史会话仅桌面版可用' : undefined}
                  className="px-4 py-1.5 rounded-full border border-gm-border text-caption text-gm-text-secondary hover:text-gm-text hover:bg-gm-surface-hover disabled:opacity-50"
                >
                  {loadingHistory ? '加载中...' : '加载更早的记录'}
                </button>
              </div>
            )}
            {visibleMessages.map((msg, i) => {
              const prevMsg = i > 0 ? visibleMessages[i - 1] : null
              const messageKey = msg.id || `${msg.role}-${msg.sessionId || 'live'}-${msg.timestamp || i}`
              const parentQuestion = msg.parentId ? userQuestionsById.get(msg.parentId) : undefined
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
                  visualId={assistantVisualId}
                  sources={msg.sources}
                  referencedSourceIds={msg.referencedSourceIds}
                  onOpenSource={handleOpenRagSource}
                  onSaveAsMarkdown={
                    msg.role === 'assistant'
                      && Boolean((msg.displayContent ?? msg.content).trim())
                      && !(i === visibleMessages.length - 1 && streaming)
                      ? () => handleSaveAssistantAsMarkdown(msg.displayContent ?? msg.content, msg.sources, parentQuestion)
                      : undefined
                  }
                  onSaveAsArtifact={
                    databaseEnabled && msg.role === 'assistant'
                      && Boolean((msg.displayContent ?? msg.content).trim())
                      && !(i === visibleMessages.length - 1 && streaming)
                      ? (type) => handleSaveAssistantAsArtifact(
                          type,
                          msg.displayContent ?? msg.content,
                          msg.sources,
                          msg.contextMeta,
                          msg.id,
                          parentQuestion,
                        )
                      : undefined
                  }
                />
                {msg.role === 'assistant' && msg.editConfirmation && (
                  <div className="mt-2">
                    <PendingEditCard
                      edit={msg.editConfirmation}
                      actionable={msg.editConfirmation.status === 'pending'}
                    />
                  </div>
                )}
                {msg.role === 'assistant' && msg.actionProposal && (
                  <div className="mt-2">
                    <ActionProposalCard proposal={msg.actionProposal} />
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
      {panelView === 'chat' && (
        <PromptComposer
          onSend={handleSend}
          streaming={streaming}
          onCancel={cancelStream}
          onReasoningModeChange={setReasoningMode}
          resetManualToggle={resetManualToggle}
        />
      )}
    </div>
  )
}

const REMINDER_STATUS_LABELS: Record<ReadingReminder['status'], string> = {
  pending: '待注册',
  scheduled: '已安排',
  fired: '已到期',
  cancel_pending: '待取消',
  cancelled: '已取消',
  failed: '失败',
}

function ReadingRemindersPanel({
  reminders,
  loading,
  onCancel,
  onRetry,
  onEdit,
  onDelete,
}: {
  reminders: ReadingReminder[]
  loading: boolean
  onCancel: (id: string) => void | Promise<void>
  onRetry: (id: string) => void | Promise<void>
  onEdit: (id: string, dueAtUtc: number, timezone: string) => void | Promise<void>
  onDelete: (id: string) => void | Promise<void>
}) {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingTime, setEditingTime] = useState('')
  const [savingEdit, setSavingEdit] = useState(false)
  if (loading) {
    return <div className="p-6 text-center text-caption text-gm-text-secondary">正在加载提醒…</div>
  }
  if (reminders.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center p-6 text-center">
        <p className="mb-1 font-bold text-gm-text-secondary">还没有阅读提醒</p>
        <p className="text-caption text-gm-text-tertiary">可在对话中让 AI 提出一次性提醒，确认后才会注册。</p>
      </div>
    )
  }
  return (
    <div className="space-y-2 p-3">
      {reminders.map((reminder) => {
        const cancellable = ['pending', 'scheduled', 'cancel_pending', 'failed'].includes(reminder.status)
        const editable = reminder.dueAtUtc > Date.now()
          && !['cancelled', 'fired', 'cancel_pending'].includes(reminder.status)
          && reminder.errorCode !== 'notification_cancel_failed'
        const editing = editingId === reminder.id
        return (
          <div key={reminder.id} className="rounded-xl border border-gm-border bg-gm-surface-elevated p-3">
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <p className="truncate text-body font-bold text-gm-text">{reminder.title}</p>
                <p className="mt-1 text-caption text-gm-text-secondary">
                  {new Intl.DateTimeFormat('zh-CN', {
                    timeZone: reminder.createdTimezone,
                    year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short',
                    hour: '2-digit', minute: '2-digit',
                  }).format(reminder.dueAtUtc)}
                </p>
                {reminder.description && (
                  <p className="mt-1 whitespace-pre-wrap text-caption text-gm-text-tertiary">{reminder.description}</p>
                )}
                <p className="mt-2 text-micro text-gm-text-tertiary">
                  {REMINDER_STATUS_LABELS[reminder.status]}
                  {reminder.errorCode ? ` · ${reminder.errorCode}` : ''}
                </p>
                {editing && (
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <input
                      type="datetime-local"
                      value={editingTime}
                      min={toDatetimeLocalValue(Date.now() + 60_000)}
                      onChange={(event) => setEditingTime(event.target.value)}
                      className="min-w-0 rounded-lg border border-gm-border bg-gm-surface px-2 py-1 text-micro text-gm-text"
                    />
                    <Button
                      type="default"
                      size="small"
                      disabled={savingEdit || !editingTime}
                      onClick={async () => {
                        const dueAtUtc = new Date(editingTime).getTime()
                        if (!Number.isFinite(dueAtUtc) || dueAtUtc <= Date.now()) {
                          toast.error('请选择未来时间')
                          return
                        }
                        setSavingEdit(true)
                        try {
                          await onEdit(
                            reminder.id,
                            dueAtUtc,
                            Intl.DateTimeFormat().resolvedOptions().timeZone,
                          )
                          setEditingId(null)
                        } finally {
                          setSavingEdit(false)
                        }
                      }}
                    >
                      保存
                    </Button>
                    <Button type="text" size="small" onClick={() => setEditingId(null)}>取消编辑</Button>
                  </div>
                )}
              </div>
              <div className="flex shrink-0 flex-col items-end gap-1">
                {reminder.status === 'failed' && (
                  <Button type="default" size="small" onClick={() => void onRetry(reminder.id)}>重试</Button>
                )}
                {editable && !editing && (
                  <Button
                    type="default"
                    size="small"
                    onClick={() => {
                      setEditingId(reminder.id)
                      setEditingTime(toDatetimeLocalValue(reminder.dueAtUtc))
                    }}
                  >
                    改期
                  </Button>
                )}
                {cancellable && (
                  <Button
                    type="default"
                    size="small"
                    className="text-red-600 hover:text-red-700"
                    onClick={() => void onCancel(reminder.id)}
                  >
                    取消
                  </Button>
                )}
                <Button danger size="small" onClick={() => void onDelete(reminder.id)}>删除</Button>
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}

function toDatetimeLocalValue(timestamp: number): string {
  const date = new Date(timestamp)
  return new Date(timestamp - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
}

const ARTIFACT_FILTER_OPTIONS: Array<{ value: ReadingArtifactFilter; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'summary', label: '摘要' },
  { value: 'question_set', label: '问题集' },
  { value: 'annotation', label: 'AI 解读' },
  { value: 'note', label: '阅读笔记' },
]

const READING_ARTIFACT_SEARCH_DEBOUNCE_MS = 180

function ReadingArtifactsPanel({
  artifacts,
  loading,
  filter,
  query,
  page,
  pageSize,
  total,
  onFilterChange,
  onQueryChange,
  onPageChange,
  onDelete,
  onOpenSource,
  onOpenArtifactSource,
  anchorStatuses,
  onCheckAnchor,
}: {
  artifacts: ReadingArtifact[]
  loading: boolean
  filter: ReadingArtifactFilter
  query: string
  page: number
  pageSize: number
  total: number
  onFilterChange: (filter: ReadingArtifactFilter) => void
  onQueryChange: (query: string) => void
  onPageChange: (page: number) => void
  onDelete: (id: string) => void | Promise<void>
  onOpenSource: (source: { filePath: string; startLine: number; endLine: number }) => void | Promise<void>
  onOpenArtifactSource: (artifact: ReadingArtifact) => void | Promise<void>
  anchorStatuses: Record<string, SourceAnchorStatus>
  onCheckAnchor: (artifact: ReadingArtifact) => void | Promise<void>
}) {
  const [searchInput, setSearchInput] = useState(query)
  const searchDebounceRef = useRef<number | null>(null)
  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  const hasNoResults = total === 0
  const hasNoArtifacts = hasNoResults && filter === 'all' && !query.trim()

  useEffect(() => {
    setSearchInput(query)
  }, [query])

  useEffect(() => () => {
    if (searchDebounceRef.current !== null) {
      window.clearTimeout(searchDebounceRef.current)
    }
  }, [])

  const handleSearchChange = (value: string) => {
    setSearchInput(value)
    if (searchDebounceRef.current !== null) {
      window.clearTimeout(searchDebounceRef.current)
    }
    searchDebounceRef.current = window.setTimeout(() => {
      searchDebounceRef.current = null
      onQueryChange(value)
    }, READING_ARTIFACT_SEARCH_DEBOUNCE_MS)
  }

  return (
    <div className="p-3 space-y-3 animate-fadeIn">
      <div className="flex items-center gap-2">
        <label className="sr-only" htmlFor="reading-artifact-search">搜索阅读成果</label>
        <input
          id="reading-artifact-search"
          type="search"
          value={searchInput}
          onChange={(event) => handleSearchChange(event.target.value)}
          placeholder="搜索阅读成果"
          className="min-w-0 flex-1 rounded-lg border border-gm-border bg-gm-surface px-2.5 py-1.5 text-caption text-gm-text outline-none transition-colors placeholder:text-gm-text-disabled focus:border-gm-primary"
        />
        <span className="shrink-0 text-micro text-gm-text-tertiary">{total} 条</span>
      </div>

      <div className="flex items-center gap-1.5 flex-wrap">
        {ARTIFACT_FILTER_OPTIONS.map((option) => (
          <button
            key={option.value}
            type="button"
            onClick={() => onFilterChange(option.value)}
            className={`px-2.5 py-1 rounded-full text-micro font-bold border transition-colors ${
              filter === option.value
                ? 'bg-gm-primary text-white border-gm-primary'
                : 'bg-gm-surface text-gm-text-secondary border-gm-border hover:bg-gm-surface-hover'
            }`}
          >
            {option.label}
          </button>
        ))}
        {loading && <span className="ml-auto text-micro text-gm-text-tertiary">更新中…</span>}
      </div>

      {loading && artifacts.length === 0 ? (
        <div className="text-center text-caption text-gm-text-tertiary py-8">加载中...</div>
      ) : hasNoResults ? (
        <div className="text-center text-caption text-gm-text-tertiary py-12">
          <p className="font-bold text-gm-text-secondary mb-1">
            {hasNoArtifacts ? '还没有阅读成果' : '当前条件无匹配结果'}
          </p>
          <p>{hasNoArtifacts ? '在 AI 回答上点击「摘要 / 问题集 / AI 解读 / 阅读笔记」即可保存' : '请尝试更换搜索词或筛选条件'}</p>
        </div>
      ) : (
        <div className="space-y-2">
          {artifacts.map((artifact) => (
            <ReadingArtifactCard
              key={artifact.id}
              artifact={artifact}
              anchorStatus={anchorStatuses[artifact.id]}
              onDelete={onDelete}
              onOpenSource={onOpenSource}
              onOpenArtifactSource={onOpenArtifactSource}
              onCheckAnchor={onCheckAnchor}
            />
          ))}
        </div>
      )}

      {total > 0 && (
        <div className="flex items-center gap-2 border-t border-gm-border-subtle pt-2 text-micro text-gm-text-tertiary">
          <span>第 {page} / {totalPages} 页</span>
          <div className="ml-auto flex items-center gap-1">
            <button
              type="button"
              onClick={() => onPageChange(page - 1)}
              disabled={page <= 1 || loading}
              className="rounded-md border border-gm-border px-2 py-1 transition-colors hover:bg-gm-surface-hover disabled:cursor-not-allowed disabled:opacity-40"
            >
              上一页
            </button>
            <button
              type="button"
              onClick={() => onPageChange(page + 1)}
              disabled={page >= totalPages || loading}
              className="rounded-md border border-gm-border px-2 py-1 transition-colors hover:bg-gm-surface-hover disabled:cursor-not-allowed disabled:opacity-40"
            >
              下一页
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function ReadingArtifactCard({
  artifact,
  anchorStatus,
  onDelete,
  onOpenSource,
  onOpenArtifactSource,
  onCheckAnchor,
}: {
  artifact: ReadingArtifact
  anchorStatus?: SourceAnchorStatus
  onDelete: (id: string) => void | Promise<void>
  onOpenSource: (source: { filePath: string; startLine: number; endLine: number }) => void | Promise<void>
  onOpenArtifactSource: (artifact: ReadingArtifact) => void | Promise<void>
  onCheckAnchor: (artifact: ReadingArtifact) => void | Promise<void>
}) {
  const [expanded, setExpanded] = useState(false)

  useEffect(() => {
    if (artifact.source?.filePath && anchorStatus === undefined) {
      onCheckAnchor(artifact)
    }
  }, [artifact, anchorStatus, onCheckAnchor])

  const annotation = artifact.type === 'annotation'
    ? getAnnotationStructuredContent(artifact)
    : null
  const question = getReadingArtifactQuestion(artifact)
  const references = getReadingArtifactReferences(artifact)

  const sourceLabel = artifact.source?.fileName
    ? [
        artifact.source.fileName,
        artifact.source.headingPath?.length ? artifact.source.headingPath.join(' / ') : null,
        artifact.source.startLine ? `L${artifact.source.startLine}-${artifact.source.endLine}` : null,
      ].filter(Boolean).join(' · ')
    : null

  const hasAnchorLines = Boolean(artifact.source?.filePath && artifact.source?.startLine && artifact.source?.endLine)
  const canOpenSource = hasAnchorLines || artifact.type === 'annotation'
  const anchorChanged = anchorStatus === 'changed'
  const anchorMissing = anchorStatus === 'missing'

  const handleOpen = () => {
    // 批注统一走 onOpenArtifactSource 以便按 Markdown model 解析定位
    if (artifact.type === 'annotation' || annotation) {
      onOpenArtifactSource(artifact)
      return
    }
    if (hasAnchorLines) {
      onOpenSource({
        filePath: artifact.source!.filePath,
        startLine: artifact.source!.startLine!,
        endLine: artifact.source!.endLine!,
      })
    }
  }

  return (
    <div className="rounded-xl border border-gm-border-subtle bg-gm-surface px-3 py-2.5 transition-colors hover:border-gm-border animate-slideInUp">
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        className="flex w-full min-w-0 items-center gap-2 text-left"
        aria-expanded={expanded}
      >
        <span className="flex-shrink-0 rounded-md bg-gm-surface-hover px-1.5 py-0.5 text-micro font-bold text-gm-text-tertiary">
          {ARTIFACT_TYPE_LABELS[artifact.type]}
        </span>
        <span className="min-w-0 flex-1 truncate text-caption font-bold text-gm-text">{artifact.title}</span>
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true" className={`ml-auto flex-shrink-0 text-gm-text-tertiary transition-transform ${expanded ? 'rotate-90' : ''}`}>
          <path d="M9 18l6-6-6-6" />
        </svg>
      </button>

      {sourceLabel && (
        <div className="mt-1.5 flex items-center gap-1.5 text-micro text-gm-text-tertiary">
          <span className="flex-shrink-0 font-bold">来源</span>
          <span className="truncate">{sourceLabel}</span>
          {anchorChanged && (
            <span className="flex-shrink-0 rounded-full bg-[#f5c31c]/15 text-[#b8860b] px-1.5 py-0.5 font-bold">来源已变化</span>
          )}
          {anchorMissing && (
            <span className="flex-shrink-0 rounded-full bg-gm-error/10 text-gm-error px-1.5 py-0.5 font-bold">来源缺失</span>
          )}
        </div>
      )}
      {(anchorChanged || anchorMissing) && (
        <div className="mt-1.5 text-micro text-gm-text-tertiary">
          {anchorChanged
            ? '原文已修改，定位可能偏移；打开来源时会尝试用引用快照重新定位。'
            : '来源文件已不可访问或未索引。'}
        </div>
      )}

      {expanded && (
        <div className="mt-3 max-h-[360px] space-y-3 overflow-auto border-t border-gm-border-subtle pt-3 pr-1">
          {question && (
            <ArtifactQuestion question={question} />
          )}
          {annotation ? (
            <AnnotationDetail annotation={annotation} fallbackContent={artifact.content} />
          ) : (
            <div className="rounded-lg bg-gm-canvas px-2.5 py-2.5">
              <div className="mb-1.5 text-micro font-bold text-gm-text-tertiary">成果内容</div>
              <AssistantMarkdown content={artifact.content} compact />
            </div>
          )}
          {references.length > 0 && (
            <ArtifactReferences references={references} onOpenSource={onOpenSource} />
          )}
          {artifact.source?.quote && !annotation && (
            <div className="rounded-lg bg-gm-surface-hover px-2.5 py-2">
              <div className="mb-1 text-micro font-bold text-gm-text-tertiary">引用原文</div>
              <div className="border-l-2 border-gm-border pl-2.5 text-micro leading-relaxed text-gm-text-secondary italic">
                「{artifact.source.quote}」
              </div>
            </div>
          )}
        </div>
      )}

      <div className="mt-3 flex items-center gap-1 border-t border-gm-border-subtle pt-2">
        {canOpenSource && (
          <button
            type="button"
            onClick={handleOpen}
            className="rounded-md px-1.5 py-1 text-micro text-gm-primary hover:bg-gm-surface-hover"
            title="打开来源"
          >
            打开来源
          </button>
        )}
        <button
          type="button"
          onClick={() => {
            if (window.confirm('确认删除这条阅读成果吗？删除后不可恢复，不会改动原文。')) {
              onDelete(artifact.id)
            }
          }}
          className="rounded-md px-1.5 py-1 text-micro text-gm-text-tertiary hover:bg-gm-error/10 hover:text-gm-error"
          title="删除成果"
        >
          删除
        </button>
        <span className="ml-auto text-micro text-gm-text-disabled">
          {new Date(artifact.createdAt).toLocaleDateString('zh-CN')}
        </span>
      </div>
    </div>
  )
}

function ArtifactQuestion({ question }: { question: string }) {
  const textRef = useRef<HTMLDivElement>(null)
  const [expanded, setExpanded] = useState(false)
  const [collapsible, setCollapsible] = useState(false)

  useEffect(() => {
    setExpanded(false)
    const text = textRef.current
    if (!text) return
    const updateCollapsible = () => {
      const hasManyLines = question.split('\n').length > 3
      setCollapsible(hasManyLines || question.length > 72 || text.scrollHeight > text.clientHeight + 1)
    }
    updateCollapsible()
    const observer = new ResizeObserver(updateCollapsible)
    observer.observe(text)
    return () => observer.disconnect()
  }, [question])

  return (
    <div className="rounded-lg bg-gm-primary/5 px-2.5 py-2.5">
      <div className="mb-1.5 text-micro font-bold text-gm-primary">原问题</div>
      <div
        ref={textRef}
        className="whitespace-pre-wrap break-words text-caption leading-relaxed text-gm-text-secondary"
        style={expanded ? undefined : {
          display: '-webkit-box',
          WebkitBoxOrient: 'vertical',
          WebkitLineClamp: 3,
          overflow: 'hidden',
        }}
      >
        {question}
      </div>
      {collapsible && (
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          className="mt-1 rounded px-1 py-0.5 text-micro text-gm-primary hover:bg-gm-surface"
          aria-expanded={expanded}
        >
          {expanded ? '收起问题' : '展开问题'}
        </button>
      )}
    </div>
  )
}

function AnnotationDetail({
  annotation,
  fallbackContent,
}: {
  annotation: AnnotationStructuredContent
  fallbackContent: string
}) {
  return (
    <div className="space-y-3">
      <div className="rounded-lg bg-gm-surface-hover px-2.5 py-2.5">
        <div className="mb-1.5 text-micro font-bold text-gm-text-tertiary">引用原文</div>
        <div className="border-l-2 border-gm-primary pl-2.5 text-micro leading-relaxed text-gm-text-secondary italic break-words">
          「{annotation.quote}」
        </div>
      </div>
      <div className="rounded-lg bg-gm-canvas px-2.5 py-2.5">
        <div className="mb-1.5 text-micro font-bold text-gm-text-tertiary">批注内容</div>
        <AssistantMarkdown content={annotation.note || fallbackContent} compact />
      </div>
    </div>
  )
}

function ArtifactReferences({
  references,
  onOpenSource,
}: {
  references: readonly ReadingArtifactReference[]
  onOpenSource: (source: { filePath: string; startLine: number; endLine: number }) => void | Promise<void>
}) {
  return (
    <div className="rounded-lg bg-gm-surface-hover px-2.5 py-2.5">
      <div className="mb-1.5 text-micro font-bold text-gm-text-tertiary">参考来源</div>
      <div className="space-y-1">
        {references.map((reference, index) => (
          reference.kind === 'web' ? (
            <a
              key={`${reference.url}-${index}`}
              href={reference.url}
              target="_blank"
              rel="noreferrer"
              className="block w-full rounded-lg px-2 py-1 text-left text-micro leading-relaxed text-gm-text-secondary hover:bg-gm-surface hover:text-gm-primary"
              title={reference.url}
            >
              <span className="mr-1 rounded border border-gm-border px-1 text-[10px] font-bold text-gm-text-tertiary">Web</span>
              <span className="font-bold">{reference.title}</span>
              {(reference.siteName || reference.publishedAt) && (
                <span> / {[reference.siteName, reference.publishedAt].filter(Boolean).join(' / ')}</span>
              )}
            </a>
          ) : (
            <button
              key={`${reference.filePath}-${reference.startLine}-${reference.endLine}-${index}`}
              type="button"
              onClick={() => onOpenSource(reference)}
              className="block w-full rounded-lg px-2 py-1 text-left text-micro leading-relaxed text-gm-text-secondary hover:bg-gm-surface hover:text-gm-primary"
              title={`打开 ${reference.fileName}:${reference.startLine}-${reference.endLine}`}
            >
              <span className="mr-1 rounded border border-gm-border px-1 text-[10px] font-bold text-gm-text-tertiary">Local</span>
              <span className="font-bold">{reference.fileName}</span>
              {formatArtifactReferenceHeading(reference) && (
                <span> / {formatArtifactReferenceHeading(reference)}</span>
              )}
              <span> / L{reference.startLine}-{reference.endLine}</span>
            </button>
          )
        ))}
      </div>
    </div>
  )
}

function formatArtifactReferenceHeading(reference: Extract<ReadingArtifactReference, { kind: 'local' }>): string {
  if (reference.titlePath?.length) return reference.titlePath.join(' / ')
  return reference.heading || ''
}

function AgentTimeline({ timeline }: { timeline: TimelineItem[] }) {
  const [collapsed, setCollapsed] = useState(true)
  if (timeline.length === 0) return null

  const latest = timeline[timeline.length - 1]

  const tone = {
    index_initializing: 'bg-gm-primary',
    index_ready: 'bg-gm-success',
    index_fallback: 'bg-gm-warning',
    local_search_start: 'bg-gm-primary',
    local_search_found: 'bg-gm-success',
    local_search_empty: 'bg-gm-text-tertiary',
    web_search_start: 'bg-gm-warning',
    web_search_done: 'bg-gm-success',
    answer_streaming: 'bg-gm-primary',
    done: 'bg-gm-success',
    error: 'bg-gm-error',
  } satisfies Record<TimelineItem['type'], string>

  return (
    <div className="border-b border-gm-border bg-gm-surface px-4 py-2">
      <button
        onClick={() => setCollapsed(!collapsed)}
        className="w-full flex items-center gap-2 text-micro font-bold text-gm-text-tertiary"
      >
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={`flex-shrink-0 transition-transform ${collapsed ? '' : 'rotate-90'}`}>
          <path d="M9 18l6-6-6-6" />
        </svg>
        {collapsed ? (
          <>
            <span className="flex-shrink-0">Agent 状态链路：</span>
            <span className="font-bold text-gm-text-secondary truncate">{latest.label}</span>
            <span className={`ml-auto flex-shrink-0 h-2 w-2 rounded-full ${tone[latest.type]} ${latest.type === 'answer_streaming' ? 'animate-pulse' : ''}`} />
          </>
        ) : (
          <span>Agent 状态链路</span>
        )}
      </button>
      {!collapsed && (
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

export const ChatBubble = memo(function ChatBubble({
  role,
  content,
  isLast,
  streaming,
  visualId,
  sources,
  referencedSourceIds,
  onOpenSource,
  onSaveAsMarkdown,
  onSaveAsArtifact,
}: {
  role: 'system' | 'user' | 'assistant'
  content: string
  isLast: boolean
  streaming: boolean
  visualId?: string | null
  sources?: ChatMessageSource[]
  referencedSourceIds?: SourceReferenceId[]
  onOpenSource?: (source: LocalChatMessageSource) => void
  onSaveAsMarkdown?: () => void
  onSaveAsArtifact?: (type: ReadingArtifactType) => void
}) {
  const isUser = role === 'user'
  const isEmpty = !content && isLast && streaming
  const isAssistantStreaming = !isUser && isLast && streaming
  const displayedSources = useMemo(
    () => resolveStoredSourceReferences(sources, referencedSourceIds),
    [referencedSourceIds, sources],
  )
  const bubbleRef = useRef<HTMLDivElement>(null)
  const saveMenuRef = useRef<HTMLDivElement>(null)
  const saveControlsHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [saveMenuOpen, setSaveMenuOpen] = useState(false)
  const [saveControlsVisible, setSaveControlsVisible] = useState(false)
  // AI 解读需绑定本地来源范围；仅当存在非 web 来源时显示对应入口
  const hasLocalSource = Boolean(sources?.some((s) => s.kind !== 'web'))

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'a') {
      e.preventDefault()
      const el = bubbleRef.current
      if (!el) return
      const range = document.createRange()
      range.selectNodeContents(el)
      const sel = window.getSelection()
      sel?.removeAllRanges()
      sel?.addRange(range)
    }
  }, [])

  const clearSaveControlsHideTimer = useCallback(() => {
    if (saveControlsHideTimerRef.current === null) return
    clearTimeout(saveControlsHideTimerRef.current)
    saveControlsHideTimerRef.current = null
  }, [])

  const showSaveControls = useCallback(() => {
    clearSaveControlsHideTimer()
    setSaveControlsVisible(true)
  }, [clearSaveControlsHideTimer])

  const scheduleSaveControlsHide = useCallback(() => {
    clearSaveControlsHideTimer()
    saveControlsHideTimerRef.current = setTimeout(() => {
      saveControlsHideTimerRef.current = null
      if (saveMenuOpen || saveMenuRef.current?.contains(document.activeElement)) return
      setSaveControlsVisible(false)
    }, SAVE_CONTROLS_HIDE_DELAY_MS)
  }, [clearSaveControlsHideTimer, saveMenuOpen])

  useEffect(() => clearSaveControlsHideTimer, [clearSaveControlsHideTimer])

  useEffect(() => {
    if (!saveMenuOpen) return
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!saveMenuRef.current?.contains(event.target as Node)) {
        setSaveMenuOpen(false)
        setSaveControlsVisible(false)
      }
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setSaveMenuOpen(false)
        setSaveControlsVisible(false)
      }
    }
    document.addEventListener('pointerdown', closeOnOutsidePointer)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointer)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [saveMenuOpen])

  const runSaveAction = (action: () => void) => {
    setSaveMenuOpen(false)
    setSaveControlsVisible(false)
    action()
  }

  const canSave = !isUser && !isEmpty && Boolean(content.trim()) && Boolean(onSaveAsMarkdown || onSaveAsArtifact)

  return (
    <div
      className={`flex min-w-0 ${isUser ? 'justify-end' : 'justify-start'} animate-slideInUp`}
      onPointerEnter={canSave ? showSaveControls : undefined}
      onPointerLeave={canSave ? scheduleSaveControlsHide : undefined}
      onFocusCapture={canSave ? showSaveControls : undefined}
      onBlurCapture={canSave ? (event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) scheduleSaveControlsHide()
      } : undefined}
    >
      {!isUser && (
        <AiAvatar size="message" animated={isAssistantStreaming} streaming={isAssistantStreaming} visualId={visualId} />
      )}
      <div className="group relative min-w-0 w-fit max-w-[80%]">
        <div
          ref={bubbleRef}
          tabIndex={-1}
          onKeyDown={handleKeyDown}
          className={`select-text max-w-full min-w-0 rounded-2xl px-4 py-2.5 text-body focus:outline-none ${
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
          {!isUser && displayedSources.sources.length > 0 && onOpenSource && (
            <MessageSources
              sources={displayedSources.sources}
              hasValidReferences={displayedSources.hasValidReferences}
              onOpenSource={onOpenSource}
            />
          )}
        </div>
        {canSave && (
          <div
            ref={saveMenuRef}
            className={`absolute bottom-0 left-full z-20 pl-1 transition-opacity ${
              saveMenuOpen || saveControlsVisible
                ? 'pointer-events-auto opacity-100'
                : 'pointer-events-none opacity-0'
            }`}
          >
            <Button
              type="default"
              size="small"
              onClick={() => {
                showSaveControls()
                setSaveMenuOpen((open) => !open)
              }}
              title="保存回复"
              aria-label="保存回复"
              aria-expanded={saveMenuOpen}
              aria-haspopup="menu"
              className="!h-6 !w-6 !min-w-0 !rounded-full !p-0"
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
                <path d="M7 10l5 5 5-5" />
                <path d="M12 15V3" />
              </svg>
            </Button>
            {saveMenuOpen && (
              <div role="menu" className="absolute bottom-full right-0 mb-1 min-w-32 rounded-lg border border-gm-border bg-gm-surface-elevated p-1 shadow-lg">
                {onSaveAsMarkdown && (
                  <Button role="menuitem" type="text" size="small" className="w-full justify-start hover:bg-gm-surface-hover focus-visible:bg-gm-surface-hover" onClick={() => runSaveAction(onSaveAsMarkdown)}>Markdown</Button>
                )}
                {onSaveAsArtifact && (
                  <>
                    <Button role="menuitem" type="text" size="small" className="w-full justify-start hover:bg-gm-surface-hover focus-visible:bg-gm-surface-hover" onClick={() => runSaveAction(() => onSaveAsArtifact('summary'))}>摘要</Button>
                    <Button role="menuitem" type="text" size="small" className="w-full justify-start hover:bg-gm-surface-hover focus-visible:bg-gm-surface-hover" onClick={() => runSaveAction(() => onSaveAsArtifact('question_set'))}>问题集</Button>
                    {hasLocalSource && (
                      <Button role="menuitem" type="text" size="small" className="w-full justify-start hover:bg-gm-surface-hover focus-visible:bg-gm-surface-hover" onClick={() => runSaveAction(() => onSaveAsArtifact('annotation'))}>AI 解读</Button>
                    )}
                    <Button role="menuitem" type="text" size="small" className="w-full justify-start hover:bg-gm-surface-hover focus-visible:bg-gm-surface-hover" onClick={() => runSaveAction(() => onSaveAsArtifact('note'))}>阅读笔记</Button>
                  </>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
})

const ARTIFACT_TYPE_LABELS: Record<ReadingArtifactType, string> = {
  summary: '摘要',
  question_set: '问题集',
  annotation: 'AI 解读',
  note: '阅读笔记',
}

function deriveArtifactTitle(type: ReadingArtifactType, content: string): string {
  // 取正文首行非空文本作为标题，截断到合理长度；不调用模型二次改写
  const firstLine = content
    .split('\n')
    .map((line) => line.replace(/^#+\s*/, '').trim())
    .find((line) => line.length > 0) || ARTIFACT_TYPE_LABELS[type]
  return firstLine.length > 40 ? `${firstLine.slice(0, 40)}…` : firstLine
}

function AiAvatar({
  size,
  animated = true,
  streaming = false,
  visualId,
}: {
  size: 'empty' | 'message'
  animated?: boolean
  streaming?: boolean
  visualId?: string | null
}) {
  const className = size === 'empty'
    ? 'gm-ai-empty-icon-shell w-16 h-16 rounded-2xl flex items-center justify-center mb-4'
    : 'gm-ai-avatar w-9 h-9 rounded-xl flex items-center justify-center mr-2 flex-shrink-0 mt-1'

  // 历史消息头像固定 idle 静态展示，仅空态图标与当前流式消息跟随实时状态。
  const forceIdle = size === 'message' && !streaming
  const spriteClassName = size === 'message' ? `${className} gm-ai-avatar--sprite` : className
  return (
    <div className={spriteClassName}>
      <AssistantVisual
        visualId={visualId}
        size={size === 'empty' ? 56 : 44}
        state={forceIdle ? 'idle' : undefined}
        animated={animated}
      />
    </div>
  )
}

function MessageSources({
  sources,
  hasValidReferences,
  onOpenSource,
}: {
  sources: ChatMessageSource[]
  hasValidReferences: boolean
  onOpenSource: (source: LocalChatMessageSource) => void
}) {
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
        <span>{hasValidReferences ? '引用来源' : '检索来源/未确认引用'} {sources.length}</span>
      </button>
      {expanded && (
        <div className="mt-2 space-y-1">
          {sources.map((source, index) => (
            source.kind === 'web' ? (
              <a
                key={`${source.url}-${index}`}
                href={source.url}
                target="_blank"
                rel="noreferrer"
                className="block w-full rounded-lg px-2 py-1 text-left text-micro leading-relaxed text-gm-text-secondary hover:bg-gm-surface hover:text-gm-primary"
                title={source.url}
              >
                <span className="mr-1 rounded border border-gm-border px-1 text-[10px] font-bold text-gm-text-tertiary">Web</span>
                <span className="font-bold">{source.title}</span>
                {(source.siteName || source.publishedAt) && (
                  <span> / {[source.siteName, source.publishedAt].filter(Boolean).join(' / ')}</span>
                )}
                <span className="mt-0.5 block truncate text-gm-text-tertiary">{source.url}</span>
              </a>
            ) : (
              <button
                key={`${source.filePath}-${source.startLine}-${source.endLine}-${index}`}
                type="button"
                onClick={() => onOpenSource(source)}
                className="block w-full rounded-lg px-2 py-1 text-left text-micro leading-relaxed text-gm-text-secondary hover:bg-gm-surface hover:text-gm-primary"
                title={`Open ${source.filePath}:${source.startLine}-${source.endLine}`}
              >
                <span className="mr-1 rounded border border-gm-border px-1 text-[10px] font-bold text-gm-text-tertiary">Local</span>
                <span className="font-bold">{source.fileName}</span>
                {formatSourceHeading(source) && (
                  <span> / {formatSourceHeading(source)}</span>
                )}
                <span> / L{source.startLine}-{source.endLine}</span>
                <span className="mt-0.5 block truncate text-gm-text-tertiary">{source.filePath}</span>
              </button>
            )
          ))}
        </div>
      )}
    </div>
  )
}

function formatSourceHeading(source: LocalChatMessageSource): string {
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

const ARTIFACT_MARKDOWN_COMPONENTS: Components = {
  ...ASSISTANT_MARKDOWN_COMPONENTS,
  p: ({ children }) => <p className="my-2 text-caption leading-relaxed">{children}</p>,
  h1: ({ children }) => <h1 className="mt-3.5 mb-1.5 text-caption font-bold text-gm-text">{children}</h1>,
  h2: ({ children }) => <h2 className="mt-3.5 mb-1.5 text-caption font-bold text-gm-text">{children}</h2>,
  h3: ({ children }) => <h3 className="mt-3 mb-1.5 text-caption font-bold text-gm-text">{children}</h3>,
  h4: ({ children }) => <h4 className="mt-3 mb-1.5 text-caption font-bold text-gm-text">{children}</h4>,
  h5: ({ children }) => <h5 className="mt-3 mb-1.5 text-caption font-bold text-gm-text">{children}</h5>,
  h6: ({ children }) => <h6 className="mt-3 mb-1.5 text-caption font-bold text-gm-text">{children}</h6>,
  ul: ({ children }) => <ul className="my-2 space-y-1.5 pl-4 text-caption list-disc">{children}</ul>,
  ol: ({ children }) => <ol className="my-2 space-y-1.5 pl-4 text-caption list-decimal">{children}</ol>,
  li: ({ children }) => <li className="leading-relaxed marker:text-gm-text-tertiary">{children}</li>,
  hr: () => <hr className="my-3.5 border-gm-border-subtle" />,
}

const AssistantMarkdown = memo(function AssistantMarkdown({
  content,
  compact = false,
}: {
  content: string
  compact?: boolean
}) {
  return (
    <div className={`ai-message-content max-w-none min-w-0 overflow-wrap-anywhere [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 ${compact ? 'text-caption text-gm-text-secondary' : ''}`}>
      <ReactMarkdown
        remarkPlugins={ASSISTANT_MARKDOWN_REMARK_PLUGINS}
        components={compact ? ARTIFACT_MARKDOWN_COMPONENTS : ASSISTANT_MARKDOWN_COMPONENTS}
      >
        {content}
      </ReactMarkdown>
    </div>
  )
})

function ActionProposalCard({ proposal }: { proposal: ActionProposal }) {
  const reminderUnavailable = proposal.kind === 'create_reading_reminder'
    && !READING_REMINDER_FEATURE_AVAILABLE
  const statusLabel: Record<ActionProposal['status'], string> = {
    pending: '待确认',
    executing: '执行中',
    completed: '已完成',
    rejected: '已拒绝',
    expired: '已过期',
    failed: '执行失败',
  }

  return (
    <div className="animate-slideInUp">
      <div className="rounded-xl p-3" style={{ border: '1px solid var(--gm-warning)', backgroundColor: 'color-mix(in srgb, var(--gm-warning) 8%, transparent)' }}>
        <div className="text-caption font-bold text-gm-text-primary">{proposal.title}</div>
        <div className="mt-1 text-caption text-gm-text-secondary">目标：{proposal.target}</div>
        <div className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap rounded-lg border border-gm-border bg-gm-surface-elevated px-3 py-2 text-caption text-gm-text-primary">
          {proposal.preview}
        </div>
        <div className="mt-2 text-caption text-gm-text-secondary">风险：{proposal.riskDescription}</div>
        <div className="mt-1 text-caption text-gm-text-secondary">
          {proposal.reversible ? '可撤销' : '不可自动撤销'}：{proposal.reversibleDescription}
        </div>
        {proposal.status === 'pending' && reminderUnavailable ? (
          <div className="mt-3 rounded-lg border border-gm-border bg-gm-surface-elevated px-3 py-1.5 text-caption text-gm-text-secondary">
            {READING_REMINDER_DEVELOPMENT_MESSAGE}
          </div>
        ) : proposal.status === 'pending' ? (
          <div className="mt-3 flex gap-2">
            <button
              onClick={() => void import('@/services/actionProposalCommand')
                .then(({ confirmActionProposalCommand }) => confirmActionProposalCommand(proposal.id))}
              className="flex-1 rounded-lg bg-gm-primary px-3 py-1.5 text-caption font-bold text-white transition-opacity hover:opacity-90"
            >
              确认执行
            </button>
            <button
              onClick={() => void import('@/services/actionProposalCommand')
                .then(({ rejectActionProposalCommand }) => rejectActionProposalCommand(proposal.id))}
              className="flex-1 rounded-lg border border-gm-border px-3 py-1.5 text-caption text-gm-text-secondary hover:bg-gm-surface-hover"
            >
              拒绝
            </button>
          </div>
        ) : (
          <div className="mt-3 rounded-lg border border-gm-border bg-gm-surface-elevated px-3 py-1.5 text-caption text-gm-text-secondary">
            {statusLabel[proposal.status]}
          </div>
        )}
      </div>
    </div>
  )
}

function PendingEditCard({ edit, actionable }: { edit: PendingEdit; actionable: boolean }) {
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
          <button onClick={() => applyPendingEditCommand(edit.id)}
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
