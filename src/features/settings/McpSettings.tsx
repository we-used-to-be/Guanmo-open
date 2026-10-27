import { useEffect, useRef, useState } from 'react'
import { Button, Input } from 'animal-island-ui'
import { isTauri } from '@/hooks/useTauri'
import {
  authorizeMcpServer, cancelMcpAuthorization, cancelMcpConnect, connectMcp, deleteMcpServer, disconnectMcp,
  getMcpPrompt, listMcpPrompts, listMcpResources, listMcpServers, McpClientError, readMcpResource,
  revokeMcpAuthorization, saveMcpServer, setMcpServerEnabled,
  type McpPromptCatalog, type McpResourceCatalog, type McpServerView, type McpServerConfig,
} from '@/services/mcp/client'

interface EnvRow { name: string; value: string; action: 'keep' | 'replace' | 'remove'; existing?: boolean }
const emptyConfig = (): McpServerConfig => ({ serverId: '', executable: '', args: [], cwd: '' })

function failure(error: unknown): string {
  const code = error instanceof McpClientError ? error.code : ''
  if (code === 'MCP_CONFIG_VERSION_UNSUPPORTED' || code === 'MCP_CONFIG_CORRUPT') return '配置已损坏或来自更新版本。原文件已保留，无法读取或覆盖。'
  if (code === 'MCP_CONFIRMATION_REJECTED') return '已拒绝或确认超时，操作未执行。'
  if (code === 'MCP_CANCELLED') return '连接已取消。'
  if (code === 'MCP_HTTP_AUTH_REQUIRED' || code === 'MCP_OAUTH_AUTHORIZATION_REQUIRED') return '该服务需要 OAuth 授权，请先在此服务卡片中完成授权。'
  if (code.startsWith('MCP_SECRET_')) return '系统安全存储不可用，请检查 Windows 用户账户或重新配置环境变量。'
  return `MCP 操作失败${code ? `（${code}）` : ''}；请检查配置后手动重试。`
}

