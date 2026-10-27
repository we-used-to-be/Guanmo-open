import type { ChatTool } from '@/services/ai/types'
import type { McpConnectionCatalog } from './client'
import { decodeMcpToolCatalog } from './toolCatalog'

export interface McpTurnTool {
  readonly serverId: string
  readonly connectionId: string
  readonly catalogRevision: string
  readonly remoteName: string
  readonly modelTool: ChatTool
}

export type McpTurnSnapshot = readonly McpTurnTool[]
export const MAX_MCP_TURN_TOOLS = 16

/** A per-send value, never persisted or registered as an internal tool. */
export function copyMcpTurnSnapshot(tools: McpTurnSnapshot): McpTurnSnapshot {
  if (tools.length > MAX_MCP_TURN_TOOLS || new TextEncoder().encode(JSON.stringify(tools)).byteLength > 65536) {
    throw new Error('本轮 MCP 工具超过数量或大小上限')
  }
  const aliases = new Set<string>()
  const servers = new Map<string, string>()
  const snapshot = tools.map(tool => {
    const alias = tool.modelTool.function.name
    const identity = `${tool.connectionId}/${tool.catalogRevision}`
    if (!tool.connectionId || tool.connectionId.length > 128
      || !alias.startsWith(`mcp_${tool.serverId}_`) || !/^[0-9]+$/.test(alias.slice(`mcp_${tool.serverId}_`.length))
      || aliases.has(alias) || (servers.has(tool.serverId) && servers.get(tool.serverId) !== identity)) {
      throw new Error('本轮 MCP 工具身份无效')
    }
    aliases.add(alias)
    servers.set(tool.serverId, identity)
    const catalog = decodeMcpToolCatalog(tool.serverId, tool.catalogRevision, [{
      name: tool.remoteName,
      description: tool.modelTool.function.description,
      inputSchema: tool.modelTool.function.parameters,
    }])
    return Object.freeze({
      serverId: catalog.serverId,
      connectionId: tool.connectionId,
      catalogRevision: catalog.revision,
      remoteName: catalog.tools[0].remoteName,
      modelTool: Object.freeze({
        type: 'function' as const,
        function: Object.freeze({ ...catalog.tools[0].modelTool.function, name: alias }),
      }),
    })
  })
  if (servers.size > 8) throw new Error('本轮 MCP 服务超过上限')
  return Object.freeze(snapshot)
}

export function selectMcpTurnTool(connection: McpConnectionCatalog, alias: string): McpTurnTool {
  const tool = connection.catalog.tools.find(entry => entry.modelTool.function.name === alias)
  if (!tool) throw new Error('MCP 工具不在当前目录中')
  return copyMcpTurnSnapshot([{
    serverId: connection.catalog.serverId,
    connectionId: connection.connectionId,
    catalogRevision: connection.catalog.revision,
    remoteName: tool.remoteName,
    modelTool: tool.modelTool,
  }])[0]
}
