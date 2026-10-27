import { isTauri } from '@/hooks/useTauri'
import { UnsupportedCapabilityError } from '@/services/externalHttp'
import { decodeMcpToolCatalog, type McpToolCatalog } from './toolCatalog'

export interface McpStdioConfig {
  transport?: never
  serverId: string
  executable: string
  args: string[]
  cwd: string
}

export interface McpHttpConfig {
  transport: 'http'
  serverId: string
  url: string
}

/** An absent discriminator is the original v1 stdio format. */
export type McpServerConfig = McpStdioConfig | McpHttpConfig

export interface McpServerView {
  config: McpServerConfig
  name: string
  enabled: boolean
  envNames: string[]
  connectionId: string | null
  status: 'disconnected' | 'connecting' | 'connected'
  authorizationStatus: 'notRequired' | 'required' | 'authorized' | 'authorizing'
  authorizationError: string | null
}

export interface McpResourceCatalog {
  connectionId: string
  catalogRevision: string
  resources: Array<{ uri: string; name: string; description?: string; mimeType?: string }>
}

export interface McpPromptCatalog {
  connectionId: string
  catalogRevision: string
  prompts: Array<{ name: string; description?: string; arguments?: Array<{ name: string; description?: string; required?: boolean }> }>
}

export interface McpServerUpdate {
  config: McpServerConfig
  name: string
  /** Omitted: retain; string: replace; null: remove. Never receives old values. */
  envChanges: Record<string, string | null>
}

interface NativeCatalog {
  serverId: string
  connectionId: string
  catalogRevision: string
  protocolVersion: string
  tools: unknown
}

export interface McpConnectionCatalog {
  connectionId: string
  protocolVersion: string
  catalog: McpToolCatalog
}

export interface McpCallProposal {
  proposalId: string
  serverId: string
  connectionId: string
  catalogRevision: string
  toolName: string
  arguments: Record<string, unknown>
  expiresInSeconds: number
}

/** Content is untrusted external data; callers must render it as such. */
export interface McpCallResult {
  content: readonly unknown[]
  structuredContent?: unknown
  isError?: boolean
}

export class McpClientError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = 'McpClientError'
  }
}

async function request<T>(command: string, args: Record<string, unknown>): Promise<T> {
  if (!isTauri()) throw new UnsupportedCapabilityError('MCP')
  const { invoke } = await import('@tauri-apps/api/core')
  try {
    return await invoke<T>(command, args)
  } catch (error) {
    // Never include protocol errors, tool arguments, process paths or stderr in errors/logs.
    throw new McpClientError(typeof error === 'string' && /^MCP_[A-Z_]+$/.test(error) ? error : 'MCP_REQUEST_FAILED')
  }
}

async function catalogRequest(command: string, args: Record<string, unknown>): Promise<McpConnectionCatalog> {
  const result = await request<NativeCatalog>(command, args)
  try {
    return {
      connectionId: result.connectionId,
      protocolVersion: result.protocolVersion,
      catalog: decodeMcpToolCatalog(result.serverId, result.catalogRevision, result.tools),
    }
  } catch {
    // A rejected directory must not leave an undisclosed child process running.
    await disconnectMcp(result.connectionId).catch(() => {})
    throw new McpClientError('MCP_CATALOG_INVALID')
  }
}

export function registerMcpStdio(config: McpStdioConfig): Promise<void> {
  return request('mcp_register_stdio', { config })
}

export function listMcpServers(): Promise<McpServerView[]> {
  return request('mcp_list_servers', {})
}

export function saveMcpServer(update: McpServerUpdate): Promise<void> {
  return request('mcp_save_server', { update })
}

export interface McpAuthorizationStatus { serverId: string; status: 'pending' }

export function authorizeMcpServer(serverId: string, requestId: string): Promise<McpAuthorizationStatus> {
  return request('mcp_authorize', { serverId, requestId })
}

export function cancelMcpAuthorization(serverId: string): Promise<void> {
  return request('mcp_cancel_authorize', { serverId })
}

export function revokeMcpAuthorization(serverId: string): Promise<void> {
  return request('mcp_revoke_authorization', { serverId })
}

export function setMcpServerEnabled(serverId: string, enabled: boolean): Promise<void> {
  return request('mcp_set_server_enabled', { serverId, enabled })
}

export function deleteMcpServer(serverId: string): Promise<void> {
  return request('mcp_delete_server', { serverId })
}

export function connectMcp(serverId: string, requestId: string): Promise<McpConnectionCatalog> {
  return catalogRequest('mcp_connect', { serverId, requestId })
}

/** Session-only HTTP connection; Rust owns consent and all network requests. */
export function connectMcpHttp(url: string, requestId: string): Promise<McpConnectionCatalog> {
  return catalogRequest('mcp_connect_http', { url, requestId })
}

export function cancelMcpConnect(requestId: string): Promise<void> {
  return request('mcp_cancel_connect', { requestId })
}

export function refreshMcpTools(connectionId: string): Promise<McpConnectionCatalog> {
  return catalogRequest('mcp_list_tools', { connectionId })
}

export function prepareMcpCall(connection: McpConnectionCatalog, modelAlias: string, args: Record<string, unknown>): Promise<McpCallProposal> {
  const tool = connection.catalog.tools.find(entry => entry.modelTool.function.name === modelAlias)
  if (!tool) return Promise.reject(new McpClientError('MCP_TOOL_MISSING'))
  return request('mcp_prepare_call', {
    request: {
      connectionId: connection.connectionId,
      catalogRevision: connection.catalog.revision,
      toolName: tool.remoteName,
      arguments: args,
    },
  })
}

/** Rust displays native consent and rechecks the stored one-time proposal before dispatch. */
export function confirmMcpCall(proposalId: string): Promise<McpCallResult> {
  return request('mcp_confirm_call', { proposalId })
}

export function cancelMcpCall(proposalId: string): Promise<void> {
  return request('mcp_cancel_call', { proposalId })
}

export function disconnectMcp(connectionId: string): Promise<void> {
  return request('mcp_disconnect', { connectionId })
}

export function listMcpResources(connectionId: string): Promise<McpResourceCatalog> {
  return request('mcp_list_resources', { connectionId })
}

export function readMcpResource(connectionId: string, catalogRevision: string, uri: string): Promise<unknown> {
  return request('mcp_read_resource', { request: { connectionId, catalogRevision, uri } })
}

export function listMcpPrompts(connectionId: string): Promise<McpPromptCatalog> {
  return request('mcp_list_prompts', { connectionId })
}

export function getMcpPrompt(connectionId: string, catalogRevision: string, name: string, arguments_: Record<string, unknown>): Promise<unknown> {
  return request('mcp_get_prompt', { request: { connectionId, catalogRevision, name, arguments: arguments_ } })
}
