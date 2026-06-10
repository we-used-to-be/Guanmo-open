import { registerTool } from './toolRegistry'
import { searchRelevant, getKnowledgeDocumentStates, getKnowledgeIndexStateSummary, getRagStatsAsync } from '@/services/rag/pipeline'
import type { SearchResult } from '@/services/rag/types'
import { webSearch, buildSearchContext, updateSearchConfig } from '@/services/webSearch'
import { useEditorStore, type Tab } from '@/stores/editorStore'
import { useChatStore } from '@/stores/chatStore'
import { getAgentScopeContext } from '@/services/aiScope'
import type { ContextTag } from '@/types/contextTag'
import type { ChatMessage, ChatMessageTag } from '@/services/ai/types'
import { searchMemories, buildMemoryContext, upsertExplicitMemory } from '@/services/memory/memoryService'
import { loadAllMemories, listEmbeddingJobs } from '@/services/database/persistence'
import { readFile } from '@/hooks/useTauri'
import type { TextRange } from './editTarget'
import { normalizeFilePath } from '@/services/pathIdentity'
import { useSettingsStore } from '@/stores/settingsStore'
import { getEmbeddingClient, isEmbeddingReady } from '@/services/ai/aiClient'

function validateString(value: unknown, name: string): string | null {
  if (!value || typeof value !== 'string') {
    return `参数 "${name}" 必须是非空字符串`
  }
  return null
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.max(min, Math.min(max, Math.round(value)))
}

function isInsideFolder(filePath: string, folderPath: string): boolean {
  const file = normalizeFilePath(filePath)
  const folder = normalizeFilePath(folderPath)
  return file === folder || file.startsWith(`${folder}/`)
}

function canReadPathInContextTags(path: string, contextTags: ContextTag[]): boolean {
  return contextTags.some((tag) => {
    if (tag.filePath && normalizeFilePath(tag.filePath) === normalizeFilePath(path)) return true
    if (tag.folderPath && isInsideFolder(path, tag.folderPath)) return true
    return false
  })
}

function canEditPathInContextTags(path: string, contextTags: ContextTag[]): boolean {
  return contextTags.some((tag) =>
    (tag.type === 'selection' || tag.type === 'file')
    && typeof tag.filePath === 'string'
    && normalizeFilePath(tag.filePath) === normalizeFilePath(path)
  )
}

interface AuthorizedContextTag {
  tag: ContextTag
  sourceMessage?: ChatMessage
}

function toContextTag(tag: ChatMessageTag, index: number): ContextTag {
  return {
    id: `message-tag-${index}`,
    type: tag.type,
    title: tag.title,
    filePath: tag.filePath,
    folderPath: tag.folderPath,
    content: tag.content ?? null,
    preview: tag.preview,
    startLine: tag.startLine,
    endLine: tag.endLine,
    selectionFrom: tag.selectionFrom,
    selectionTo: tag.selectionTo,
  }
}

function getAuthorizedContextTags(): AuthorizedContextTag[] {
  const activeScope = getAgentScopeContext()
  if (activeScope) {
    return activeScope.contextTags.map((tag) => ({ tag }))
  }

  return getRecentContextTags()
}

function getRecentContextTags(): AuthorizedContextTag[] {
  const messages = useChatStore.getState().messages
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message.role === 'user' && !message.sessionId && message.tags?.length) {
      return message.tags.map((tag, index) => ({
        tag: toContextTag(tag, index),
        sourceMessage: message,
      }))
    }
  }

  return []
}

function getOpenTabByPath(path: string) {
  return useEditorStore.getState().tabs.find(
    (tab) => tab.filePath && normalizeFilePath(tab.filePath) === normalizeFilePath(path)
  )
}

function getLatestEditForTab(tabId: string) {
  const messages = useChatStore.getState().messages
  for (let i = messages.length - 1; i >= 0; i--) {
    const edit = messages[i].editConfirmation
    if (edit?.tabId === tabId) return edit
  }
  return undefined
}

