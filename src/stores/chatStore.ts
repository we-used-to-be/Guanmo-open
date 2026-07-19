import { create } from 'zustand'
import type { ChatMessage, ChatMessageContextMeta, ChatMessageSource, EditConfirmation } from '@/services/ai/types'
import type { AgentStep } from '@/services/agent/types'
import type { ContextTag } from '@/types/contextTag'
import { MAX_CONTEXT_TAGS } from '@/types/contextTag'
import { useEditorStore } from './editorStore'
import {
  persistChatSession,
  persistChatMessage,
  loadRecentChatTurns,
} from '@/services/database/persistence'
import { normalizeStoredDisplayContent } from '@/services/aiChatMessages'
import { buildLinkedQaRows } from '@/services/chatHistory'

const MAX_MESSAGES = 100
const HISTORY_QA_GROUP_SIZE = 5

export type RagStatus = 'idle' | 'searching' | 'found' | 'empty' | 'error'
export type TimelineType =
  | 'local_search_start'
  | 'local_search_found'
  | 'local_search_empty'
  | 'web_search_start'
  | 'web_search_done'
  | 'answer_streaming'
  | 'done'
  | 'error'

export interface TimelineItem {
  id: string
  type: TimelineType
  label: string
  detail?: string
  timestamp: number
}

export interface RagSource {
  title: string
  filePath: string
  fileName: string
  titlePath?: string[]
  heading?: string
  score: number
  startLine: number
  endLine: number
}

export type PendingEdit = EditConfirmation

interface ChatState {
  messages: ChatMessage[]
  streaming: boolean
  error: string | null
  agentMode: boolean
  agentSteps: AgentStep[]
  ragStatus: RagStatus
  ragSources: RagSource[]
  timeline: TimelineItem[]
  draftInput: string
  contextTags: ContextTag[]
  pendingEdit: PendingEdit | null
  currentSessionId: string
  historyOffset: number
  hasMoreHistory: boolean

  addMessage: (msg: ChatMessage) => void
  updateLastAssistantMessage: (content: string) => void
  updateMessageContent: (id: string, content: string) => void
  updateMessageContextMeta: (id: string, contextMeta: ChatMessageContextMeta) => void
  updateMessageSources: (id: string, sources: ChatMessageSource[]) => void
  removeLastMessage: () => void
  removeMessageById: (id: string) => void
  setStreaming: (v: boolean) => void
  setError: (err: string | null) => void
  clearMessages: () => void
  setAgentMode: (v: boolean) => void
  addAgentStep: (step: AgentStep) => void
  clearAgentSteps: () => void
  setRagStatus: (status: RagStatus) => void
  setRagSources: (sources: RagSource[]) => void
  addTimelineItem: (item: Omit<TimelineItem, 'id' | 'timestamp'> & { timestamp?: number }) => void
  clearTimeline: () => void
  setDraftInput: (content: string) => void
  appendDraftInput: (content: string) => void
  addContextTag: (tag: Omit<ContextTag, 'id'>) => void
  removeContextTag: (id: string) => void
  clearContextTags: () => void
  setPendingEdit: (edit: PendingEdit | null) => void
  applyPendingEdit: (editId?: string) => void
  rejectPendingEdit: (editId?: string) => void
  createUndoPendingEdit: (editId: string) => void
  saveCurrentSession: () => Promise<void>
  loadMoreHistory: () => Promise<void>
}

