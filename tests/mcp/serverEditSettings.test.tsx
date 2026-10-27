import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { McpServerEdits } from '@/features/settings/McpServerEdits'
import { McpClientError } from '@/services/mcp/client'

const mocks = vi.hoisted(() => ({ list:vi.fn(), detail:vi.fn(), approve:vi.fn(), cancel:vi.fn(), revert:vi.fn() }))
vi.mock('@/services/mcp/serverEdits', () => ({ listMcpDocumentEdits:mocks.list, getMcpDocumentEdit:mocks.detail, approveMcpDocumentEdit:mocks.approve, cancelMcpDocumentEdit:mocks.cancel, revertMcpDocumentEdit:mocks.revert }))
const detail = { proposalId:'id', path:'X:/anonymous.md', state:'pending', oldText:'<img src=x onerror=alert(1)>', newText:'replacement', recoveryFiles:[] }
beforeEach(() => {
  vi.clearAllMocks(); mocks.list.mockResolvedValue([detail]); mocks.detail.mockResolvedValue(detail)
  mocks.approve.mockResolvedValue({ status:'written', currentSaved:true })
})
it('shows escaped diff only on explicit review and cannot submit from the list', async () => {
  const view = render(<McpServerEdits />)
  const review = await screen.findByRole('button', { name:'查看差异' })
  expect(screen.queryByRole('button', { name:'核对完成，确认写入' })).not.toBeInTheDocument()
  expect(mocks.approve).not.toHaveBeenCalled()
  fireEvent.click(review)
  await screen.findByText(detail.oldText)
  expect(view.container.querySelector('img')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name:'核对完成，确认写入' }))
  await screen.findByText('修改已写入，当前标签页已同步。')
  expect(mocks.approve).toHaveBeenCalledExactlyOnceWith('id')
})
it('unknown results remain failures and never retry; undo creates a separately reviewable proposal', async () => {
  mocks.approve.mockRejectedValue(new McpClientError('MCP_SERVER_EDIT_OUTCOME_UNKNOWN'))
  const view = render(<McpServerEdits />)
  fireEvent.click(await screen.findByRole('button', { name:'查看差异' }))
  fireEvent.click(await screen.findByRole('button', { name:'核对完成，确认写入' }))
  await screen.findByText(/结果未知时勿重复提交/)
  expect(mocks.approve).toHaveBeenCalledOnce()
  view.unmount()
  mocks.list.mockResolvedValue([{ ...detail, state:'written' }])
  mocks.revert.mockResolvedValue({ proposalId:'reverse' })
  mocks.detail.mockResolvedValue({ ...detail, proposalId:'reverse' })
  render(<McpServerEdits />)
  fireEvent.click(await screen.findByRole('button', { name:'提出撤销' }))
  await waitFor(() => expect(mocks.detail).toHaveBeenLastCalledWith('reverse'))
  await screen.findByText(/尚未撤销写盘/)
  expect(mocks.approve).toHaveBeenCalledOnce()
})

it('a cancellation racing with an already committed write reports the authoritative state', async () => {
  mocks.cancel.mockResolvedValue(undefined)
  mocks.detail.mockResolvedValue({ ...detail, state:'written' })
  render(<McpServerEdits />)
  fireEvent.click(await screen.findByRole('button', { name:'拒绝提案' }))
  await screen.findByText('提案状态：已写入。请核实文件，已提交操作不会回滚。')
  expect(screen.queryByText('提案已取消，未写入。')).not.toBeInTheDocument()
  expect(mocks.approve).not.toHaveBeenCalled()
})