function getSelectionRange(tag: ContextTag): TextRange | undefined {
  if (typeof tag.selectionFrom !== 'number' || typeof tag.selectionTo !== 'number') return undefined
  return { from: tag.selectionFrom, to: tag.selectionTo }
}

function isValidRange(content: string, range?: TextRange): range is TextRange {
  return Boolean(
    range
    && range.from >= 0
    && range.to >= range.from
    && range.to <= content.length
  )
}

function getCurrentSelectionTargetRange(
  content: string,
  initialRange: TextRange,
  latestAppliedRange?: TextRange
): TextRange | null {
  if (isValidRange(content, latestAppliedRange)) return latestAppliedRange
  if (isValidRange(content, initialRange)) return initialRange
  return null
}

function getLatestAppliedRangeForSelection(tabId: string, tag: ContextTag): TextRange | undefined {
  const edit = getLatestEditForTab(tabId)
  if (
    edit?.status !== 'applied'
    || edit.selectionFrom !== tag.selectionFrom
    || edit.selectionTo !== tag.selectionTo
    || typeof edit.replaceFrom !== 'number'
    || typeof edit.replaceTo !== 'number'
  ) {
    return undefined
  }
  return { from: edit.replaceFrom, to: edit.replaceTo }
}

function limitText(content: string, maxLength: number): string {
  if (content.length <= maxLength) return content
  return `${content.slice(0, maxLength)}\n... (已截断，共 ${content.length} 字符)`
}

function formatKnowledgeSearchResults(results: SearchResult[]): string {
  if (results.length === 0) return '未找到相关内容。'

  const grouped = new Map<string, { title: string; filePath: string; hits: string[] }>()

  for (const result of results) {
    const filePath = result.document.filePath
    const item = grouped.get(filePath) || {
      title: result.document.title || filePath,
      filePath,
      hits: [],
    }
    item.hits.push(`L${result.chunk.startLine}-${result.chunk.endLine}，相关度 ${result.score.toFixed(3)}`)
    grouped.set(filePath, item)
  }

  const lines = Array.from(grouped.values()).map((item, index) => [
    `${index + 1}. ${item.title}`,
    `   路径: ${item.filePath}`,
    `   命中: ${item.hits.join('；')}`,
  ].join('\n'))

  return [
    '数据库检索命中以下文件。仅返回文件位置，未返回文件正文；如需基于具体文件总结或改写，请先把对应文件添加到聊天框上下文。',
    '',
    ...lines,
  ].join('\n')
}

/**
 * Register all built-in tools for the Agent system.
 */
async function formatKnowledgeSearchResultsStructured(results: SearchResult[]): Promise<string> {
  const documentStates = await getKnowledgeDocumentStates()
  const stateByPath = new Map(documentStates.map((item) => [item.filePath, item.state]))

  return JSON.stringify({
    status: results.length > 0 ? 'ok' : 'empty',
    resultCount: results.length,
    results: results.map((result) => ({
      filePath: result.document.filePath,
      title: result.document.title || result.document.filePath,
      chunkId: result.chunk.id,
      contentHash: result.chunk.contentHash,
      score: Number(result.score.toFixed(4)),
      vectorScore: typeof result.vectorScore === 'number' ? Number(result.vectorScore.toFixed(4)) : undefined,
      keywordScore: typeof result.keywordScore === 'number' ? Number(result.keywordScore.toFixed(4)) : undefined,
      snippet: limitText(result.chunk.content, 240),
      titlePath: result.chunk.titlePath || [],
      heading: result.chunk.heading,
      embeddingStatus: stateByPath.get(result.document.filePath) || (result.chunk.embedding ? 'INDEXED' : 'CHUNKED'),
      retrievalMode: result.retrievalMode,
      startLine: result.chunk.startLine,
      endLine: result.chunk.endLine,
    })),
  }, null, 2)
}

