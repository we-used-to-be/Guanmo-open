import { useEffect, useState } from 'react'
import { isTauri } from '@/hooks/useTauri'
import { loadMemories } from '@/services/database/persistence'
import { getDatabase, isDatabaseReady } from '@/services/database/db'
import type { ChatMessageRow } from '@/services/database/persistence'
import { getAiConfig, isAiReady } from '@/services/ai/aiClient'
import { resolveRouterConfig } from '@/services/agent/routerConfig'
import { routingModelChat } from '@/services/agent/routingModel'
import { fingerprintGlobalMemorySource } from '@/services/memory/memoryIntake'
import { readMemoryIntakeSource } from '@/services/memory/memoryIntakeSource'
import { assistantUnit } from '@/services/memory/memoryWindowInput'
import type { MemoryWindowPacket } from '@/services/memory/memoryWindowInput'
import { createMemoryWindowRequest, compareMemoryWindowCandidatesForSimulation } from '@/services/memory/memoryWindowModel'
import { parseMemoryWindowCandidates } from '@/services/memory/memoryWindowCandidates'

type Row = ChatMessageRow
interface Result { content: string; relation: string; target?: string }
const relationLabels: Record<string, string> = { add: '模型判断：新增', duplicate: '模型判断：重复', enrich: '模型判断：补充', coexist: '模型判断：并存', replace: '模型判断：替代', review: '模型判断：待核对' }

function displayText(row: Row): string {
  try {
    const value = row.metadata ? JSON.parse(row.metadata) : null
    return typeof value?.displayContent === 'string' ? value.displayContent : row.content
  } catch { return '' }
}

