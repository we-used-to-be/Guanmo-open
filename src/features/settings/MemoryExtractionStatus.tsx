import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { getDatabase, isDatabaseReady } from '@/services/database/db'
import { readMemoryIntakeSource } from '@/services/memory/memoryIntakeSource'
import { assistantUnit } from '@/services/memory/memoryWindowInput'
import { loadExtractionHistory, type ExtractionHistory } from '@/services/memory/memoryExtractionHistory'

interface Receipt { sourceId: string; sessionId: string; scopeKey: null; epoch: number; sequence: number; sourceFingerprint: string; createdAt: number }
interface Batch { key: string; messages: Receipt[]; running: boolean }
interface Row { value: string }
interface Detail { id: string; user: string; assistant?: string; assistantGap?: string }
const ASSISTANT_GAP_LABELS: Record<string, string> = { ambiguous: '存在多条配对回复', metadata: '回复元数据无效', restricted: '回复受提取安全规则限制', oversize: '回复超过提取输入预算' }
const REJECTION_LABELS: Record<string, string> = { shape: '候选格式或字段无效', source: '来源关联无效', sensitive: '包含禁止保存的敏感内容', scope: '作用域不符', unsupported_value: '事实值未在来源中逐字出现', content_mismatch: '记忆内容未包含原文事实值', undecided: '来源尚未确定', negation: '否定含义不一致', policy: '候选不符合记忆规则' }
const DECISION_LABELS: Record<string, string> = { conflict: '与已有记忆的事实字段冲突', policy: '未通过写入安全条件', duplicate: '已有相同记忆' }

async function loadBatches(): Promise<Batch[]> {
  if (!isDatabaseReady()) throw new Error('database not ready')
  const db = getDatabase()
  const [rows, windows] = await Promise.all([
    db.select<Row>(`SELECT value FROM settings WHERE key LIKE 'memory-extraction:v3:intake:%'
      AND CASE WHEN json_valid(value) THEN json_extract(value, '$.status') = 'pending' ELSE 0 END
      ORDER BY json_extract(value, '$.createdAt'), json_extract(value, '$.sequence') LIMIT 512`),
    db.select<Row>(`SELECT value FROM settings WHERE key LIKE 'memory-extraction:v3:window:%'
      AND CASE WHEN json_valid(value) THEN json_extract(value, '$.status') = 'running' ELSE 0 END LIMIT 512`),
  ])
  const running = new Set<string>()
  for (const row of windows) {
    try {
      const window = JSON.parse(row.value)
      if (window.leaseUntil > Date.now() && Array.isArray(window.sourceIds)) {
        for (const id of window.sourceIds) if (typeof id === 'string') running.add(id)
      }
    } catch { /* Ignore invalid persisted records. */ }
  }
  const groups = new Map<string, Receipt[]>()
  for (const row of rows) {
    try {
      const item = JSON.parse(row.value)
      if (item.version !== 3 || item.scopeKey !== null || typeof item.sourceId !== 'string'
        || typeof item.sessionId !== 'string' || !Number.isSafeInteger(item.epoch)
        || !Number.isSafeInteger(item.sequence) || typeof item.sourceFingerprint !== 'string') continue
      const key = JSON.stringify([item.sessionId, item.epoch])
      groups.set(key, [...(groups.get(key) ?? []), item])
    } catch { /* Ignore invalid persisted records. */ }
  }
  const batches: Batch[] = []
  for (const [key, messages] of groups) {
    messages.sort((a, b) => a.sequence - b.sequence)
    // A claimed window can be smaller than eight; keep it separate from later arrivals.
    const active = messages.filter(message => running.has(message.sourceId))
    const waiting = messages.filter(message => !running.has(message.sourceId))
    if (active.length) batches.push({ key: `${key}:active`, messages: active, running: true })
    for (let i = 0; i < waiting.length; i += 8) batches.push({ key: `${key}:${waiting[i].sequence}`, messages: waiting.slice(i, i + 8), running: false })
  }
  return batches
}

