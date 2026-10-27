import { beforeEach, expect, it, vi } from 'vitest'
import { useEditorStore } from '@/stores/editorStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { approveMcpDocumentEdit, captureMcpDocumentEdit, clearMcpEditSnapshots, cancelMcpDocumentEdit } from '@/services/mcp/serverEdits'
import type { McpServerQuery } from '@/services/mcp/serverData'

const mocks = vi.hoisted(() => ({ request:vi.fn(), commit:vi.fn(), writer:vi.fn(), info:vi.fn() }))
vi.mock('@/services/mcp/server', () => ({ mcpServerRequest:mocks.request }))
vi.mock('@/hooks/useTauri', () => ({ isTauri:() => true, commitMcpDocumentEdit:mocks.commit }))
vi.mock('@/services/fileSystem', () => ({ saveFile:mocks.writer, selectSaveTarget:vi.fn() }))
vi.mock('@/services/rag/indexer', () => ({ scheduleMarkdownDocumentIndex:vi.fn() }))
vi.mock('@/services/toast', () => ({ toast:{ info:mocks.info, warning:vi.fn(), error:vi.fn() } }))
const detail = { proposalId:'anonymous-id', path:'X:/anonymous.md', before:'before', after:'after', oldText:'before', newText:'after', state:'pending', beforeHash:'hash', afterHash:'hash2', recoveryFiles:[] }
function query(id = detail.proposalId, generation = 'generation'): McpServerQuery {
  return { requestId:'request', generation, toolName:'capture_document_edit', arguments:{ proposalId:id, path:detail.path, content:detail.before }, paths:[], artifactKeys:[] }
}
function resetTab() {
  useEditorStore.setState({ tabs:[{ id:'tab', filePath:detail.path, title:'anonymous.md', content:'before', savedContent:'before', originalContent:'before', modified:false }] })
}
beforeEach(() => {
  vi.clearAllMocks(); clearMcpEditSnapshots()
  useSettingsStore.setState({ editor:{ ...useSettingsStore.getState().editor, autoSave:false } })
  useEditorStore.setState({ tabs:[] }); resetTab()
  mocks.request.mockImplementation(async command => command === 'mcp_server_edit_detail' ? detail : undefined)
  mocks.commit.mockResolvedValue(undefined)
})

it('capture does not write; approval precedes the ID-only disk command and updates the saved baseline', async () => {
  expect(captureMcpDocumentEdit(query())).toEqual({ captured:true })
  expect(mocks.commit).not.toHaveBeenCalled(); expect(mocks.request).not.toHaveBeenCalled()
  expect(await approveMcpDocumentEdit(detail.proposalId)).toMatchObject({ status:'written', currentSaved:true })
  expect(mocks.request.mock.calls.map(call => call[0])).toEqual(['mcp_server_edit_detail', 'mcp_server_approve_edit'])
  expect(mocks.commit).toHaveBeenCalledExactlyOnceWith('anonymous-id')
  expect(useEditorStore.getState().tabs[0]).toMatchObject({ content:'after', savedContent:'after' })
  await expect(approveMcpDocumentEdit(detail.proposalId)).rejects.toMatchObject({ code:'MCP_SERVER_EDIT_CONFLICT' })
})

it('a dirty Tab rejects capture and an unknown proposal cannot request native approval', async () => {
  useEditorStore.getState().updateTabContent('tab', 'draft')
  expect(() => captureMcpDocumentEdit(query())).toThrow('MCP_SERVER_EDIT_CONFLICT')
  await expect(approveMcpDocumentEdit('unknown')).rejects.toMatchObject({ code:'MCP_SERVER_EDIT_CONFLICT' })
  expect(mocks.request).not.toHaveBeenCalled(); expect(mocks.commit).not.toHaveBeenCalled()
})

it('an edit during native confirmation invalidates the queued write and preserves the draft', async () => {
  captureMcpDocumentEdit(query())
  mocks.request.mockImplementation(async command => {
    if (command === 'mcp_server_edit_detail') return detail
    if (command === 'mcp_server_approve_edit') useEditorStore.getState().updateTabContent('tab', 'late draft')
  })
  await expect(approveMcpDocumentEdit(detail.proposalId)).rejects.toMatchObject({ code:'MCP_SERVER_EDIT_CONFLICT' })
  expect(mocks.commit).not.toHaveBeenCalled()
  expect(mocks.request).toHaveBeenLastCalledWith('mcp_server_cancel_edit', { proposalId:detail.proposalId })
  expect(useEditorStore.getState().tabs[0]).toMatchObject({ content:'late draft', savedContent:'before' })
})

it('rejecting native confirmation and an unknown disk result never stage or retry the replacement', async () => {
  captureMcpDocumentEdit(query())
  mocks.request.mockImplementation(async command => {
    if (command === 'mcp_server_edit_detail') return detail
    if (command === 'mcp_server_approve_edit') throw 'MCP_CONFIRMATION_REJECTED'
  })
  await expect(approveMcpDocumentEdit(detail.proposalId)).rejects.toMatchObject({ code:'MCP_CONFIRMATION_REJECTED' })
  expect(mocks.commit).not.toHaveBeenCalled()
  mocks.request.mockImplementation(async command => command === 'mcp_server_edit_detail' ? detail : undefined)
  captureMcpDocumentEdit(query())
  mocks.commit.mockRejectedValue('MCP_SERVER_EDIT_OUTCOME_UNKNOWN')
  await expect(approveMcpDocumentEdit(detail.proposalId)).rejects.toMatchObject({ code:'MCP_SERVER_EDIT_OUTCOME_UNKNOWN' })
  expect(mocks.commit).toHaveBeenCalledOnce(); expect(mocks.writer).not.toHaveBeenCalled()
  expect(useEditorStore.getState().tabs[0]).toMatchObject({ content:'before', savedContent:'before' })
})

it('stale generation cleanup preserves a newer proposal, while explicit cancellation removes its snapshot', async () => {
  captureMcpDocumentEdit(query())
  clearMcpEditSnapshots('old-generation')
  await cancelMcpDocumentEdit(detail.proposalId)
  await expect(approveMcpDocumentEdit(detail.proposalId)).rejects.toMatchObject({ code:'MCP_SERVER_EDIT_CONFLICT' })
  expect(mocks.request).toHaveBeenCalledExactlyOnceWith('mcp_server_cancel_edit', { proposalId:detail.proposalId })
  captureMcpDocumentEdit(query())
  clearMcpEditSnapshots('generation')
  await expect(approveMcpDocumentEdit(detail.proposalId)).rejects.toMatchObject({ code:'MCP_SERVER_EDIT_CONFLICT' })
})

it('duplicate UI approval cannot cancel or dispatch the already active confirmation', async () => {
  captureMcpDocumentEdit(query())
  let confirmed!: () => void
  const pending = new Promise<void>(resolve => { confirmed = resolve })
  mocks.request.mockImplementation(async command => command === 'mcp_server_edit_detail' ? detail : command === 'mcp_server_approve_edit' ? pending : undefined)
  const first = approveMcpDocumentEdit(detail.proposalId)
  await vi.waitFor(() => expect(mocks.request).toHaveBeenCalledWith('mcp_server_approve_edit', { proposalId:detail.proposalId }))
  await expect(approveMcpDocumentEdit(detail.proposalId)).rejects.toMatchObject({ code:'MCP_SERVER_BUSY' })
  expect(mocks.request.mock.calls.some(call => call[0] === 'mcp_server_cancel_edit')).toBe(false)
  confirmed(); await first
  expect(mocks.commit).toHaveBeenCalledOnce()
})
