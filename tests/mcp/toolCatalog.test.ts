import { describe, expect, it, vi } from 'vitest'
import { decodeMcpToolCatalog } from '@/services/mcp/toolCatalog'
import { getAllTools, getTool, getToolsForLLM, registerTool } from '@/services/agent/toolRegistry'
import { DEFAULT_AI_CONFIG, type ChatTool } from '@/services/ai/types'
import { OpenAICompatibleProvider } from '@/services/ai/providers/openaiCompatible'
import { externalApiFetch } from '@/services/externalHttp'

vi.mock('@/services/externalHttp', () => ({
  externalApiFetch: vi.fn(),
  ExternalHttpError: class extends Error {},
  UnsupportedCapabilityError: class extends Error {},
}))

const nestedSchema = {
  type: 'object' as const,
  $defs: { filter: { type: 'string', enum: ['new', 'saved'] } },
  properties: {
    ids: { type: 'array', items: { type: 'integer', minimum: 1 } },
    options: {
      type: 'object',
      properties: { filter: { $ref: '#/$defs/filter' } },
      additionalProperties: false,
    },
  },
  required: ['ids'],
  additionalProperties: false,
  allOf: [{ if: { required: ['options'] }, then: { minProperties: 2 } }],
}

function tool(name = 'search', schema: unknown = nestedSchema) {
  return { name, description: 'Find records', inputSchema: schema }
}

