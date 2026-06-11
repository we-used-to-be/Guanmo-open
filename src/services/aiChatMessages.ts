import type { ChatMessage, ChatMessageContextMeta, ChatMessageTag } from '@/services/ai/types'
import type { ContextTag } from '@/types/contextTag'
import { CONTEXT_BLOCK_PREFIX } from '@/services/contextBuilder'
import { buildSystemMessages, buildUntrustedContextMessage } from '@/services/ai/systemPrompts'

export function buildChatMessageTags(contextTags: ContextTag[] = []): ChatMessageTag[] {
  return contextTags.map((tag) => ({
    type: tag.type,
    title: tag.title,
    filePath: tag.filePath,
    folderPath: tag.folderPath,
    content: tag.content,
    preview: tag.preview,
    startLine: tag.startLine,
    endLine: tag.endLine,
    selectionFrom: tag.selectionFrom,
    selectionTo: tag.selectionTo,
  }))
}

export function createUserChatMessage(content: string, tagContext: string, tags: ChatMessageTag[]): ChatMessage {
  const trimmedContent = content.trim()
  const messageContent = [trimmedContent, tagContext].filter(Boolean).join('\n\n')

  return {
    id: `user-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    role: 'user',
    content: messageContent,
    timestamp: Date.now(),
    tags: tags.length > 0 ? tags : undefined,
    displayContent: tagContext ? trimmedContent : undefined,
  }
}

export function stripInjectedTagContext(content: string): string {
  const marker = `\n\n${CONTEXT_BLOCK_PREFIX}`
  const index = content.indexOf(marker)
  return index >= 0 ? content.slice(0, index).trimEnd() : content
}

export function normalizeStoredDisplayContent(
  content: string,
  displayContent: string | undefined,
  hasTags: boolean
): string | undefined {
  if (typeof displayContent === 'string' && displayContent.trim()) {
    return displayContent
  }
  if (!hasTags) return undefined

  const stripped = stripInjectedTagContext(content).trim()
  if (!stripped || stripped === content.trim()) return undefined
  return stripped
}

export function prepareChatHistoryForModel(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((msg) => ({
    role: msg.role,
    content: msg.role === 'user' && msg.displayContent && !msg.hidden
      ? msg.displayContent
      : msg.content,
  }))
}

export function appendRagContext(
  messages: ChatMessage[],
  userMessage: ChatMessage,
  ragContext: string
): ChatMessage[] {
  if (!ragContext) return messages
  const contextMessage = buildUntrustedContextMessage(ragContext)
  if (!contextMessage) return messages
  return [...messages.slice(0, -1), contextMessage, userMessage]
}

export function buildMessagesForModel(options: {
  history: ChatMessage[]
  userMessage: ChatMessage
  supplementalContext?: string
  customPreferencePrompt?: string
}): ChatMessage[] {
  const strippedUserContent = stripInjectedTagContext(options.userMessage.content)
  const latestUserMessage: ChatMessage = {
    role: 'user',
    content: options.userMessage.displayContent && !options.userMessage.hidden
      ? options.userMessage.displayContent
      : strippedUserContent,
  }
  const contextText = [
    strippedUserContent === options.userMessage.content
      ? ''
      : options.userMessage.content.slice(strippedUserContent.length).trim(),
    options.supplementalContext?.trim(),
  ].filter(Boolean).join('\n\n')
  const contextMessage = buildUntrustedContextMessage(contextText)

  return [
    ...buildSystemMessages(options.customPreferencePrompt),
    ...options.history,
    ...(contextMessage ? [contextMessage] : []),
    latestUserMessage,
  ]
}

export function buildSupplementalAiContext(options: {
  knowledgeContext?: string
  memoryContext?: string
}): string {
  const parts = [
    options.knowledgeContext?.trim(),
    options.memoryContext?.trim(),
  ].filter((part): part is string => Boolean(part))

  if (parts.length === 0) return ''
  return `【补充上下文】\n${parts.join('\n\n')}`
}

export function createContextMeta(options: {
  tagCount: number
  ragSourceCount: number
  webSearchUsed: boolean
}): ChatMessageContextMeta {
  return {
    tagCount: options.tagCount,
    ragSourceCount: options.ragSourceCount,
    webSearchUsed: options.webSearchUsed,
  }
}

export function countRagSourcesInContext(ragContext: string): number {
  return ragContext ? (ragContext.match(/\[知识来源/g) || []).length : 0
}
