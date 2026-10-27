import { isTauri } from '@/hooks/useTauri'
import { UnsupportedCapabilityError } from '@/services/externalHttp'
import { McpClientError } from './client'
import type { McpServerPath, McpServerQuery } from './serverData'

export interface McpServerConfig { paths: string[]; artifactKeys: string[]; readDocuments: boolean; searchKnowledge: boolean; readArtifacts: boolean; writeDocuments?: boolean }
export interface McpServerStatus { running: boolean; starting: boolean; generation: string | null; endpoint: string | null; config: McpServerConfig | null }
export interface McpServerConnectionInfo { endpoint: string; token: string }
let unlisten: (() => void) | null = null
let installing: Promise<void> | null = null
let activeQueries = 0

export async function mcpServerRequest<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  if (!isTauri()) throw new UnsupportedCapabilityError('MCP server')
  const { invoke } = await import('@tauri-apps/api/core')
  try { return await invoke<T>(command, args) } catch (error) { throw new McpClientError(typeof error === 'string' && /^MCP_[A-Z_]+$/.test(error) ? error : 'MCP_SERVER_REQUEST_FAILED') }
}
const request = mcpServerRequest

async function ensureBridge(): Promise<void> {
  if (!isTauri()) throw new UnsupportedCapabilityError('MCP server')
  if (unlisten) return
  if (!installing) installing = (async () => {
    const { listen } = await import('@tauri-apps/api/event')
    const { handleMcpServerQuery } = await import('./serverData')
    const { captureMcpDocumentEdit } = await import('./serverEdits')
    unlisten = await listen<McpServerQuery>('guanmo:mcp-server-query', async event => {
      const query = event.payload
      let result: unknown = null
      let error: string | null = null
      let entered = false
      try {
        if (activeQueries >= 4) throw new Error('MCP_SERVER_BUSY')
        activeQueries++; entered = true
        result = query.toolName === 'capture_document_edit' ? captureMcpDocumentEdit(query) : await handleMcpServerQuery(query)
      } catch (cause) {
        error = cause instanceof Error && /^MCP_SERVER_[A-Z_]+$/.test(cause.message) ? cause.message : 'MCP_SERVER_QUERY_FAILED'
      }
      // Rust accepts only the pending request with this exact generation; no retries.
      await request('mcp_server_reply', { requestId: query.requestId, generation: query.generation, result, error }).catch(() => {})
      if (entered) activeQueries--
    })
  })().finally(() => { installing = null })
  await installing
}

export async function getMcpServerStatus(): Promise<McpServerStatus> {
  const status = await request<McpServerStatus>('mcp_server_status')
  if (status.running) await ensureBridge()
  return status
}
export function getMcpServerOptions(offset = 0): Promise<{ paths: McpServerPath[]; nextOffset: number | null }> { return request('mcp_server_options', { offset }) }
export async function startMcpServer(config: McpServerConfig, requestId = crypto.randomUUID(), signal?: AbortSignal): Promise<McpServerStatus> {
  if (signal?.aborted) throw new McpClientError('MCP_CANCELLED')
  await ensureBridge()
  if (signal?.aborted) throw new McpClientError('MCP_CANCELLED')
  return request('mcp_server_start', { config, requestId })
}
export async function stopMcpServer(generation?: string): Promise<void> {
  await request('mcp_server_stop', { generation: generation ?? null })
  const { clearMcpEditSnapshots } = await import('./serverEdits')
  clearMcpEditSnapshots(generation)
  // The single passive UI listener survives stop/restart; it does no work without a Rust query.
}
export function getMcpServerConnectionInfo(): Promise<McpServerConnectionInfo> { return request('mcp_server_connection_info') }
