import type { ChatMessage } from '@/services/ai/types'
import type { Memory } from '@/services/database/persistence'
import { containsForbiddenMemorySecret, containsSensitiveMemoryText } from './memoryPolicy'
import { parseMemoryWindowCandidates } from './memoryWindowCandidates'
import type { MemoryWindowCandidate } from './memoryWindowCandidates'
import type { MemoryWindowPacket } from './memoryWindowInput'
import { isMemoryWindowLeaseCurrent } from './memoryWindowLedger'
import type { MemoryWindowClaim } from './memoryWindowLedger'
import { classifyGlobalMemoryInputGap } from './memoryInputPolicy'

export const MEMORY_WINDOW_PROMPT = `从连续对话中提取适合跨所有工作区和文档长期使用的全局记忆。只提取用户明确表达或明确接受的稳定事实；助手建议、引用、临时请求、普通闲聊和项目/文档限定内容不保存。任何仅适用于某个项目、文档、工作区或当前任务的内容都返回空数组。前缀只提供上下文，事实来源必须包含新用户消息。含糊、推测或来源不足时返回空数组。
只输出 JSON 数组，最多六项；无事实输出 []。每项包含 content、category（preference/learning/profile/instruction）、kind（semantic/episodic）、scope（必须为 global）、primarySourceId、supportingSourceIds、subject、factKey、factValue、confidence 和 sensitivity（normal/sensitive）。一般健康或财务状态标记 sensitive；密码、密钥、验证码、证件号、账户号、精确地址及联系方式不得提取。来源必须使用消息 ID。factValue 必须出现在可见用户来源或被用户明确接受的配对助手建议中；引用助手建议时，必须同时提供该助手回复及其 parent 用户消息，并由 primarySourceId 对应的新用户消息明确接受。`
export const MEMORY_WINDOW_VERIFY_PROMPT = `逐项核对候选是否完全由可见用户来源支持。不得把助手建议、提问、未决定、引用、暂时任务或缺失片段当作用户决定；不得扩大项目范围、时间范围或否定含义。任何细节不确定时判 false。只输出 JSON 数组，每项包含 index（从 0 开始）和 supported（布尔值），必须覆盖每个候选一次。`

interface ModelRequest { messages: ChatMessage[]; temperature: number; maxTokens: number; reasoningMode: 'off' }
interface ModelClient { chat(request: ModelRequest & { signal?: AbortSignal }): Promise<{ content: string; usage?: unknown }> }
interface ModelOptions { signal?: AbortSignal; foregroundBusy: () => boolean; timeoutMs?: number }

function catalogue(memories: readonly Memory[], scopeKey: string | null): Array<Pick<Memory, 'id' | 'content' | 'category' | 'scopeType'>> {
  const result: Array<Pick<Memory, 'id' | 'content' | 'category' | 'scopeType'>> = []
  for (const memory of memories.slice(0, 40)) {
    if (memory.source !== 'auto_extracted' || memory.locked || !['active', 'candidate'].includes(memory.status)
      || (memory.scopeType === 'project' && (!scopeKey || memory.scopeKey !== scopeKey))
      || [memory.content, memory.subject || '', memory.factKey || '', memory.factValue || '']
        .some(text => containsSensitiveMemoryText(text) || containsForbiddenMemorySecret(text))) continue
    const item = { id: memory.id, content: memory.content, category: memory.category, scopeType: memory.scopeType }
    if (new TextEncoder().encode(JSON.stringify([...result, item])).length > 1200) break
    result.push(item)
  }
  return result
}

function safeTurns(packet: MemoryWindowPacket): MemoryWindowPacket['turns'] {
  const gaps = ['hidden', 'sensitive', 'refusal', 'explicit', 'transformation', 'missing_visible_text', 'invalidated',
    'ambiguous', 'metadata', 'restricted', 'oversize']
  if (packet.turns.length > (packet.policyVersion === 3 ? 20 : 12)) throw new Error('invalid_memory_window_turn_count')
  const turns: MemoryWindowPacket['turns'] = packet.turns.map(turn => {
    if (!turn.id || turn.id.length > 340 || !['user', 'assistant'].includes(turn.role) || typeof turn.contextOnly !== 'boolean'
      || (turn.text === undefined) === (turn.gap === undefined)
      || (turn.parentId !== undefined && (typeof turn.parentId !== 'string' || !turn.parentId || turn.parentId.length > 300))
      || (turn.gap !== undefined && !gaps.includes(turn.gap))
      || (turn.text !== undefined && (typeof turn.text !== 'string' || containsForbiddenMemorySecret(turn.text)
        || turn.text.includes('【上下文') || turn.role === 'user' && classifyGlobalMemoryInputGap(turn.text)))) throw new Error('unsafe_memory_window_turn')
    if (turn.segment && (!Number.isSafeInteger(turn.segment.index) || !Number.isSafeInteger(turn.segment.total)
      || turn.segment.index < 0 || turn.segment.total < 2 || turn.segment.total > 128 || turn.segment.index >= turn.segment.total
      || turn.segment.continuationBefore !== (turn.segment.index > 0)
      || turn.segment.continuationAfter !== (turn.segment.index + 1 < turn.segment.total))) throw new Error('invalid_memory_window_segment')
    return { id: turn.id, role: turn.role, contextOnly: turn.contextOnly,
      ...(turn.parentId !== undefined ? { parentId: turn.parentId } : {}),
      ...(turn.text !== undefined ? { text: turn.text } : { gap: turn.gap }),
      ...(turn.segment ? { segment: { index: turn.segment.index, total: turn.segment.total,
        continuationBefore: turn.segment.continuationBefore, continuationAfter: turn.segment.continuationAfter } } : {}) }
  })
  for (let index = 0; index < turns.length; index++) {
    const turn = turns[index]
    if (turn.role === 'assistant' && (!turn.parentId || !turns.slice(0, index).some(parent => parent.role === 'user'
      && parent.id === turn.parentId && parent.text !== undefined && parent.contextOnly === turn.contextOnly))) {
      throw new Error('invalid_memory_window_assistant_parent')
    }
  }
  return turns
}