function createSessionId(): string {
  return `session-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

export const useChatStore = create<ChatState>((set, get) => ({
  messages: [],
  streaming: false,
  error: null,
  agentMode: false,
  agentSteps: [],
  ragStatus: 'idle',
  ragSources: [],
  timeline: [],
  draftInput: '',
  contextTags: [],
  pendingEdit: null,
  currentSessionId: createSessionId(),
  historyOffset: 0,
  hasMoreHistory: true,

  addMessage: (msg) => set((s) => {
    const nextMessages = [...s.messages, msg]
    if (nextMessages.length > MAX_MESSAGES) {
      return { messages: nextMessages.slice(-MAX_MESSAGES) }
    }
    return { messages: nextMessages }
  }),

  updateLastAssistantMessage: (content) => set((s) => {
    const nextMessages = [...s.messages]
    for (let i = nextMessages.length - 1; i >= 0; i -= 1) {
      if (nextMessages[i].role === 'assistant') {
        nextMessages[i] = { ...nextMessages[i], content }
        break
      }
    }
    return { messages: nextMessages }
  }),

  updateMessageContent: (id, content) => set((s) => {
    const current = s.messages.find((msg) => msg.id === id)
    if (!current || current.content === content) return s
    return {
      messages: s.messages.map((msg) => (msg.id === id ? { ...msg, content } : msg)),
    }
  }),

  updateMessageContextMeta: (id, contextMeta) => set((s) => ({
    messages: s.messages.map((msg) => (msg.id === id ? { ...msg, contextMeta } : msg)),
  })),

  updateMessageSources: (id, sources) => set((s) => ({
    messages: s.messages.map((msg) => (msg.id === id ? { ...msg, sources } : msg)),
  })),

  removeLastMessage: () => set((s) => {
    if (s.messages.length === 0) return s
    return { messages: s.messages.slice(0, -1) }
  }),

  removeMessageById: (id) => set((s) => ({
    messages: s.messages.filter((msg) => msg.id !== id),
  })),

  setStreaming: (v) => set({ streaming: v }),
  setError: (err) => set({ error: err }),

  clearMessages: () => set({
    messages: [],
    error: null,
    agentMode: false,
    agentSteps: [],
    ragStatus: 'idle',
    ragSources: [],
    timeline: [],
    draftInput: '',
    contextTags: [],
    pendingEdit: null,
    currentSessionId: createSessionId(),
    historyOffset: 0,
    hasMoreHistory: true,
  }),

  setAgentMode: (v) => set({ agentMode: v }),
  addAgentStep: (step) => set((s) => ({ agentSteps: [...s.agentSteps, step] })),
  clearAgentSteps: () => set({ agentSteps: [] }),
  setRagStatus: (status) => set({ ragStatus: status }),
  setRagSources: (sources) => set({ ragSources: sources }),
  addTimelineItem: (item) => set((s) => ({
    timeline: [
      ...s.timeline,
      {
        ...item,
        id: `timeline-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        timestamp: item.timestamp ?? Date.now(),
      },
    ],
  })),
  clearTimeline: () => set({ timeline: [] }),
  setDraftInput: (content) => set({ draftInput: content }),
  appendDraftInput: (content) => set((s) => ({
    draftInput: s.draftInput.trim()
      ? `${s.draftInput.trimEnd()}\n\n${content}`
      : content,
  })),

  addContextTag: (tag) => set((s) => {
    if (s.contextTags.length >= MAX_CONTEXT_TAGS) return s

    const isDuplicate = s.contextTags.some((current) => {
      if (current.type !== tag.type) return false
      if (current.type === 'file' && tag.type === 'file') {
        return Boolean(current.filePath && tag.filePath && current.filePath === tag.filePath)
      }
      if (current.type === 'folder' && tag.type === 'folder') {
        return Boolean(current.folderPath && tag.folderPath && current.folderPath === tag.folderPath)
      }
      if (current.type === 'selection' && tag.type === 'selection') {
        return (
          current.filePath === tag.filePath
          && current.startLine === tag.startLine
          && current.endLine === tag.endLine
          && current.content === tag.content
        )
      }
      return false
    })
    if (isDuplicate) return s

    const id = `tag-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
    return { contextTags: [...s.contextTags, { ...tag, id }] }
  }),

  removeContextTag: (id) => set((s) => ({
    contextTags: s.contextTags.filter((tag) => tag.id !== id),
  })),
  clearContextTags: () => set({ contextTags: [] }),

  setPendingEdit: (edit) => set((s) => ({
    pendingEdit: edit,
    messages: edit?.messageId
      ? s.messages.map((msg) => (
          msg.id === edit.messageId ? { ...msg, editConfirmation: edit } : msg
        ))
      : s.messages,
  })),

  applyPendingEdit: (editId) => {
    let applied = false

    set((s) => {
      const pendingEdit = editId
        ? s.messages.find((msg) => msg.editConfirmation?.id === editId)?.editConfirmation
        : s.pendingEdit
      if (!pendingEdit || pendingEdit.status !== 'pending') return s

      const { tabId, newText } = pendingEdit
      const editorState = useEditorStore.getState()
      const tab = editorState.tabs.find((current) => current.id === tabId)

      if (tab) {
        const { replaceFrom, replaceTo } = pendingEdit
        const index = typeof replaceFrom === 'number' && typeof replaceTo === 'number'
          ? (tab.content.slice(replaceFrom, replaceTo) === pendingEdit.oldText ? replaceFrom : -1)
          : -1

        if (index >= 0) {
          const nextContent = `${tab.content.slice(0, index)}${newText}${tab.content.slice(index + pendingEdit.oldText.length)}`
          editorState.updateTabContent(tabId, nextContent)
          applied = true
        }
      }

      if (!applied) {
        return {
          error: '修改未应用：目标文本已变化，请重新发起修改确认。',
        }
      }

      const confirmMessage: ChatMessage = {
        role: 'user',
        content: [
          `[系统] 用户确认并应用了对文件《${pendingEdit.tabTitle}》的文本修改。`,
          `原文：\n${pendingEdit.oldText}`,
          `新文本：\n${pendingEdit.newText}`,
          '该记录仅用于理解上下文，不提供后续修改授权。若继续修改，请重新添加目标 tag。',
        ].join('\n\n'),
        timestamp: Date.now(),
        hidden: true,
      }

      const appliedEdit: PendingEdit = {
        ...pendingEdit,
        status: 'applied',
        ...(typeof pendingEdit.replaceFrom === 'number'
          ? { replaceTo: pendingEdit.replaceFrom + newText.length }
          : {}),
      }
      const nextMessages = [...s.messages, confirmMessage].map((msg) => (
        msg.id === appliedEdit.messageId ? { ...msg, editConfirmation: appliedEdit } : msg
      ))
      const nextPendingEdit = [...nextMessages]
        .reverse()
        .find((msg) => msg.editConfirmation?.status === 'pending')
        ?.editConfirmation || appliedEdit

      return {
        pendingEdit: nextPendingEdit,
        messages: nextMessages.length > MAX_MESSAGES ? nextMessages.slice(-MAX_MESSAGES) : nextMessages,
      }
    })

    if (applied) {
      void get().saveCurrentSession().catch((err) => {
        console.warn('[Chat] save edit confirmation failed:', err)
      })
    }
  },

  rejectPendingEdit: (editId) => {
    set((s) => {
      const pendingEdit = editId
        ? s.messages.find((msg) => msg.editConfirmation?.id === editId)?.editConfirmation
        : s.pendingEdit
      if (!pendingEdit || pendingEdit.status !== 'pending') return s

      const rejectMessage: ChatMessage = {
        role: 'user',
        content: `[系统] 用户拒绝了对文件《${pendingEdit.tabTitle}》的文本修改。`,
        timestamp: Date.now(),
        hidden: true,
      }
      const rejectedEdit: PendingEdit = { ...pendingEdit, status: 'rejected' }
      const nextMessages = [...s.messages, rejectMessage].map((msg) => (
        msg.id === rejectedEdit.messageId ? { ...msg, editConfirmation: rejectedEdit } : msg
      ))
      const nextPendingEdit = [...nextMessages]
        .reverse()
        .find((msg) => msg.editConfirmation?.status === 'pending')
        ?.editConfirmation || rejectedEdit

      return {
        pendingEdit: nextPendingEdit,
        messages: nextMessages.length > MAX_MESSAGES ? nextMessages.slice(-MAX_MESSAGES) : nextMessages,
      }
    })

    void get().saveCurrentSession().catch((err) => {
      console.warn('[Chat] save edit rejection failed:', err)
    })
  },

  createUndoPendingEdit: (editId) => set((s) => {
    const targetMessage = s.messages.find((msg) => msg.editConfirmation?.id === editId)
    const edit = targetMessage?.editConfirmation
    if (!edit || edit.status !== 'applied') return s

    const undoId = `undo-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
    const undoMessageId = `assistant-${undoId}`
    const undoEdit: PendingEdit = {
      ...edit,
      id: undoId,
      messageId: undoMessageId,
      oldText: edit.newText,
      newText: edit.oldText,
      replaceWholeDocument: edit.replaceWholeDocument,
      changeSummary: `撤销修改：将恢复 ${edit.oldText.length} 字符的原文`,
      status: 'pending',
    }
    const assistantMessage: ChatMessage = {
      id: undoMessageId,
      role: 'assistant',
      content: '已根据你的撤销操作生成反向修改确认卡片，请确认是否恢复到修改前内容。',
      timestamp: Date.now(),
      editConfirmation: undoEdit,
    }
    const nextMessages = [...s.messages, assistantMessage]

    return {
      pendingEdit: undoEdit,
      messages: nextMessages.length > MAX_MESSAGES ? nextMessages.slice(-MAX_MESSAGES) : nextMessages,
    }
  }),

  saveCurrentSession: async () => {
    const state = get()
    const sessionId = state.currentSessionId
    const visibleMessages = state.messages.filter(
      (msg) => !msg.hidden && (!msg.sessionId || msg.sessionId === sessionId)
    )
    if (visibleMessages.length === 0) return

    const assignedIds = new Map<ChatMessage, string>()
    const normalizedVisibleMessages = visibleMessages.map((msg, index) => {
      if (msg.id) return msg
      const nextId = `msg-${sessionId}-${index}-${msg.timestamp ?? Date.now()}`
      assignedIds.set(msg, nextId)
      return { ...msg, id: nextId }
    })

    if (assignedIds.size > 0) {
      set((s) => ({
        messages: s.messages.map((msg) => (
          assignedIds.has(msg) ? { ...msg, id: assignedIds.get(msg)! } : msg
        )),
      }))
    }

    const firstUserMessage = normalizedVisibleMessages.find((msg) => msg.role === 'user')
    const title = firstUserMessage
      ? (firstUserMessage.displayContent || firstUserMessage.content).slice(0, 30).replace(/\n/g, ' ')
      : '新对话'

    await persistChatSession({ id: sessionId, title })

    for (const msg of normalizedVisibleMessages) {
      const metadata: Record<string, unknown> = {}
      if (msg.tags?.length) metadata.tags = msg.tags
      if (msg.displayContent) metadata.displayContent = msg.displayContent
      if (msg.contextMeta) metadata.contextMeta = msg.contextMeta
      if (msg.sources?.length) metadata.sources = msg.sources
      if (msg.editConfirmation) metadata.editConfirmation = msg.editConfirmation

      await persistChatMessage({
        id: msg.id!,
        sessionId,
        parentId: msg.parentId,
        role: msg.role,
        content: msg.content,
        metadata: Object.keys(metadata).length > 0 ? JSON.stringify(metadata) : undefined,
        createdAt: msg.timestamp,
      })
    }

    if (!get().hasMoreHistory) {
      set({ hasMoreHistory: true })
    }
  },

  loadMoreHistory: async () => {
    const state = get()
    if (!state.hasMoreHistory) return

    const rows = await loadRecentChatTurns(state.historyOffset, HISTORY_QA_GROUP_SIZE)

    if (rows.length === 0) {
      set({ hasMoreHistory: false })
      return
    }

    const historyMessages = buildCompleteQaMessages(rows)
    const loadedTurnCount = historyMessages.length / 2
    set((s) => ({
      messages: [
        ...historyMessages.filter((msg) => !s.messages.some((current) => current.id === msg.id)),
        ...s.messages,
      ],
      historyOffset: s.historyOffset + loadedTurnCount,
      hasMoreHistory: loadedTurnCount === HISTORY_QA_GROUP_SIZE,
    }))
  },
}))

