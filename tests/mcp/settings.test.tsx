import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { McpSettings } from '@/features/settings/McpSettings'

const mocks = vi.hoisted(() => ({ list: vi.fn(), save: vi.fn(), enable: vi.fn(), remove: vi.fn(), connect: vi.fn(), cancel: vi.fn(), disconnect: vi.fn(), desktop: vi.fn(() => true), authorize: vi.fn(), cancelAuth: vi.fn(), revoke: vi.fn(), resources: vi.fn(), read: vi.fn(), prompts: vi.fn(), getPrompt: vi.fn() }))
vi.mock('@/hooks/useTauri', () => ({ isTauri: mocks.desktop }))
vi.mock('@/services/mcp/client', () => ({
  listMcpServers: mocks.list, saveMcpServer: mocks.save, setMcpServerEnabled: mocks.enable,
  deleteMcpServer: mocks.remove, connectMcp: mocks.connect, cancelMcpConnect: mocks.cancel,
  disconnectMcp: mocks.disconnect, McpClientError: class extends Error {},
  authorizeMcpServer: mocks.authorize, cancelMcpAuthorization: mocks.cancelAuth, revokeMcpAuthorization: mocks.revoke,
  listMcpResources: mocks.resources, readMcpResource: mocks.read, listMcpPrompts: mocks.prompts, getMcpPrompt: mocks.getPrompt,
}))

const server = { config: { serverId: 'anonymous', executable: 'C:\\fixture\\node.exe', args: ['fixture.cjs'], cwd: 'C:\\fixture' }, name: 'Anonymous', enabled: false, envNames: ['TOKEN', 'DELETE_ME'], connectionId: null, status: 'disconnected' }
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r }); return { promise, resolve } }

