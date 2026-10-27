import { describe, expect, it } from 'vitest'
import { decodeMcpToolCatalog } from '@/services/mcp/toolCatalog'
import { copyMcpTurnSnapshot, selectMcpTurnTool } from '@/services/mcp/turnSnapshot'
import { buildAgentRunRequest } from '@/services/agent/requestBuilder'
import { buildRoutingAppContext } from '@/services/agent/requestBuilder'
import { makeRoutingDecision } from '@/services/agent/routingService'

const connection = (serverId = 'anon', connectionId = 'conn-1', revision = 'rev-1') => ({
  connectionId, protocolVersion: 'fixture',
  catalog: decodeMcpToolCatalog(serverId, revision, [
    { name: 'a', inputSchema: { type: 'object' } },
    { name: 'nested.echo', description: 'untrusted description', inputSchema: { type: 'object', properties: { items: { type: 'array', items: { $ref: '#/$defs/item' } } }, $defs: { item: { type: 'object', properties: { text: { type: 'string' } } } } } },
  ]),
})

describe('current-turn MCP selection', () => {
  it('retains precise remote identity, original alias and nested frozen schema', () => {
    const selected = selectMcpTurnTool(connection(), 'mcp_anon_1')
    expect(selected).toMatchObject({ serverId: 'anon', connectionId: 'conn-1', catalogRevision: 'rev-1', remoteName: 'nested.echo', modelTool: { function: { name: 'mcp_anon_1' } } })
    const copy = copyMcpTurnSnapshot([selected])
    expect(copy[0]).not.toBe(selected)
    expect(copy[0].modelTool.function.parameters).toEqual(selected.modelTool.function.parameters)
    expect(Object.isFrozen(copy)).toBe(true)
    expect(Object.isFrozen(copy[0].modelTool.function.parameters.$defs)).toBe(true)
    expect(() => selectMcpTurnTool(connection(), 'missing')).toThrow()
  })

  it('isolates same remote names across servers and rejects stale mixed identities and aliases', () => {
    const first = selectMcpTurnTool(connection(), 'mcp_anon_1')
    const second = selectMcpTurnTool(connection('other'), 'mcp_other_1')
    expect(copyMcpTurnSnapshot([first, second])).toHaveLength(2)
    expect(() => copyMcpTurnSnapshot([first, first])).toThrow()
    expect(() => copyMcpTurnSnapshot([first, selectMcpTurnTool(connection('anon', 'new-conn'), 'mcp_anon_0')])).toThrow()
    expect(() => copyMcpTurnSnapshot([first, selectMcpTurnTool(connection('anon', 'conn-1', 'new-rev'), 'mcp_anon_0')])).toThrow()
  })

  it('enforces aggregate selection bounds', () => {
    const many = decodeMcpToolCatalog('anon', 'rev', Array.from({ length: 17 }, (_, i) => ({ name: `t${i}`, inputSchema: { type: 'object' } })))
    expect(() => copyMcpTurnSnapshot(many.tools.map(tool => selectMcpTurnTool({ connectionId: 'conn', protocolVersion: 'fixture', catalog: many }, tool.modelTool.function.name)))).toThrow()
    const large = decodeMcpToolCatalog('anon', 'rev', Array.from({ length: 9 }, (_, i) => ({ name: `t${i}`, description: 'x'.repeat(8192), inputSchema: { type: 'object' } })))
    expect(() => copyMcpTurnSnapshot(large.tools.map(tool => selectMcpTurnTool({ connectionId: 'conn', protocolVersion: 'fixture', catalog: large }, tool.modelTool.function.name)))).toThrow()
  })

  it('copies only this turn into AgentRunRequest without extending internal candidates', () => {
    const selected = [selectMcpTurnTool(connection(), 'mcp_anon_1')]
    const options = {
      content: '使用本轮工具', messages: [], tagContext: '', memoryContext: '',
      routingDecision: makeRoutingDecision('使用本轮工具', buildRoutingAppContext([], false), { forceAgent: true }),
      hasRecentEditContext: false, hasPrefetchedMemoryLookup: false,
      signal: new AbortController().signal, temperature: 0.2, onStep: () => {}, streamEnabled: false,
    }
    const built = buildAgentRunRequest({ ...options, mcpTools: selected })
    selected.length = 0
    expect(built.request.mcpTools).toHaveLength(1)
    expect(built.request.candidateToolNames).not.toContain('mcp_anon_1')
    expect(built.request.untrustedContext).not.toContain('untrusted description')
    expect(buildAgentRunRequest(options).request).not.toHaveProperty('mcpTools')
  })
})