function readUsage(value: unknown): { promptTokens: number; completionTokens: number } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const item = value as Record<string, unknown>
  if (!Number.isSafeInteger(item.promptTokens) || !Number.isSafeInteger(item.completionTokens)
    || (item.promptTokens as number) < 0 || (item.completionTokens as number) < 0) return null
  return { promptTokens: item.promptTokens as number, completionTokens: item.completionTokens as number }
}

/** Constructs bounded input; local source snapshots and the workspace scope key never enter the request. */
export function createMemoryWindowRequest(packet: MemoryWindowPacket, scopeKey: string | null, memories: readonly Memory[]):
  { kind: 'ready'; request: ModelRequest; estimatedInputTokens: number } | { kind: 'oversize' } {
  if (!packet.needsModel) throw new Error('memory_window_no_model_needed')
  const existing = catalogue(memories, scopeKey)
  const turns = safeTurns(packet)
  const build = (): ModelRequest => ({ messages: [
    { role: 'system', content: MEMORY_WINDOW_PROMPT },
    { role: 'user', content: JSON.stringify({ scope: scopeKey === null ? 'global' : 'project', existing, turns }) },
  ], temperature: 0.1, maxTokens: 800, reasoningMode: 'off' })
  let request = build()
  const inputBudget = packet.policyVersion === 3 ? 36_000 : 6000
  let estimatedInputTokens = new TextEncoder().encode(JSON.stringify(request)).length + 256
  while (estimatedInputTokens > inputBudget && existing.length) {
    existing.pop(); request = build(); estimatedInputTokens = new TextEncoder().encode(JSON.stringify(request)).length + 256
  }
  return estimatedInputTokens <= inputBudget ? { kind: 'ready', request, estimatedInputTokens } : { kind: 'oversize' }
}

type CallResult = { kind: 'response'; content: string; usage: { promptTokens: number; completionTokens: number } | null; elapsedMs: number }
  | { kind: 'deferred' | 'lost_lease' | 'retry' }
type ProposalResult = { kind: 'proposals'; candidates: MemoryWindowCandidate[]; rejected: number;
  usage: { promptTokens: number; completionTokens: number } | null; elapsedMs: number }
  | { kind: 'noop' | 'deferred' | 'lost_lease' | 'oversize' | 'retry' }

async function callMemoryWindowModel(claim: MemoryWindowClaim, request: ModelRequest, client: ModelClient, options: ModelOptions): Promise<CallResult> {
  if (options.signal?.aborted || options.foregroundBusy()) return { kind: 'deferred' }
  if (!await isMemoryWindowLeaseCurrent(claim)) return { kind: 'lost_lease' }
  if (options.signal?.aborted || options.foregroundBusy()) return { kind: 'deferred' }
  const timeoutMs = options.timeoutMs ?? 20_000
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 20_000) throw new Error('invalid_memory_window_timeout')
  const controller = new AbortController()
  let timedOut = false
  const abort = () => controller.abort('foreground_or_cancelled')
  options.signal?.addEventListener('abort', abort, { once: true })
  if (options.signal?.aborted) abort()
  const timer = setTimeout(() => { timedOut = true; controller.abort('memory_window_timeout') }, timeoutMs)
  const started = performance.now()
  try {
    if (controller.signal.aborted) return { kind: 'deferred' }
    const response = await Promise.race([
      client.chat({ ...request, signal: controller.signal }),
      new Promise<never>((_, reject) => {
        if (controller.signal.aborted) reject(new Error('memory_window_aborted'))
        else controller.signal.addEventListener('abort', () => reject(new Error('memory_window_aborted')), { once: true })
      }),
    ])
    if (controller.signal.aborted || options.foregroundBusy()) return { kind: timedOut ? 'retry' : 'deferred' }
    if (!await isMemoryWindowLeaseCurrent(claim)) return { kind: 'lost_lease' }
    if (controller.signal.aborted || options.foregroundBusy()) return { kind: timedOut ? 'retry' : 'deferred' }
    return { kind: 'response', content: response.content, usage: readUsage(response.usage), elapsedMs: Math.round(performance.now() - started) }
  } catch {
    return { kind: controller.signal.aborted && !timedOut ? 'deferred' : 'retry' }
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', abort)
    controller.abort('memory_window_finished')
  }
}