export function registerBuiltinTools() {
  registerTool({
    name: 'search_knowledge',
    description: '在本地 RAG 数据库中检索用户要找的信息位于哪些文件。此工具返回命中的文件路径、行号、标题路径和短片段；短片段可用于判断相关性，若要总结或改写整篇文件仍需用户把目标文件加入上下文。',
    parameters: [
      { name: 'query', type: 'string', description: '搜索查询', required: true },
      { name: 'topK', type: 'number', description: '返回结果数量（1-20），默认 5', required: false },
    ],
    execute: async (args, context) => {
      const err = validateString(args.query, 'query')
      if (err) return err
      const topK = clampNumber(args.topK, 1, 20, 5)
      const editorState = useEditorStore.getState()
      const activeTab = editorState.tabs.find((tab) => tab.id === editorState.activeTabId)
      const results = await searchRelevant(args.query as string, {
        topK,
        currentFilePath: activeTab?.filePath || undefined,
        signal: context?.signal,
      })
      return formatKnowledgeSearchResultsStructured(results)
    },
  })

  registerTool({
    name: 'read_context_file',
    description: '按精确路径读取用户本轮或最近一次添加到聊天框的文件内容。若文件已在标签页打开，返回编辑器中的最新内容（包含尚未保存但已确认应用的修改）。用于总结、归纳或继续编辑已授权文件。',
    parameters: [
      { name: 'path', type: 'string', description: '要读取的文件绝对路径，必须是已添加到聊天框的文件，或位于已添加文件夹内', required: true },
      { name: 'maxLength', type: 'number', description: '最大返回字符数（1000-30000），默认 12000', required: false },
    ],
    execute: async (args) => {
      const err = validateString(args.path, 'path')
      if (err) return err

      const path = args.path as string
      const maxLength = clampNumber(args.maxLength, 1000, 30000, 12000)
      const contextTags = getAuthorizedContextTags().map((entry) => entry.tag)

      if (!canReadPathInContextTags(path, contextTags)) {
        return '读取被拒绝：该路径没有添加到聊天框上下文。请先把文件添加到聊天框。'
      }

      const openTab = getOpenTabByPath(path)
      if (openTab) {
        return `文件路径: ${path}\n来源: 当前打开标签页的最新编辑内容\n---\n${limitText(openTab.content, maxLength)}`
      }

      try {
        const content = await readFile(path)
        return `文件路径: ${path}\n来源: 磁盘文件内容\n---\n${limitText(content, maxLength)}`
      } catch (readErr) {
        const msg = readErr instanceof Error ? readErr.message : String(readErr)
        return `读取文件失败: ${msg}`
      }
    },
  })

  registerTool({
    name: 'get_recent_context_tag',
    description: '读取用户本会话最近一次显式添加的选中文本或文件标签，仅用于查看历史上下文。不得用该工具返回的历史标签继续生成修改确认卡片；需要修改时必须让用户重新框选或重新添加文件标签。',
    parameters: [
      { name: 'path', type: 'string', description: '可选文件绝对路径；多个历史标签时用于指定目标文件', required: false },
      { name: 'maxLength', type: 'number', description: '最大返回字符数（1000-30000），默认 12000', required: false },
    ],
    execute: async (args) => {
      const maxLength = clampNumber(args.maxLength, 1000, 30000, 12000)
      const path = typeof args.path === 'string' && args.path.trim() ? args.path : undefined
      const activeEntries = getAuthorizedContextTags()
      const entries = (activeEntries.length > 0 ? activeEntries : getRecentContextTags()).filter(
        (entry) => entry.tag.type === 'selection' || entry.tag.type === 'file'
      )
      const entry = path
        ? entries.find((item) => item.tag.filePath && normalizeFilePath(item.tag.filePath) === normalizeFilePath(path))
        : entries[entries.length - 1]

      if (!entry) {
        return '没有可继续编辑的最近上下文标签。请先将选中文本或文件添加到聊天框。'
      }

      const tag = entry.tag
      const lines = [
        `最近授权标签类型: ${tag.type}`,
        `标题: ${tag.title}`,
        `路径: ${tag.filePath || '无'}`,
      ]
      if (tag.filePath) {
        lines.push('该标签仅供查看历史上下文；需要继续修改时，请用户重新框选目标文本或重新添加文件标签。')
      }

      if (tag.type === 'selection' && tag.content) {
        lines.push(`用户最初选中的文本:\n---\n${limitText(tag.content, maxLength)}`)
      }
      const selectionRange = tag.type === 'selection' ? getSelectionRange(tag) : undefined
      if (selectionRange) {
        lines.push(`选区精确字符范围: ${selectionRange.from}-${selectionRange.to}。该历史范围仅供查看；需要修改时必须重新框选，不得匹配文档内其他相同文本。`)
      }

      if (tag.filePath) {
        const openTab = getOpenTabByPath(tag.filePath)
        if (openTab) {
          const latestEdit = getLatestEditForTab(openTab.id)
          const isRelevantEdit = tag.type === 'file' || (
            latestEdit?.selectionFrom === tag.selectionFrom
            && latestEdit?.selectionTo === tag.selectionTo
          )
          if (latestEdit && isRelevantEdit) {
            const latestTargetText = latestEdit.status === 'applied' ? latestEdit.newText : latestEdit.oldText
            lines.push(`最近修改卡片状态: ${latestEdit.status}\n最近目标文本（仅供理解上下文，不得作为历史标签修改授权）:\n---\n${limitText(latestTargetText, maxLength)}`)
          }
          if (selectionRange) {
            const latestAppliedRange = getLatestAppliedRangeForSelection(openTab.id, tag)
            const currentRange = latestAppliedRange || selectionRange
            lines.push(`历史选区当前位置文本（仅供查看）:\n---\n${limitText(openTab.content.slice(currentRange.from, currentRange.to), maxLength)}`)
          }
          lines.push(`当前打开标签页的最新内容:\n---\n${limitText(openTab.content, maxLength)}`)
        } else if (tag.type === 'file') {
          lines.push('目标文件当前未在标签页打开；可以读取内容，但生成修改确认卡片前必须先由用户打开该文件。')
        }
      } else if (tag.type === 'selection' && !tag.content && entry.sourceMessage) {
        lines.push(`原始上下文消息:\n---\n${limitText(entry.sourceMessage.content, maxLength)}`)
      }

      return lines.join('\n\n')
    },
  })

  registerTool({
    name: 'web_search',
    description: '在互联网上搜索信息。用于回答需要最新信息或知识库中没有的问题。',
    parameters: [
      { name: 'query', type: 'string', description: '搜索查询', required: true },
    ],
    execute: async (args, context) => {
      const err = validateString(args.query, 'query')
      if (err) return err
      if (!useSettingsStore.getState().ai.webSearchEnabled) {
        return '联网搜索被拒绝：设置中的 Web 搜索开关当前已关闭。请由用户开启后再发起搜索。'
      }
      updateSearchConfig(useSettingsStore.getState().webSearch)
      const response = await webSearch(args.query as string, context?.signal)
      return buildSearchContext(response) || '未找到搜索结果。'
    },
  })

  registerTool({
    name: 'knowledge_stats',
    description: '获取当前已索引的本地文档统计信息（文档数量、分块数量、已嵌入数量等）。',
    parameters: [],
    execute: async () => {
      const stats = await getRagStatsAsync()
      const stateSummary = await getKnowledgeIndexStateSummary()
      return JSON.stringify({
        documents: stats.documents,
        totalChunks: stats.totalChunks,
        embeddedChunks: stats.embeddedChunks,
        pendingEmbeddings: stats.pendingEmbeddings,
        documentStates: stateSummary,
      }, null, 2)
    },
  })

  registerTool({
    name: 'list_database_contents',
    description: '查看知识库索引概览。只返回文档索引和 embedding 队列，不返回长期记忆；需要记忆时必须使用 search_memory 或 list_memories。',
    parameters: [
      { name: 'page', type: 'number', description: '页码，从 1 开始，默认 1', required: false },
      { name: 'pageSize', type: 'number', description: '每页数量，默认 20，最大 100', required: false },
    ],
    execute: async (args) => {
      const parts: string[] = []

      // 文档列表
      const stats = await getRagStatsAsync()
      const docs = await getKnowledgeDocumentStates()

      // 分页处理
      const page = clampNumber(args.page, 1, 1000, 1)
      const pageSize = clampNumber(args.pageSize, 1, 100, 20)
      const startIndex = (page - 1) * pageSize
      const endIndex = startIndex + pageSize
      const paginatedDocs = docs.slice(startIndex, endIndex)

      if (docs.length > 0) {
        parts.push(`📚 文档（${stats.documents} 篇，${stats.totalChunks} 分块，${stats.embeddedChunks} 已嵌入，${stats.pendingEmbeddings} 待嵌入）：`)
        parts.push(`  第 ${page} 页，共 ${Math.ceil(docs.length / pageSize)} 页，每页 ${pageSize} 条`)
        for (const doc of paginatedDocs) {
          parts.push(`  - ${doc.title}（${doc.totalChunks} 分块，${doc.embeddedChunks} 已嵌入，状态 ${doc.state}）`)
        }
      } else {
        parts.push('📚 文档：无')
      }

      // 嵌入任务
      const jobs = await listEmbeddingJobs()
      if (jobs.length > 0) {
        const pending = jobs.filter(j => j.status === 'pending').length
        const running = jobs.filter(j => j.status === 'running').length
        const done = jobs.filter(j => j.status === 'done').length
        const failed = jobs.filter(j => j.status === 'failed').length
        parts.push(`\n⚙️ 嵌入任务：${jobs.length} 总计（${pending} 待处理 / ${running} 运行中 / ${done} 完成 / ${failed} 失败）`)
      } else {
        parts.push('\n⚙️ 嵌入任务：无')
      }

      return parts.join('\n') || '数据库为空。'
    },
  })

  registerTool({
    name: 'list_memories',
    description: '查看记忆库概览。只返回 memories 表中的长期记忆和候选记忆，不返回知识库文档。',
    parameters: [
      { name: 'includeCandidates', type: 'boolean', description: '是否包含候选记忆，默认 true', required: false },
      { name: 'page', type: 'number', description: '页码，从 1 开始，默认 1', required: false },
      { name: 'pageSize', type: 'number', description: '每页数量，默认 20，最大 100', required: false },
    ],
    execute: async (args) => {
      const statuses = args.includeCandidates === false
        ? (['active'] as const)
        : (['active', 'candidate'] as const)
      const allMemories = await loadAllMemories(undefined, [...statuses])

      // 分页处理
      const page = clampNumber(args.page, 1, 1000, 1)
      const pageSize = clampNumber(args.pageSize, 1, 100, 20)
      const startIndex = (page - 1) * pageSize
      const endIndex = startIndex + pageSize
      const paginatedMemories = allMemories.slice(startIndex, endIndex)

      return JSON.stringify({
        activeCount: allMemories.filter((memory) => memory.status === 'active').length,
        candidateCount: allMemories.filter((memory) => memory.status === 'candidate').length,
        total: allMemories.length,
        page,
        pageSize,
        totalPages: Math.ceil(allMemories.length / pageSize),
        memories: paginatedMemories.map((memory) => ({
          id: memory.id,
          category: memory.category,
          status: memory.status,
          source: memory.source,
          locked: memory.locked,
          content: memory.content,
          updatedAt: memory.updatedAt,
        })),
      }, null, 2)
    },
  })

  registerTool({
    name: 'replace_current_tab_text',
    description: '为用户本轮明确添加的 file/selection 标签生成文本替换确认卡片。必须传入目标文件 path；selection 会由工具读取授权范围内当前完整原文，整文替换应设置 replaceWholeDocument=true。工具不会直接写入文件。',
    parameters: [
      { name: 'oldText', type: 'string', description: 'file 片段替换时要被替换的原文，必须与文档内容完全匹配；selection 修改和整文替换时省略', required: false },
      { name: 'newText', type: 'string', description: '替换后的新文本', required: true },
      { name: 'path', type: 'string', description: '目标文件绝对路径；必须是用户本轮添加到聊天框且已打开的 file 或 selection 标签', required: true },
      { name: 'replaceWholeDocument', type: 'boolean', description: '是否替换目标标签页整份内容；为 true 时由工具自动使用完整原文', required: false },
    ],
    execute: async (args) => {
      const newTextErr = validateString(args.newText, 'newText')
      if (newTextErr) return newTextErr

      const state = useEditorStore.getState()
      const path = typeof args.path === 'string' && args.path.trim() ? args.path : undefined
      if (!path) {
        return '修改被拒绝：必须提供用户本轮添加的文件或选区标签路径。'
      }
      let tab: Tab | undefined
      let targetedSelection: ContextTag | undefined

      const contextTags = getAuthorizedContextTags().map((entry) => entry.tag)
      if (!canEditPathInContextTags(path, contextTags)) {
        return '修改被拒绝：目标文件没有作为本轮文件或选中文本标签添加到聊天框。请先添加该文件或选区。'
      }
      targetedSelection = [...contextTags].reverse().find(
        (tag) => tag.type === 'selection'
          && tag.filePath
          && normalizeFilePath(tag.filePath) === normalizeFilePath(path)
      )
      tab = state.tabs.find((item) => item.filePath && normalizeFilePath(item.filePath) === normalizeFilePath(path))
      if (!tab) {
        return '修改被拒绝：目标文件尚未在标签页打开。请先打开文件后重新请求修改。'
      }

      if (!tab) return '当前没有打开的编辑标签页。'

      const replaceWholeDocument = args.replaceWholeDocument === true
      const selectionRange = targetedSelection && getSelectionRange(targetedSelection)
      if (!replaceWholeDocument && !selectionRange) {
        const oldTextErr = validateString(args.oldText, 'oldText')
        if (oldTextErr) return oldTextErr
      }

      let oldText = replaceWholeDocument ? tab.content : args.oldText as string
      let replaceRange: TextRange
      if (!replaceWholeDocument && targetedSelection && selectionRange) {
        const latestAppliedRange = getLatestAppliedRangeForSelection(tab.id, targetedSelection)
        const anchoredRange = getCurrentSelectionTargetRange(tab.content, selectionRange, latestAppliedRange)
        if (!anchoredRange) {
          return '替换失败：授权选区范围已失效。请重新框选目标文本后再次发起修改。'
        }
        replaceRange = anchoredRange
        oldText = tab.content.slice(replaceRange.from, replaceRange.to)
      } else {
        const index = tab.content.indexOf(oldText)
        if (index < 0) {
          return '替换失败：当前文档中没有找到完全匹配的 oldText。请先缩小到一个准确的段落或句子。'
        }
        replaceRange = { from: index, to: index + oldText.length }
      }

      const newText = args.newText as string
      const changeSummary = replaceWholeDocument
        ? `整文替换：将替换当前文档全部 ${oldText.length} 字符`
        : oldText.length >= 1200
          ? `大段替换：将替换 ${oldText.length} 字符`
          : `将替换 ${oldText.length} 字符`
      // 返回待确认内容，不直接修改编辑器
      return JSON.stringify({
        __pendingEdit: true,
        oldText,
        newText,
        tabId: tab.id,
        tabTitle: tab.title,
        replaceFrom: replaceRange.from,
        replaceTo: replaceRange.to,
        replaceWholeDocument,
        changeSummary,
        ...(selectionRange ? {
          selectionFrom: selectionRange.from,
          selectionTo: selectionRange.to,
        } : {}),
        preview: changeSummary,
      })
    },
  })

  registerTool({
    name: 'get_current_tab_text',
    description: '读取当前打开且已被用户在本轮添加为 file 或 selection 标签的文本内容，仅用于构造待确认修改；无本轮授权标签时不得读取。',
    parameters: [
      { name: 'maxLength', type: 'number', description: '最大返回字符数（1-20000），默认 8000', required: false },
    ],
    execute: async (args) => {
      const state = useEditorStore.getState()
      const tab = state.tabs.find((t) => t.id === state.activeTabId)
      if (!tab) return '当前没有打开的编辑标签页。'
      if (!tab.filePath || !canEditPathInContextTags(tab.filePath, getAuthorizedContextTags().map((entry) => entry.tag))) {
        return '读取被拒绝：当前标签页没有作为本轮文件或选中文本标签添加到聊天框。'
      }
      const maxLength = clampNumber(args.maxLength, 1, 20000, 8000)
      const content = tab.content
      if (content.length <= maxLength) {
        return `当前文档「${tab.title}」内容：\n\n${content}`
      }
      return `当前文档「${tab.title}」内容（已截断，共 ${content.length} 字符，显示前 ${maxLength} 字符）：\n\n${content.slice(0, maxLength)}\n... (已截断)`
    },
  })

  registerTool({
    name: 'get_current_time',
    description: '获取当前日期和时间。',
    parameters: [],
    execute: async () => {
      return `当前系统时间：${new Date().toLocaleString('zh-CN', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        weekday: 'long',
        timeZoneName: 'short',
      })}`
    },
  })

  registerTool({
    name: 'search_memory',
    description: '按需搜索已确认的长期记忆。用户询问自己的地址、偏好、习惯、身份信息、长期目标、项目约定或此前告知过的信息时，应先调用此工具再回答；不要在未检索前声称没有相关记忆。',
    parameters: [
      { name: 'query', type: 'string', description: '搜索查询', required: true },
      { name: 'topK', type: 'number', description: '返回结果数量（1-10），默认 5', required: false },
    ],
    execute: async (args, context) => {
      const err = validateString(args.query, 'query')
      if (err) return err
      const topK = clampNumber(args.topK, 1, 10, 5)
      const embedding = isEmbeddingReady()
        ? async (text: string, signal?: AbortSignal) => (await getEmbeddingClient().embedding(text, signal)).embedding
        : undefined
      const memories = await searchMemories(args.query as string, {
        mode: 'strong',
        topK,
        embedding,
        signal: context?.signal,
      })
      return buildMemoryContext(memories) || '未找到相关记忆。'
    },
  })

  registerTool({
    name: 'save_memory',
    description: '主动保存长期记忆。用于记录用户偏好、项目信息、重要上下文等需要跨会话记住的内容。',
    parameters: [
      { name: 'content', type: 'string', description: '记忆内容（简洁明确）', required: true },
      { name: 'category', type: 'string', description: '分类: preference(偏好) | project(项目) | learning(学习进度) | profile(稳定背景) | instruction(长期指令)，默认 preference', required: false },
    ],
    execute: async (args) => {
      const err = validateString(args.content, 'content')
      if (err) return err
      const validCategories = ['preference', 'project', 'learning', 'profile', 'instruction']
      const category = validCategories.includes(args.category as string)
        ? (args.category as string)
        : 'preference'
      const result = await upsertExplicitMemory(args.content as string, category)
      return `${result.action === 'updated' ? '已更新已有记忆' : '已保存新记忆'}：「${result.memory.content}」（分类：${result.memory.category}）`
    },
  })
}
