// Anonymous loopback fixture: no user files, credentials or outbound requests.
const http = require('node:http')
const mode = process.argv[1]
let calls = 0
const tool = name => ({ name, inputSchema: { type: 'object' } })
const server = http.createServer((req, res) => {
  if (req.url === '/redirect') { res.writeHead(307, { Location: '/mcp' }); return res.end() }
  if (req.url === '/auth') { res.writeHead(401, { 'WWW-Authenticate': 'Bearer realm="anonymous"' }); return res.end() }
  if (req.method === 'GET') { res.writeHead(405); return res.end() }
  if (req.method === 'DELETE') { res.writeHead(204); return res.end() }
  let body = ''
  req.on('data', b => { body += b })
  req.on('end', () => {
    const m = JSON.parse(body)
    const reply = (result, error, status = 200) => {
      const payload = JSON.stringify({ jsonrpc: '2.0', id: m.id, ...(error ? { error } : { result }) })
      if (mode === 'sse' && status === 200) {
        res.writeHead(status, { 'Content-Type': 'text/event-stream' })
        // Split one SSE event across network writes.
        res.write('event: message\nda')
        return setTimeout(() => res.end(`ta: ${payload}\n\n`), 5)
      }
      res.writeHead(status, { 'Content-Type': 'application/json', ...(mode === 'legacy' ? { 'Mcp-Session-Id': 'anonymous-session' } : {}) })
      res.end(payload)
    }
    if (m.method === 'server/discover') {
      if (mode === 'legacy') return reply(null, { code: -32601, message: 'unsupported' }, 400)
      return reply({ resultType: 'complete', supportedVersions: ['2026-07-28'], capabilities: { tools: {} }, ttlMs: 0, cacheScope: 'private' })
    }
    if (m.method === 'initialize') return reply({ protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'anonymous', version: '1' } })
    if (m.id === undefined) { res.writeHead(202); return res.end() }
    if (m.method === 'tools/list') {
      if (mode === 'cycle') return reply({ tools: [], nextCursor: 'same' })
      if (mode === 'oversized_sse') { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); return res.end('data: ' + 'x'.repeat(1024 * 1024 + 1)) }
      if (mode === 'oversized') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end('x'.repeat(1024 * 1024 + 1)) }
      return reply(m.params?.cursor ? { tools: [tool('error'), tool('expire'), tool('slow')] } : { tools: [tool('echo')], nextCursor: 'page-2' })
    }
    if (m.method === 'tools/call') {
      calls++
      if (m.params.name === 'expire') { res.writeHead(404); return res.end() }
      const result = { content: [{ type: 'text', text: JSON.stringify({ calls, args: m.params.arguments, authorization: Boolean(req.headers.authorization), session: req.headers['mcp-session-id'] || null }) }], isError: m.params.name === 'error' }
      if (m.params.name === 'slow') return setTimeout(() => reply(result), 500)
      return reply(result)
    }
    reply(null, { code: -32601, message: 'unsupported' })
  })
})
server.listen(0, '127.0.0.1', () => console.log(`http://127.0.0.1:${server.address().port}/mcp`))