describe('MCP tool catalog', () => {
  it('preserves complete nested JSON Schema and round-trips model JSON without registering tools', () => {
    const before = getAllTools()
    const catalog = decodeMcpToolCatalog('local_1', 'generation-1', [tool()])
    const model: ChatTool = catalog.tools[0].modelTool
    expect(model.function.parameters).toEqual(nestedSchema)
    expect(JSON.parse(JSON.stringify(model)).function.parameters).toEqual(nestedSchema)
    expect(catalog).toMatchObject({ serverId: 'local_1', revision: 'generation-1' })
    expect(catalog.tools[0].remoteName).toBe('search')
    expect(getTool(model.function.name)).toBeUndefined()
    expect(getAllTools()).toEqual(before)
  })

  it('supports parameterless tools, boolean subschemas and omitted descriptions', () => {
    const catalog = decodeMcpToolCatalog('s', 'r', [{
      name: 'empty', inputSchema: { type: 'object', properties: { allowed: true, denied: false } },
    }])
    expect(catalog.tools[0].modelTool.function.description).toBe('')
    expect(catalog.tools[0].modelTool.function.parameters.properties).toEqual({ allowed: true, denied: false })
    expect(decodeMcpToolCatalog('s', 'r', []).tools).toEqual([])
  })

  it('isolates identical remote names across services and ignores server-provided trust hints', () => {
    const remote = { ...tool(), annotations: { readOnlyHint: true, destructiveHint: false } }
    const a = decodeMcpToolCatalog('a', 'r1', [remote]).tools[0]
    const b = decodeMcpToolCatalog('b', 'r1', [remote]).tools[0]
    expect(a.modelTool.function.name).not.toBe(b.modelTool.function.name)
    expect(a).toMatchObject({ effect: 'external', confirmationPolicy: 'required' })
    expect(a).not.toHaveProperty('execute')
  })

  it('sorts aliases independently of page order and retains the exact case-sensitive remote name', () => {
    const a = decodeMcpToolCatalog('s', 'r', [tool('z'), tool('Search.v1'), tool('search')])
    const b = decodeMcpToolCatalog('s', 'r', [tool('search'), tool('z'), tool('Search.v1')])
    expect(a).toEqual(b)
    expect(a.tools.map(entry => entry.remoteName)).toEqual(['Search.v1', 'search', 'z'])
    expect(a.tools.every(entry => /^[A-Za-z0-9_-]{1,64}$/.test(entry.modelTool.function.name))).toBe(true)
    expect(decodeMcpToolCatalog('s', 'r2', [tool()]).revision).not.toBe(a.revision)
  })

  it('creates an immutable independent snapshot including nested schema arrays', () => {
    const source = JSON.parse(JSON.stringify([tool()]))
    const catalog = decodeMcpToolCatalog('s', 'r', source)
    source[0].name = 'changed'
    source[0].inputSchema.properties.ids.items.minimum = 99
    expect(catalog.tools[0].remoteName).toBe('search')
    expect(catalog.tools[0].modelTool.function.parameters).toEqual(nestedSchema)
    expect(Object.isFrozen(catalog)).toBe(true)
    expect(Object.isFrozen(catalog.tools)).toBe(true)
    expect(Object.isFrozen(catalog.tools[0].modelTool.function)).toBe(true)
    const properties = catalog.tools[0].modelTool.function.parameters.properties!
    expect(Object.isFrozen(properties.ids)).toBe(true)
    expect(Object.isFrozen(catalog.tools[0].modelTool.function.parameters.required)).toBe(true)
  })

  it.each([
    null, {}, [null], [tool('has space')], [tool('')], [tool('a'.repeat(129))],
    [tool(), tool()], [tool('x', null)], [tool('x', { type: 'array' })],
    [tool('x', { type: 'object', properties: [] })],
    [tool('x', { type: 'object', required: 'id' })],
    [tool('x', { type: 'object', required: [1] })],
    [tool('x', { type: 'object', required: ['id', 'id'] })],
    [{ ...tool(), description: 3 }], [{ ...tool(), description: 'x'.repeat(8193) }],
    [{ ...tool(), inputSchema: { type: 'object', invalid: undefined } }],
    [{ ...tool(), inputSchema: { type: 'object', invalid: Number.NaN } }],
    [{ ...tool(), inputSchema: { type: 'object', invalid: new Date() } }],
  ].map(input => ({ input })))('rejects malformed catalogs without echoing their content (%#)', ({ input }) => {
    expect(() => decodeMcpToolCatalog('s', 'r', input)).toThrow('MCP 工具目录格式无效或超过上限')
  })

  it('bounds identities, tool count, aggregate text, depth, cycles and JSON node count', () => {
    expect(() => decodeMcpToolCatalog('../s', 'r', [])).toThrow()
    expect(() => decodeMcpToolCatalog('s', '', [])).toThrow()
    expect(() => decodeMcpToolCatalog('s'.repeat(41), 'r', [])).toThrow()
    expect(() => decodeMcpToolCatalog('s', 'r', Array.from({ length: 201 }, (_, i) => tool(`t${i}`)))).toThrow()
    expect(() => decodeMcpToolCatalog('s', 'r', Array.from({ length: 40 }, (_, i) => ({
      ...tool(`t${i}`), description: 'x'.repeat(8192),
    })))).toThrow()
    let deep: Record<string, unknown> = { type: 'object' }
    for (let i = 0; i < 33; i++) deep = { type: 'object', nested: deep }
    expect(() => decodeMcpToolCatalog('s', 'r', [tool('deep', deep)])).toThrow()
    const cyclic: Record<string, unknown> = { type: 'object' }
    cyclic.self = cyclic
    expect(() => decodeMcpToolCatalog('s', 'r', [tool('cycle', cyclic)])).toThrow()
    expect(() => decodeMcpToolCatalog('s', 'r', [tool('nodes', {
      type: 'object', enum: Array.from({ length: 20001 }, () => 0),
    })])).toThrow()
  })

  it('accepts the tool-count and description boundaries and long remote names', () => {
    const catalog = decodeMcpToolCatalog('s'.repeat(40), 'r', Array.from({ length: 200 }, (_, i) => ({
      ...tool(`t${i}`), description: i === 0 ? 'x'.repeat(8192) : '',
    })))
    expect(catalog.tools).toHaveLength(200)
    const long = decodeMcpToolCatalog('s', 'r', [tool('a'.repeat(128))]).tools[0]
    expect(long.remoteName).toHaveLength(128)
    expect(long.modelTool.function.name.length).toBeLessThanOrEqual(64)
  })

  it('preserves JSON property keys without prototype mutation', () => {
    const schema = JSON.parse('{"type":"object","properties":{"__proto__":{"type":"string"}}}')
    const result = decodeMcpToolCatalog('s', 'r', [tool('safe', schema)])
    expect(Object.hasOwn(result.tools[0].modelTool.function.parameters.properties!, '__proto__')).toBe(true)
    expect(result.tools[0].modelTool.function.parameters).toEqual(schema)
  })

  it('keeps legacy primitive tool schemas compatible', () => {
    registerTool({
      name: 'mcp_test_legacy', description: 'Legacy',
      parameters: [{ name: 'query', type: 'string', description: 'Query', required: true }],
      execute: async () => '',
    })
    expect(getToolsForLLM(['mcp_test_legacy'])[0].function.parameters).toEqual({
      type: 'object', properties: { query: { type: 'string', description: 'Query' } }, required: ['query'],
    })
  })

  it.each(['chat', 'streamChat'] as const)('preserves nested schema in the existing provider %s payload', async method => {
    const model = decodeMcpToolCatalog('s', 'r', [tool()]).tools[0].modelTool
    vi.mocked(externalApiFetch).mockResolvedValue(new Response(method === 'chat'
      ? JSON.stringify({ id: 'response', choices: [{ message: { content: 'ok' } }] })
      : 'data: [DONE]\n\n', { status: 200 }))
    const provider = new OpenAICompatibleProvider(DEFAULT_AI_CONFIG)
    const request = { messages: [{ role: 'user' as const, content: 'test' }], tools: [model] }
    if (method === 'chat') await provider.chat(request)
    else for await (const chunk of provider.streamChat(request)) expect(chunk).toBeDefined()
    const call = vi.mocked(externalApiFetch).mock.calls.at(-1)!
    expect(JSON.parse(call[2]!.body!).tools[0]).toEqual(model)
  })
})