describe('MCP settings lifecycle and write-only credentials', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.desktop.mockReturnValue(true)
    mocks.list.mockResolvedValue([server])
    mocks.save.mockResolvedValue(undefined); mocks.enable.mockResolvedValue(undefined)
    mocks.remove.mockResolvedValue(undefined); mocks.cancel.mockResolvedValue(undefined); mocks.disconnect.mockResolvedValue(undefined)
  })

  it('starts OAuth only on request and obtains final authorization state through manual refresh', async () => {
    const http = { ...server, config: { transport: 'http', serverId: 'remote', url: 'https://anonymous.example/mcp' }, enabled: true, authorizationStatus: 'required' };
    mocks.list.mockResolvedValue([http])
    mocks.authorize.mockResolvedValue({ serverId: 'remote', status: 'pending' })
    render(<McpSettings />)
    fireEvent.click(await screen.findByRole('button', { name: 'OAuth 授权' }))
    await waitFor(() => expect(mocks.authorize).toHaveBeenCalledExactlyOnceWith('remote', expect.any(String)))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('完成后刷新状态'))
    expect(mocks.connect).not.toHaveBeenCalled()
    mocks.list.mockResolvedValue([{ ...http, authorizationStatus: 'authorized' }])
    fireEvent.click(screen.getByRole('button', { name: '刷新状态' }))
    expect(await screen.findByRole('button', { name: '撤销授权' })).toBeInTheDocument()
  })

  it('reads only selected snapshot resources, escapes external content and hides it after reconnect', async () => {
    const connected = { ...server, enabled: true, status: 'connected', connectionId: 'first' }
    mocks.list.mockResolvedValue([connected])
    mocks.resources.mockResolvedValue({ connectionId: 'first', catalogRevision: 'resource-revision', resources: [{ uri: 'anon://fixture/one', name: 'One' }] })
    mocks.read.mockResolvedValue({ contents: [{ uri: 'anon://fixture/one', text: '<img src=x onerror=alert(1)>' }] })
    render(<McpSettings />)
    fireEvent.click(await screen.findByRole('button', { name: '列出 Resources' }))
    await screen.findByText('One')
    expect(mocks.read).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '读取资源' }))
    const content = await screen.findByRole('region', { name: 'MCP 外部内容 Anonymous' })
    expect(mocks.read).toHaveBeenCalledExactlyOnceWith('first', 'resource-revision', 'anon://fixture/one')
    expect(content).toHaveTextContent('<img src=x onerror=alert(1)>')
    expect(content.querySelector('img')).toBeNull()
    await waitFor(() => expect(screen.getByRole('button', { name: '刷新状态' })).toBeEnabled())
    mocks.list.mockResolvedValue([{ ...connected, connectionId: 'second' }])
    fireEvent.click(screen.getByRole('button', { name: '刷新状态' }))
    await waitFor(() => expect(screen.queryByRole('region', { name: 'MCP 外部内容 Anonymous' })).not.toBeInTheDocument())
    expect(screen.queryByRole('button', { name: '读取资源' })).not.toBeInTheDocument()
  })

  it('only lists on mount, enables without connecting, and edits without obtaining secret values', async () => {
    render(<McpSettings />)
    const section = await screen.findByRole('region', { name: 'MCP 服务 Anonymous' })
    expect(mocks.connect).not.toHaveBeenCalled()
    expect(within(section).getByRole('button', { name: '连接并检查' })).toBeDisabled()
    fireEvent.click(within(section).getByRole('button', { name: '启用' }))
    await waitFor(() => expect(mocks.enable).toHaveBeenCalledWith('anonymous', true))
    await waitFor(() => expect(within(section).getByRole('button', { name: '编辑' })).toBeEnabled())
    expect(mocks.connect).not.toHaveBeenCalled()
    fireEvent.click(within(section).getByRole('button', { name: '编辑' }))
    expect(screen.queryByLabelText('环境变量值 1')).not.toBeInTheDocument()
    fireEvent.click(screen.getAllByLabelText('删除', { selector: 'input' })[1])
    fireEvent.click(screen.getByRole('button', { name: '保存配置' }))
    await waitFor(() => expect(mocks.save).toHaveBeenCalledWith({ config: server.config, name: server.name, envChanges: { DELETE_ME: null } }))
  })

  it('does not treat a blank replacement as deletion, then sends only the explicitly entered replacement', async () => {
    render(<McpSettings />)
    fireEvent.click(await screen.findByRole('button', { name: '编辑' }))
    fireEvent.click(screen.getAllByLabelText('替换', { selector: 'input' })[0])
    fireEvent.click(screen.getByRole('button', { name: '保存配置' }))
    expect(screen.getByRole('status')).toHaveTextContent('替换值不能为空')
    expect(mocks.save).not.toHaveBeenCalled()
    fireEvent.change(screen.getByLabelText('环境变量值 1'), { target: { value: 'anonymous-new-value' } })
    const pending = deferred<void>(); mocks.save.mockReturnValueOnce(pending.promise)
    fireEvent.click(screen.getByRole('button', { name: '保存配置' }))
    expect(mocks.save).toHaveBeenCalledWith({ config: server.config, name: server.name, envChanges: { TOKEN: 'anonymous-new-value' } })
    expect(screen.queryByDisplayValue('anonymous-new-value')).not.toBeInTheDocument()
    await act(async () => pending.resolve())
  })

  it('requires explicit delete confirmation and never deletes the program itself', async () => {
    render(<McpSettings />)
    fireEvent.click(await screen.findByRole('button', { name: '删除', exact: true }))
    expect(mocks.remove).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '取消删除' }))
    expect(mocks.remove).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '删除', exact: true }))
    fireEvent.click(screen.getByRole('button', { name: '确定删除' }))
    await waitFor(() => expect(mocks.remove).toHaveBeenCalledExactlyOnceWith('anonymous'))
  })

  it('cancels its pending request on unmount and disconnects a late successful result', async () => {
    mocks.list.mockResolvedValue([{ ...server, enabled: true }])
    const pending = deferred<unknown>(); mocks.connect.mockReturnValueOnce(pending.promise)
    const view = render(<McpSettings />)
    fireEvent.click(await screen.findByRole('button', { name: '连接并检查' }))
    const request = mocks.connect.mock.calls[0][1]
    view.unmount()
    expect(mocks.cancel).toHaveBeenCalledWith(request)
    await act(async () => pending.resolve({ connectionId: 'late', catalog: { tools: [] } }))
    expect(mocks.disconnect).toHaveBeenCalledWith('late')
  })

  it('keeps an established connection when leaving settings and requires explicit disconnect', async () => {
    mocks.list.mockResolvedValue([{ ...server, enabled: true, connectionId: 'existing', status: 'connected' }])
    const view = render(<McpSettings />)
    await screen.findByText('已启用 · 已连接')
    expect(mocks.connect).not.toHaveBeenCalled()
    view.unmount()
    expect(mocks.disconnect).not.toHaveBeenCalled()
  })

  it('does no native work on Web or after a failed initial read', async () => {
    mocks.desktop.mockReturnValue(false)
    const view = render(<McpSettings />)
    expect(mocks.list).not.toHaveBeenCalled()
    view.unmount()
    mocks.desktop.mockReturnValue(true)
    mocks.list.mockRejectedValueOnce(new Error('anonymous read failure'))
    render(<McpSettings />)
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('MCP 操作失败'))
    expect(screen.getByRole('button', { name: '保存配置' })).toBeDisabled()
    expect(mocks.save).not.toHaveBeenCalled()
  })

  it('saves HTTP without process or credential fields and never connects on save', async () => {
    render(<McpSettings />)
    await screen.findByRole('region', { name: 'MCP 服务 Anonymous' })
    fireEvent.click(screen.getByLabelText('Streamable HTTP', { selector: 'input' }))
    expect(screen.queryByLabelText('MCP 可执行文件')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '添加环境变量' })).not.toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('MCP 服务 ID'), { target: { value: 'remote' } })
    fireEvent.change(screen.getByLabelText('MCP 名称'), { target: { value: 'Remote' } })
    fireEvent.change(screen.getByLabelText('MCP HTTP URL'), { target: { value: 'https://anonymous.example/mcp' } })
    fireEvent.click(screen.getByRole('button', { name: '保存配置' }))
    await waitFor(() => expect(mocks.save).toHaveBeenCalledExactlyOnceWith({
      config: { transport: 'http', serverId: 'remote', url: 'https://anonymous.example/mcp' },
      name: 'Remote', envChanges: {},
    }))
    expect(mocks.connect).not.toHaveBeenCalled()
    expect(mocks.enable).not.toHaveBeenCalled()
  })

  it('connects a persisted HTTP service through the shared catalog API and edits its precise URL', async () => {
    const http = { ...server, config: { transport: 'http', serverId: 'remote', url: 'https://anonymous.example/mcp' }, name: 'Remote', envNames: [], enabled: true }
    mocks.list.mockResolvedValue([http])
    mocks.connect.mockResolvedValue({ connectionId: 'remote-connection', protocolVersion: 'fixture', catalog: { tools: [{ name: 'echo' }] } })
    render(<McpSettings />)
    const section = await screen.findByRole('region', { name: 'MCP 服务 Remote' })
    fireEvent.click(within(section).getByRole('button', { name: '连接并检查' }))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('检查成功：1 个工具'))
    expect(mocks.connect).toHaveBeenCalledExactlyOnceWith('remote', expect.any(String))
    fireEvent.click(within(section).getByRole('button', { name: '编辑' }))
    expect(screen.getByLabelText('本地 stdio', { selector: 'input' })).toBeDisabled()
    expect(screen.getByLabelText('MCP HTTP URL')).toHaveValue(http.config.url)
    fireEvent.change(screen.getByLabelText('MCP HTTP URL'), { target: { value: 'https://anonymous.example/changed' } })
    fireEvent.click(screen.getByRole('button', { name: '保存配置' }))
    await waitFor(() => expect(mocks.save).toHaveBeenCalledWith({ config: { ...http.config, url: 'https://anonymous.example/changed' }, name: 'Remote', envChanges: {} }))
  })
})
