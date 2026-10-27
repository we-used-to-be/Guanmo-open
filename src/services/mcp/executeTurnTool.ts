import { cancelMcpCall, confirmMcpCall, McpClientError, prepareMcpCall } from './client'
import type { McpCallProposal } from './client'
import type { McpTurnTool } from './turnSnapshot'

export interface McpExecutionResult {
  status: 'success' | 'error' | 'outcome_unknown'
  result: string
}

/** Each invocation owns one proposal; cancellation also revokes late prepare results. */
export async function executeMcpTurnTool(tool: McpTurnTool, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpExecutionResult> {
  let proposal: McpCallProposal | undefined
  let dispatched = false
  let cancelled = false
  let cancelWait: (() => void) | undefined
  const aborted = new Promise<never>((_, reject) => {
    cancelWait = () => reject(new McpClientError('MCP_CALL_CANCELLED'))
  })
  // The rejection is consumed even when cancellation precedes the first IPC.
  void aborted.catch(() => {})
  const cancel = () => {
    cancelled = true
    if (proposal) void cancelMcpCall(proposal.proposalId).catch(() => {})
    cancelWait?.()
  }
  signal?.addEventListener('abort', cancel, { once: true })
  const pack = (status: McpExecutionResult['status'], data: unknown): McpExecutionResult => ({
    status,
    result: JSON.stringify({ kind: 'external_mcp_result', serverId: tool.serverId, remoteName: tool.remoteName, status, data }),
  })
  try {
    if (signal?.aborted) throw new McpClientError('MCP_CALL_CANCELLED')
    const encoded = JSON.stringify(args)
    if (!args || typeof args !== 'object' || Array.isArray(args) || new TextEncoder().encode(encoded).byteLength > 8192) {
      throw new McpClientError('MCP_ARGUMENTS_INVALID')
    }
    const originalArgs = JSON.parse(encoded) as Record<string, unknown>
    const preparing = prepareMcpCall({
      connectionId: tool.connectionId,
      protocolVersion: '',
      catalog: { serverId: tool.serverId, revision: tool.catalogRevision, tools: [{ ...tool, effect: 'external', confirmationPolicy: 'required' }] },
    }, tool.modelTool.function.name, originalArgs).then(value => {
      if (cancelled || signal?.aborted) {
        void cancelMcpCall(value.proposalId).catch(() => {})
        throw new McpClientError('MCP_CALL_CANCELLED')
      }
      proposal = value
      return value
    })
    await Promise.race([preparing, aborted])
    if (!proposal || proposal.serverId !== tool.serverId || proposal.connectionId !== tool.connectionId
      || proposal.catalogRevision !== tool.catalogRevision || proposal.toolName !== tool.remoteName) {
      if (proposal) void cancelMcpCall(proposal.proposalId).catch(() => {})
      throw new McpClientError('MCP_PROPOSAL_INVALID')
    }
    if (signal?.aborted) throw new McpClientError('MCP_CALL_CANCELLED')
    dispatched = true
    const response = await Promise.race([confirmMcpCall(proposal.proposalId), aborted])
    const text = JSON.stringify(response)
    // Keep the envelope valid JSON and preserve isError even when content is large.
    return pack(response.isError ? 'error' : 'success', {
      isError: response.isError === true,
      ...(text.length > 12000 ? { truncated: true, preview: text.slice(0, 12000) } : { result: response }),
    })
  } catch (error) {
    const code = error instanceof McpClientError ? error.code : 'MCP_REQUEST_FAILED'
    const rejectedBeforeCall = ['MCP_CONFIRMATION_REJECTED', 'MCP_CONFIRMATION_BUSY', 'MCP_PROPOSAL_MISSING', 'MCP_PROPOSAL_USED', 'MCP_PROPOSAL_EXPIRED']
    // Catalog/session validation can also fail after the server has already run the call.
    const unknown = code.includes('OUTCOME_UNKNOWN') || (dispatched && !rejectedBeforeCall.includes(code))
    return pack(unknown ? 'outcome_unknown' : 'error', { code, message: unknown
      ? '外部调用结果未知，可能已产生副作用；未自动重试。'
      : '外部调用失败或被拒绝；未自动重试。' })
  } finally {
    signal?.removeEventListener('abort', cancel)
  }
}