export function McpSettings() {
  const [servers, setServers] = useState<McpServerView[]>([])
  const [config, setConfig] = useState(emptyConfig)
  const [name, setName] = useState('')
  const [args, setArgs] = useState('[]')
  const [env, setEnv] = useState<EnvRow[]>([])
  const [editing, setEditing] = useState(false)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [pendingRequest, setPendingRequest] = useState<string | null>(null)
  const [resourceCatalogs, setResourceCatalogs] = useState<Record<string, McpResourceCatalog>>({})
  const [promptCatalogs, setPromptCatalogs] = useState<Record<string, McpPromptCatalog>>({})
  const [promptArguments, setPromptArguments] = useState<Record<string, string>>({})
  const [externalContent, setExternalContent] = useState<Record<string, { connectionId: string; text: string }>>({})
  const mounted = useRef(false)
  const working = useRef(false)
  const pending = useRef<string | null>(null)
  const desktop = isTauri()

  useEffect(() => {
    mounted.current = true
    let active = true
    if (desktop) void listMcpServers().then(value => {
      if (active) { setServers(value); setLoaded(true) }
    }).catch(error => { if (active) setMessage(failure(error)) })
    return () => {
      active = false
      mounted.current = false
      if (pending.current) void cancelMcpConnect(pending.current).catch(() => {})
    }
  }, [desktop])

  const run = async (operation: () => Promise<string>) => {
    if (working.current) return
    working.current = true
    setBusy(true)
    setMessage('')
    try {
      const result = await operation()
      const value = await listMcpServers()
      if (mounted.current) { setServers(value); setLoaded(true); setMessage(result) }
    } catch (error) {
      if (mounted.current) setMessage(failure(error))
    } finally {
      working.current = false
      if (mounted.current) setBusy(false)
    }
  }

  const reset = () => {
    setConfig(emptyConfig()); setName(''); setArgs('[]'); setEnv([]); setEditing(false)
  }
  const edit = (server: McpServerView) => {
    setConfig({ ...server.config }); setName(server.name); setArgs(server.config.transport === 'http' ? '[]' : JSON.stringify(server.config.args, null, 2))
    setEnv(server.envNames.map(name => ({ name, value: '', action: 'keep', existing: true }))); setEditing(true)
  }
  const patchEnv = (index: number, patch: Partial<EnvRow>) => setEnv(rows => rows.map((row, i) => i === index ? { ...row, ...patch } : row))

  const save = () => {
    let nextConfig = config
    if (config.transport !== 'http') {
      let argv: unknown
      try { argv = JSON.parse(args) } catch { setMessage('参数必须是 JSON 字符串数组，例如 ["C:\\mcp\\server.cjs"]。'); return }
      if (!Array.isArray(argv) || argv.some(value => typeof value !== 'string')) { setMessage('参数必须是 JSON 字符串数组。'); return }
      nextConfig = { ...config, args: argv as string[] }
    }
    const envChanges: Record<string, string | null> = Object.create(null)
    const names = new Set<string>()
    for (const row of config.transport === 'http' ? [] : env) {
      if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(row.name) || names.has(row.name.toUpperCase())) { setMessage('环境变量名无效或重复。'); return }
      names.add(row.name.toUpperCase())
      if (row.action === 'replace') {
        if (!row.value) { setMessage('替换值不能为空；保留旧值请选择“保留”，删除请选择“删除”。'); return }
        envChanges[row.name] = row.value
      } else if (row.action === 'remove') envChanges[row.name] = null
    }
    const update = { config: nextConfig, name, envChanges }
    // Clear typed values as soon as they are handed to IPC; never store them elsewhere.
    setEnv(rows => rows.filter(row => row.existing).map(row => ({ ...row, value: '', action: 'keep' })))
    void run(async () => {
      await saveMcpServer(update)
      if (mounted.current) reset()
      return '已保存；新服务默认禁用，保存不会连接或启动进程。'
    })
  }

  const connect = (server: McpServerView) => void run(async () => {
    const requestId = crypto.randomUUID()
    pending.current = requestId; setPendingRequest(requestId)
    try {
      const result = await connectMcp(server.config.serverId, requestId)
      if (!mounted.current) { await disconnectMcp(result.connectionId); return '' }
      return `检查成功：${result.catalog.tools.length} 个工具，协议 ${result.protocolVersion}。连接保留，可在 AI 面板选择本轮工具；每次调用需原生确认。`
    } finally {
      pending.current = null
      if (mounted.current) setPendingRequest(null)
    }
  })

  if (!desktop) return <p className="text-caption text-gm-text-secondary">MCP 仅支持 Windows 桌面端。</p>
  return (
    <div className="w-full space-y-4 pb-6 text-gm-text">
      <h3 className="text-body font-semibold">MCP 服务</h3>
      <p className="text-caption text-gm-text-secondary">支持本地 stdio 和 Streamable HTTP。保存和启用不会连接或启动进程；连接和工具调用仍需原生确认。stdio 凭据使用加密环境变量；HTTP OAuth 在系统浏览器完成，令牌由 Rust 使用 Windows DPAPI 保护，WebView 不接收令牌或回调数据。</p>
      <div role="status" className="text-caption break-words">{message}</div>
      <Button type="default" size="small" disabled={busy} onClick={() => void run(async () => '已刷新连接状态。')}>刷新状态</Button>
      {pendingRequest && <Button type="default" size="small" onClick={() => void cancelMcpConnect(pendingRequest).catch(error => setMessage(failure(error)))}>取消连接</Button>}
      {loaded && servers.length === 0 && <p className="text-caption text-gm-text-secondary">尚未配置 MCP 服务。</p>}
      {servers.map(server => (
        <section key={server.config.serverId} aria-label={`MCP 服务 ${server.name}`} className="space-y-2 rounded-xl border border-gm-border bg-gm-surface-elevated p-3">
          <div className="text-body font-semibold">{server.name} <span className="text-caption text-gm-text-secondary">{server.config.serverId}</span></div>
          <p className="text-caption">{server.enabled ? '已启用' : '已禁用'} · {server.status === 'connected' ? '已连接' : server.status === 'connecting' ? '连接中' : '未连接'}</p>
          {server.config.transport === 'http' && <p className="text-caption text-gm-text-secondary">OAuth：{server.authorizationStatus === 'authorized' ? '已授权' : server.authorizationStatus === 'authorizing' ? '授权进行中' : '未授权'}{server.authorizationError ? ` · 上次失败（${server.authorizationError}）` : ''}</p>}
          <p className="text-caption break-all">{server.config.transport === 'http' ? `HTTP · ${server.config.url}` : `stdio · ${server.config.executable}`}</p>
          {server.config.transport !== 'http' && <p className="text-caption text-gm-text-secondary">环境变量：{server.envNames.join('、') || '无'}（已配置的值不回传）</p>}
          <div className="flex flex-wrap gap-2">
            <Button type="default" size="small" disabled={busy} onClick={() => edit(server)}>编辑</Button>
            <Button type="default" size="small" disabled={busy} onClick={() => void run(async () => { await setMcpServerEnabled(server.config.serverId, !server.enabled); return server.enabled ? '已禁用并撤销连接和提案。' : '已启用，尚未启动。' })}>{server.enabled ? '禁用' : '启用'}</Button>
            <Button type="default" size="small" disabled={busy || !server.enabled || Boolean(server.connectionId)} onClick={() => connect(server)}>连接并检查</Button>
            {server.config.transport === 'http' && server.authorizationStatus === 'authorizing' && <Button type="default" size="small" disabled={busy} onClick={() => void run(async () => { await cancelMcpAuthorization(server.config.serverId); return '已取消授权。' })}>取消授权</Button>}
            {server.config.transport === 'http' && server.authorizationStatus !== 'authorizing' && <Button type="default" size="small" disabled={busy || !server.enabled} onClick={() => void run(async () => { await authorizeMcpServer(server.config.serverId, crypto.randomUUID()); return '已启动 OAuth 授权；请在系统浏览器完成后刷新状态。' })}>{server.authorizationStatus === 'authorized' ? '重新授权' : 'OAuth 授权'}</Button>}
            {server.config.transport === 'http' && server.authorizationStatus === 'authorized' && <Button type="text" size="small" className="text-gm-error" disabled={busy} onClick={() => void run(async () => { await revokeMcpAuthorization(server.config.serverId); return '已撤销 OAuth 凭据和连接。' })}>撤销授权</Button>}
            <Button type="default" size="small" disabled={busy || !server.connectionId} onClick={() => void run(async () => { await disconnectMcp(server.connectionId!); return '已断开；未自动重试。' })}>断开</Button>
            <Button type="text" size="small" className="text-gm-error" disabled={busy} onClick={() => setDeleting(server.config.serverId)}>删除</Button>
          </div>
          {server.connectionId && <div className="space-y-3 border-t border-gm-border-subtle pt-3">
            <p className="text-caption text-gm-text-secondary">Resources 与 Prompts 只在这里按需读取；外部返回内容不可信，不会自动加入 AI 上下文。</p>
            <div className="flex flex-wrap gap-2">
              <Button type="default" size="small" disabled={busy} onClick={() => void run(async () => { const catalog = await listMcpResources(server.connectionId!); setResourceCatalogs(value => ({ ...value, [server.config.serverId]: catalog })); return `已列出 ${catalog.resources.length} 个资源。` })}>列出 Resources</Button>
              <Button type="default" size="small" disabled={busy} onClick={() => void run(async () => { const catalog = await listMcpPrompts(server.connectionId!); setPromptCatalogs(value => ({ ...value, [server.config.serverId]: catalog })); return `已列出 ${catalog.prompts.length} 个 Prompts。` })}>列出 Prompts</Button>
            </div>
            {(resourceCatalogs[server.config.serverId]?.connectionId === server.connectionId ? resourceCatalogs[server.config.serverId]?.resources : undefined)?.map(resource => <div key={resource.uri} className="space-y-1 rounded-lg border border-gm-border-subtle p-2">
              <p className="text-caption font-semibold">{resource.name}</p>
              <p className="text-caption break-all text-gm-text-secondary">{resource.uri}</p>
              {resource.description && <p className="text-caption text-gm-text-secondary">{resource.description}</p>}
              <Button type="default" size="small" disabled={busy} onClick={() => void run(async () => { const catalog = resourceCatalogs[server.config.serverId]!; const value = await readMcpResource(server.connectionId!, catalog.catalogRevision, resource.uri); setExternalContent(content => ({ ...content, [server.config.serverId]: { connectionId: server.connectionId!, text: JSON.stringify(value, null, 2) } })); return '资源内容已读取；请按不可信外部数据查看。' })}>读取资源</Button>
            </div>)}
            {(promptCatalogs[server.config.serverId]?.connectionId === server.connectionId ? promptCatalogs[server.config.serverId]?.prompts : undefined)?.map(prompt => {
              const key = `${server.config.serverId}:${prompt.name}`
              return <div key={prompt.name} className="space-y-2 rounded-lg border border-gm-border-subtle p-2">
                <p className="text-caption font-semibold">{prompt.name}</p>
                {prompt.description && <p className="text-caption text-gm-text-secondary">{prompt.description}</p>}
                {prompt.arguments?.map(argument => <p key={argument.name} className="text-caption text-gm-text-secondary">{argument.name}{argument.required ? ' · 必填' : ''}{argument.description ? ` · ${argument.description}` : ''}</p>)}
                <label className="block text-caption">参数 JSON<textarea className="w-full rounded-lg border border-gm-border bg-gm-surface-elevated p-2 text-gm-text" value={promptArguments[key] ?? '{}'} onChange={event => setPromptArguments(value => ({ ...value, [key]: event.target.value }))} rows={2} /></label>
                <Button type="default" size="small" disabled={busy} onClick={() => void run(async () => { let args: unknown; try { args = JSON.parse(promptArguments[key] ?? '{}') } catch { throw new McpClientError('MCP_ARGUMENTS_INVALID') }; if (!args || typeof args !== 'object' || Array.isArray(args)) throw new McpClientError('MCP_ARGUMENTS_INVALID'); const catalog = promptCatalogs[server.config.serverId]!; const value = await getMcpPrompt(server.connectionId!, catalog.catalogRevision, prompt.name, args as Record<string, unknown>); setExternalContent(content => ({ ...content, [server.config.serverId]: { connectionId: server.connectionId!, text: JSON.stringify(value, null, 2) } })); return 'Prompt 内容已获取；不会自动加入 AI 上下文。' })}>获取 Prompt</Button>
              </div>
            })}
            {externalContent[server.config.serverId]?.connectionId === server.connectionId && <pre role="region" aria-label={`MCP 外部内容 ${server.name}`} className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-gm-surface p-2 text-caption">{externalContent[server.config.serverId]?.text}</pre>}
          </div>}
          {deleting === server.config.serverId && <div className="text-caption space-y-2">
          <p>删除“{server.name}”的连接配置、加密环境变量和 OAuth 凭据，并撤销连接和提案？不会删除第三方程序。</p>
            <Button type="text" size="small" className="text-gm-error" disabled={busy} onClick={() => void run(async () => { await deleteMcpServer(server.config.serverId); if (mounted.current) { setDeleting(null); if (config.serverId === server.config.serverId) reset() }; return '配置已删除，连接与提案已撤销。' })}>确定删除</Button>
            <Button type="default" size="small" disabled={busy} onClick={() => setDeleting(null)}>取消删除</Button>
          </div>}
        </section>
      ))}
      <form className="space-y-3 rounded-xl border border-gm-border p-3" onSubmit={event => { event.preventDefault(); if (!busy && loaded) save() }}>
        <h4 className="text-body font-semibold">{editing ? '编辑服务' : '添加服务'}</h4>
        <fieldset disabled={busy || editing || !loaded} className="flex gap-3 text-caption">
          <legend>传输类型（已有服务保持原类型）</legend>
          <label><input type="radio" name="mcp-transport" checked={config.transport !== 'http'} onChange={() => { setConfig({ ...emptyConfig(), serverId: config.serverId }); setEnv([]); setArgs('[]') }} />本地 stdio</label>
          <label><input type="radio" name="mcp-transport" checked={config.transport === 'http'} onChange={() => { setConfig({ transport: 'http', serverId: config.serverId, url: '' }); setEnv([]); setArgs('[]') }} />Streamable HTTP</label>
        </fieldset>
        <label className="block text-caption">服务 ID<Input aria-label="MCP 服务 ID" value={config.serverId} disabled={busy || editing || !loaded} onChange={e => setConfig({ ...config, serverId: e.target.value })} placeholder="字母、数字、下划线或短横线" /></label>
        <label className="block text-caption">名称<Input aria-label="MCP 名称" value={name} disabled={busy || !loaded} onChange={e => setName(e.target.value)} /></label>
        {config.transport === 'http' ? <>
          <label className="block text-caption">精确 MCP 端点<Input aria-label="MCP HTTP URL" value={config.url} disabled={busy || !loaded} onChange={e => setConfig({ ...config, url: e.target.value })} placeholder="https://example.com/mcp" /></label>
          <p className="text-caption text-gm-text-secondary">公网仅 HTTPS；本机/私网需在连接时原生确认。URL 不接受用户名、密码、查询参数或片段；不跟随重定向，不支持自定义头。OAuth 授权由系统浏览器完成。</p>
        </> : <>
        <label className="block text-caption">可执行文件绝对路径（.exe）<Input aria-label="MCP 可执行文件" value={config.executable} disabled={busy || !loaded} onChange={e => setConfig({ ...config, executable: e.target.value })} /></label>
        <label className="block text-caption">工作目录绝对路径<Input aria-label="MCP 工作目录" value={config.cwd} disabled={busy || !loaded} onChange={e => setConfig({ ...config, cwd: e.target.value })} /></label>
        <label className="block text-caption">参数（JSON 字符串数组，路径反斜杠需转义）<textarea aria-label="MCP 参数" className="w-full rounded-lg border border-gm-border bg-gm-surface-elevated p-2 text-gm-text" value={args} disabled={busy || !loaded} onChange={e => setArgs(e.target.value)} rows={3} /></label>
        <fieldset disabled={busy || !loaded} className="space-y-2">
          <legend className="text-caption">加密环境变量（保留不填值；替换需重新输入；删除须显式选择）</legend>
          {env.map((row, i) => <div key={i} className="space-y-2 border-b border-gm-border-subtle pb-2">
            <Input aria-label={`环境变量名 ${i + 1}`} value={row.name} disabled={row.existing} onChange={e => patchEnv(i, { name: e.target.value })} />
            <div className="flex gap-3 text-caption">{(['keep', 'replace', 'remove'] as const).map(action => <label key={action}><input type="radio" name={`mcp-env-${i}`} checked={row.action === action} onChange={() => patchEnv(i, { action, value: '' })} />{action === 'keep' ? '保留' : action === 'replace' ? '替换' : '删除'}</label>)}</div>
            {row.action === 'replace' && <Input aria-label={`环境变量值 ${i + 1}`} type="password" autoComplete="off" value={row.value} onChange={e => patchEnv(i, { value: e.target.value })} />}
            {!row.existing && <Button type="text" size="small" onClick={() => setEnv(rows => rows.filter((_, index) => index !== i))}>移除此输入</Button>}
          </div>)}
          <Button type="default" size="small" disabled={busy || !loaded || env.length >= 32} onClick={() => setEnv(rows => [...rows, { name: '', value: '', action: 'replace' }])}>添加环境变量</Button>
        </fieldset>
        </>}
        <div className="flex gap-2">
          <Button type="primary" disabled={busy || !loaded} onClick={save}>保存配置</Button>
          <Button type="default" disabled={busy} onClick={reset}>清空表单</Button>
        </div>
      </form>
    </div>
  )
}
