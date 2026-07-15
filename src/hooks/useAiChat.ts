import { useCallback, useRef } from 'react'
import { useChatStore } from '@/stores/chatStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { getAiClient, getEmbeddingClient, getEmbeddingConfig, initAiClient, initEmbeddingClient, isAiReady, isEmbeddingReady, isLocalApi } from '@/services/ai/aiClient'
import type { ChatMessage, ChatMessageSource } from '@/services/ai/types'
import { SYSTEM_TEMPERATURE } from '@/services/ai/types'
import { initAgent, runAgent, shouldUseAgent } from '@/services/agent'
import { detectIntentScores, shouldIncludeFullDocumentContext, shouldAllowMemoryWrite } from '@/services/agent/intentDetector'
import { buildCandidateTools } from '@/services/agent/toolSelector'
import type { AgentStep } from '@/services/agent/types'
import type { ContextTag } from '@/types/contextTag'
import { buildContextFromTags } from '@/services/contextBuilder'
import { readFile as readTauriFile } from '@/hooks/useTauri'
import { setAgentScopeContext, type AgentEditTarget } from '@/services/aiScope'
import { searchScopedKnowledge, shouldTriggerScopedRag, streamFinalAnswer } from '@/services/aiChatFlow'
import { buildChatMessageTags, buildMessagesForModel, buildSupplementalAiContext, countRagSourcesInContext, createContextMeta, createUserChatMessage, prepareChatHistoryForModel } from '@/services/aiChatMessages'
import { stripToolCallJson } from '@/services/agent/toolCallParser'
import { buildMemoryContext, classifyMemoryRetrievalIntent, processMemoryCandidateExtraction, searchMemories } from '@/services/memory/memoryService'
import type { Memory } from '@/services/database/persistence'
import type { ManualCapability } from '@/components/ai/ManualToolToggle'
import { hydrateSettingsSecrets } from '@/services/settingsSecrets'

function isCancelLastAppliedEdit(content: string, history: ChatMessage[]): boolean {
  const text = content.trim()
  if (!/^(算了|不改了|还是不改了|别改了|不用改了|先不改了|先别改了)/.test(text)) {
    return false
  }
  return history.some((msg) =>
    msg.content.includes('用户确认并应用了对文件') &&
    msg.content.includes('原文：') &&
    msg.content.includes('新文本：')
  )
}

