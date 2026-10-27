import { captureDocumentWriteSnapshot, validateDocumentWriteSnapshot, applyDocumentWriteSnapshot, type DocumentWriteSnapshot, type SaveReceipt } from '@/services/documentSave'
import { commitMcpDocumentEdit } from '@/hooks/useTauri'
import { toast } from '@/services/toast'
import { McpClientError } from './client'
import { mcpServerRequest } from './server'
import type { McpServerQuery } from './serverData'

export interface McpDocumentEdit { proposalId: string; path: string; state: string; beforeHash: string; afterHash: string }
export interface McpDocumentEditDetail extends McpDocumentEdit { before: string; after: string; oldText: string; newText: string; recoveryFiles: string[] }
const snapshots = new Map<string, { generation: string; snapshot: DocumentWriteSnapshot; expires: number }>()
const applying = new Set<string>()

function prune() { for (const [id, value] of snapshots) if (value.expires <= Date.now()) snapshots.delete(id) }
export function clearMcpEditSnapshots(generation?: string) {
  for (const [id, value] of snapshots) if (!generation || value.generation === generation) snapshots.delete(id)
}
export function captureMcpDocumentEdit(query: McpServerQuery): { captured: true } {
  prune()
  const { proposalId, path, content } = query.arguments
  if (typeof proposalId !== 'string' || typeof path !== 'string' || typeof content !== 'string' || snapshots.size >= 8) throw new Error('MCP_SERVER_BUSY')
  try {
    const snapshot = captureDocumentWriteSnapshot(path, content)
    snapshots.set(proposalId, { generation: query.generation, snapshot, expires: Date.now() + 300000 })
  } catch { throw new Error('MCP_SERVER_EDIT_CONFLICT') }
  toast.info('外部客户端提出了文档修改，请到设置 → MCP 核对提案。')
  return { captured: true }
}
export function listMcpDocumentEdits(): Promise<McpDocumentEdit[]> { return mcpServerRequest('mcp_server_edits') }
export function getMcpDocumentEdit(proposalId: string): Promise<McpDocumentEditDetail> { return mcpServerRequest('mcp_server_edit_detail', { proposalId }) }
export function revertMcpDocumentEdit(proposalId: string): Promise<McpDocumentEdit> { return mcpServerRequest('mcp_server_revert_edit', { proposalId }) }
export async function cancelMcpDocumentEdit(proposalId: string): Promise<void> {
  await mcpServerRequest('mcp_server_cancel_edit', { proposalId })
  snapshots.delete(proposalId)
}
export async function approveMcpDocumentEdit(proposalId: string): Promise<SaveReceipt> {
  if (applying.has(proposalId)) throw new McpClientError('MCP_SERVER_BUSY')
  prune()
  const saved = snapshots.get(proposalId)
  if (!saved) throw new McpClientError('MCP_SERVER_EDIT_CONFLICT')
  applying.add(proposalId)
  try {
    const detail = await getMcpDocumentEdit(proposalId)
    if (detail.state !== 'pending' || detail.path !== saved.snapshot.path || detail.before !== saved.snapshot.content) throw new McpClientError('MCP_SERVER_EDIT_CONFLICT')
    validateDocumentWriteSnapshot(saved.snapshot)
    await mcpServerRequest('mcp_server_approve_edit', { proposalId })
    return await applyDocumentWriteSnapshot(saved.snapshot, detail.after, () => commitMcpDocumentEdit(proposalId))
  } catch (error) {
    await mcpServerRequest('mcp_server_cancel_edit', { proposalId }).catch(() => {})
    if (error instanceof Error && /^DOCUMENT_SAVE_/.test(error.message)) throw new McpClientError('MCP_SERVER_EDIT_CONFLICT')
    if (typeof error === 'string') throw new McpClientError(/^MCP_[A-Z_]+$/.test(error) ? error : 'MCP_SERVER_EDIT_OUTCOME_UNKNOWN')
    throw error
  } finally { snapshots.delete(proposalId); applying.delete(proposalId) }
}
