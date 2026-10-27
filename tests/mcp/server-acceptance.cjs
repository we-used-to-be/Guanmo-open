'use strict'

// Manual native acceptance helper. Never enables the server or approves edits.
// Supply the anonymous server connection only in local process environment:
// MCP_ACCEPTANCE_ENDPOINT, MCP_ACCEPTANCE_TOKEN. Never paste the token in chat.
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const BEFORE = '# MCP anonymous acceptance\nbefore 😀\n'
const AFTER = '# MCP anonymous acceptance\nafter 😀\n'
const VERSION = '2026-07-28'
let sequence = 0

function fail(code) { throw new Error(code) }
async function anonymousFile(input) {
  const file = path.resolve(input || '')
  const parent = path.dirname(file)
  if (path.basename(file) !== 'anonymous.md' || !/^guanmo-mcp-phase6-[a-zA-Z0-9_-]+$/.test(path.basename(parent))) fail('MCP_ACCEPTANCE_ANONYMOUS_FILE_REQUIRED')
  const temp = await fs.realpath(os.tmpdir())
  const actualParent = await fs.realpath(parent)
  if (path.dirname(actualParent).toLowerCase() !== temp.toLowerCase() || (await fs.lstat(parent)).isSymbolicLink() || (await fs.lstat(file)).isSymbolicLink() || (await fs.stat(file)).size > 256) fail('MCP_ACCEPTANCE_ANONYMOUS_FILE_REQUIRED')
  return file
}
async function rpc(method, params) {
  if (process.env.NODE_USE_ENV_PROXY === '1' || process.execArgv.some(value => value.includes('--use-env-proxy')) || (process.env.NODE_OPTIONS || '').includes('--use-env-proxy')) fail('MCP_ACCEPTANCE_PROXY_UNSUPPORTED')
  const endpoint = new URL(process.env.MCP_ACCEPTANCE_ENDPOINT || 'http://invalid/')
  const token = process.env.MCP_ACCEPTANCE_TOKEN
  if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || !endpoint.port || endpoint.pathname !== '/mcp' || endpoint.search || endpoint.hash || endpoint.username || endpoint.password || !token) fail('MCP_ACCEPTANCE_LOCAL_CONNECTION_REQUIRED')
  const headers = { Authorization:`Bearer ${token}`, Accept:'application/json, text/event-stream', 'Content-Type':'application/json', 'Mcp-Protocol-Version':VERSION, 'Mcp-Method':method }
  if (method === 'tools/call') headers['Mcp-Name'] = params.name
  const response = await fetch(endpoint, { method:'POST', headers, redirect:'error', signal:AbortSignal.timeout(30000), body:JSON.stringify({ jsonrpc:'2.0', id:++sequence, method, params:{ ...params, _meta:{ 'io.modelcontextprotocol/protocolVersion':VERSION, 'io.modelcontextprotocol/clientInfo':{ name:'guanmo-anonymous-acceptance', version:'1' }, 'io.modelcontextprotocol/clientCapabilities':{} } } }) })
  if (!response.ok) fail(`MCP_ACCEPTANCE_HTTP_${response.status}`)
  const text = await response.text()
  if (Buffer.byteLength(text) > 1024 * 1024) fail('MCP_ACCEPTANCE_RESPONSE_LIMIT')
  const message = JSON.parse(text)
  if (message.error || !message.result) fail('MCP_ACCEPTANCE_PROTOCOL_ERROR')
  return message.result
}
async function call(name, args) {
  const result = await rpc('tools/call', { name, arguments:args })
  if (result.isError) {
    const code = result.structuredContent?.error
    fail(typeof code === 'string' && /^MCP_[A-Z_]+$/.test(code) ? code : 'MCP_ACCEPTANCE_TOOL_ERROR')
  }
  if (!result.structuredContent) fail('MCP_ACCEPTANCE_RESULT_INVALID')
  return result.structuredContent
}
async function main() {
  const [mode, input] = process.argv.slice(2)
  if (mode === 'prepare') {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'guanmo-mcp-phase6-'))
    const file = path.join(directory, 'anonymous.md')
    await fs.writeFile(file, BEFORE, { flag:'wx' })
    console.log(JSON.stringify({ path:file, next:'在匿名观墨内手动打开此文件，选择该文件范围，启用读取和修改提案权限；原生授权由你操作。' }))
    return
  }
  if (mode === 'verify' || mode === 'verify-before') {
    const file = await anonymousFile(input)
    if (await fs.readFile(file, 'utf8') !== (mode === 'verify' ? AFTER : BEFORE)) fail('MCP_ACCEPTANCE_FILE_CONTENT_MISMATCH')
    console.log(JSON.stringify({ fileVerified:true, content:mode === 'verify' ? 'after' : 'before' })); return
  }
  if (!['propose', 'status', 'cancel'].includes(mode)) fail('MCP_ACCEPTANCE_USAGE_PREPARE_PROPOSE_STATUS_CANCEL_VERIFY')
  const discovery = await rpc('server/discover', {})
  if (discovery._meta?.['io.modelcontextprotocol/serverInfo']?.name !== 'guanmo') fail('MCP_ACCEPTANCE_WRONG_SERVER')
  let result
  if (mode === 'propose') {
    const file = await anonymousFile(input)
    if (await fs.readFile(file, 'utf8') !== BEFORE) fail('MCP_ACCEPTANCE_ANONYMOUS_FILE_REQUIRED')
    const read = await call('read_document', { path:file, maxChars:1024 })
    if (read.content !== BEFORE || !/^[a-f0-9]{64}$/.test(read.contentHash)) fail('MCP_ACCEPTANCE_FILE_SNAPSHOT_MISMATCH')
    result = await call('propose_document_edit', { path:file, expectedHash:read.contentHash, oldText:'before 😀', newText:'after 😀' })
    if (result.state !== 'pending' || await fs.readFile(file, 'utf8') !== BEFORE) fail('MCP_ACCEPTANCE_PENDING_MUST_NOT_WRITE')
  } else {
    if (!/^[a-zA-Z0-9_-]{16,128}$/.test(input || '')) fail('MCP_ACCEPTANCE_PROPOSAL_ID_REQUIRED')
    result = await call(mode === 'status' ? 'get_document_edit' : 'cancel_document_edit', { proposalId:input })
  }
  console.log(JSON.stringify({ proposalId:result.proposalId, state:result.state, written:result.state === 'written' }))
}
main().catch(error => { console.error(error instanceof Error && /^MCP_[A-Z_0-9]+$/.test(error.message) ? error.message : 'MCP_ACCEPTANCE_FAILED'); process.exitCode = 1 })
