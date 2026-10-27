import type { ChatTool, ToolInputSchema } from '@/services/ai/types'

const MAX_TOOLS = 200
const MAX_DESCRIPTION_LENGTH = 8192
const MAX_JSON_LENGTH = 262144
const MAX_JSON_DEPTH = 32
const MAX_JSON_NODES = 20000

export interface McpCatalogTool {
  readonly remoteName: string
  readonly modelTool: ChatTool
  /** 仅声明策略；后续执行层必须在调用前独立核验用户确认。 */
  readonly effect: 'external'
  readonly confirmationPolicy: 'required'
}

export interface McpToolCatalog {
  readonly serverId: string
  readonly revision: string
  /** 模型别名仅在本 serverId/revision 快照内有效，不得用新目录解释旧调用。 */
  readonly tools: readonly McpCatalogTool[]
}

function invalidCatalog(): never {
  // 不回显外部工具描述、参数或原始错误。
  throw new Error('MCP 工具目录格式无效或超过上限')
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function cloneJson(value: unknown, budget: { nodes: number; length: number }, depth = 0): unknown {
  if (depth > MAX_JSON_DEPTH || ++budget.nodes > MAX_JSON_NODES) invalidCatalog()
  if (typeof value === 'string') {
    budget.length += value.length
    if (budget.length > MAX_JSON_LENGTH) invalidCatalog()
    return value
  }
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (Array.isArray(value)) {
    return Object.freeze(Array.from(value, entry => cloneJson(entry, budget, depth + 1)))
  }
  if (!isObject(value)) invalidCatalog()
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) invalidCatalog()
  const entries = Object.entries(value).map(([key, entry]) => {
    budget.length += key.length
    if (budget.length > MAX_JSON_LENGTH) invalidCatalog()
    return [key, cloneJson(entry, budget, depth + 1)] as const
  })
  return Object.freeze(Object.fromEntries(entries))
}

function inputSchema(value: unknown): ToolInputSchema {
  if (!isObject(value) || value.type !== 'object') invalidCatalog()
  if ('properties' in value && !isObject(value.properties)) invalidCatalog()
  if ('required' in value && (
    !Array.isArray(value.required)
    || value.required.some(entry => typeof entry !== 'string')
    || new Set(value.required).size !== value.required.length
  )) invalidCatalog()
  // 不裁平 Schema，也不解析远程 $ref；完整语义验证归 SDK/实际执行边界。
  return value as ToolInputSchema
}

/** 解码已聚合的 tools/list 数据；不注册工具、不连接服务、不产生调用。 */
export function decodeMcpToolCatalog(serverId: string, revision: string, tools: unknown): McpToolCatalog {
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(serverId) || !/^[A-Za-z0-9_.:-]{1,128}$/.test(revision)) invalidCatalog()
  if (!Array.isArray(tools) || tools.length > MAX_TOOLS) invalidCatalog()

  const snapshot = cloneJson(tools, { nodes: 0, length: 0 }) as unknown[]
  if (JSON.stringify(snapshot).length > MAX_JSON_LENGTH) invalidCatalog()
  const names = new Set<string>()
  const decoded = snapshot.map(tool => {
    if (!isObject(tool) || typeof tool.name !== 'string' || !/^[A-Za-z0-9_.-]{1,128}$/.test(tool.name)) invalidCatalog()
    if (names.has(tool.name)) invalidCatalog()
    names.add(tool.name)
    if ('description' in tool && (typeof tool.description !== 'string' || tool.description.length > MAX_DESCRIPTION_LENGTH)) invalidCatalog()
    return {
      name: tool.name,
      description: typeof tool.description === 'string' ? tool.description : '',
      schema: inputSchema(tool.inputSchema),
    }
  }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)

  return Object.freeze({
    serverId,
    revision,
    tools: Object.freeze(decoded.map((tool, index) => Object.freeze({
      remoteName: tool.name,
      modelTool: Object.freeze({
        type: 'function' as const,
        function: Object.freeze({
          // 避免远端长名称超出模型供应商常见的 64 字符上限。
          name: `mcp_${serverId}_${index}`,
          description: tool.description,
          parameters: tool.schema,
        }),
      }),
      effect: 'external' as const,
      confirmationPolicy: 'required' as const,
    }))),
  })
}
