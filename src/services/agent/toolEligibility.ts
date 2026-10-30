import { getTool } from './toolRegistry'
import type { RoutingDecision } from './types'

export type ToolEligibility = 'available' | 'needs_input' | 'blocked'

export interface ToolEligibilityContext {
  desktop: boolean
  databaseAvailable?: boolean
  readAllowed: boolean
  writeAllowed: boolean
  hasSelection: boolean
  hasReadableContext: boolean
  hasEditTarget: boolean
  memoryWriteRequested: boolean
  webEnabled: boolean
  reminderEnabled: boolean
}

/** Integration boundary for MCP snapshots; no schemas, connection or global registration. */
export interface ExternalToolQualification {
  name: `mcp_${string}_${number}`
  enabled: boolean
  connectionState: 'connected' | 'disconnected' | 'unknown'
  catalogCurrent: boolean
  userSelected: boolean
}

export function qualifyExternalTool(tool: ExternalToolQualification): ToolEligibility {
  return /^mcp_[A-Za-z0-9_-]{1,40}_\d+$/.test(tool.name)
    && tool.enabled && tool.connectionState === 'connected'
    && tool.catalogCurrent && tool.userSelected ? 'available' : 'blocked'
}

/** Selection never grants permission. This check is synchronous and side-effect free. */
export function qualifyTool(name: string, context: ToolEligibilityContext): ToolEligibility {
  const tool = getTool(name)
  if (!tool || tool.enabled === false || !context.desktop) return 'blocked'
  if (context.databaseAvailable === false && [
    'search_memory', 'list_memories', 'save_memory', 'search_knowledge', 'list_database_contents',
    'search_reading_artifacts', 'get_reading_artifact', 'propose_save_reading_artifact', 'propose_create_reading_reminder',
  ].includes(name)) return 'blocked'
  try {
    if (tool.isAvailable && !tool.isAvailable()) return 'blocked'
  } catch { return 'blocked' }
  if (tool.effect === 'read' && !context.readAllowed) return 'blocked'
  if (tool.effect !== 'read' && tool.effect !== 'external' && !context.writeAllowed) return 'blocked'
  if (tool.effect === 'external' && name !== 'web_search') return 'blocked'
  if (name === 'web_search' && !context.webEnabled) return 'blocked'
  if (name === 'propose_create_reading_reminder' && !context.reminderEnabled) return 'blocked'
  if (name === 'save_memory' && !context.memoryWriteRequested) return 'blocked'
  if (name === 'read_selection_context' && !context.hasSelection) return 'needs_input'
  if (name === 'read_context_file' && !context.hasReadableContext) return 'needs_input'
  if (name === 'replace_current_tab_text' && !context.hasEditTarget) return 'needs_input'
  return 'available'
}

export function qualifyCandidates<T extends string>(names: readonly T[], context: ToolEligibilityContext) {
  const available: T[] = []
  const needsInput: T[] = []
  const blocked: T[] = []
  for (const name of new Set(names)) {
    const status = qualifyTool(name, context)
    if (status === 'available') available.push(name)
    else if (status === 'needs_input') needsInput.push(name)
    else blocked.push(name)
  }
  return { available, needsInput, blocked }
}

export const CORE_READ_TOOLS = ['search_memory', 'search_knowledge'] as const

/** Keep the route snapshot and execution fallback on the same qualified tool set. */
export function qualifyAgentCoreReadTools(decision: RoutingDecision | undefined, query: string, context: ToolEligibilityContext) {
  return decision?.mode === 'agent' && !decision.isDocumentRewrite && !decision.isFileSummary
    && !decision.requiresEditConfirmation && decision.selectionRequestKind !== 'fast'
    && decision.readingScope !== 'section' && !decision.candidateTools.includes('read_selection_context')
    ? qualifyCoreReadTools(query, context) : []
}

export function allowsCoreReadQuery(name: string, query: string, userIntent: string): boolean {
  const sensitive = /地址|住址|手机|电话|邮箱|证件|密码|密钥|过敏|诊断|敏感/
  return name !== 'search_memory' || !sensitive.test(query) || sensitive.test(userIntent)
}

/** Shared fallback selection does not grant access or force a lookup. */
export function qualifyCoreReadTools(query: string, context: ToolEligibilityContext) {
  return qualifyCandidates(CORE_READ_TOOLS, context).available.filter(name => {
    const tool = getTool(name)
    if (tool?.effect !== 'read' || tool.confirmationPolicy !== 'never') return false
    if (/(?:不要|不用|无需|不必|禁止|别).{0,6}(?:检索|搜索|查询|查找|调取|回忆)/.test(query)) return false
    const refused = name === 'search_memory'
      ? /(?:不要|不用|无需|不必|禁止|别).{0,12}(?:记忆|历史)|(?:不要|别).{0,4}按我的/
      : /(?:不要|不用|无需|不必|禁止|别).{0,12}(?:知识库|本地资料|本地文档|检索|搜索)/
    return !refused.test(query)
  })
}