export function MemoryExtractionStatus() {
  const [batches, setBatches] = useState<Batch[]>([])
  const [history, setHistory] = useState<ExtractionHistory[]>([])
  const [error, setError] = useState(false)
  const [open, setOpen] = useState(false)
  const [selectedKey, setSelectedKey] = useState<string>()
  const pages = [
    ...batches.map(batch => ({ key: batch.key, sources: batch.messages, status: batch.running ? '正在处理' : '等待处理', summary: undefined })),
    ...history.map(batch => ({ key: `history:${batch.id}`, sources: batch.sources, status: '已完成', summary: batch })),
  ]
  const pageIndex = Math.max(0, pages.findIndex(page => page.key === selectedKey))
  const page = pages[pageIndex]
  const pageKey = page?.key
  const sources = page?.sources
  const summary = page?.summary
  const [details, setDetails] = useState<{ key: string; messages: Detail[] }>()

  useEffect(() => {
    let cancelled = false
    let pending = false
    const refresh = async () => {
      if (pending) return
      pending = true
      try {
        const [next, recent] = await Promise.all([loadBatches(), loadExtractionHistory()])
        if (!cancelled) { setBatches(next); setHistory(recent); setError(false) }
      } catch { if (!cancelled) setError(true) }
      finally { pending = false }
    }
    void refresh()
    const timer = window.setInterval(refresh, 5000)
    return () => { cancelled = true; window.clearInterval(timer) }
  }, [])

  useEffect(() => {
    if (!open || !pageKey || !sources) return
    let cancelled = false
    const load = async () => {
      try {
        const messages = await Promise.all(sources.map(async receipt => {
          const source = await readMemoryIntakeSource({ ...receipt, policyVersion: 3 })
          const user = source.kind === 'ready' ? source.visibleText : '该消息不参与提取或已不可用'
          const assistant = source.kind === 'ready' ? await assistantUnit(receipt.sessionId, receipt.sourceId) : null
          return { id: receipt.sourceId, user, assistant: assistant?.turn.text, assistantGap: source.kind === 'ready' ? assistant?.turn.gap ?? (assistant ? undefined : 'missing') : undefined }
        }))
        if (!cancelled) setDetails({ key: pageKey, messages })
      } catch { if (!cancelled) setError(true) }
    }
    void load()
    return () => { cancelled = true }
  }, [open, pageKey, sources])

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false) }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open])

  return <>
    <button type="button" disabled={error} onClick={() => setOpen(true)}
      className="mb-4 flex w-full items-center justify-between rounded-xl border border-gm-border bg-gm-surface-elevated p-3 text-left text-caption text-gm-text hover:bg-gm-surface-hover disabled:opacity-60">
      <span>{error ? '记忆提取状态暂不可用' : batches.length ? `记忆提取 · ${batches.filter(batch => batch.running).length} 批处理中，${batches.filter(batch => !batch.running).length} 批等待中` : '记忆提取 · 暂无待处理内容'}</span>
      <span className="text-gm-text-tertiary">查看详情 ›</span>
    </button>
    {open && createPortal(<div className="gm-settings-mask gm-ai-shortcut-dialog-mask fixed inset-0 z-[1100] flex items-center justify-center p-4"
      onMouseDown={event => { if (event.target === event.currentTarget) setOpen(false) }}>
      <div className="gm-settings-modal gm-ai-shortcut-dialog-panel w-full max-w-[800px]">
        <div role="dialog" aria-modal="true" aria-labelledby="memory-extraction-title" className="flex h-[min(480px,calc(100dvh-80px))] flex-col">
          <div className="flex shrink-0 items-center justify-between border-b border-gm-border-subtle pb-3">
            <div>
              <h2 id="memory-extraction-title" className="text-heading font-bold text-gm-text">记忆提取队列</h2>
              <p aria-live="polite" className="mt-1 text-caption text-gm-text-secondary">
                {page ? `${page.status} · ${page.sources.length} 条消息${summary ? ` · ${new Date(summary.completedAt).toLocaleString()}` : ''}` : '暂无批次'}
              </p>
            </div>
            <button type="button" aria-label="关闭记忆提取队列" className="rounded-lg px-2 py-1 text-body text-gm-text-secondary hover:bg-gm-surface-hover" onClick={() => setOpen(false)}>×</button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto py-4">
            {summary && <div className="mb-4">
              <p className="mb-3 text-caption text-gm-text-secondary">{summary.modelCalled
                ? `模型返回 ${summary.proposed} 条候选，其中 ${summary.rejected} 条未通过格式或来源等校验；最终写入 ${summary.inserted} 条，另有 ${summary.skipped} 条被跳过或已存在。`
                : '本批未获得模型判断（没有可用输入或输入超限）。'}</p>
              {summary.formatRepaired && <p className="mb-2 text-micro text-gm-text-secondary">本批已使用一次格式纠错预算。</p>}
              <p className="mb-3 text-micro text-gm-text-tertiary">模型不提供逐条判断理由；候选与写入数量可能不同。</p>
              {summary.rejectionReasons?.map((reason, index) => <p key={index} className="mb-1 text-caption text-gm-text-secondary">校验拒绝：{REJECTION_LABELS[reason] ?? '未知原因'}</p>)}
            </div>}
            {page ? (
              details?.key === pageKey ? <div className="grid grid-cols-2 gap-3 max-sm:grid-cols-1">
                {details.messages.map(message => <div key={message.id} className="min-w-0 rounded-xl border border-gm-border p-3">
                <div className="text-micro text-gm-text-tertiary">用户</div><p className="whitespace-pre-wrap break-words text-caption text-gm-text">{message.user}</p>
                {summary?.decisions?.filter(decision => decision.sourceId === message.id).map((decision, index) => <p key={index} className="mt-1 text-micro text-gm-text-secondary">模型提取了候选 · {decision.outcome === 'inserted' ? (decision.state === 'candidate' ? '待用户确认' : '已写入') : DECISION_LABELS[decision.reason ?? ''] ?? '未写入或已存在'}</p>)}
                {message.assistantGap && <p className="mt-2 text-micro text-gm-text-tertiary">{ASSISTANT_GAP_LABELS[message.assistantGap] ?? '当前没有可用的配对回复'}</p>}
                {message.assistant && <><div className="mt-2 text-micro text-gm-text-tertiary">当前关联的助手回复（不一定参与本次提取）</div><p className="whitespace-pre-wrap break-words text-caption text-gm-text-secondary">{message.assistant}</p></>}
                </div>)}
              </div> : <p className="text-caption text-gm-text-tertiary">{error ? '消息暂不可用' : '正在读取…'}</p>
            ) : <p className="text-caption text-gm-text-tertiary">暂无待处理内容或批次记录</p>}
          </div>
          <div className="flex shrink-0 items-center justify-between border-t border-gm-border-subtle pt-3">
            <button type="button" disabled={pageIndex === 0} onClick={() => setSelectedKey(pages[pageIndex - 1]?.key)}
              className="rounded-lg px-3 py-1 text-caption text-gm-text hover:bg-gm-surface-hover disabled:opacity-50">上一批</button>
            <span className="text-caption text-gm-text-secondary">{page ? pageIndex + 1 : 0} / {pages.length}</span>
            <button type="button" disabled={pageIndex + 1 >= pages.length} onClick={() => setSelectedKey(pages[pageIndex + 1]?.key)}
              className="rounded-lg px-3 py-1 text-caption text-gm-text hover:bg-gm-surface-hover disabled:opacity-50">下一批</button>
          </div>
        </div>
      </div>
    </div>, document.body)}
  </>
}
