import type { ChatMessage, ChatMessageSource } from '@/services/ai/types'
import type { Capability } from './intentDetector'

export interface ToolParameter {
  name: string
  type: 'string' | 'number' | 'boolean'
  description: string
  required: boolean
}

export interface ToolDefinition {
  name: string
  description: string
  parameters: ToolParameter[]
  execute: (args: Record<string, unknown>, context?: { signal?: AbortSignal }) => Promise<string>
}

export interface AgentStep {
  type: 'thought' | 'action' | 'observation'
  content: string
  toolName?: string
  toolArgs?: Record<string, unknown>
  timestamp: number
}

export type AgentResultReason = 'completed' | 'max_steps' | 'error'

export interface AgentResult {
  answer: string
  steps: AgentStep[]
  toolCalls: number
  reason: AgentResultReason
  finalMessages?: ChatMessage[]
  sources?: ChatMessageSource[]
}

export interface AgentConfig {
  maxSteps: number
  stepTimeout: number
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
  requiredCapabilities?: readonly Capability[]
  untrustedContext?: string
  customPreferencePrompt?: string
  streamEnabled?: boolean
}
