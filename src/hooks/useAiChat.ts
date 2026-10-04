import { useCallback, useRef } from 'react'
import { useChatStore } from '@/stores/chatStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { selectPrimaryWorkspacePath, useAppStore } from '@/stores/appStore'
import { getAiClient, getEmbeddingClient, getEmbeddingConfig, initAiClient, initEmbeddingClient, isAiReady, isEmbeddingReady, isLocalApi } from '@/services/ai/aiClient'
import { SYSTEM_TEMPERATURE, type ChatMessage } from '@/services/ai/types'
import { initAgent, runAgent } from '@/services/agent'
import type { AgentStep, AgentTaskContext } from '@/services/agent/types'
import type { SourceReferenceRegistry } from '@/services/ai/sourceReferences'
import { createAgentTaskContext, decodeAgentStepEvent, decodeKnowledgeSearchOutcome } from '@/services/agent/session'
import { createActionProposal } from '@/services/agent/actionProposal'
import type { ContextTag } from '@/types/contextTag'
import { readRememberedMarkdownFileForOpen } from '@/services/markdownFileOpenPolicy'
import { setAgentScopeContext } from '@/services/aiScope'
import { resolveDirectRagSources, searchScopedKnowledge, shouldTriggerScopedRag, streamFinalAnswer } from '@/services/aiChatFlow'
import { buildAgentFinalAnswerMessages, buildChatMessageTags, buildMessagesForModel, buildSupplementalAiContext, countRagSourcesInContext, createContextMeta, createUserChatMessage, prepareChatHistoryForModel, resolveAiAnswerMode } from '@/services/aiChatMessages'
import { hideLikelyToolJsonPrefix, stripToolCallJson } from '@/services/agent/toolCallParser'
import { buildMemoryContext, isPersonalizedRewriteMemoryIntent, processMemoryCandidateExtraction, searchMemories } from '@/services/memory/memoryService'
import type { ManualCapability } from '@/components/ai/ManualToolToggle'
import { ensureSettingsSecretsHydrated } from '@/services/settingsSecrets'
import { singletonManager, SINGLETON_IDS } from '@/services/singletonPromise'
import { promoteTask } from '@/services/idleScheduler'
import { prepareConversationContext, prepareConversationRouting } from '@/services/agent/conversationRequest'
import { buildAgentRunRequest } from '@/services/agent/requestBuilder'
import {
  buildScopedAgentResultPresentation,
  resolveAgentAnswerSources,
  resolveReadingSourceCoverage,
  toContextTagSources,
} from '@/services/agent/sourceMetadata'
import { READING_REMINDER_FEATURE_AVAILABLE } from '@/services/readingReminderFeature'
import { finishAgentTrace, finishAgentTraceSpan, startAgentTrace, startAgentTraceSpan, type AgentTraceStatus } from '@/services/devAgentDiagnostics'

export function getAgentProgressText(step: AgentStep, knowledgeActionMessage?: string): string {
  if (step.type === 'progress') {
    if (knowledgeActionMessage) return knowledgeActionMessage
    return {
      rag_initializing: '正在初始化索引库…',
      rag_ready: '索引库已就绪，正在检索…',
      rag_searching: '索引库已就绪，正在检索…',
      rag_fallback: '索引库初始化失败，正在使用关键词检索…',
    }[step.progressStage || 'rag_searching']
  }
  if (step.type === 'thought') return 'AI 正在判断下一步处理方式...'
  if (step.type === 'observation') {
    return step.toolName
      ? `${getAgentToolLabel(step.toolName)}已完成，正在整理下一步...`
      : '工具结果已返回，正在整理下一步...'
  }
  if (step.actionMessage) return step.actionMessage

  switch (step.toolName) {
    case 'search_knowledge':
      return '正在检索本地知识库索引...'
    case 'search_reading_artifacts':
      return '正在检索阅读成果...'
    case 'get_reading_artifact':
      return '正在读取阅读成果详情...'
    case 'search_memory':
      return '正在读取长期记忆库...'
    case 'list_database_contents':
      return '正在查看知识库索引概览...'
    case 'list_memories':
      return '正在查看记忆库概览...'
    case 'web_search':
      return '正在执行联网搜索...'
    case 'save_memory':
      return '正在写入长期记忆...'
    case 'read_context_file':
      return '正在读取上下文...'
    case 'read_selection_context':
      return '正在读取选区上下文...'
    case 'get_recent_context_tag':
      return '正在读取最近上下文标签...'
    case 'knowledge_stats':
      return '正在读取知识库统计...'
    case 'list_current_edit_targets':
      return '正在读取可修改目标...'
    case 'get_current_tab_text':
      return '正在读取当前文档内容...'
    case 'replace_current_tab_text':
      return '正在调用文档修改工具...'
    case 'propose_save_reading_artifact':
      return '正在生成阅读成果确认卡片...'
    case 'propose_create_markdown_note':
      return '正在生成阅读笔记确认卡片...'
    case 'propose_create_reading_reminder':
      return READING_REMINDER_FEATURE_AVAILABLE
        ? '正在生成阅读提醒确认卡片...'
        : '正在检查提醒功能状态...'
    case 'get_current_time':
      return '正在读取当前系统时间...'
    default:
      return step.toolName ? `正在执行工具：${step.toolName}...` : 'Agent 正在执行工具...'
  }
}