function preparePacket(claim: MemoryWindowClaim, packet: MemoryWindowPacket): { scopeKey: string | null; packet: MemoryWindowPacket } {
  const locked = JSON.parse(claim.value) as MemoryWindowClaim['record'], scopeKey = locked.scopeKey
  if (!packet.newSourceIds.length || packet.newSourceIds.some(id => !locked.sourceIds.includes(id))
    || packet.turns.some(turn => turn.role === 'user' && !turn.contextOnly && !packet.newSourceIds.includes(turn.id))) {
    throw new Error('invalid_memory_window_packet_sources')
  }
  return { scopeKey, packet: { ...packet, turns: safeTurns(packet), newSourceIds: [...packet.newSourceIds],
    segmentedSourceIds: [...packet.segmentedSourceIds], snapshots: [] } }
}

/** One bounded model call, with no write side effects. The caller owns foreground cancellation. */
export async function requestMemoryWindowProposals(claim: MemoryWindowClaim, packet: MemoryWindowPacket, memories: readonly Memory[],
  client: ModelClient, options: ModelOptions): Promise<ProposalResult> {
  if (!packet.needsModel) return { kind: 'noop' }
  if (options.signal?.aborted || options.foregroundBusy()) return { kind: 'deferred' }
  const prepared = preparePacket(claim, packet)
  const built = createMemoryWindowRequest(prepared.packet, prepared.scopeKey, memories)
  if (built.kind === 'oversize') return built
  const result = await callMemoryWindowModel(claim, built.request, client, options)
  if (result.kind !== 'response') return result
  try {
    const parsed = parseMemoryWindowCandidates(result.content, prepared.packet, prepared.scopeKey)
    return { kind: 'proposals', candidates: parsed.candidates, rejected: parsed.rejections.length,
      usage: result.usage, elapsedMs: result.elapsedMs }
  } catch { return { kind: 'retry' } }
}

type VerificationResult = { kind: 'verified'; verdicts: Array<{ candidate: MemoryWindowCandidate; supported: boolean }>;
  usage: { promptTokens: number; completionTokens: number } | null; elapsedMs: number }
  | { kind: 'noop' | 'deferred' | 'lost_lease' | 'oversize' | 'retry' }

/** A second model check is experimental evidence, not independent or conclusive semantic validation. */
export async function verifyMemoryWindowProposals(claim: MemoryWindowClaim, packet: MemoryWindowPacket,
  candidates: readonly MemoryWindowCandidate[], client: ModelClient, options: ModelOptions): Promise<VerificationResult> {
  if (!candidates.length) return { kind: 'noop' }
  if (options.signal?.aborted || options.foregroundBusy()) return { kind: 'deferred' }
  if (candidates.length > 6) throw new Error('invalid_memory_window_candidate_count')
  const prepared = preparePacket(claim, packet)
  const checked = parseMemoryWindowCandidates(JSON.stringify(candidates), prepared.packet, prepared.scopeKey)
  if (checked.candidates.length !== candidates.length || checked.rejections.length) throw new Error('invalid_memory_window_candidates')
  const proposals = checked.candidates.map(candidate => ({ content: candidate.content, category: candidate.category, kind: candidate.kind,
    scope: candidate.scope, primarySourceId: candidate.primarySourceId, supportingSourceIds: candidate.supportingSourceIds,
    subject: candidate.subject, factKey: candidate.factKey, factValue: candidate.factValue, segmented: candidate.segmented }))
  const request: ModelRequest = { messages: [
    { role: 'system', content: MEMORY_WINDOW_VERIFY_PROMPT },
    { role: 'user', content: JSON.stringify({ scope: prepared.scopeKey === null ? 'global' : 'project', turns: prepared.packet.turns, proposals }) },
  ], temperature: 0.1, maxTokens: 800, reasoningMode: 'off' }
  if (new TextEncoder().encode(JSON.stringify(request)).length + 256 > 6000) return { kind: 'oversize' }
  const result = await callMemoryWindowModel(claim, request, client, options)
  if (result.kind !== 'response') return result
  try {
    const text = result.content.trim(), fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
    const parsed: unknown = JSON.parse(fenced ? fenced[1] : text)
    if (!Array.isArray(parsed) || parsed.length !== candidates.length) throw new Error('invalid_memory_window_verdict')
    const verdicts = new Map<number, boolean>()
    for (const value of parsed) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_memory_window_verdict')
      const item = value as Record<string, unknown>
      if (!Number.isSafeInteger(item.index) || (item.index as number) < 0 || (item.index as number) >= candidates.length
        || typeof item.supported !== 'boolean' || verdicts.has(item.index as number)) throw new Error('invalid_memory_window_verdict')
      verdicts.set(item.index as number, item.supported)
    }
    return { kind: 'verified', verdicts: checked.candidates.map((candidate, index) => ({ candidate, supported: verdicts.get(index)! })),
      usage: result.usage, elapsedMs: result.elapsedMs }
  } catch { return { kind: 'retry' } }
}
