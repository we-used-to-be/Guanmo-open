import { useState } from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { McpToolPicker } from '@/components/ai/McpToolPicker'
import { decodeMcpToolCatalog } from '@/services/mcp/toolCatalog'
import type { McpTurnSnapshot } from '@/services/mcp/turnSnapshot'

const mocks = vi.hoisted(() => ({ list: vi.fn(), refresh: vi.fn(), desktop: vi.fn(() => true) }))
vi.mock('@/hooks/useTauri', () => ({ isTauri: mocks.desktop }))
vi.mock('@/services/mcp/client', () => ({ listMcpServers: mocks.list, refreshMcpTools: mocks.refresh }))
const server = { config: { serverId: 'anon' }, name: 'Anonymous', enabled: true, connectionId: 'conn', status: 'connected' }
const catalog = { connectionId: 'conn', protocolVersion: 'fixture', catalog: decodeMcpToolCatalog('anon', 'rev', [{ name: 'echo', inputSchema: { type: 'object' } }]) }
function Harness() {
  const [value, setValue] = useState<McpTurnSnapshot>([])
  return <><McpToolPicker value={value} onChange={setValue} disabled={false} /><output>{JSON.stringify(value)}</output><button onClick={() => setValue([])}>模拟发送</button></>
}

describe('explicit MCP picker', () => {
  beforeEach(() => {
    vi.clearAllMocks(); mocks.desktop.mockReturnValue(true)
    mocks.list.mockResolvedValue([server, { ...server, name: 'Offline', status: 'disconnected' }])
    mocks.refresh.mockResolvedValue(catalog)
  })

  it('does no mount IPC, lists only connected servers, reads only the clicked directory and clears after send', async () => {
    render(<Harness />)
    expect(mocks.list).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '本轮 MCP 工具' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Anonymous' }))
    expect(screen.queryByText('Offline')).not.toBeInTheDocument()
    expect(mocks.refresh).toHaveBeenCalledExactlyOnceWith('conn')
    fireEvent.click(await screen.findByRole('menuitemcheckbox', { name: 'echo' }))
    expect(screen.getByRole('status')).toHaveTextContent('"remoteName":"echo"')
    fireEvent.click(screen.getByRole('menuitem', { name: '完成选择' }))
    fireEvent.click(screen.getByRole('button', { name: '模拟发送' }))
    expect(screen.getByRole('status')).toHaveTextContent('[]')
  })

  it('ignores late directory replies after close and rejects changed connection identity', async () => {
    let resolve!: (value: typeof catalog) => void
    mocks.refresh.mockReturnValueOnce(new Promise(r => { resolve = r }))
    render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: '本轮 MCP 工具' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Anonymous' }))
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    await act(async () => resolve(catalog))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    mocks.refresh.mockResolvedValueOnce({ ...catalog, connectionId: 'new-connection' })
    fireEvent.click(screen.getByRole('button', { name: '本轮 MCP 工具' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Anonymous' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('读取工具目录失败')
    expect(screen.queryByRole('menuitemcheckbox')).not.toBeInTheDocument()
  })

  it('shows listing errors without offering stale tools and does no work on Web', async () => {
    mocks.list.mockRejectedValueOnce(new Error('private detail'))
    const view = render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: '本轮 MCP 工具' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('读取 MCP 服务失败')
    expect(screen.queryByText('private detail')).not.toBeInTheDocument()
    view.unmount(); mocks.desktop.mockReturnValue(false)
    render(<Harness />)
    await waitFor(() => expect(screen.queryByRole('button', { name: '本轮 MCP 工具' })).not.toBeInTheDocument())
    expect(mocks.list).toHaveBeenCalledTimes(1)
  })

  it('discovers a persisted HTTP directory with the same explicit connection and revision binding', async () => {
    mocks.list.mockResolvedValue([{ ...server, config: { serverId: 'anon', transport: 'http', url: 'https://anonymous.example/mcp' }, name: 'Remote' }])
    render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: '本轮 MCP 工具' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Remote' }))
    fireEvent.click(await screen.findByRole('menuitemcheckbox', { name: 'echo' }))
    expect(mocks.refresh).toHaveBeenCalledExactlyOnceWith('conn')
    expect(screen.getByRole('status')).toHaveTextContent('"connectionId":"conn"')
    expect(screen.getByRole('status')).toHaveTextContent('"catalogRevision":"rev"')
  })
})
