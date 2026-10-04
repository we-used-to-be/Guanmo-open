import { useChatStore, type RagStatus, type TimelineType } from '@/stores/chatStore'
import type { AgentStep } from '@/services/agent/types'

/**
 * AI 助手角色状态。
 *
 * 由真实程序事件派生（订阅 chatStore），不依赖模型输出：
 * - 请求开始后的准备阶段（读上下文 / 初始化客户端 / 路由）→ reading
 * - RAG 检索进行中 → retrieving
 * - 联网搜索进行中 → searching
 * - 等待模型响应 / 规划 → thinking
 * - 收到流式正文 → generating
 * - 完成 → success（短暂展示后回 idle）
 * - 失败 → error（短暂展示后回 idle）
 */
export type AssistantState =
  | 'idle'
  | 'reading'
  | 'retrieving'
  | 'searching'
  | 'thinking'
  | 'generating'
  | 'success'
  | 'error'

export const ASSISTANT_STATE_LABELS: Record<AssistantState, string> = {
  idle: 'AI 助手空闲',
  reading: 'AI 正在读取文档',
  retrieving: 'AI 正在检索知识库',
  searching: 'AI 正在联网搜索',
  thinking: 'AI 正在思考',
  generating: 'AI 正在生成回答',
  success: 'AI 任务完成',
  error: 'AI 请求失败',
}

const SUCCESS_HOLD_MS = 1400
const ERROR_HOLD_MS = 1800

/**
 * 请求生命周期中受控的进度占位文案（与 useAiChat 保持一致）。
 * 流式正文一旦出现即视为首个真实 Token。
 */
const PROGRESS_PLACEHOLDERS: ReadonlySet<string> = new Set([
  '正在准备 AI 请求...',
  'Agent 正在规划工具链路...',
  '正在分析文档修改要求...',
  '正在确定上下文读取范围...',
  '正在检索本地知识库...',
  '正在初始化索引库…',
  '索引库已就绪，正在检索…',
  '索引库初始化失败，正在使用关键词检索…',
  '正在判断处理方式...',
  '正在生成回答...',
  '正在生成最终回答...',
  'AI 正在判断下一步处理方式...',
  'Agent 正在执行工具...',
  '工具结果已返回，正在整理下一步...',
  '正在检索本地知识库索引...',
  '正在读取长期记忆库...',
  '正在查看知识库索引概览...',
  '正在查看记忆库概览...',
  '正在执行联网搜索...',
  '正在写入长期记忆...',
  '正在读取已授权文件内容...',
  '正在读取文件上下文...',
  '正在读取上下文...',
  '正在阅读上下文...',
  '正在读取选区上下文...',
  '正在读取最近上下文标签...',
  '正在读取知识库统计...',
  '正在读取可修改目标...',
  '正在读取当前文档内容...',
  '正在生成文本修改确认卡片...',
  '正在调用文档修改工具...',
  '正在生成阅读成果确认卡片...',
  '正在生成阅读笔记确认卡片...',
  '正在生成阅读提醒确认卡片...',
  '正在检查提醒功能状态...',
  '正在读取当前系统时间...',
])

/** 动态拼接的进度文案兜底识别（如「xx已完成，正在整理下一步...」「正在执行工具：web_search...」）。 */
export function isProgressPlaceholder(text: string): boolean {
  const trimmed = text.trim()
  if (trimmed === '') return true
  if (PROGRESS_PLACEHOLDERS.has(trimmed)) return true
  if (!/[.…]$/.test(trimmed)) return false
  if (/^正在|^Agent 正在|^AI 正在/.test(trimmed) && /\.{3}$|…$/.test(trimmed)) return true
  return /，正在[^，]*\.{3}$/.test(trimmed)
}

interface ChatSnapshot {
  streaming: boolean
  error: string | null
  ragStatus: RagStatus
  lastTimelineType: TimelineType | null
  lastAssistantContent: string | undefined
  lastAgentStepType: AgentStep['type'] | null
  lastActionMessage: string | undefined
}

function takeSnapshot(state: {
  messages: { role: string; content: string }[]
  streaming: boolean
  error: string | null
  ragStatus: RagStatus
  timeline: { type: TimelineType }[]
  agentSteps: AgentStep[]
}): ChatSnapshot {
  let lastAssistantContent: string | undefined
  for (let i = state.messages.length - 1; i >= 0; i--) {
    if (state.messages[i].role === 'assistant') {
      lastAssistantContent = state.messages[i].content
      break
    }
  }
  return {
    streaming: state.streaming,
    error: state.error,
    ragStatus: state.ragStatus,
    lastTimelineType: state.timeline.length > 0 ? state.timeline[state.timeline.length - 1].type : null,
    lastAssistantContent,
    lastAgentStepType: state.agentSteps.length > 0 ? state.agentSteps[state.agentSteps.length - 1].type : null,
    lastActionMessage: [...state.agentSteps].reverse().find((step) => step.actionMessage)?.actionMessage,
  }
}