function getAgentProgressText(step: AgentStep): string {
  if (step.type === 'thought') return 'AI 正在判断下一步处理方式...'
  if (step.type === 'observation') return '工具结果已返回，正在整理下一步...'

  switch (step.toolName) {
    case 'search_knowledge':
      return '正在检索本地知识库索引...'
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
      return '正在读取已授权文件内容...'
    case 'read_selection_context':
      return '正在阅读上下文...'
    case 'replace_current_tab_text':
      return '正在生成文本修改确认卡片...'
    case 'get_current_time':
      return '正在读取当前系统时间...'
    default:
      return step.toolName ? `正在执行工具：${step.toolName}...` : 'Agent 正在执行工具...'
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function sourceFileName(filePath: string, fallback?: string): string {
  return filePath.split(/[/\\]/).pop() || fallback || filePath
}

function extractKnowledgeSourcesFromSteps(steps: AgentStep[]): ChatMessageSource[] {
  const sources: ChatMessageSource[] = []
  const seen = new Set<string>()

  for (const step of steps) {
    if (step.type !== 'observation') continue
    try {
      const parsed = JSON.parse(step.content)
      if (!isPlainObject(parsed) || !Array.isArray(parsed.results)) continue

      for (const item of parsed.results) {
        if (!isPlainObject(item)) continue
        if (
          typeof item.filePath !== 'string'
          || typeof item.startLine !== 'number'
          || typeof item.endLine !== 'number'
        ) {
          continue
        }

        const key = `${item.filePath}:${item.startLine}:${item.endLine}`
        if (seen.has(key)) continue
        seen.add(key)

        sources.push({
          kind: 'local',
          filePath: item.filePath,
          fileName: sourceFileName(item.filePath, typeof item.title === 'string' ? item.title : undefined),
          titlePath: Array.isArray(item.titlePath)
            ? item.titlePath.filter((part): part is string => typeof part === 'string')
            : undefined,
          heading: typeof item.heading === 'string' ? item.heading : undefined,
          startLine: item.startLine,
          endLine: item.endLine,
        })
      }
    } catch {
      // Non-JSON observations are normal for other tools.
    }
  }

  return sources
}

function buildEditTargets(tags: ContextTag[] = []): AgentEditTarget[] {
  return tags
    .filter((tag) =>
      (tag.type === 'selection' || tag.type === 'file')
      && typeof tag.filePath === 'string'
      && tag.filePath.trim().length > 0
    )
    .map((tag, index) => ({
      id: `edit-target-${index + 1}`,
      type: tag.type as 'selection' | 'file',
      title: tag.title,
      filePath: tag.filePath as string,
      selectionFrom: tag.selectionFrom,
      selectionTo: tag.selectionTo,
    }))
}

function buildEditTargetsContext(editTargets: AgentEditTarget[]): string {
  if (editTargets.length === 0) {
    return [
      '【本轮可编辑目标】',
      '无。本轮没有新的 selection 或 file 标签；如用户要求修改文本，只能提示重新添加目标标签。',
    ].join('\n')
  }

  return [
    '【本轮可编辑目标】',
    '以下 targetId 由系统根据本轮新增标签生成，是本轮唯一可用于文本修改确认卡的写授权。需要修改时调用 replace_current_tab_text，并优先传 targetId。',
    ...editTargets.map((target) => [
      `- targetId: ${target.id}`,
      `  type: ${target.type}`,
      `  path: ${target.filePath}`,
      `  title: ${target.title}`,
      typeof target.selectionFrom === 'number' && typeof target.selectionTo === 'number'
        ? `  selectionRange: ${target.selectionFrom}-${target.selectionTo}`
        : '',
    ].filter(Boolean).join('\n')),
  ].join('\n')
}

export function useAiChat() {
  const messages = useChatStore((s) => s.messages)
  const streaming = useChatStore((s) => s.streaming)
  const error = useChatStore((s) => s.error)
  const agentMode = useChatStore((s) => s.agentMode)
  const ragStatus = useChatStore((s) => s.ragStatus)
  const ragSources = useChatStore((s) => s.ragSources)
  const timeline = useChatStore((s) => s.timeline)
  const addMessage = useChatStore((s) => s.addMessage)
  const setStreaming = useChatStore((s) => s.setStreaming)
  const setError = useChatStore((s) => s.setError)
  const addAgentStep = useChatStore((s) => s.addAgentStep)
  const clearAgentSteps = useChatStore((s) => s.clearAgentSteps)
  const setAgentMode = useChatStore((s) => s.setAgentMode)
  const updateMessageContent = useChatStore((s) => s.updateMessageContent)
  const updateMessageContextMeta = useChatStore((s) => s.updateMessageContextMeta)
  const updateMessageSources = useChatStore((s) => s.updateMessageSources)
  const removeMessageById = useChatStore((s) => s.removeMessageById)
  const setRagStatus = useChatStore((s) => s.setRagStatus)
  const setRagSources = useChatStore((s) => s.setRagSources)
  const addTimelineItem = useChatStore((s) => s.addTimelineItem)
  const clearTimeline = useChatStore((s) => s.clearTimeline)
  const ai = useSettingsStore((s) => s.ai)
  const lastConfigRef = useRef('')
  const cancelRef = useRef<() => void>(() => {})
  const activeRequestRef = useRef<{ id: string; assistantMessageId: string; cancelled: boolean } | null>(null)

  const ensureClient = useCallback(async (): Promise<boolean> => {
    let currentAi = useSettingsStore.getState().ai
    if (!currentAi.apiKey) {
      try {
        await hydrateSettingsSecrets()
        currentAi = useSettingsStore.getState().ai
      } catch (err) {
        console.warn('[AI] Settings secret hydration retry failed:', err)
      }
    }

    // 初始化对话客户端（本地 API 无需 apiKey）
    const chatReady = (currentAi.apiKey || isLocalApi(currentAi.baseUrl)) && currentAi.baseUrl && currentAi.chatModel
    if (chatReady) {
      const configKey = `${currentAi.baseUrl}|${currentAi.apiKey}|${currentAi.chatModel}`
      if (configKey !== lastConfigRef.current || !isAiReady()) {
        try {
          initAiClient(currentAi)
          lastConfigRef.current = configKey
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
        try {
          initEmbeddingClient(emb)
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
    async (content: string, forceAgent?: boolean, contextTags?: ContextTag[], manualCapabilities?: ManualCapability[]) => {
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

      // 构建 contextTags 的上下文文本
      let tagContext = ''
      if (hasTags) {
        tagContext = await buildContextFromTags({
          tags: contextTags || [],
          readFile: readTauriFile,
          maxChars: shouldIncludeFullDocumentContext(content) ? 30000 : 8000,
        })
      }

      const tagMetadata = buildChatMessageTags(contextTags || [])
      const userMsg = createUserChatMessage(content, tagContext, tagMetadata)
      if (!isCurrentRequest()) return
      addMessage(userMsg)
      addMessage({
        id: assistantMessageId,
        parentId: userMsg.id,
        role: 'assistant',
        content: '正在准备 AI 请求...',
        timestamp: Date.now(),
      })
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

      // Agent 自动切换：意图检测 + 工具裁剪
      const tagCount = contextTags?.length || 0
      const latestVisibleAssistant = [...messages].reverse().find(
        (msg) => msg.role === 'assistant' && !msg.hidden && !msg.sessionId
      )
      const hasRecentEditContext = Boolean(latestVisibleAssistant?.editConfirmation)

      // 构建应用上下文
      const appContext = {
        hasRecentEdit: hasRecentEditContext,
        hasOpenFile: Boolean(contextTags?.some((tag) => tag.type === 'file')),
        hasSelection: Boolean(contextTags?.some((tag) => tag.type === 'selection')),
        hasContextTags: tagCount > 0,
      }

      // 意图检测
      const intentResult = detectIntentScores(content.trim(), appContext)

      // 合并手动选择的 capabilities
      const manualCapabilitiesSet = new Set(manualCapabilities || [])
      const mergedCandidates = Array.from(new Set([
        ...manualCapabilitiesSet,
        ...intentResult.candidates,
      ]))
      const mergedRequired = Array.from(new Set([
        ...manualCapabilitiesSet,
        ...intentResult.required,
      ]))

      // 构建候选工具
      let candidateToolNames = buildCandidateTools(mergedCandidates)
      const currentEditTargets = buildEditTargets(contextTags || [])
      if (currentEditTargets.length > 0 && candidateToolNames.includes('replace_current_tab_text')) {
        candidateToolNames.unshift('list_current_edit_targets')
      }
      if (candidateToolNames.includes('read_selection_context')) {
        candidateToolNames = [
          'read_selection_context',
          ...candidateToolNames.filter((name) => name !== 'read_selection_context'),
        ]
      }

      // 检查是否需要记忆写入
      const explicitMemoryWriteIntent = shouldAllowMemoryWrite(content.trim())
      if (explicitMemoryWriteIntent && !candidateToolNames.includes('save_memory')) {
        candidateToolNames.push('save_memory', 'list_memories')
      }
      candidateToolNames = Array.from(new Set(candidateToolNames))

      // 判断是否使用 Agent 模式
      const matchesAgentRule = candidateToolNames.length > 0 || isCancelLastAppliedEdit(content, messages)
      const useAgentMode = forceAgent === true || matchesAgentRule

      // --- 预检索优化：并行执行记忆检索和知识库检索 ---
      let memoryContext = ''
      let memoryLookupAttempted = false
      const memoryIntent = classifyMemoryRetrievalIntent(content.trim())
      const shouldLookupMemory = memoryIntent !== 'none'
      const shouldLookupKnowledge = intentResult.candidates.includes('knowledge')

      clearAgentSteps()

      // 并行执行预检索
      const prefetchTasks: Array<Promise<{ type: string; result: unknown }>> = []

      // 记忆预检索
      if (shouldLookupMemory) {
        updateRequestMessage('正在检查长期记忆...')
        addAgentStep({
          type: 'action',
          content: memoryIntent === 'strong' ? '按用户明确记忆意图触发强检索' : '按用户弱记忆意图触发轻量检索',
          toolName: 'search_memory',
          toolArgs: { query: content.trim(), topK: memoryIntent === 'strong' ? 10 : 3 },
          timestamp: Date.now(),
        })

        prefetchTasks.push(
          (async () => {
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
                signal: requestController.signal,
              })
              return { type: 'memory', result: memories }
            } catch (err) {
              console.warn('[Memory] retrieval failed:', err)
              return { type: 'memory', result: [] }
            }
          })()
        )
      }

      // 知识库预检索（如果需要）
      if (shouldLookupKnowledge && useAgentMode) {
        addAgentStep({
          type: 'action',
          content: '预检索本地知识库',
          toolName: 'search_knowledge',
          toolArgs: { query: content.trim(), topK: 5 },
          timestamp: Date.now(),
        })

        prefetchTasks.push(
          (async () => {
            try {
              // 这里可以添加知识库预检索逻辑
              // 目前知识库检索在Agent模式中执行
              return { type: 'knowledge', result: null }
            } catch (err) {
              console.warn('[Knowledge] prefetch failed:', err)
              return { type: 'knowledge', result: null }
            }
          })()
        )
      }

      // 等待所有预检索完成
      if (prefetchTasks.length > 0) {
        const prefetchResults = await Promise.allSettled(prefetchTasks)

        // 处理记忆预检索结果
        const memoryResult = prefetchResults.find(
          r => r.status === 'fulfilled' && r.value.type === 'memory'
        )
        if (memoryResult && memoryResult.status === 'fulfilled') {
          const memories = memoryResult.value.result as Memory[]
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
        }
      }

      const executeAgentRequest = async () => {
        clearAgentSteps()
        initAgent()
        updateRequestMessage('Agent 正在规划工具链路...')
        addTimelineItem({ type: 'local_search_start', label: 'Agent 开始规划工具链路' })
        let pendingEditCount = 0
        let liveAgentStepCount = 0
        const handleLiveAgentStep = (step: AgentStep) => {
          if (!isCurrentRequest()) return
          liveAgentStepCount++
          addAgentStep(step)
          updateRequestMessage(getAgentProgressText(step))
          if (step.type === 'action' && step.toolName === 'search_knowledge') {
            addTimelineItem({ type: 'local_search_start', label: '检索本地知识库索引' })
          } else if (step.type === 'action' && step.toolName === 'read_selection_context') {
            addTimelineItem({ type: 'local_search_start', label: '正在阅读上下文' })
          } else if (step.type === 'action' && step.toolName === 'web_search') {
            addTimelineItem({ type: 'web_search_start', label: '执行联网搜索' })
          } else if (step.type === 'action' && step.toolName === 'search_memory') {
            addTimelineItem({ type: 'local_search_start', label: '读取长期记忆库' })
          } else if (step.type === 'action' && step.toolName === 'save_memory') {
            addTimelineItem({ type: 'local_search_start', label: '写入长期记忆库' })
          } else if (step.type === 'action' && step.toolName === 'list_database_contents') {
            addTimelineItem({ type: 'local_search_start', label: '查看知识库索引概览' })
          } else if (step.type === 'action' && step.toolName === 'list_memories') {
            addTimelineItem({ type: 'local_search_start', label: '查看记忆库概览' })
          } else if (step.type === 'observation') {
            addTimelineItem({ type: 'web_search_done', label: '工具结果已返回' })
            try {
              const parsed = JSON.parse(step.content)
              if (parsed.__pendingEdit) {
                const targetMessageId = pendingEditCount === 0
                  ? assistantMessageId
                  : `assistant-${requestId}-edit-${pendingEditCount}`
                if (pendingEditCount > 0) {
                  addMessage({
                    id: targetMessageId,
                    parentId: userMsg.id,
                    role: 'assistant',
                    content: '已生成修改确认卡片，请在下方确认。',
                    timestamp: Date.now(),
                  })
                }
                pendingEditCount++
                useChatStore.getState().setPendingEdit({
                  id: `edit-${Date.now()}`,
                  messageId: targetMessageId,
                  oldText: parsed.oldText,
                  newText: parsed.newText,
                  tabId: parsed.tabId,
                  tabTitle: parsed.tabTitle,
                  replaceFrom: parsed.replaceFrom,
                  replaceTo: parsed.replaceTo,
                  replaceWholeDocument: parsed.replaceWholeDocument,
                  changeSummary: parsed.changeSummary,
                  selectionFrom: parsed.selectionFrom,
                  selectionTo: parsed.selectionTo,
                  status: 'pending',
                })
              }
            } catch { /* 不是 pendingEdit JSON，忽略 */ }
          }
        }

        // Agent 查询复用本轮预检索到的只读记忆上下文，避免普通转 Agent 后重复检索。
        const editTargets = currentEditTargets
        const editTargetsContext = buildEditTargetsContext(editTargets)
        const agentContext = [tagContext, editTargetsContext, memoryContext].filter(Boolean).join('\n\n')
        const normalizedUserIntent = explicitMemoryWriteIntent
          ? `记住：${content.trim()}`
          : content.trim()
        const agentUserQuery = content.trim() || '请根据我提供的上下文继续。'

        try {
          setAgentScopeContext({ contextTags: contextTags || [], editTargets })
          const result = await runAgent(
            agentUserQuery,
            prepareChatHistoryForModel(messages),
            {},
            normalizedUserIntent,
            hasRecentEditContext,
            Boolean(contextTags?.some((tag) => tag.type === 'selection' || tag.type === 'file')),
            contextTags?.filter((tag) => tag.type === 'selection' || tag.type === 'file').length || 0,
            candidateToolNames,
            memoryLookupAttempted,
            requestController.signal,
            SYSTEM_TEMPERATURE.agentPlanning,
            handleLiveAgentStep,
            mergedRequired,
            agentContext,
            ai.customPreferencePrompt,
            ai.streamEnabled
          )
          if (!isCurrentRequest()) return
          for (const step of result.steps.slice(liveAgentStepCount)) {
            if (!isCurrentRequest()) return
            addAgentStep(step)
            if (step.type === 'action' && step.toolName === 'search_knowledge') {
              addTimelineItem({ type: 'local_search_start', label: '检索本地知识库' })
              } else if (step.type === 'action' && step.toolName === 'read_selection_context') {
                addTimelineItem({ type: 'local_search_start', label: '正在阅读上下文' })
              } else if (step.type === 'action' && step.toolName === 'web_search') {
                addTimelineItem({ type: 'web_search_start', label: '联网搜索' })
              } else if (step.type === 'action' && step.toolName === 'search_memory') {
                addTimelineItem({ type: 'local_search_start', label: '读取长期记忆（敏感）' })
              } else if (step.type === 'action' && step.toolName === 'save_memory') {
                addTimelineItem({ type: 'local_search_start', label: '写入长期记忆（敏感）' })
              } else if (step.type === 'action' && step.toolName === 'list_database_contents') {
                addTimelineItem({ type: 'local_search_start', label: '查看本地数据库概览（敏感）' })
              } else if (step.type === 'observation') {
              addTimelineItem({ type: 'web_search_done', label: '信息检索完成' })
              // 检测 pendingEdit 工具结果
              try {
                const parsed = JSON.parse(step.content)
                if (parsed.__pendingEdit) {
                  console.log('[useAiChat] pendingEdit detected:', parsed)
                  const targetMessageId = pendingEditCount === 0
                    ? assistantMessageId
                    : `assistant-${requestId}-edit-${pendingEditCount}`
                  if (pendingEditCount > 0) {
                    addMessage({
                      id: targetMessageId,
                      parentId: userMsg.id,
                      role: 'assistant',
                      content: '已生成修改确认卡片，请在下方确认。',
                      timestamp: Date.now(),
                    })
                  }
                  pendingEditCount++
                  useChatStore.getState().setPendingEdit({
                    id: `edit-${Date.now()}`,
                    messageId: targetMessageId,
                    oldText: parsed.oldText,
                    newText: parsed.newText,
                    tabId: parsed.tabId,
                    tabTitle: parsed.tabTitle,
                    replaceFrom: parsed.replaceFrom,
                    replaceTo: parsed.replaceTo,
                    replaceWholeDocument: parsed.replaceWholeDocument,
                    changeSummary: parsed.changeSummary,
                    selectionFrom: parsed.selectionFrom,
                    selectionTo: parsed.selectionTo,
                    status: 'pending',
                  })
                }
              } catch { /* 不是 pendingEdit JSON，忽略 */ }
            }
          }
          const agentSources = result.sources?.length
            ? result.sources
            : extractKnowledgeSourcesFromSteps(result.steps)
          const updateAgentSourceMetadata = () => {
            if (!isCurrentRequest()) return
            const filteredSources = agentSources
            updateMessageContextMeta(assistantMessageId, createContextMeta({
              tagCount: tagMetadata.length,
              ragSourceCount: filteredSources.length,
              webSearchUsed: result.steps.some((s) => s.type === 'action' && s.toolName === 'web_search'),
            }))
            if (filteredSources.length > 0) updateMessageSources(assistantMessageId, filteredSources)
          }

          if (result.finalMessages) {
            const client = getAiClient()
            const finalAnswerMessages = [
              ...result.finalMessages,
              {
                role: 'user' as const,
                content: '如果工具结果不足、记忆不确定、数据不存在或证据太弱，必须明确说不确定或当前信息不足，禁止脑补。',
              },
            ]
            updateRequestMessage('正在生成最终回答...')
            addTimelineItem({ type: 'answer_streaming', label: '生成最终回答' })

            await streamFinalAnswer({
              client,
              messages: finalAnswerMessages,
              streamEnabled: ai.streamEnabled,
              onUpdate: (answer) => updateRequestMessage(stripToolCallJson(answer)),
              isCancelled: () => !isCurrentRequest(),
              filterToolJson: true,
              signal: requestController.signal,
              temperature: SYSTEM_TEMPERATURE.agentPlanning,
            })

            if (!isCurrentRequest()) {
              addTimelineItem({ type: 'error', label: '已停止生成最终回答' })
              return
            }
            updateAgentSourceMetadata()
          } else {
            // 过滤工具调用 JSON 后再存入消息
            const cleanAnswer = stripToolCallJson(result.answer)
            updateRequestMessage(cleanAnswer || '已生成修改确认卡片，请在下方确认。')
            updateAgentSourceMetadata()
          }
          addTimelineItem({ type: 'done', label: '生成回答完成' })
          // 异步提取候选记忆（Agent 模式）
          if (isCurrentRequest()) {
            const allMsgs = useChatStore.getState().messages
            const agentClient = getAiClient()
            processMemoryCandidateExtraction(allMsgs, agentClient, SYSTEM_TEMPERATURE.memoryExtract, { triggerReason: 'agent_completed' }).catch((err) =>
              console.warn('[Memory] extraction failed:', err)
            )
            // 自动保存会话到数据库
            useChatStore.getState().saveCurrentSession().catch((err) =>
              console.warn('[Chat] auto-save failed:', err)
            )
          }
        } catch (err) {
          if (!isCurrentRequest()) return
          const msg = err instanceof Error ? err.message : String(err)
          setError(`Agent 执行失败：${msg}`)
          addTimelineItem({ type: 'error', label: 'Agent 执行失败', detail: msg })
        } finally {
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

      const client = getAiClient()
      let ragContext = ''

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
        setRagStatus('searching')
        addTimelineItem({ type: 'local_search_start', label: '检索本地知识库', detail: content.trim() })

        try {
          const scopedKnowledge = await searchScopedKnowledge(content.trim(), contextTags || [], requestController.signal)
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
        history: prepareChatHistoryForModel(messages),
        userMessage: userMsg,
        supplementalContext: injectedContext,
        customPreferencePrompt: ai.customPreferencePrompt,
      })

      const contextMeta = createContextMeta({
        tagCount: tagMetadata.length,
        ragSourceCount: countRagSourcesInContext(ragContext),
        webSearchUsed: false,
      })
      if (isCurrentRequest()) updateMessageContextMeta(assistantMessageId, contextMeta)
      const messageSources = useChatStore.getState().ragSources.map((source) => ({
        kind: 'local' as const,
        filePath: source.filePath,
        fileName: source.fileName,
        titlePath: source.titlePath,
        heading: source.heading,
        startLine: source.startLine,
        endLine: source.endLine,
      }))
      if (isCurrentRequest() && messageSources.length > 0) {
        updateMessageSources(assistantMessageId, messageSources)
      }

      updateRequestMessage('正在判断处理方式...')
      addTimelineItem({ type: 'answer_streaming', label: '判断处理方式' })

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
        })
        if (!isCurrentRequest()) return
        if (isCurrentRequest()) addTimelineItem({ type: 'done', label: '生成回答完成' })
        // 异步提取候选记忆（不阻塞用户）
        if (isCurrentRequest()) {
          const allMsgs = useChatStore.getState().messages
          processMemoryCandidateExtraction(allMsgs, client, SYSTEM_TEMPERATURE.memoryExtract, { triggerReason: 'normal_completed' }).catch((err) =>
            console.warn('[Memory] extraction failed:', err)
          )
          // 自动保存会话到数据库
          useChatStore.getState().saveCurrentSession().catch((err) =>
            console.warn('[Chat] auto-save failed:', err)
          )
        }
      } catch (err) {
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
        if (activeRequestRef.current?.id === requestId) {
          activeRequestRef.current = null
          cancelRef.current = () => {}
          setStreaming(false)
        }
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [streaming, agentMode, ai, ensureClient]
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
