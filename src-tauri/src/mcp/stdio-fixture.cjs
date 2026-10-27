// Anonymous local fixture. No files, network or credentials are read.
const readline = require('node:readline')
const { spawn } = require('node:child_process')
const mode = process.argv[1]
let calls = 0
let cancelled = 0
let descendant
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n')
const error = (id, code) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message: 'fixture' } }) + '\n')
const tool = name => ({ name, inputSchema: { type: 'object', properties: { nested: { type: 'array', items: { type: 'object', properties: { value: { enum: ['a', 'b'] } } } } } } })
readline.createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line)
  if (m.method === 'notifications/cancelled') { cancelled++; return }
  if (m.method === 'server/discover') {
    if (mode === 'legacy') return error(m.id, -32601)
    if (mode === 'silent') return
    return reply(m.id, { resultType: 'complete', supportedVersions: ['2026-07-28'], capabilities: { tools: { listChanged: true }, resources: { listChanged: true }, prompts: { listChanged: true } }, ttlMs: 0, cacheScope: 'private' })
  }
  if (m.method === 'initialize') return reply(m.id, { protocolVersion: '2025-11-25', capabilities: { tools: { listChanged: true }, resources: { listChanged: true }, prompts: { listChanged: true } }, serverInfo: { name: 'anonymous-fixture', version: '1' } })
  if (m.method === 'resources/list') return reply(m.id, { resources: [{ uri: 'anon://fixture/one', name: 'anonymous resource' }] })
  if (m.method === 'resources/read') return reply(m.id, { contents: [{ uri: m.params.uri, text: 'anonymous fixture content' }] })
  if (m.method === 'prompts/list') return reply(m.id, { prompts: [{ name: 'anonymous-prompt', description: 'Anonymous fixture prompt', arguments: [{ name: 'topic', required: true }] }] })
  if (m.method === 'prompts/get') return reply(m.id, { description: 'Anonymous fixture response', messages: [{ role: 'user', content: { type: 'text', text: `fixture:${m.params.arguments.topic}` } }] })
  if (m.method === 'tools/list') {
    if (mode === 'cycle') return reply(m.id, { tools: [], nextCursor: 'cycle' })
    if (mode === 'duplicate') return reply(m.id, { tools: [tool('echo'), tool('echo')] })
    return reply(m.id, m.params?.cursor ? { tools: [tool('slow')] } : { tools: [tool('echo'), tool('change'), tool('error'), tool('schema_error')], nextCursor: 'page-2' })
  }
  if (m.method === 'tools/call') {
    calls++
    if (m.params.name === 'schema_error') return error(m.id, -32602)
    if (m.params.name === 'change') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }) + '\n')
    if (!descendant) descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true })
    const result = { content: [{ type: 'text', text: JSON.stringify({ args: m.params.arguments, calls, cancelled, pid: process.pid, descendantPid: descendant.pid, injected: Boolean(process.env.MCP_FIXTURE_SECRET), nodeOptions: Boolean(process.env.NODE_OPTIONS), configuredToken: process.env.MCP_CONFIGURED_TOKEN === 'anonymous-configured-token' }) }], isError: m.params.name === 'error' }
    if (m.params.name === 'slow' && mode === 'crash') return process.exit(42)
    if (m.params.name === 'slow') return setTimeout(() => reply(m.id, result), mode === 'timeout' ? 35000 : 500)
    return reply(m.id, result)
  }
  if (m.id !== undefined) error(m.id, -32601)
})
