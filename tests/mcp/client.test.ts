import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  cancelMcpCall, cancelMcpConnect, confirmMcpCall, connectMcp, disconnectMcp, prepareMcpCall,
  refreshMcpTools, registerMcpStdio, connectMcpHttp, listMcpServers, saveMcpServer, setMcpServerEnabled, deleteMcpServer,
} from '@/services/mcp/client'
import { decodeMcpToolCatalog } from '@/services/mcp/toolCatalog'

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), isTauri: vi.fn(() => true) }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))
vi.mock('@/hooks/useTauri', () => ({ isTauri: mocks.isTauri }))
vi.mock('@/services/externalHttp', () => ({ UnsupportedCapabilityError: class UnsupportedCapabilityError extends Error { name = 'UnsupportedCapabilityError' } }))

const tools = [{ name: 'echo', inputSchema: { type: 'object', properties: { values: { type: 'array', items: { type: 'integer' } } } } }]
const native = { serverId: 's', connectionId: 'connection-1', catalogRevision: 'catalog-1', protocolVersion: '2026-07-28', tools }

describe('MCP desktop IPC adapter', () => {
  beforeEach(() => { mocks.isTauri.mockReturnValue(true); mocks.invoke.mockReset() })

  it('does not invoke anything on import and registers explicit argv without a shell string', async () => {
    expect(mocks.invoke).not.toHaveBeenCalled()
    const config = { serverId: 's', executable: 'C:\\fixture\\node.exe', args: ['fixture.cjs', '$(literal)'], cwd: 'C:\\fixture' }
    await registerMcpStdio(config)
    expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith('mcp_register_stdio', { config })
  })

  it('connects HTTP through its own Rust endpoint and reuses the bound catalog protocol', async () => {
    mocks.invoke.mockResolvedValue(native)
    const connection = await connectMcpHttp('https://anonymous.example/mcp', 'http-request')
    expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith('mcp_connect_http', { url: 'https://anonymous.example/mcp', requestId: 'http-request' })
    await prepareMcpCall(connection, 'mcp_s_0', { values: [3] })
    expect(mocks.invoke).toHaveBeenLastCalledWith('mcp_prepare_call', { request: { connectionId: 'connection-1', catalogRevision: 'catalog-1', toolName: 'echo', arguments: { values: [3] } } })
  })

  it('keeps secret changes write-only and distinguishes retention, replacement and deletion', async () => {
    const config = { serverId: 's', executable: 'C:\\fixture\\node.exe', args: [], cwd: 'C:\\fixture' }
    await saveMcpServer({ config, name: 'anonymous', envChanges: { TOKEN: 'anonymous-value', REMOVE: null } })
    expect(mocks.invoke).toHaveBeenLastCalledWith('mcp_save_server', { update: { config, name: 'anonymous', envChanges: { TOKEN: 'anonymous-value', REMOVE: null } } })
    await setMcpServerEnabled('s', false)
    expect(mocks.invoke).toHaveBeenLastCalledWith('mcp_set_server_enabled', { serverId: 's', enabled: false })
    await listMcpServers()
    expect(mocks.invoke).toHaveBeenLastCalledWith('mcp_list_servers', {})
    await deleteMcpServer('s')
    expect(mocks.invoke).toHaveBeenLastCalledWith('mcp_delete_server', { serverId: 's' })
    expect(mocks.invoke).toHaveBeenCalledTimes(4)
  })

  it('preserves the HTTP discriminator across persistence and uses the normal connect IPC', async () => {
    const config = { transport: 'http' as const, serverId: 's', url: 'https://anonymous.example/mcp' }
    await saveMcpServer({ config, name: 'Remote', envChanges: {} })
    expect(mocks.invoke).toHaveBeenLastCalledWith('mcp_save_server', { update: { config, name: 'Remote', envChanges: {} } })
    mocks.invoke.mockResolvedValueOnce([{ config, name: 'Remote', enabled: true, envNames: [], connectionId: null, status: 'disconnected' }])
    expect((await listMcpServers())[0].config).toEqual(config)
    mocks.invoke.mockResolvedValueOnce(native)
    const connected = await connectMcp('s', 'persistent-request')
    expect(mocks.invoke).toHaveBeenLastCalledWith('mcp_connect', { serverId: 's', requestId: 'persistent-request' })
    expect(connected.catalog.serverId).toBe('s')
  })

  it('decodes a revision-bound catalog and routes an alias through that exact snapshot', async () => {
    mocks.invoke.mockResolvedValue(native)
    const connection = await connectMcp('s', 'request-1')
    const args = { values: [1, 2] }
    await prepareMcpCall(connection, 'mcp_s_0', args)
    expect(mocks.invoke).toHaveBeenLastCalledWith('mcp_prepare_call', { request: { connectionId: 'connection-1', catalogRevision: 'catalog-1', toolName: 'echo', arguments: args } })
    expect(connection.catalog.tools[0].modelTool.function.parameters).toEqual(tools[0].inputSchema)
    await refreshMcpTools(connection.connectionId)
    expect(mocks.invoke).toHaveBeenLastCalledWith('mcp_list_tools', { connectionId: 'connection-1' })
  })

  it('rejects an unknown alias without invoking and keeps the old snapshot after a refreshed directory reorders names', async () => {
    const connection = { connectionId: 'old', protocolVersion: '2025-11-25', catalog: decodeMcpToolCatalog('s', 'old-revision', tools) }
    await expect(prepareMcpCall(connection, 'unknown', {})).rejects.toMatchObject({ code: 'MCP_TOOL_MISSING' })
    expect(mocks.invoke).not.toHaveBeenCalled()
    await prepareMcpCall(connection, 'mcp_s_0', {})
    expect(mocks.invoke).toHaveBeenCalledWith('mcp_prepare_call', { request: { connectionId: 'old', catalogRevision: 'old-revision', toolName: 'echo', arguments: {} } })
  })

  it('disconnects when the native directory is rejected by the decoder', async () => {
    mocks.invoke.mockResolvedValueOnce({ ...native, tools: [tools[0], tools[0]] }).mockResolvedValueOnce(undefined)
    await expect(connectMcp('s', 'request-1')).rejects.toMatchObject({ code: 'MCP_CATALOG_INVALID' })
    expect(mocks.invoke).toHaveBeenLastCalledWith('mcp_disconnect', { connectionId: 'connection-1' })
  })

  it('confirms, cancels and disconnects by stored identity without resending editable parameters', async () => {
    const result = { content: [{ type: 'text', text: 'untrusted' }], isError: true }
    mocks.invoke.mockResolvedValueOnce(result)
    await expect(confirmMcpCall('p')).resolves.toEqual(result)
    await cancelMcpCall('p')
    await cancelMcpConnect('request-1')
    await disconnectMcp('connection-1')
    expect(mocks.invoke.mock.calls).toEqual([
      ['mcp_confirm_call', { proposalId: 'p' }], ['mcp_cancel_call', { proposalId: 'p' }],
      ['mcp_cancel_connect', { requestId: 'request-1' }],
      ['mcp_disconnect', { connectionId: 'connection-1' }],
    ])
  })

  it('preserves safe error codes but strips arbitrary native errors, without retry', async () => {
    mocks.invoke.mockRejectedValueOnce('MCP_CALL_TIMEOUT_OUTCOME_UNKNOWN').mockRejectedValueOnce('secret/path/payload')
    await expect(confirmMcpCall('p')).rejects.toMatchObject({ code: 'MCP_CALL_TIMEOUT_OUTCOME_UNKNOWN' })
    await expect(confirmMcpCall('p2')).rejects.toMatchObject({ code: 'MCP_REQUEST_FAILED', message: 'MCP_REQUEST_FAILED' })
    expect(mocks.invoke).toHaveBeenCalledTimes(2)
  })

  it('rejects every native operation on Web', async () => {
    mocks.isTauri.mockReturnValue(false)
    const connection = { connectionId: 'c', protocolVersion: '2026-07-28', catalog: decodeMcpToolCatalog('s', 'r', tools) }
    const requests = [connectMcpHttp('http://127.0.0.1/mcp', 'request'), listMcpServers(), saveMcpServer({ config: { serverId: 's', executable: 'x', args: [], cwd: 'x' }, name: 's', envChanges: {} }), setMcpServerEnabled('s', true), deleteMcpServer('s'), registerMcpStdio({ serverId: 's', executable: 'x', args: [], cwd: 'x' }), connectMcp('s', 'request-1'), cancelMcpConnect('request-1'), refreshMcpTools('c'), prepareMcpCall(connection, 'mcp_s_0', {}), confirmMcpCall('p'), cancelMcpCall('p'), disconnectMcp('c')]
    for (const promise of requests) await expect(promise).rejects.toMatchObject({ name: 'UnsupportedCapabilityError' })
    expect(mocks.invoke).not.toHaveBeenCalled()
  })
})
