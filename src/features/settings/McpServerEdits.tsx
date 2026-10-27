import { useEffect, useRef, useState } from 'react'
import { Button } from 'animal-island-ui'
import { approveMcpDocumentEdit, cancelMcpDocumentEdit, getMcpDocumentEdit, listMcpDocumentEdits, revertMcpDocumentEdit, type McpDocumentEdit, type McpDocumentEditDetail } from '@/services/mcp/serverEdits'
import { McpClientError } from '@/services/mcp/client'

const states: Record<string, string> = { preparing:'正在捕获快照', pending:'待核对', confirming:'等待原生确认', approved:'待提交', committing:'写入中', written:'已写入', reverted:'已撤销', rejected:'已拒绝', cancelled:'已取消', expired:'已过期', stopped:'服务已关闭', conflict:'快照冲突', failed:'写入失败', unknown:'结果未知，请核实文件' }

export function McpServerEdits() {
  const [items, setItems] = useState<McpDocumentEdit[]>([])
  const [detail, setDetail] = useState<McpDocumentEditDetail | null>(null)
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const alive = useRef(false)
  const working = useRef(false)
  const refresh = async () => {
    const values = await listMcpDocumentEdits()
    if (alive.current) {
      setItems(values)
      setDetail(current => {
        const latest = values.find(item => item.proposalId === current?.proposalId)
        return current && latest ? { ...current, state:latest.state } : null
      })
    }
  }
  const run = async (operation: () => Promise<string>) => {
    if (working.current) return
    working.current = true; setBusy(true)
    try { const result = await operation(); if (alive.current) setMessage(result) }
    catch (error) { if (alive.current) setMessage(`操作未完成${error instanceof McpClientError ? `（${error.code}）` : ''}。请刷新提案状态核实结果，结果未知时勿重复提交。`) }
    finally { await refresh().catch(() => {}); working.current = false; if (alive.current) setBusy(false) }
  }
  useEffect(() => {
    alive.current = true
    void refresh().catch(() => { if (alive.current) setMessage('提案状态暂不可用，请手动刷新。') })
    return () => { alive.current = false }
  }, [])
  return <section aria-label="外部文档修改提案" className="space-y-2 rounded-lg border border-gm-border p-3 text-caption">
    <h4 className="font-semibold">外部文档修改提案</h4>
    <p>外部请求不会立即写入。先查看差异，再通过原生确认；原文或标签页变化会使提案失效。提案保留 5 分钟，已写入修改可在记录有效期内另提撤销并重新确认。</p>
    <Button type="default" size="small" disabled={busy} onClick={() => void run(async () => { setDetail(null); return '提案列表已刷新。' })}>刷新修改提案</Button>
    {message && <p role="status">{message}</p>}
    {items.length === 0 && <p>暂无提案。</p>}
    {items.map(item => <div key={item.proposalId} className="space-y-1 border-b border-gm-border py-2">
      <p className="break-all">{item.path} · {states[item.state] ?? item.state}</p>
      <Button type="default" size="small" disabled={busy} onClick={() => void run(async () => { const value = await getMcpDocumentEdit(item.proposalId); if (alive.current) setDetail(value); return '请核对下方原文与替换片段。' })}>查看差异</Button>
      {['preparing', 'pending', 'confirming', 'approved'].includes(item.state) && <Button type="default" size="small" disabled={busy} onClick={() => void run(async () => {
        await cancelMcpDocumentEdit(item.proposalId)
        const latest = await getMcpDocumentEdit(item.proposalId)
        if (alive.current) setDetail(null)
        return latest.state === 'cancelled' ? '提案已取消，未写入。' : `提案状态：${states[latest.state] ?? latest.state}。请核实文件，已提交操作不会回滚。`
      })}>拒绝提案</Button>}
      {item.state === 'written' && <Button type="default" size="small" disabled={busy} onClick={() => void run(async () => { const reverse = await revertMcpDocumentEdit(item.proposalId); const value = await getMcpDocumentEdit(reverse.proposalId); if (alive.current) setDetail(value); return '已生成撤销提案，请核对后重新确认；尚未撤销写盘。' })}>提出撤销</Button>}
    </div>)}
    {detail && <div className="space-y-2">
      <p className="break-all">{detail.path}</p>
      <p>删除片段</p><pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded border border-gm-border p-2">{detail.oldText || '（空）'}</pre>
      <p>替换为</p><pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded border border-gm-border p-2">{detail.newText || '（空）'}</pre>
      {detail.recoveryFiles.map(path => <p key={path} className="break-all">恢复副本（如存在）：{path}</p>)}
      {detail.state === 'pending' && <Button type="primary" size="small" disabled={busy} onClick={() => void run(async () => { const receipt = await approveMcpDocumentEdit(detail.proposalId); if (alive.current) setDetail(null); return receipt.currentSaved ? '修改已写入，当前标签页已同步。' : '修改已写入；写入期间的新草稿仍保留，已关闭的标签页不会恢复。' })}>核对完成，确认写入</Button>}
    </div>}
  </section>
}
