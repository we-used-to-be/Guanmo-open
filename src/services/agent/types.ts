import type { ChatMessage, ChatMessageSource, ReadingArtifactMessageReference, ReadingScope } from '@/services/ai/types'
import type { SourceReferenceId, SourceReferenceRegistry } from '@/services/ai/sourceReferences'
import type { Capability, SelectionRequestKind } from './intentDetector'
import type { AgentToolName } from './toolSelector'

export interface ToolParameter {
  name: string
  type: 'string' | 'number' | 'boolean'
  description: string
  required: boolean
}

export type ToolEffect = 'read' | 'write_local' | 'schedule' | 'external'
export type ToolConfirmationPolicy = 'never' | 'required'

export interface ToolDefinition {
  name: string
  description: string
  parameters: ToolParameter[]
  effect?: ToolEffect
  capability?: string
  confirmationPolicy?: ToolConfirmationPolicy
  reversibleDescription?: string
  execute: (args: Record<string, unknown>, context?: ToolExecutionContext) => Promise<string>
}

export interface RegisteredToolDefinition extends ToolDefinition {
  effect: ToolEffect
  capability: string
  confirmationPolicy: ToolConfirmationPolicy
  reversibleDescription: string
}

export type AgentProgressStage =
  | 'rag_initializing'
  | 'rag_ready'
  | 'rag_searching'
  | 'rag_fallback'

export interface ToolExecutionContext {
  signal?: AbortSignal
  onProgress?: (stage: AgentProgressStage) => void
}

export interface AgentStep {
  type: 'thought' | 'action' | 'observation' | 'progress'
  content: string
  toolName?: string
  toolArgs?: Record<string, unknown>
  /** 模型为用户提供的、尚未执行的行动说明；仅用于过程展示。 */
  actionMessage?: string
  timestamp: number
  progressStage?: AgentProgressStage
}

export type AgentResultReason = 'completed' | 'max_steps' | 'max_tool_calls' | 'deadline' | 'error'

export interface AgentResult {
  answer: string
  steps: AgentStep[]
  toolCalls: number
  reason: AgentResultReason
  finalMessages?: ChatMessage[]
  sources?: ChatMessageSource[]
  sourceRegistry?: SourceReferenceRegistry
  referencedSourceIds?: SourceReferenceId[]
  artifactReferences?: ReadingArtifactMessageReference[]
}

export interface AgentTaskContext {
  intent: Capability[]
  requiredCapabilities: Capability[]
  candidateToolNames: AgentToolName[]
  usedToolNames: AgentToolName[]
  originalRequest: string
  status: 'success' | 'failed'
  resultSummary?: string
}

export interface AgentConfig {
  maxSteps: number
  maxToolCalls: number
  stepTimeout: number
  deadlineMs: number
  systemPrompt: string
}

export interface AgentRunRequest {
  query: string
  chatHistory?: ChatMessage[]
  config?: Partial<AgentConfig>
  rawQuery?: string
  hasRecentEditContext?: boolean
  hasCurrentEditTarget?: boolean
  currentEditTargetCount?: number
  candidateToolNames?: readonly string[]
  hasPrefetchedMemoryLookup?: boolean
  signal?: AbortSignal
  temperature?: number
  onStep?: (step: AgentStep) => void
  onStreamContent?: (content: string) => void
  requiredCapabilities?: readonly Capability[]
  untrustedContext?: string
  customPreferencePrompt?: string
  streamEnabled?: boolean
  routingDecision?: RoutingDecision
  /** 开发模式诊断关联 ID，生产环境为空且不影响执行。 */
  diagnosticRunId?: string
}

// --- 统一路由决策 ---

export type RoutingMode = 'direct' | 'agent'

/**
 * 路由原因码 — 仅用于内部测试和匿名诊断，不向用户展示。
 */
export type RoutingReasonCode =
  | 'no_candidates'
  | 'strong_signal'
  | 'regex_match'
  | 'classifier'
  | 'context_signal'
  | 'manual_override'
  | 'continuation'
  | 'weak_combo'
  | 'cancel_last_edit'
  | 'explicit_memory_write'

/**
 * 统一路由决策对象。
 *
 * 一次用户请求只产生一个 RoutingDecision，由 useAiChat 提供 AppContext
 * 后调用 makeRoutingDecision 生成，executor 直接消费，不再重复执行意图检测。
 */
export interface RoutingDecision {
  mode: RoutingMode
  reasonCodes: RoutingReasonCode[]
  candidates: Capability[]
  required: Capability[]
  candidateTools: AgentToolName[]
  selectionRequestKind: SelectionRequestKind
  requiresEditConfirmation: boolean
  shouldLookupMemory: boolean
  memoryIntent: 'strong' | 'weak' | 'none'
  shouldLookupKnowledge: boolean
  isDocumentRewrite: boolean
  isWebComparison: boolean
  isLocalResearch: boolean
  isFileSummary: boolean
  readingScope?: ReadingScope
  answerInstruction?: string
  explicitMemoryWriteIntent: boolean
  /** 短指令续接时继承的查询文本 */
  inheritedQuery?: string
  /** 短指令续接时继承的原始请求 */
  inheritedOriginalRequest?: string
  /** 短指令续接时继承的工具列表 */
  inheritedToolNames?: AgentToolName[]
}
