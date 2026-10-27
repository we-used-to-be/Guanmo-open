import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { McpServerSettings } from '@/features/settings/McpServerSettings'

const mocks = vi.hoisted(() => ({ status: vi.fn(), options: vi.fn(), start: vi.fn(), stop: vi.fn(), info: vi.fn() }))
vi.mock('@/services/mcp/server', () => ({ getMcpServerStatus: mocks.status, getMcpServerOptions: mocks.options, startMcpServer: mocks.start, stopMcpServer: mocks.stop, getMcpServerConnectionInfo: mocks.info }))
const inactive = { running: false, starting: false, generation: null, endpoint: null, config: null }
describe('MCP server explicit authorization and settings lifetime', () => {
  beforeEach(() => {
    vi.clearAllMocks(); mocks.status.mockResolvedValue(inactive); mocks.stop.mockResolvedValue(undefined)
    mocks.options.mockResolvedValue({ paths: [{ path: 'D:/anonymous', directory: true }], nextOffset: null })
  })
  it('requires explicit file scope, cancels only its pending start on unmount, and cleans up its late result', async () => {
    let resolve!: (value: unknown) => void
    mocks.start.mockReturnValue(new Promise(r => { resolve = r }))
    const view = render(<McpServerSettings />)
    const enable = await screen.findByRole('button', { name: '启用本机 MCP 服务端' })
    expect(enable).toBeDisabled(); expect(mocks.start).not.toHaveBeenCalled()
    fireEvent.click(await screen.findByLabelText('文件夹 · D:/anonymous'))
    await waitFor(() => expect(enable).toBeEnabled())
    fireEvent.click(enable)
    const requestId = mocks.start.mock.calls[0][1]
    expect(mocks.start.mock.calls[0][0]).toEqual({ paths: ['D:/anonymous'], artifactKeys: [], readDocuments: true, searchKnowledge: true, readArtifacts: false, writeDocuments: false })
    view.unmount()
    expect(mocks.stop).toHaveBeenCalledWith(requestId)
    expect((mocks.start.mock.calls[0][2] as AbortSignal).aborted).toBe(true)
    await act(async () => resolve({ ...inactive, running: true, generation: 'late-owned-generation' }))
    expect(mocks.stop).toHaveBeenCalledWith('late-owned-generation')
    expect(mocks.stop.mock.calls.every(call => typeof call[0] === 'string')).toBe(true)
  })
  it('keeps an established server when leaving settings and reveals credentials only on explicit request', async () => {
    mocks.status.mockResolvedValue({ ...inactive, running: true, generation: 'established', endpoint: 'http://127.0.0.1:12345/mcp', config: { paths: ['D:/anonymous'], artifactKeys: [] } })
    mocks.info.mockResolvedValue({ endpoint: 'http://127.0.0.1:12345/mcp', token: 'anonymous-token' })
    const view = render(<McpServerSettings />)
    const reveal = await screen.findByRole('button', { name: '查看连接信息' })
    expect(mocks.info).not.toHaveBeenCalled()
    fireEvent.click(reveal)
    await screen.findByText('Bearer 令牌：anonymous-token')
    expect(mocks.info).toHaveBeenCalledOnce()
    view.unmount(); expect(mocks.stop).not.toHaveBeenCalled()
  })
})
