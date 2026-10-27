import { useEffect, useRef, useState } from 'react'
import { Button, Input } from 'animal-island-ui'
import { McpClientError } from '@/services/mcp/client'
import { getMcpServerConnectionInfo, getMcpServerOptions, getMcpServerStatus, startMcpServer, stopMcpServer, type McpServerConnectionInfo, type McpServerStatus } from '@/services/mcp/server'
import type { McpServerPath } from '@/services/mcp/serverData'
import { McpServerEdits } from './McpServerEdits'

function failure(error: unknown): string { return `操作未完成${error instanceof McpClientError ? `（${error.code}）` : ''}，请检查状态后重试。` }

export function McpServerSettings() {
  const [status, setStatus] = useState<McpServerStatus | null>(null)
  const [paths, setPaths] = useState<McpServerPath[]>([])
  const [selectedPaths, setSelectedPaths] = useState<string[]>([])
  const [pathOffset, setPathOffset] = useState(0)
  const [nextPathOffset, setNextPathOffset] = useState<number | null>(null)
  const [readDocuments, setReadDocuments] = useState(true)
  const [searchKnowledge, setSearchKnowledge] = useState(true)
  const [readArtifacts, setReadArtifacts] = useState(false)
  const [writeDocuments, setWriteDocuments] = useState(false)
  const [artifacts, setArtifacts] = useState<Array<{ key: string; title: string; type: string }>>([])
  const [selectedArtifacts, setSelectedArtifacts] = useState<Record<string, string>>({})
  const [artifactQuery, setArtifactQuery] = useState('')
  const [artifactOffset, setArtifactOffset] = useState(0)
  const [nextArtifactOffset, setNextArtifactOffset] = useState<number | null>(null)
  const [connection, setConnection] = useState<McpServerConnectionInfo | null>(null)
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [starting, setStarting] = useState(false)
  const alive = useRef(false)
  const working = useRef(false)
  const pendingStart = useRef<{ id: string; controller: AbortController } | null>(null)

  useEffect(() => {
    alive.current = true
    void Promise.all([getMcpServerStatus(), getMcpServerOptions()]).then(([value, options]) => {
      if (alive.current) { setStatus(value); setPaths(options.paths); setNextPathOffset(options.nextOffset) }
    }).catch(error => { if (alive.current) setMessage(failure(error)) })
    return () => { alive.current = false; if (pendingStart.current) { pendingStart.current.controller.abort(); void stopMcpServer(pendingStart.current.id).catch(() => {}) } }
  }, [])

  const run = async (operation: () => Promise<string>) => {
    if (working.current) return
    working.current = true; setBusy(true); setMessage('')
    try {
      const result = await operation()
      const current = await getMcpServerStatus()
      if (alive.current) { setStatus(current); if (!current.running) setConnection(null); setMessage(result) }
    } catch (error) { if (alive.current) setMessage(failure(error)) }
    finally { working.current = false; if (alive.current) { setBusy(false); setStarting(false) } }
  }
  const loadPaths = (offset: number) => void run(async () => {
    const options = await getMcpServerOptions(offset)
    if (alive.current) { setPaths(options.paths); setNextPathOffset(options.nextOffset); setPathOffset(offset) }
    return '文件授权范围已刷新。'
  })
  const loadArtifacts = (offset: number) => void run(async () => {
    const { listMcpShareableArtifacts } = await import('@/services/mcp/serverData')
    const options = await listMcpShareableArtifacts(artifactQuery, offset)
    if (alive.current) { setArtifacts(options.items); setNextArtifactOffset(options.nextOffset); setArtifactOffset(offset) }
    return '只会分享你明确勾选的完整阅读成果。'
  })
  const stop = async () => {
    try { await stopMcpServer(); const current = await getMcpServerStatus(); if (alive.current) { setStatus(current); setConnection(null); setMessage('服务端已关闭，外部授权已撤销。') } }
    catch (error) { if (alive.current) setMessage(failure(error)) }
  }
  const selectionReady = Boolean(status && (readDocuments || searchKnowledge || readArtifacts || writeDocuments) && (!(readDocuments || searchKnowledge || writeDocuments) || selectedPaths.length) && (!readArtifacts || Object.keys(selectedArtifacts).length))
  const start = () => {
    if (working.current) return
    const requestId = crypto.randomUUID()
    const controller = new AbortController()
    pendingStart.current = { id: requestId, controller }; setStarting(true)
    void run(async () => {
      try {
        const value = await startMcpServer({ paths: readDocuments || searchKnowledge || writeDocuments ? selectedPaths : [], artifactKeys: readArtifacts ? Object.keys(selectedArtifacts) : [], readDocuments, searchKnowledge, readArtifacts, writeDocuments }, requestId, controller.signal)
        if (!alive.current) { await stopMcpServer(value.generation ?? requestId); return '' }
        return '服务端已启用；请查看连接信息并配置可信客户端。'
      } finally { pendingStart.current = null }
    })
  }

  return <section aria-label="观墨 MCP 服务端" className="space-y-3 rounded-xl border border-gm-border p-4 text-gm-text">
    <h3 className="text-body font-semibold">向外部 AI 提供观墨内容</h3>
    <p className="text-caption text-gm-text-secondary">默认关闭，仅监听本机。启用后，持有连接令牌的客户端可读取你在这里授权的内容；软件重启后关闭。此授权独立于观墨内部 AI 和外部 MCP 服务。</p>
    <p role="status" aria-label="MCP 服务端状态" className="text-caption break-words">{message || (status?.running ? '服务端运行中' : status?.starting || starting ? '等待启动确认' : '服务端已关闭')}</p>
    <div className="flex flex-wrap gap-2">
      <Button type="default" size="small" disabled={busy} onClick={() => void run(async () => '状态已刷新。')}>刷新服务端状态</Button>
      {(status?.running || status?.starting || starting) && <Button type="default" size="small" onClick={() => void stop()}>关闭服务端并撤销授权</Button>}
    </div>
    {status?.running ? <div className="space-y-2 text-caption">
      <p className="break-all">{status.endpoint}</p>
      <p>已授权 {status.config?.paths.length ?? 0} 个文件范围，{status.config?.artifactKeys.length ?? 0} 项阅读成果。修改授权需先关闭服务端。</p>
      <Button type="default" size="small" disabled={busy} onClick={() => void run(async () => { const value = await getMcpServerConnectionInfo(); if (alive.current) setConnection(value); return '连接信息已显示，请只交给你信任的本机客户端。' })}>查看连接信息</Button>
      {connection && <div className="space-y-2 rounded-lg border border-gm-border p-3">
        <p className="break-all">HTTP 端点：{connection.endpoint}</p>
        <p className="break-all">Bearer 令牌：{connection.token}</p>
        <Button type="default" size="small" onClick={() => void navigator.clipboard.writeText(JSON.stringify({ url: connection.endpoint, headers: { Authorization: `Bearer ${connection.token}` } }, null, 2)).then(() => setMessage('连接信息已复制。')).catch(error => setMessage(failure(error)))}>复制连接信息</Button>
      </div>}
      {status.config?.writeDocuments && <McpServerEdits />}
    </div> : <fieldset disabled={busy || Boolean(status?.starting)} className="space-y-3">
      <legend className="text-caption font-semibold">本次运行授权</legend>
      <div className="flex flex-wrap gap-3 text-caption">
        <label><input type="checkbox" checked={readDocuments} onChange={event => setReadDocuments(event.target.checked)} />读取 Markdown</label>
        <label><input type="checkbox" checked={searchKnowledge} onChange={event => setSearchKnowledge(event.target.checked)} />检索知识库（关键词）</label>
        <label><input type="checkbox" checked={readArtifacts} onChange={event => setReadArtifacts(event.target.checked)} />读取指定阅读成果</label>
        <label><input type="checkbox" checked={writeDocuments} onChange={event => setWriteDocuments(event.target.checked)} />允许提出文档修改（每次确认）</label>
      </div>
      {(readDocuments || searchKnowledge || writeDocuments) && <div className="space-y-2 text-caption">
        <p>勾选文件范围（最多 32 项）。这里只列出观墨已有授权；没有可选项时，请先打开工作区或 Markdown 文件。</p>
        {paths.map(scope => <label key={scope.path} className="block break-all"><input type="checkbox" checked={selectedPaths.includes(scope.path)} disabled={!selectedPaths.includes(scope.path) && selectedPaths.length >= 32} onChange={event => setSelectedPaths(value => event.target.checked ? [...value, scope.path] : value.filter(path => path !== scope.path))} />{scope.directory ? '文件夹' : '文件'} · {scope.path}</label>)}
        <div className="flex gap-2"><Button type="default" size="small" onClick={() => loadPaths(Math.max(0, pathOffset - 50))} disabled={pathOffset === 0}>上一页范围</Button><Button type="default" size="small" onClick={() => loadPaths(nextPathOffset!)} disabled={nextPathOffset === null}>下一页范围</Button><Button type="default" size="small" onClick={() => loadPaths(pathOffset)}>刷新范围</Button></div>
        <p>已选 {selectedPaths.length} 项</p>
      </div>}
      {readArtifacts && <div className="space-y-2 text-caption">
        <p>勾选即授权该成果全文，包括其中的引用和历史选区；最多 100 项。</p>
        <Input aria-label="查找可分享的阅读成果" value={artifactQuery} onChange={event => setArtifactQuery(event.target.value)} placeholder="按标题、摘录或笔记查找" />
        <Button type="default" size="small" onClick={() => loadArtifacts(0)}>加载阅读成果</Button>
        {artifacts.map(artifact => <label key={artifact.key} className="block break-words"><input type="checkbox" checked={Boolean(selectedArtifacts[artifact.key])} disabled={!selectedArtifacts[artifact.key] && Object.keys(selectedArtifacts).length >= 100} onChange={event => setSelectedArtifacts(value => { const next = { ...value }; if (event.target.checked) next[artifact.key] = artifact.title; else delete next[artifact.key]; return next })} />{artifact.title || '无标题成果'} · {artifact.type}</label>)}
        <div className="flex gap-2"><Button type="default" size="small" onClick={() => loadArtifacts(Math.max(0, artifactOffset - 20))} disabled={artifactOffset === 0}>上一页成果</Button><Button type="default" size="small" onClick={() => loadArtifacts(nextArtifactOffset!)} disabled={nextArtifactOffset === null}>下一页成果</Button></div>
        <p>已选 {Object.keys(selectedArtifacts).length} 项</p>
      </div>}
      <Button type="primary" disabled={!selectionReady} onClick={start}>启用本机 MCP 服务端</Button>
    </fieldset>}
  </section>
}
