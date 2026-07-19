/**
 * 工具选择器 - 基于意图的智能工具裁剪
 *
 * 设计原则：
 * 1. 无候选工具不发送 tools
 * 2. 有候选工具只发送相关 tools
 * 3. 禁止每轮发送全量 tools
 */

import type { Capability } from './intentDetector'

// 工具名称类型
export type AgentToolName =
  | 'search_memory'
  | 'list_memories'
  | 'save_memory'
  | 'search_knowledge'
  | 'list_database_contents'
  | 'read_selection_context'
  | 'list_current_edit_targets'
  | 'replace_current_tab_text'
  | 'read_context_file'
  | 'web_search'
  | 'get_current_time'

// 能力到工具的映射
const CAPABILITY_TOOLS: Record<Capability, AgentToolName[]> = {
  memory: ['search_memory', 'list_memories'],
  knowledge: ['search_knowledge', 'list_database_contents'],
  selection_context: ['read_selection_context'],
  file_read: ['read_context_file'],
  file_write: ['list_current_edit_targets', 'replace_current_tab_text'],
  web: ['web_search'],
  time: ['get_current_time'],
}

// 写入类工具（需要确认）
const WRITE_TOOLS: AgentToolName[] = ['replace_current_tab_text', 'save_memory']

// 读取类工具（可以自动执行）
const READ_TOOLS: AgentToolName[] = [
  'search_memory',
  'list_memories',
  'search_knowledge',
  'list_database_contents',
  'read_selection_context',
  'list_current_edit_targets',
  'read_context_file',
  'web_search',
  'get_current_time',
]

/**
 * 根据候选能力构建工具列表
 *
 * @param candidates 候选能力列表
 * @returns 工具名称列表
 */
export function buildCandidateTools(candidates: Capability[]): AgentToolName[] {
  const tools = new Set<AgentToolName>()

  for (const capability of candidates) {
    const capabilityTools = CAPABILITY_TOOLS[capability]
    if (capabilityTools) {
      capabilityTools.forEach(tool => tools.add(tool))
    }
  }

  return Array.from(tools)
}

/**
 * 判断工具是否为写入类工具
 */
export function isWriteTool(toolName: string): boolean {
  return WRITE_TOOLS.includes(toolName as AgentToolName)
}

/**
 * 判断工具是否为读取类工具
 */
export function isReadTool(toolName: string): boolean {
  return READ_TOOLS.includes(toolName as AgentToolName)
}

/**
 * 检查强依赖能力是否已满足
 *
 * @param required 强依赖能力列表
 * @param calledTools 已调用的工具列表
 * @returns 未满足的能力列表
 */
export function checkRequiredCapabilities(
  required: Capability[],
  calledTools: string[]
): Capability[] {
  return required.filter(capability => {
    const requiredTools = CAPABILITY_TOOLS[capability]
    if (!requiredTools) return false

    // 检查是否有任意一个相关工具被调用
    return !requiredTools.some(tool => calledTools.includes(tool))
  })
}

/**
 * 获取需要补调的工具
 *
 * @param unmetCapabilities 未满足的能力
 * @returns 需要补调的工具列表
 */
export function getRepairTools(unmetCapabilities: Capability[]): AgentToolName[] {
  const tools: AgentToolName[] = []

  for (const capability of unmetCapabilities) {
    const capabilityTools = CAPABILITY_TOOLS[capability]
    if (capabilityTools) {
      // 只补调读取类工具，不补调写入类工具
      const readTools = capabilityTools.filter(tool => isReadTool(tool))
      tools.push(...readTools)
    }
  }

  return tools
}

/**
 * 获取能力的提示信息
 */
export function getCapabilityHint(capability: Capability): string {
  const hints: Record<Capability, string> = {
    memory: '用户问题涉及长期记忆，已自动检索记忆库',
    knowledge: '用户问题涉及本地知识库，已自动检索文档',
    selection_context: '用户问题依赖选区附近内容，已自动读取受限的选区上下文',
    file_read: '用户问题涉及文件读取，已自动读取文件',
    file_write: '用户问题涉及文件修改，需要用户确认',
    web: '用户问题需要网络搜索，已自动搜索',
    time: '用户问题涉及时间信息，已自动获取当前时间',
  }
  return hints[capability] || ''
}

/**
 * 获取工具的 token 预算
 */
export function getToolTokenBudget(toolName: string): number {
  const budgets: Record<string, number> = {
    search_memory: 3000,
    list_memories: 4000,
    search_knowledge: 5000,
    list_database_contents: 5000,
    read_selection_context: 1400,
    list_current_edit_targets: 1000,
    read_context_file: 4000,
    web_search: 3000,
    get_current_time: 1000,
    save_memory: 1000,
    replace_current_tab_text: 2000,
  }
  return budgets[toolName] || 3000
}
