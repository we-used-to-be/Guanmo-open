import { useEffect, useRef, useState } from 'react'
import { ContextMenu, ContextMenuItem } from '@/components/common/ContextMenu'
import { isTauri } from '@/hooks/useTauri'
import { listMcpServers, refreshMcpTools, type McpConnectionCatalog, type McpServerView } from '@/services/mcp/client'
import { copyMcpTurnSnapshot, selectMcpTurnTool, type McpTurnSnapshot } from '@/services/mcp/turnSnapshot'

export function McpToolPicker({ value, onChange, disabled }: {
  value: McpTurnSnapshot
  onChange: (value: McpTurnSnapshot) => void
  disabled: boolean
}) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const [servers, setServers] = useState<McpServerView[]>([])
  const [catalog, setCatalog] = useState<McpConnectionCatalog | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const generation = useRef(0)
  useEffect(() => () => { generation.current++ }, [])
  useEffect(() => {
    if (disabled) { generation.current++; setAnchor(null); setBusy(false) }
  }, [disabled])
  // Async results are scoped to the still-open menu; closing never disconnects a service.
  const close = () => { generation.current++; setAnchor(null); setBusy(false) }
  if (!isTauri()) return null

  const open = async (target: HTMLElement) => {
    const token = ++generation.current
    setAnchor(target); setCatalog(null); setServers([]); setError(''); setBusy(true)
    onChange([])
    try {
      const current = await listMcpServers()
      if (generation.current === token && target.isConnected) setServers(current.filter(server => server.enabled && server.status === 'connected' && server.connectionId))
    } catch { if (generation.current === token) setError('读取 MCP 服务失败，请重新打开选择。') }
    finally { if (generation.current === token) setBusy(false) }
  }

  const load = async (server: McpServerView) => {
    const token = ++generation.current
    setCatalog(null); setBusy(true); setError('')
    // Refresh revokes this server's previous directory selection before awaiting Rust.
    onChange(copyMcpTurnSnapshot(value.filter(tool => tool.serverId !== server.config.serverId)))
    try {
      const current = await refreshMcpTools(server.connectionId!)
      if (generation.current !== token) return
      if (current.connectionId !== server.connectionId || current.catalog.serverId !== server.config.serverId) throw new Error('identity')
      setCatalog(current)
    } catch { if (generation.current === token) setError('读取工具目录失败，请在设置中检查连接。') }
    finally { if (generation.current === token) setBusy(false) }
  }

  return <div className="px-3 py-1 text-caption text-gm-text-secondary">
    <button type="button" disabled={disabled} onClick={event => anchor ? close() : void open(event.currentTarget)} className="rounded px-2 py-1 hover:bg-gm-surface-hover disabled:opacity-50">
      本轮 MCP 工具{value.length > 0 ? `（${value.length}）` : ''}
    </button>
    {value.length > 0 && <button type="button" disabled={disabled} onClick={() => onChange([])}>清除选择</button>}
    {value.length > 0 && <p className="break-words px-2">{value.map(tool => `${tool.serverId} / ${tool.remoteName}`).join('、')}</p>}
    {anchor && !disabled && <ContextMenu anchor={anchor} placement="top-end" role="dialog" aria-label="本轮 MCP 工具" onClose={close} minWidth={280} maxWidth={420}>
      <p className="px-2 py-1 text-caption text-gm-text-secondary">仅本次发送有效；重新打开会清除旧选择。不会自动连接。每次调用需原生确认，取消不保证回滚外部副作用。</p>
      {busy && <p role="status">正在读取…</p>}
      {!busy && servers.length === 0 && <p className="px-2 py-1">没有已连接服务，请先在设置中连接。</p>}
      {servers.map(server => <ContextMenuItem key={server.config.serverId} disabled={busy} onClick={() => void load(server)}>{server.name}</ContextMenuItem>)}
      {catalog?.catalog.tools.map(tool => {
        const alias = tool.modelTool.function.name
        const selected = value.some(entry => entry.modelTool.function.name === alias)
        return <ContextMenuItem key={alias} role="menuitemcheckbox" selected={selected} onClick={() => {
          try {
            onChange(copyMcpTurnSnapshot(selected ? value.filter(entry => entry.modelTool.function.name !== alias) : [...value, selectMcpTurnTool(catalog, alias)]))
            setError('')
          } catch { setError('本轮最多选择16个工具，目录总大小不得超过64 KiB。') }
        }}>{selected ? '✓ ' : ''}{tool.remoteName}</ContextMenuItem>
      })}
      {catalog && catalog.catalog.tools.length === 0 && <p>该服务没有工具。</p>}
      {error && <p role="alert" className="text-gm-error px-2">{error}</p>}
      <ContextMenuItem onClick={close}>完成选择</ContextMenuItem>
    </ContextMenu>}
  </div>
}
