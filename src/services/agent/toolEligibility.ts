import { getTool } from './toolRegistry'

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
