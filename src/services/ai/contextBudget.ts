import type { ChatMessage, ModelMessage } from './types'

export function estimateModelTokens(text: string): number {
  let ascii = 0
  let nonAscii = 0
  for (const char of text) {
    if (char.codePointAt(0)! <= 0x7f) ascii += 1
    else nonAscii += 1
  }
  return Math.ceil(ascii / 4) + nonAscii
}

export function estimateMessageTokens(message: ChatMessage): number {
  return 4 + estimateModelTokens(message.content)
}

export function isModelContextOverflowError(error: unknown): boolean {
  if (error instanceof DOMException && ['AbortError', 'TimeoutError'].includes(error.name)) return false
  if (error && typeof error === 'object') {
    const { code, statusCode } = error as { code?: string; statusCode?: number }
    if (statusCode !== undefined && ![400, 413, 422].includes(statusCode)) return false
    if (code && !['API_ERROR', 'context_length_exceeded', 'context_window_exceeded'].includes(code)) return false
    if (code === 'context_length_exceeded' || code === 'context_window_exceeded') return true
  }
  const message = error instanceof Error ? error.message : String(error)
  if (/(?:rate[_ ]limit|tokens? per (?:minute|second|day)|\bTPM\b|\bRPM\b|invalid api key|network error|timed? out|cancelled|canceled)/i.test(message)) return false
  return /(?:context[_ ]length[_ ]exceeded|context[_ ]window[_ ]exceeded|(?:context length|context window|maximum context).*(?:exceed|too long|too large|reached|limit)|too many tokens|token limit exceeded|上下文.*(?:超限|过长)|输入.*过长)/i.test(message)
}

// 请求副本的对象身份标记；不改变消息字段、Provider payload 或持久化格式。
const currentTurnStarts = new WeakSet<ModelMessage>()
const compactableReadGroups = new WeakSet<ModelMessage>()

export function markCompactableReadGroup(message: ModelMessage): void {
  compactableReadGroups.add(message)
}

export function markCurrentTurnStart(message: ModelMessage): void {
  currentTurnStarts.add(message)
}

export function compactOverflowMessages<T extends ModelMessage>(messages: T[]): T[] {
  let start = messages.findIndex(message => currentTurnStarts.has(message))
  if (start < 0) {
    start = messages.length - 1
    while (start >= 0 && messages[start].role !== 'user') start--
    // 未标记的普通直答仍保护紧邻问题的参考资料。
    while (start > 0 && messages[start - 1].role === 'user') start--
  }
  if (start < 0) return messages.slice()
  const removed = new Set<number>()
  for (let i = 0; i < start; i++) {
    if (messages[i].role !== 'user') continue
    let end = i + 1
    while (end < start && messages[end].role !== 'user') end++
    if (messages.slice(i + 1, end).some(message => message.role === 'assistant')) {
      for (let j = i; j < end; j++) if (messages[j].role !== 'system') removed.add(j)
    }
    i = end - 1
  }
  // 只合并执行器生成的完全相同结果组；不同证据、JSON、来源和确认信息不截断。
  const seen = new Set<string>()
  for (let i = messages.length - 1; i > start; i--) {
    const result = messages[i]
    const call = messages[i - 1]
    const tool = call.role === 'assistant' && call.content.match(/^(?:调用工具|复用本轮工具结果): (\w+)$/)?.[1]
    if (!tool || result.role !== 'user' || !result.content.startsWith('工具返回结果：\n')) continue
    const key = `${tool}\n${result.content}`
    if (seen.has(key)) {
      removed.add(i - 1)
      removed.add(i)
    } else seen.add(key)
    i--
  }
  const seenNative = new Set<string>()
  for (let i = messages.length - 1; i > start; i--) {
    const call = messages[i]
    if (!compactableReadGroups.has(call) || !('tool_calls' in call)) continue
    const results = messages.slice(i + 1, i + 1 + call.tool_calls.length)
    const resultById = new Map(results.flatMap(result => result.role === 'tool' ? [[result.tool_call_id, result.content] as const] : []))
    if (results.length !== call.tool_calls.length || !call.tool_calls.every(tool => resultById.has(tool.id))) continue
    const key = JSON.stringify([call.content, call.tool_calls.map(tool => [tool.function, resultById.get(tool.id)])])
    if (seenNative.has(key)) {
      for (let j = i; j <= i + results.length; j++) removed.add(j)
    } else seenNative.add(key)
  }
  return messages.filter((_, index) => !removed.has(index))
}

export async function withContextOverflowRecovery<T, M extends ModelMessage>(
  messages: M[],
  send: (messages: M[]) => Promise<T>,
  options: { isCancelled: () => boolean; onRetry?: (messages: M[]) => void },
): Promise<T> {
  try {
    return await send(messages)
  } catch (error) {
    if (!isModelContextOverflowError(error) || options.isCancelled()) throw error
    const reduced = compactOverflowMessages(messages)
    const terminalError = () => new Error('当前上下文材料过大，请缩小问题或引用资料范围后重试。')
    if (reduced.length >= messages.length) throw terminalError()
    if (options.isCancelled()) throw error
    options.onRetry?.(reduced)
    if (options.isCancelled()) throw error
    try {
      return await send(reduced)
    } catch (retryError) {
      if (isModelContextOverflowError(retryError) && !options.isCancelled()) throw terminalError()
      throw retryError
    }
  }
}

/**
 * 从最旧的完整问答轮次开始移除消息，用于 Provider 真实返回上下文超限时
 * 做一次性无副作用降级重试。
 *
 * 保留：system 消息、当前问题，以及 keepMessage 判定为真的消息。
 * 完整轮次定义为：一条 user 消息及其后直到下一条 user 之前的连续消息。
 */
export function dropOldestCompleteTurns(
  messages: ChatMessage[],
  options: { keepMessage?: (message: ChatMessage) => boolean } = {},
): ChatMessage[] {
  if (messages.length <= 1) return messages.slice()

  let currentUserIndex = messages.length - 1
  while (currentUserIndex >= 0 && messages[currentUserIndex].role !== 'user') {
    currentUserIndex -= 1
  }
  if (currentUserIndex <= 0) return messages.slice()

  let oldestUserIndex = -1
  for (let i = 0; i < currentUserIndex; i += 1) {
    if (messages[i].role === 'user') {
      oldestUserIndex = i
      break
    }
  }
  if (oldestUserIndex < 0) return messages.slice()

  let turnEnd = currentUserIndex
  for (let i = oldestUserIndex + 1; i < currentUserIndex; i += 1) {
    if (messages[i].role === 'user') {
      turnEnd = i
      break
    }
  }

  const keep = options.keepMessage ?? (() => false)
  return messages.filter((message, index) => {
    if (index < oldestUserIndex || index >= turnEnd) return true
    if (message.role === 'system') return true
    return keep(message)
  })
}