export function getAgentToolLabel(toolName: string): string {
  return {
    search_knowledge: '本地知识库检索',
    search_reading_artifacts: '阅读成果检索',
    get_reading_artifact: '阅读成果详情读取',
    search_memory: '长期记忆读取',
    list_database_contents: '知识库索引概览读取',
    list_memories: '记忆库概览读取',
    web_search: '联网搜索',
    save_memory: '长期记忆写入',
    read_context_file: '上下文读取',
    read_selection_context: '选区上下文读取',
    get_recent_context_tag: '最近上下文标签读取',
    knowledge_stats: '知识库统计读取',
    list_current_edit_targets: '可修改目标读取',
    get_current_tab_text: '当前文档内容读取',
    replace_current_tab_text: '文档修改工具调用',
    propose_save_reading_artifact: '阅读成果确认卡片生成',
    propose_create_markdown_note: '阅读笔记确认卡片生成',
    propose_create_reading_reminder: READING_REMINDER_FEATURE_AVAILABLE
      ? '阅读提醒确认卡片生成'
      : '提醒功能状态检查',
    get_current_time: '系统时间读取',
  }[toolName] || `工具 ${toolName}`
}

export function useAiChat() {
  const messages = useChatStore((s) => s.messages)
  const streaming = useChatStore((s) => s.streaming)
  const error = useChatStore((s) => s.error)
  const agentMode = useChatStore((s) => s.agentMode)
  const ragStatus = useChatStore((s) => s.ragStatus)
  const ragSources = useChatStore((s) => s.ragSources)
  const timeline = useChatStore((s) => s.timeline)
  const agentTaskContext = useChatStore((s) => s.agentTaskContext)
  const addMessage = useChatStore((s) => s.addMessage)
  const setStreaming = useChatStore((s) => s.setStreaming)
  const setError = useChatStore((s) => s.setError)
  const addAgentStep = useChatStore((s) => s.addAgentStep)
  const clearAgentSteps = useChatStore((s) => s.clearAgentSteps)
  const setAgentMode = useChatStore((s) => s.setAgentMode)
  const updateMessageContent = useChatStore((s) => s.updateMessageContent)
  const updateMessageContextMeta = useChatStore((s) => s.updateMessageContextMeta)
  const updateMessageSources = useChatStore((s) => s.updateMessageSources)
  const updateMessageArtifactReferences = useChatStore((s) => s.updateMessageArtifactReferences)
  const updateMessageReferencedSourceIds = useChatStore((s) => s.updateMessageReferencedSourceIds)
  const removeMessageById = useChatStore((s) => s.removeMessageById)
  const setRagStatus = useChatStore((s) => s.setRagStatus)
  const setRagSources = useChatStore((s) => s.setRagSources)
  const addTimelineItem = useChatStore((s) => s.addTimelineItem)
  const clearTimeline = useChatStore((s) => s.clearTimeline)
  const setAgentTaskContext = useChatStore((s) => s.setAgentTaskContext)
  const ai = useSettingsStore((s) => s.ai)
  const workspacePath = useAppStore(selectPrimaryWorkspacePath)
  const lastConfigRef = useRef('')
  const cancelRef = useRef<() => void>(() => {})
  const activeRequestRef = useRef<{ id: string; assistantMessageId: string; cancelled: boolean } | null>(null)

  const ensureClient = useCallback(async (): Promise<boolean> => {
    try {
      await ensureSettingsSecretsHydrated()
    } catch (err) {
      console.warn('[AI] Settings secret hydration retry failed:', err)
    }
    const currentAi = useSettingsStore.getState().ai

    // 初始化对话客户端（本地 API 无需 apiKey）
    const chatReady = (currentAi.apiKey || isLocalApi(currentAi.baseUrl)) && currentAi.baseUrl && currentAi.chatModel
    if (chatReady) {
      const configKey = `${currentAi.baseUrl}|${currentAi.apiKey}|${currentAi.chatModel}`
      if (configKey !== lastConfigRef.current || !isAiReady()) {
        // 提升 AI 客户端初始化优先级（如果正在闲时加载）
        promoteTask(SINGLETON_IDS.CHAT_AI)
        try {
          // 如果闲时初始化已完成，直接使用
          if (!isAiReady()) {
            // 等待闲时初始化完成
            await singletonManager.init(SINGLETON_IDS.CHAT_AI, async () => {
              const provider = initAiClient(currentAi)
              lastConfigRef.current = configKey
              return provider
            })
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          setError(`AI 初始化失败：${msg}`)
        }
      }
    }

    // 初始化 embedding 客户端（独立配置，本地 API 无需 apiKey）
    const emb = currentAi.embedding
    const embReady = (emb?.apiKey || isLocalApi(emb?.baseUrl || '')) && emb?.baseUrl && emb?.embeddingModel
    if (embReady) {
      const currentEmbeddingConfig = getEmbeddingConfig()
      const embeddingConfigChanged = !currentEmbeddingConfig
        || currentEmbeddingConfig.apiKey !== emb.apiKey
        || currentEmbeddingConfig.baseUrl !== emb.baseUrl
        || currentEmbeddingConfig.embeddingModel !== emb.embeddingModel
      if (embeddingConfigChanged || !isEmbeddingReady()) {
        // 提升 Embedding 客户端初始化优先级
        promoteTask(SINGLETON_IDS.EMBEDDING_AI)
        try {
          if (!isEmbeddingReady()) {
            await singletonManager.init(SINGLETON_IDS.EMBEDDING_AI, async () => {
              return initEmbeddingClient(emb)
            })
          }
        } catch (err) {
          console.warn('[AI] Embedding client init failed:', err)
        }
      }
    }

    if (!isAiReady()) {
      setError('请先在设置中配置 API Key 或选择本地模型（如 Ollama）')
      return false
    }

    return true
  }, [setError])

  const cancelStream = useCallback(() => {
    cancelRef.current()
    setStreaming(false)
  }, [setStreaming])

  const sendMessage = useCallback(
    async (content: string, forceAgent?: boolean, contextTags?: ContextTag[], manualCapabilities?: ManualCapability[], reasoningMode?: 'off' | 'on') => {
      const hasText = content.trim().length > 0
      const hasTags = contextTags && contextTags.length > 0
      if ((!hasText && !hasTags) || useChatStore.getState().streaming) return
      setStreaming(true)
      setError(null)
      clearTimeline()
      const requestId = `ai-request-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
      const assistantMessageId = `assistant-${requestId}`
      const requestController = new AbortController()
      activeRequestRef.current = { id: requestId, assistantMessageId, cancelled: false }
      const isCurrentRequest = () => activeRequestRef.current?.id === requestId && !activeRequestRef.current.cancelled
      const updateRequestMessage = (nextContent: string) => {
        if (isCurrentRequest()) updateMessageContent(assistantMessageId, nextContent)
      }
      cancelRef.current = () => {
        const current = activeRequestRef.current
        if (!current || current.id !== requestId) return
        current.cancelled = true
        requestController.abort('user_cancelled')
        removeMessageById(assistantMessageId)
        setStreaming(false)
      }

      const initialUserMessage = createUserChatMessage(content, '', buildChatMessageTags(contextTags))
      if (hasTags) initialUserMessage.displayContent = content.trim()
      addMessage(initialUserMessage)
      addMessage({
        id: assistantMessageId,
        parentId: initialUserMessage.id,
        role: 'assistant',
        content: hasTags ? '正在读取上下文...' : '正在准备 AI 请求...',
        timestamp: Date.now(),
      })
      if (contextTags && contextTags.length > 0) {
        addTimelineItem({ type: 'local_search_start', label: '正在读取上下文' })
      }
      let preparedContext: Awaited<ReturnType<typeof prepareConversationContext>>
      try {
        preparedContext = await prepareConversationContext({
          content,
          contextTags,
          readFile: readRememberedMarkdownFileForOpen,
        })
      } catch (err) {
        if (isCurrentRequest()) {
          const msg = err instanceof Error ? err.message : String(err)
          setError(`读取上下文失败：${msg}`)
          removeMessageById(assistantMessageId)
          activeRequestRef.current = null
          cancelRef.current = () => {}
          setStreaming(false)
        }
        return
      }
      if (!isCurrentRequest()) return
      const { tagContext, tagMetadata } = preparedContext
      const userMsg = { ...preparedContext.userMessage, id: initialUserMessage.id, timestamp: initialUserMessage.timestamp }
      updateMessageContent(initialUserMessage.id!, userMsg.content)
      updateRequestMessage('正在准备 AI 请求...')
      setRagStatus('idle')
      setRagSources([])

      updateRequestMessage('正在读取 AI 配置...')
      if (!(await ensureClient())) {
        removeMessageById(assistantMessageId)
        activeRequestRef.current = null
        cancelRef.current = () => {}
        setStreaming(false)
        return
      }
      updateRequestMessage('正在初始化模型连接...')

      // Agent 自动切换：统一路由决策
      const latestVisibleAssistant = [...messages].reverse().find(
        (msg) => msg.role === 'assistant' && !msg.hidden && !msg.sessionId
      )
      const hasRecentEditContext = Boolean(latestVisibleAssistant?.editConfirmation)

      // 统一路由决策（一次性生成，消除 useAiChat 与 executor 的重复判断）
      const routingDecision = prepareConversationRouting({
        content,
        contextTags,
        forceAgent,
        manualCapabilities,
        agentTaskContext,
        hasRecentEditContext,
        messages,
      })

      const selectionRequestKind = routingDecision.selectionRequestKind
      const candidateToolNames = routingDecision.candidateTools
      const mergedCandidates = routingDecision.candidates
      const mergedRequired = routingDecision.required
      const useAgentMode = routingDecision.mode === 'agent'

      // --- 记忆预检索 ---
      let memoryContext = ''
      let memoryLookupAttempted = false
      const memoryIntent = routingDecision.memoryIntent
      const personalizedRewriteMemory = isPersonalizedRewriteMemoryIntent(content.trim())
      const shouldLookupMemory = routingDecision.shouldLookupMemory

      clearAgentSteps()

      if (shouldLookupMemory) {
        updateRequestMessage('正在检查长期记忆...')
        addAgentStep({
          type: 'action',
          content: memoryIntent === 'strong' ? '按用户明确记忆意图触发强检索' : '按用户弱记忆意图触发轻量检索',
          toolName: 'search_memory',
          toolArgs: { query: content.trim(), topK: memoryIntent === 'strong' ? 10 : 3 },
          timestamp: Date.now(),
        })

        try {
          const embeddingClient = isEmbeddingReady() ? getEmbeddingClient() : null
          const embedding = embeddingClient
            ? async (text: string, signal?: AbortSignal) => (await embeddingClient.embedding(text, signal)).embedding
            : undefined
          const batchEmbedding = embeddingClient
            ? async (texts: string[], signal?: AbortSignal) => embeddingClient.batchEmbedding(texts, signal)
            : undefined
          const memories = await searchMemories(content.trim(), {
            mode: memoryIntent === 'strong' ? 'strong' : 'light',
            embedding,
            batchEmbedding,
            scopeType: workspacePath ? 'project' : 'global',
            scopeKey: workspacePath,
            embeddingModel: getEmbeddingConfig()?.embeddingModel,
            categories: personalizedRewriteMemory ? ['preference', 'instruction'] : undefined,
            signal: requestController.signal,
          })
          if (!isCurrentRequest()) return
          memoryContext = buildMemoryContext(memories)
          memoryLookupAttempted = memoryIntent === 'strong' || Boolean(memoryContext)
          if (memoryIntent === 'strong' && !memoryContext) {
            memoryContext = '系统已按需检索长期记忆：未找到相关长期记忆。'
          }
          addAgentStep({
            type: 'observation',
            content: memories.length > 0
              ? `检索到 ${memories.length} 条长期记忆`
              : '未检索到相关长期记忆',
            timestamp: Date.now(),
          })
        } catch (err) {
          console.warn('[Memory] retrieval failed:', err)
          if (!isCurrentRequest()) return
          if (memoryIntent === 'strong') {
            memoryContext = '系统已按需检索长期记忆：未找到相关长期记忆。'
            memoryLookupAttempted = true
          }
          addAgentStep({
            type: 'observation',
            content: '未检索到相关长期记忆',
            timestamp: Date.now(),
          })
        }
      }

      const activeClient = getAiClient()
      const modelHistory: ChatMessage[] = prepareChatHistoryForModel(messages)
      const diagnosticMetadata = {
        routeMode: routingDecision.mode,
        routeReasons: routingDecision.reasonCodes.join(','),
        candidateToolCount: candidateToolNames.length,
        streamEnabled: ai.streamEnabled,
      }
      const agentDiagnosticRunId = useAgentMode
        ? startAgentTrace({ mode: 'agent', metadata: diagnosticMetadata })
        : undefined

      const executeAgentRequest = async () => {
        let diagnosticStatus: AgentTraceStatus = 'completed'
        let diagnosticReason = 'completed'
        let diagnosticToolCalls = 0
        let diagnosticStepCount = 0
        clearAgentSteps()
        initAgent()
        const planningText = routingDecision.requiresEditConfirmation
          ? '正在分析文档修改要求...'
          : candidateToolNames.some((name) => name === 'read_context_file' || name === 'read_selection_context')
            ? '正在确定上下文读取范围...'
            : 'Agent 正在规划工具链路...'
        updateRequestMessage(planningText)
        addTimelineItem({ type: 'local_search_start', label: planningText.replace(/\.\.\.$/, '') })
        let pendingEditCount = 0
        let pendingActionCount = 0
        let liveAgentStepCount = 0
        let hasVisibleStreamContent = false
        let knowledgeActionMessage: string | undefined
        const handleAgentStep = (step: AgentStep) => {
          if (!isCurrentRequest()) return
          liveAgentStepCount++
          addAgentStep(step)
          if (step.type === 'action' && step.toolName === 'search_knowledge') {
            knowledgeActionMessage = step.actionMessage
          } else if (step.type === 'thought' || step.type === 'observation' && step.toolName === 'search_knowledge') {
            knowledgeActionMessage = undefined
          }
          if (step.type !== 'thought' || !hasVisibleStreamContent) {
            updateRequestMessage(step.type === 'thought' ? planningText : getAgentProgressText(step, knowledgeActionMessage))
          }
          if (step.type !== 'thought') hasVisibleStreamContent = false
          const event = decodeAgentStepEvent(step)
          const knowledgeOutcome = decodeKnowledgeSearchOutcome(event)
          if (event.type === 'progress') {
            if (event.stage === 'rag_initializing') {
              setRagStatus('initializing')
              addTimelineItem({ type: 'index_initializing', label: '正在初始化索引库…' })
            } else if (event.stage === 'rag_ready') {
              setRagStatus('searching')
              addTimelineItem({ type: 'index_ready', label: '索引库已就绪，正在检索…' })
            } else if (event.stage === 'rag_fallback') {
              setRagStatus('fallback')
              addTimelineItem({ type: 'index_fallback', label: '索引库初始化失败，正在使用关键词检索…' })
            } else {
              setRagStatus('searching')
            }
          } else if (knowledgeOutcome) {
            setRagStatus(knowledgeOutcome)
            if (knowledgeOutcome === 'found') {
              addTimelineItem({ type: 'local_search_found', label: '本地知识库检索完成' })
            } else if (knowledgeOutcome === 'empty') {
              addTimelineItem({ type: 'local_search_empty', label: '本地知识库没有命中' })
            } else {
              addTimelineItem({ type: 'error', label: '本地知识库检索失败' })
            }
          } else if (event.type === 'action' && event.toolName === 'search_knowledge') {
            addTimelineItem({ type: 'local_search_start', label: '检索本地知识库索引' })
          } else if (event.type === 'action' && event.toolName === 'read_selection_context') {
            addTimelineItem({ type: 'local_search_start', label: '正在读取选区上下文' })
          } else if (event.type === 'action' && event.toolName === 'read_context_file') {
            addTimelineItem({ type: 'local_search_start', label: '正在读取上下文' })
          } else if (event.type === 'action' && event.toolName === 'replace_current_tab_text') {
            addTimelineItem({ type: 'local_search_start', label: '正在调用文档修改工具' })
          } else if (event.type === 'action' && event.toolName === 'web_search') {
            addTimelineItem({ type: 'web_search_start', label: '执行联网搜索' })
          } else if (event.type === 'action' && event.toolName === 'search_memory') {
            addTimelineItem({ type: 'local_search_start', label: '读取长期记忆库' })
          } else if (event.type === 'action' && event.toolName === 'save_memory') {
            addTimelineItem({ type: 'local_search_start', label: '写入长期记忆库' })
          } else if (event.type === 'action' && event.toolName === 'list_database_contents') {
            addTimelineItem({ type: 'local_search_start', label: '查看知识库索引概览' })
          } else if (event.type === 'action' && event.toolName === 'list_memories') {
            addTimelineItem({ type: 'local_search_start', label: '查看记忆库概览' })
          } else if (event.type === 'action' && event.toolName) {
            addTimelineItem({ type: 'local_search_start', label: `执行${getAgentToolLabel(event.toolName)}` })
          } else if (event.type === 'observation') {
            addTimelineItem({
              type: 'web_search_done',
              label: event.toolName ? `${getAgentToolLabel(event.toolName)}已完成` : '工具结果已返回',
            })
            if (event.pendingEdit) {
              const targetMessageId = pendingEditCount === 0
                ? assistantMessageId
                : `assistant-${requestId}-edit-${pendingEditCount}`
              if (pendingEditCount > 0) {
                addMessage({ id: targetMessageId, parentId: userMsg.id, role: 'assistant', content: '已生成修改确认卡片，请在下方确认。', timestamp: Date.now() })
              }
              pendingEditCount++
              useChatStore.getState().setPendingEdit({
                id: `edit-${Date.now()}`,
                messageId: targetMessageId,
                ...event.pendingEdit,
                status: 'pending',
              })
            }
            if (event.pendingAction) {
              const targetMessageId = pendingActionCount === 0 && pendingEditCount === 0
                ? assistantMessageId
                : `assistant-${requestId}-action-${pendingActionCount}`
              if (targetMessageId !== assistantMessageId) {
                addMessage({ id: targetMessageId, parentId: userMsg.id, role: 'assistant', content: '已生成行动确认卡片，请在下方确认。', timestamp: Date.now() })
              }
              pendingActionCount++
              const proposal = createActionProposal(event.pendingAction, {
                id: `action-${Date.now()}-${pendingActionCount}`,
                messageId: targetMessageId,
              })
              useChatStore.getState().updateMessageActionProposal(targetMessageId, proposal)
            }
          }
        }

        const createAgentRequest = () => buildAgentRunRequest({
            content,
            messages,
            modelHistory,
            contextTags,
            tagContext,
            memoryContext,
            routingDecision,
            hasRecentEditContext,
            hasPrefetchedMemoryLookup: memoryLookupAttempted,
            signal: requestController.signal,
            temperature: SYSTEM_TEMPERATURE.agentPlanning,
            streamEnabled: ai.streamEnabled,
            onStep: handleAgentStep,
            onStreamContent: (streamedContent) => {
              if (!isCurrentRequest()) return
              const visibleContent = hideLikelyToolJsonPrefix(streamedContent)
              if (!visibleContent) return
              hasVisibleStreamContent = true
              updateRequestMessage(visibleContent)
            },
          })
        const agentRequest = createAgentRequest()
        const { editTargets, originalRequest: contextOriginalRequest } = agentRequest

        try {
          setAgentScopeContext({ contextTags: contextTags || [], editTargets })
          const result = await runAgent({ ...agentRequest.request, diagnosticRunId: agentDiagnosticRunId })
          diagnosticReason = result.reason
          diagnosticToolCalls = result.toolCalls
          diagnosticStepCount = result.steps.length
          if (result.reason === 'deadline') diagnosticStatus = 'timeout'
          else if (result.reason === 'error') diagnosticStatus = 'error'
          if (!isCurrentRequest()) return
          if (candidateToolNames.length > 0) {
            setAgentTaskContext(createAgentTaskContext({
              originalRequest: contextOriginalRequest,
              intent: mergedCandidates,
              requiredCapabilities: mergedRequired,
              candidateToolNames,
              result,
            }))
          }
          for (const step of result.steps.slice(liveAgentStepCount)) {
            if (!isCurrentRequest()) return
            handleAgentStep(step)
          }
          const presentation = buildScopedAgentResultPresentation(
            result,
            tagMetadata.length,
            routingDecision.readingScope,
          )
          const updateAgentSourceMetadata = () => {
            if (!isCurrentRequest()) return
            updateMessageContextMeta(assistantMessageId, presentation.contextMeta)
            if (presentation.sources.length > 0) {
              updateMessageSources(assistantMessageId, presentation.sources)
            }
            updateMessageReferencedSourceIds(assistantMessageId, presentation.referencedSourceIds)
            if (result.artifactReferences?.length) {
              updateMessageArtifactReferences(assistantMessageId, result.artifactReferences)
            }
          }

          if (result.finalMessages) {
            const client = getAiClient()
            const finalAnswerMessages = buildAgentFinalAnswerMessages(result.finalMessages)
            updateRequestMessage('正在生成最终回答...')
            addTimelineItem({ type: 'answer_streaming', label: '生成最终回答' })

            const finalAnswerSpanId = startAgentTraceSpan(agentDiagnosticRunId, 'final_answer', { streaming: ai.streamEnabled })
            await streamFinalAnswer({
              client,
              messages: finalAnswerMessages,
              streamEnabled: ai.streamEnabled,
              onUpdate: (answer) => updateRequestMessage(stripToolCallJson(answer)),
              isCancelled: () => !isCurrentRequest(),
              filterToolJson: true,
              signal: requestController.signal,
              temperature: SYSTEM_TEMPERATURE.agentAnswer,
              reasoningMode,
            })
            finishAgentTraceSpan(agentDiagnosticRunId, finalAnswerSpanId, isCurrentRequest() ? 'success' : 'cancelled')

            if (!isCurrentRequest()) {
              addTimelineItem({ type: 'error', label: '已停止生成最终回答' })
              return
            }
            updateAgentSourceMetadata()
            // 解析正文中的稳定引用，只更新已确认的来源展示；无引用时保留候选来源。
            if (isCurrentRequest()) {
              const agentMsg = useChatStore.getState().messages.find((m) => m.id === assistantMessageId)
              if (agentMsg && result.sourceRegistry) {
                const resolved = resolveAgentAnswerSources(
                  agentMsg.content,
                  result.sourceRegistry,
                  presentation.sources,
                )
                updateMessageReferencedSourceIds(assistantMessageId, resolved.referencedIds)
              }
            }
          } else {
            updateRequestMessage(presentation.answer)
            updateAgentSourceMetadata()
          }
          addTimelineItem({ type: 'done', label: '生成回答完成' })
          // 异步提取候选记忆（Agent 模式）
          if (isCurrentRequest()) {
            const allMsgs = useChatStore.getState().messages
            const agentClient = getAiClient()
            processMemoryCandidateExtraction(allMsgs, agentClient, SYSTEM_TEMPERATURE.memoryExtract, { triggerReason: 'agent_completed', workspacePath }).catch((err) =>
              console.warn('[Memory] extraction failed:', err)
            )
            // 自动保存会话到数据库
            useChatStore.getState().saveCurrentSession().catch((err) =>
              console.warn('[Chat] auto-save failed:', err)
            )
          }
        } catch (err) {
          diagnosticStatus = 'error'
          diagnosticReason = 'error'
          if (!isCurrentRequest()) return
          const msg = err instanceof Error ? err.message : String(err)
          if (candidateToolNames.length > 0) {
            const failedContext: AgentTaskContext = {
              intent: mergedCandidates,
              requiredCapabilities: mergedRequired,
              candidateToolNames,
              usedToolNames: [],
              originalRequest: contextOriginalRequest,
              status: 'failed',
              resultSummary: msg.slice(0, 500),
            }
            setAgentTaskContext(failedContext)
          }
          setError(`Agent 执行失败：${msg}`)
          addTimelineItem({ type: 'error', label: 'Agent 执行失败', detail: msg })
        } finally {
          finishAgentTrace(
            agentDiagnosticRunId,
            requestController.signal.aborted ? 'cancelled' : diagnosticStatus,
            { reason: diagnosticReason, toolCalls: diagnosticToolCalls, stepCount: diagnosticStepCount },
          )
          setAgentScopeContext(null)
          if (activeRequestRef.current?.id === requestId) {
            activeRequestRef.current = null
            cancelRef.current = () => {}
            setStreaming(false)
          }
        }
      }

      if (useAgentMode) {
        await executeAgentRequest()
        return
      }

      setAgentTaskContext(null)
      const client = activeClient
      let ragContext = ''
      let directRagRegistry: SourceReferenceRegistry = { entries: [] }

      // --- 轻量 RAG：仅在规则放行时检索已添加的 ContextTag 文件 ---
      const shouldRag = shouldTriggerScopedRag(content.trim(), contextTags || [])

      if (shouldRag) {
        updateRequestMessage('正在检索本地知识库...')
        addAgentStep({
          type: 'action',
          content: '检索已添加文件的知识库',
          toolName: 'search_knowledge',
          toolArgs: { query: content.trim(), topK: 3 },
          timestamp: Date.now(),
        })
        addTimelineItem({ type: 'local_search_start', label: '检索本地知识库', detail: content.trim() })

        try {
          const scopedKnowledge = await searchScopedKnowledge(
            content.trim(),
            contextTags || [],
            requestController.signal,
            (progress) => {
              if (!isCurrentRequest()) return
              if (progress === 'initializing') {
                setRagStatus('initializing')
                updateRequestMessage('正在初始化索引库…')
                addTimelineItem({ type: 'index_initializing', label: '正在初始化索引库…' })
              } else if (progress === 'ready') {
                setRagStatus('searching')
                updateRequestMessage('索引库已就绪，正在检索…')
                addTimelineItem({ type: 'index_ready', label: '索引库已就绪，正在检索…' })
              } else if (progress === 'fallback') {
                setRagStatus('fallback')
                updateRequestMessage('索引库初始化失败，正在使用关键词检索…')
                addTimelineItem({ type: 'index_fallback', label: '索引库初始化失败，正在使用关键词检索…' })
              } else {
                setRagStatus('searching')
              }
            },
          )
          if (!isCurrentRequest()) return
          if (scopedKnowledge.status === 'empty' && scopedKnowledge.emptyReason) {
            setRagStatus('empty')
            addTimelineItem({
              type: 'local_search_empty',
              label: '当前范围没有可检索文件',
              detail: scopedKnowledge.emptyReason,
            })
            addAgentStep({ type: 'observation', content: '当前上下文没有可检索的文件，跳过本地知识库检索', timestamp: Date.now() })
          } else if (scopedKnowledge.status === 'found') {
            ragContext = scopedKnowledge.context
            directRagRegistry = scopedKnowledge.sourceRegistry
            setRagSources(scopedKnowledge.sources)
            setRagStatus('found')
            addTimelineItem({ type: 'local_search_found', label: '命中本地资料', detail: `${scopedKnowledge.sources.length} 个片段` })
            addAgentStep({ type: 'observation', content: `检索到 ${scopedKnowledge.sources.length} 个本地知识片段`, timestamp: Date.now() })
          } else {
            setRagStatus('empty')
            addTimelineItem({ type: 'local_search_empty', label: '本地资料不足', detail: '继续使用当前对话上下文回答' })
            addAgentStep({ type: 'observation', content: '本地知识库没有命中，继续使用当前对话上下文回答', timestamp: Date.now() })
          }
        } catch (err) {
          if (!isCurrentRequest()) return
          const msg = err instanceof Error ? err.message : String(err)
          console.warn('RAG search failed:', err)
          setRagStatus('error')
          addTimelineItem({ type: 'error', label: '本地知识库检索失败', detail: msg })
          addAgentStep({ type: 'observation', content: `本地知识库检索失败：${msg}`, timestamp: Date.now() })
        }
      }

      // 注入 RAG 上下文和 Memory 上下文
      const injectedContext = buildSupplementalAiContext({
        knowledgeContext: ragContext,
        memoryContext,
      })
      const finalMessages = buildMessagesForModel({
        history: modelHistory,
        userMessage: userMsg,
        supplementalContext: injectedContext,
        customPreferencePrompt: ai.customPreferencePrompt,
        answerMode: resolveAiAnswerMode(selectionRequestKind, useAgentMode),
      })

      const ragMessageSources = directRagRegistry.entries.map((entry) => entry.source)
      const tagMessageSources = routingDecision.readingScope === 'selection'
        ? toContextTagSources(contextTags || [])
        : []
      const messageSources = ragMessageSources.length > 0 ? ragMessageSources : tagMessageSources
      const contextMeta = createContextMeta({
        tagCount: tagMetadata.length,
        ragSourceCount: countRagSourcesInContext(ragContext),
        webSearchUsed: false,
        readingScope: routingDecision.readingScope,
        sourceCoverage: resolveReadingSourceCoverage(
          routingDecision.readingScope,
          [],
          messageSources.length,
        ),
      })
      if (isCurrentRequest()) updateMessageContextMeta(assistantMessageId, contextMeta)
      if (isCurrentRequest() && messageSources.length > 0) {
        updateMessageSources(assistantMessageId, messageSources)
      }

      updateRequestMessage('正在判断处理方式...')
      addTimelineItem({ type: 'answer_streaming', label: '判断处理方式' })

      const directDiagnosticRunId = startAgentTrace({ mode: 'direct', metadata: diagnosticMetadata })
      const directAnswerSpanId = startAgentTraceSpan(directDiagnosticRunId, 'final_answer', { streaming: ai.streamEnabled })
      let directDiagnosticStatus: AgentTraceStatus = 'completed'
      try {
        updateRequestMessage('正在生成回答...')
        addTimelineItem({ type: 'answer_streaming', label: '生成回答' })
        await streamFinalAnswer({
          client,
          messages: finalMessages,
          streamEnabled: ai.streamEnabled,
          onUpdate: updateRequestMessage,
          isCancelled: () => !isCurrentRequest(),
          signal: requestController.signal,
          temperature: ai.temperature,
          reasoningMode,
        })
        finishAgentTraceSpan(directDiagnosticRunId, directAnswerSpanId, isCurrentRequest() ? 'success' : 'cancelled')
        if (!isCurrentRequest()) return
        if (isCurrentRequest()) {
          addTimelineItem({ type: 'done', label: '生成回答完成' })
          // 解析正文中的稳定引用，只更新已确认的来源展示；未引用时保留候选来源。
          const assistantMsg = useChatStore.getState().messages.find((m) => m.id === assistantMessageId)
          if (assistantMsg && directRagRegistry.entries.length > 0) {
            const resolved = resolveDirectRagSources(
              assistantMsg.content,
              directRagRegistry,
              messageSources,
            )
            updateMessageReferencedSourceIds(assistantMessageId, resolved.referencedIds)
          }
        }
        // 异步提取候选记忆（不阻塞用户）
        if (isCurrentRequest()) {
          const allMsgs = useChatStore.getState().messages
          processMemoryCandidateExtraction(allMsgs, client, SYSTEM_TEMPERATURE.memoryExtract, { triggerReason: 'normal_completed', workspacePath }).catch((err) =>
            console.warn('[Memory] extraction failed:', err)
          )
          // 自动保存会话到数据库
          useChatStore.getState().saveCurrentSession().catch((err) =>
            console.warn('[Chat] auto-save failed:', err)
          )
        }
      } catch (err) {
        directDiagnosticStatus = 'error'
        if (!isCurrentRequest()) return
        const msg = err instanceof Error ? err.message : String(err)
        setError(`请求失败：${msg}`)
        addTimelineItem({ type: 'error', label: 'AI 请求失败', detail: msg })
        const partialContent = useChatStore.getState().messages.find(
          (message) => message.id === assistantMessageId
        )?.content.trim()
        if (!partialContent || partialContent.startsWith('正在')) {
          removeMessageById(assistantMessageId)
        }
      } finally {
        finishAgentTrace(
          directDiagnosticRunId,
          requestController.signal.aborted ? 'cancelled' : directDiagnosticStatus,
        )
        if (activeRequestRef.current?.id === requestId) {
          activeRequestRef.current = null
          cancelRef.current = () => {}
          setStreaming(false)
        }
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [streaming, agentMode, ai, ensureClient, workspacePath, agentTaskContext]
  )

  return {
    messages,
    streaming,
    error,
    agentMode,
    ragStatus,
    ragSources,
    timeline,
    sendMessage,
    cancelStream,
    setAgentMode,
  }
}