type LoadedChatMessageRow = Awaited<ReturnType<typeof loadRecentChatTurns>>[number]

function buildCompleteQaMessages(rows: LoadedChatMessageRow[]): ChatMessage[] {
  return buildLinkedQaRows(rows).map(toChatMessage)
}

function toChatMessage(row: LoadedChatMessageRow): ChatMessage {
  let tags: ChatMessage['tags']
  let displayContent: string | undefined
  let contextMeta: ChatMessageContextMeta | undefined
  let sources: ChatMessageSource[] | undefined
  let editConfirmation: EditConfirmation | undefined

  if (row.metadata) {
    try {
      const meta = JSON.parse(row.metadata)
      tags = sanitizeMessageTags(meta.tags)
      displayContent = typeof meta.displayContent === 'string' ? meta.displayContent : undefined
      contextMeta = sanitizeContextMeta(meta.contextMeta)
      sources = sanitizeMessageSources(meta.sources)
      editConfirmation = sanitizeEditConfirmation(meta.editConfirmation)
    } catch {
      // ignore corrupted metadata
    }
  }

  displayContent = normalizeStoredDisplayContent(row.content, displayContent, Boolean(tags?.length))

  return {
    id: row.id,
    parentId: row.parent_id ?? undefined,
    role: row.role as 'system' | 'user' | 'assistant',
    content: row.content,
    timestamp: row.created_at > 100000000000 ? row.created_at : row.created_at * 1000,
    tags,
    displayContent,
    contextMeta,
    sources,
    editConfirmation,
    sessionId: row.session_id,
    sessionTitle: row.session_title,
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function sanitizeMessageSources(value: unknown): ChatMessageSource[] | undefined {
  if (!Array.isArray(value)) return undefined

  const normalized = value.flatMap((item): ChatMessageSource[] => {
    if (!isPlainObject(item)) return []
    if (item.kind === 'web') {
      if (typeof item.url !== 'string') return []
      return [{
        kind: 'web' as const,
        title: typeof item.title === 'string' && item.title.trim() ? item.title : item.url,
        url: item.url,
        siteName: typeof item.siteName === 'string' ? item.siteName : undefined,
        publishedAt: typeof item.publishedAt === 'string' ? item.publishedAt : undefined,
        snippet: typeof item.snippet === 'string' ? item.snippet : undefined,
      }]
    }
    if (
      typeof item.filePath !== 'string'
      || typeof item.fileName !== 'string'
      || typeof item.startLine !== 'number'
      || typeof item.endLine !== 'number'
    ) {
      return []
    }

    return [{
      kind: 'local' as const,
      filePath: item.filePath,
      fileName: item.fileName,
      titlePath: Array.isArray(item.titlePath)
        ? item.titlePath.filter((part): part is string => typeof part === 'string')
        : undefined,
      heading: typeof item.heading === 'string' ? item.heading : undefined,
      startLine: item.startLine,
      endLine: item.endLine,
    }]
  })

  return normalized.length > 0 ? normalized : undefined
}

function sanitizeMessageTags(value: unknown): ChatMessage['tags'] {
  if (!Array.isArray(value)) return undefined

  const normalized = value.flatMap((item) => {
    if (!isPlainObject(item)) return []
    const type = item.type
    const title = item.title
    if (
      typeof type !== 'string'
      || typeof title !== 'string'
      || !['file', 'selection', 'folder', 'memory', 'web'].includes(type)
    ) {
      return []
    }

    return [{
      type: type as NonNullable<ChatMessage['tags']>[number]['type'],
      title,
      filePath: typeof item.filePath === 'string' ? item.filePath : null,
      folderPath: typeof item.folderPath === 'string' ? item.folderPath : undefined,
      content: typeof item.content === 'string' || item.content === null ? item.content : undefined,
      preview: typeof item.preview === 'string' ? item.preview : title,
      startLine: typeof item.startLine === 'number' ? item.startLine : undefined,
      endLine: typeof item.endLine === 'number' ? item.endLine : undefined,
      selectionFrom: typeof item.selectionFrom === 'number' ? item.selectionFrom : undefined,
      selectionTo: typeof item.selectionTo === 'number' ? item.selectionTo : undefined,
    }]
  })

  return normalized.length > 0 ? normalized : undefined
}

function sanitizeContextMeta(value: unknown): ChatMessageContextMeta | undefined {
  if (!isPlainObject(value)) return undefined
  if (
    typeof value.tagCount !== 'number'
    || typeof value.ragSourceCount !== 'number'
    || typeof value.webSearchUsed !== 'boolean'
  ) {
    return undefined
  }
  return {
    tagCount: value.tagCount,
    ragSourceCount: value.ragSourceCount,
    webSearchUsed: value.webSearchUsed,
  }
}

function sanitizeEditConfirmation(value: unknown): EditConfirmation | undefined {
  if (!isPlainObject(value)) return undefined
  if (
    typeof value.id !== 'string'
    || typeof value.oldText !== 'string'
    || typeof value.newText !== 'string'
    || typeof value.tabId !== 'string'
    || typeof value.tabTitle !== 'string'
    || !['pending', 'applied', 'rejected'].includes(String(value.status))
  ) {
    return undefined
  }

  return {
    id: value.id,
    messageId: typeof value.messageId === 'string' ? value.messageId : undefined,
    oldText: value.oldText,
    newText: value.newText,
    tabId: value.tabId,
    tabTitle: value.tabTitle,
    replaceFrom: typeof value.replaceFrom === 'number' ? value.replaceFrom : undefined,
    replaceTo: typeof value.replaceTo === 'number' ? value.replaceTo : undefined,
    replaceWholeDocument: typeof value.replaceWholeDocument === 'boolean' ? value.replaceWholeDocument : undefined,
    changeSummary: typeof value.changeSummary === 'string' ? value.changeSummary : undefined,
    selectionFrom: typeof value.selectionFrom === 'number' ? value.selectionFrom : undefined,
    selectionTo: typeof value.selectionTo === 'number' ? value.selectionTo : undefined,
    status: value.status as EditConfirmation['status'],
  }
}
