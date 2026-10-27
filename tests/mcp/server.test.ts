import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { McpServerQuery } from '@/services/mcp/serverData'

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn(), query: vi.fn(), desktop: vi.fn(() => true) }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))
vi.mock('@tauri-apps/api/event', () => ({ listen: mocks.listen }))
vi.mock('@/hooks/useTauri', () => ({ isTauri: mocks.desktop }))
vi.mock('@/services/mcp/serverData', () => ({ handleMcpServerQuery: mocks.query }))
vi.mock('@/services/externalHttp', () => ({ UnsupportedCapabilityError: class extends Error { name = 'UnsupportedCapabilityError' } }))
const config = { paths: ['D:/fixture'], artifactKeys: [], readDocuments: true, searchKnowledge: true, readArtifacts: false }
const inactive = { running: false, starting: false, generation: null, endpoint: null, config: null }

describe('MCP local server IPC and one bounded business bridge', () => {
  beforeEach(() => {
    vi.resetModules(); vi.clearAllMocks(); mocks.desktop.mockReturnValue(true)
    mocks.invoke.mockResolvedValue(inactive); mocks.listen.mockResolvedValue(vi.fn()); mocks.query.mockResolvedValue({ items: [] })
  })
  it('does no listener work while disabled, installs one listener on explicit start, and does not reveal token on status', async () => {
    const api = await import('@/services/mcp/server')
    await api.getMcpServerStatus()
    expect(mocks.listen).not.toHaveBeenCalled()
    await api.startMcpServer(config, 'unique-request')
    expect(mocks.invoke).toHaveBeenLastCalledWith('mcp_server_start', { config, requestId: 'unique-request' })
    await api.startMcpServer(config, 'next-request')
    expect(mocks.listen).toHaveBeenCalledTimes(1)
    expect(mocks.invoke.mock.calls.some(([command]) => command === 'mcp_server_connection_info')).toBe(false)
    await api.stopMcpServer('unique-request')
    expect(mocks.invoke).toHaveBeenLastCalledWith('mcp_server_stop', { generation: 'unique-request' })
  })
  it('does not dispatch a start cancelled while the listener is still being installed', async () => {
    let installed!: (unlisten: () => void) => void
    mocks.listen.mockReturnValue(new Promise<() => void>(resolve => { installed = resolve }))
    const api = await import('@/services/mcp/server')
    const controller = new AbortController()
    const starting = api.startMcpServer(config, 'cancelled', controller.signal)
    await vi.waitFor(() => expect(mocks.listen).toHaveBeenCalledTimes(1))
    controller.abort(); installed(vi.fn())
    await expect(starting).rejects.toMatchObject({ code: 'MCP_CANCELLED' })
    expect(mocks.invoke).not.toHaveBeenCalled()
  })
  it('replies once to the exact generation, sanitizes business failures, and never retries', async () => {
    const api = await import('@/services/mcp/server')
    await api.startMcpServer(config, 'unique-request')
    const query: McpServerQuery = { requestId: 'query-id', generation: 'unique-request', toolName: 'search_knowledge', arguments: { query: 'anonymous' }, paths: [], artifactKeys: [] }
    const handler = mocks.listen.mock.calls[0][1] as (event: { payload: McpServerQuery }) => Promise<void>
    mocks.invoke.mockClear()
    mocks.query.mockRejectedValue(new Error('private SQL and data must not escape'))
    await handler({ payload: query })
    expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith('mcp_server_reply', { requestId: 'query-id', generation: 'unique-request', result: null, error: 'MCP_SERVER_QUERY_FAILED' })
  })
  it('rejects Web calls before any native listener or IPC', async () => {
    mocks.desktop.mockReturnValue(false)
    const api = await import('@/services/mcp/server')
    await expect(api.startMcpServer(config)).rejects.toMatchObject({ name: 'UnsupportedCapabilityError' })
    await expect(api.getMcpServerStatus()).rejects.toMatchObject({ name: 'UnsupportedCapabilityError' })
    expect(mocks.listen).not.toHaveBeenCalled(); expect(mocks.invoke).not.toHaveBeenCalled()
  })
  it('keeps the business query limit until cancelled callers underlying SQL has actually finished', async () => {
    const api = await import('@/services/mcp/server')
    await api.startMcpServer(config, 'unique-request')
    const handler = mocks.listen.mock.calls[0][1] as (event: { payload: McpServerQuery }) => Promise<void>
    let finish!: (value: unknown) => void
    mocks.query.mockReturnValue(new Promise(resolve => { finish = resolve }))
    const query: McpServerQuery = { requestId: 'query', generation: 'unique-request', toolName: 'search_knowledge', arguments: { query: 'anonymous' }, paths: [], artifactKeys: [] }
    const running = Array.from({ length: 4 }, (_, i) => handler({ payload: { ...query, requestId: `query-${i}` } }))
    await vi.waitFor(() => expect(mocks.query).toHaveBeenCalledTimes(4))
    await handler({ payload: { ...query, requestId: 'excess' } })
    expect(mocks.query).toHaveBeenCalledTimes(4)
    expect(mocks.invoke).toHaveBeenLastCalledWith('mcp_server_reply', { requestId: 'excess', generation: 'unique-request', result: null, error: 'MCP_SERVER_BUSY' })
    finish({ items: [] }); await Promise.all(running)
  })
})