/** streaming 期间按优先级派生活动相位。 */
function deriveStreamingPhase(cur: ChatSnapshot): AssistantState {
  if (cur.lastTimelineType === 'web_search_start') return 'searching'
  if (cur.ragStatus === 'initializing' || cur.ragStatus === 'searching' || cur.ragStatus === 'fallback') {
    return 'retrieving'
  }
  if (
    cur.lastAgentStepType === 'action'
    && cur.lastActionMessage !== undefined
    && (cur.lastAssistantContent === undefined || isProgressPlaceholder(cur.lastAssistantContent) || cur.lastAssistantContent === cur.lastActionMessage)
  ) return 'thinking'
  if (cur.lastAssistantContent !== undefined && cur.lastAssistantContent === cur.lastActionMessage) return 'thinking'
  if (cur.lastTimelineType === 'answer_streaming') {
    if (
      cur.lastAssistantContent !== undefined
      && !isProgressPlaceholder(cur.lastAssistantContent)
      && cur.lastAssistantContent !== cur.lastActionMessage
    ) return 'generating'
    return 'thinking'
  }
  if (cur.lastAssistantContent !== undefined && !isProgressPlaceholder(cur.lastAssistantContent)) {
    return 'generating'
  }
  return 'thinking'
}

let currentState: AssistantState = 'idle'
let tempTimer: ReturnType<typeof setTimeout> | null = null
let tempDeadline = 0
let prevSnapshot: ChatSnapshot | null = null
let unsubscribeStore: (() => void) | null = null
const listeners = new Set<() => void>()

function notify() {
  for (const listener of listeners) listener()
}

function enter(next: AssistantState) {
  if (next === currentState) return
  currentState = next
  notify()
}

function clearTempTimer() {
  if (tempTimer !== null) {
    clearTimeout(tempTimer)
    tempTimer = null
    tempDeadline = 0
  }
}

function scheduleTempEnd(delay: number) {
  clearTempTimer()
  tempDeadline = Date.now() + delay
  tempTimer = setTimeout(() => {
    tempTimer = null
    tempDeadline = 0
    enter('idle')
  }, delay)
}

function evaluate(prev: ChatSnapshot, cur: ChatSnapshot) {
  if (cur.streaming && !prev.streaming) {
    // 新请求开始：清除未到期的临时态定时器，旧状态不会覆盖新请求
    clearTempTimer()
    enter('reading')
    return
  }
  if (!cur.streaming && prev.streaming) {
    // 请求收尾：done/error 在 setStreaming(false) 之前提交，此处可直接判定结果
    if (cur.error !== null) {
      enter('error')
      scheduleTempEnd(ERROR_HOLD_MS)
    } else if (cur.lastTimelineType === 'done') {
      enter('success')
      scheduleTempEnd(SUCCESS_HOLD_MS)
    } else {
      // 用户取消或无结果：直接回到 idle，不闪临时态
      enter('idle')
    }
    return
  }
  if (!cur.streaming) return
  enter(deriveStreamingPhase(cur))
}

/**
 * 后台标签页会节流 setTimeout；重新可见时对已超时的临时态补一刀回 idle，
 * 避免回来后重放 success/error 闪烁。
 */
function handleVisibilityChange() {
  if (document.visibilityState !== 'visible') return
  if (
    (currentState === 'success' || currentState === 'error')
    && tempTimer !== null
    && Date.now() >= tempDeadline
  ) {
    clearTempTimer()
    enter('idle')
  }
}

function ensureStarted() {
  if (unsubscribeStore !== null) return
  const snapshot = takeSnapshot(useChatStore.getState())
  prevSnapshot = snapshot
  currentState = snapshot.streaming ? deriveStreamingPhase(snapshot) : 'idle'
  unsubscribeStore = useChatStore.subscribe(() => {
    const next = takeSnapshot(useChatStore.getState())
    const prev = prevSnapshot
    prevSnapshot = next
    if (prev !== null) evaluate(prev, next)
  })
  document.addEventListener('visibilitychange', handleVisibilityChange)
}

export function getAssistantState(): AssistantState {
  ensureStarted()
  return currentState
}

export function subscribeAssistantState(listener: () => void): () => void {
  ensureStarted()
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** 仅测试使用：完全重置单例（订阅、定时器、监听者、相位）。 */
export function __resetAssistantStateForTests() {
  clearTempTimer()
  if (unsubscribeStore !== null) {
    unsubscribeStore()
    unsubscribeStore = null
  }
  document.removeEventListener('visibilitychange', handleVisibilityChange)
  listeners.clear()
  prevSnapshot = null
  currentState = 'idle'
}