export function MemoryExtractionSimulator() {
  const [rows, setRows] = useState<Row[]>([])
  const [start, setStart] = useState(-1)
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState('')
  const [preview, setPreview] = useState<string[]>([])
  const [results, setResults] = useState<Result[]>([])
  const [rejections, setRejections] = useState<string[]>([])

  useEffect(() => {
    if (!import.meta.env.DEV || !isTauri()) return
    let cancelled = false
    if (!isDatabaseReady()) { setFeedback('数据库暂不可用'); return }
    void getDatabase().select<Row>(`SELECT u.* FROM chat_messages a
      JOIN chat_messages u ON u.id = a.parent_id AND u.role = 'user' AND u.session_id = a.session_id
      WHERE a.role = 'assistant' AND a.rowid = (
        SELECT recent.rowid FROM chat_messages recent
        WHERE recent.session_id = a.session_id AND recent.parent_id = a.parent_id AND recent.role = 'assistant'
        ORDER BY recent.created_at DESC, recent.rowid DESC LIMIT 1
      )
      ORDER BY a.created_at DESC, a.rowid DESC LIMIT 30`).then(items => {
      if (!cancelled) setRows(items.reverse())
    }).catch(() => { if (!cancelled) setFeedback('读取历史对话失败') })
    return () => { cancelled = true }
  }, [])

  const selected = start < 0 ? [] : rows.slice(start, start + 8)

  async function run() {
    if (selected.length !== 8 || busy) return
    setBusy(true)
    setFeedback('')
    setResults([])
    setPreview([])
    setRejections([])
    try {
      const config = getAiConfig()
      if (!config || !isAiReady()) throw new Error('请先配置并初始化聊天模型')
      const turns: MemoryWindowPacket['turns'] = []
      const descriptions: string[] = []
      for (const row of selected) {
        const fingerprint = await fingerprintGlobalMemorySource(displayText(row), row.created_at)
        const source = await readMemoryIntakeSource({ sourceId: row.id, sessionId: row.session_id, sourceFingerprint: fingerprint, policyVersion: 3 })
        if (source.kind !== 'ready') {
          const gap = source.kind === 'gap' ? source.reason : source.kind === 'segmented' ? 'oversize' : source.kind
          if (gap === 'blocked') throw new Error('数据库暂不可用')
          turns.push({ id: row.id, role: 'user', contextOnly: false, gap })
          descriptions.push('用户消息未发送：' + gap)
          continue
        }
        turns.push({ id: row.id, role: 'user', contextOnly: false, text: source.visibleText })
        descriptions.push('用户：' + source.visibleText)
        const reply = await assistantUnit(row.session_id, row.id, 3)
        if (reply) {
          turns.push({ ...reply.turn, contextOnly: false })
          descriptions.push(reply.turn.text === undefined ? '助手回复未发送：' + reply.turn.gap : '助手：' + reply.turn.text)
        } else descriptions.push('没有可用的配对助手回复')
      }
      const packet: MemoryWindowPacket = { policyVersion: 3, turns, snapshots: [], newSourceIds: selected.map(row => row.id),
        segmentedSourceIds: [], needsModel: turns.some(turn => turn.role === 'user' && turn.text !== undefined), estimatedInputTokens: 0 }
      if (!packet.needsModel) { setPreview(descriptions); throw new Error('没有符合发送条件的用户消息') }
      while (new TextEncoder().encode(JSON.stringify({ turns: packet.turns })).length > 32000) {
        let index = packet.turns.length - 1
        while (index >= 0 && packet.turns[index].role !== 'assistant') index--
        if (index < 0) throw new Error('用户消息超过输入预算')
        const [removed] = packet.turns.splice(index, 1)
        descriptions.push('预算限制，移除助手回复：' + removed.id)
      }
      setPreview(packet.turns.map(turn => turn.text === undefined
        ? `${turn.role === 'user' ? '用户' : '助手'}未发送：${turn.gap}`
        : `${turn.role === 'user' ? '用户' : '助手'}：${turn.text}`)
        .concat(descriptions.filter(line => line.startsWith('预算限制') || line.startsWith('没有可用'))))
      const memories = await loadMemories({ scopeType: 'global' })
      const request = createMemoryWindowRequest(packet, null, memories)
      if (request.kind !== 'ready') throw new Error('提取请求超过输入预算')
      const model = resolveRouterConfig(config.routing).model || config.chatModel
      const client = { chat: (input: Parameters<typeof routingModelChat>[1]) => routingModelChat(model, input) }
      const response = await client.chat(request.request)
      let parsed: ReturnType<typeof parseMemoryWindowCandidates> | undefined
      try { parsed = parseMemoryWindowCandidates(response.content, packet, null) } catch { /* Retry malformed output once. */ }
      if (!parsed || (!parsed.candidates.length && parsed.rejections.length > 0 && parsed.rejections.every(reason => reason === 'shape'))) {
        const correction = { ...request.request, messages: request.request.messages.map((message, index) => index === 0
          ? { ...message, content: message.content + '\n上次输出的 JSON 格式或字段类型无效。请重新按要求输出；confidence 必须是 0 至 1 的数字，禁止使用 high 等字符串。不要输出解释。' }
          : message) }
        if (new TextEncoder().encode(JSON.stringify(correction)).length + 256 > 36000) throw new Error('格式纠错请求超过输入预算')
        parsed = parseMemoryWindowCandidates((await client.chat(correction)).content, packet, null)
      }
      setRejections(parsed.rejections)
      if (!parsed.candidates.length) { setFeedback('模型返回 0 条有效候选'); return }
      setResults(parsed.candidates.map(candidate => ({ content: candidate.content, relation: '已通过候选校验，等待记忆比较' })))
      const compared = await compareMemoryWindowCandidatesForSimulation(parsed.candidates, memories, client)
      if (compared.kind !== 'compared') throw new Error('候选已通过校验，但记忆比较失败')
      setResults(parsed.candidates.map((candidate, index) => {
        const relation = compared.relations[index]
        return { content: candidate.content, relation: relationLabels[relation.action], target: memories.find(memory => memory.id === relation.targetId)?.content }
      }))
      setFeedback('演练完成。下方为模型关系判断，未执行正式入库规则及事务校验。')
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : String(error))
    } finally { setBusy(false) }
  }

  if (!import.meta.env.DEV || !isTauri()) return null
  return <section className="mb-4 rounded-xl border border-gm-border bg-gm-surface-elevated p-3">
    <h3 className="text-caption font-bold text-gm-text">记忆提取演练</h3>
    <p className="my-2 text-micro text-gm-text-tertiary">从最近 30 组问答中选择起点，取后续 8 组进行只读演练。</p>
    <select aria-label="选择起始对话" value={start} disabled={busy} onChange={event => { setStart(Number(event.target.value)); setPreview([]); setResults([]); setRejections([]); setFeedback('') }}
      className="w-full rounded-lg border border-gm-border-subtle bg-gm-surface px-2 py-1.5 text-caption text-gm-text">
      <option value={-1}>选择起始对话</option>
      {rows.map((row, index) => <option key={row.id} value={index}>{index + 1} · {displayText(row).replace(/\s+/g, ' ').slice(0, 80)}</option>)}
    </select>
    {start >= 0 && <p className="my-2 text-caption text-gm-text-secondary">已选 {selected.length} / 8 组问答{selected.length < 8 ? '，后续对话不足' : ''}</p>}
    <button type="button" disabled={selected.length !== 8 || busy} onClick={() => void run()}
      className="my-2 rounded-lg bg-gm-primary px-3 py-1.5 text-caption text-white disabled:opacity-50">{busy ? '演练中…' : '运行演练'}</button>
    <p aria-live="polite" className="text-caption text-gm-text-secondary">{feedback}</p>
    {preview.length > 0 && <details className="mt-2 text-caption text-gm-text-secondary"><summary>请求上下文</summary>
      {preview.map((line, index) => <p key={index} className="mt-2 whitespace-pre-wrap break-words">{line}</p>)}</details>}
    {rejections.map((reason, index) => <p key={index} className="mt-1 text-caption text-gm-text-secondary">校验拒绝：{reason}</p>)}
    {results.map((result, index) => <div key={index} className="mt-2 rounded-lg border border-gm-border p-2 text-caption text-gm-text">
      <p>{result.content}</p><p className="mt-1 text-gm-text-secondary">{result.relation}</p>
      {result.target && <p className="mt-1 text-gm-text-secondary">相关记忆：{result.target}</p>}
    </div>)}
  </section>
}
