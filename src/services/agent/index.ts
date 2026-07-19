export { initAgent, runAgent, selectAgentToolNames, shouldUseAgent } from './executor'
export { registerTool, getTool, getAllTools, getToolDescriptions, getToolsForLLM } from './toolRegistry'
export { registerBuiltinTools } from './tools'
export type { ToolDefinition, ToolParameter, AgentStep, AgentResult, AgentResultReason, AgentConfig } from './types'
export type { AgentRunRequest } from './types'
export { decodeAgentStepEvent, reduceAgentSession } from './session'
export type { AgentSessionEvent, AgentSessionState } from './session'

// 导出新的意图检测和工具选择系统
export { detectIntentScores, shouldAllowMemoryWrite, isImplicitEditContinuation, shouldIncludeFullDocumentContext } from './intentDetector'
export type { Capability, IntentScore, IntentDetectionResult, AppContext } from './intentDetector'
export { buildCandidateTools, checkRequiredCapabilities, getRepairTools, isWriteTool, isReadTool } from './toolSelector'
export type { AgentToolName } from './toolSelector'
