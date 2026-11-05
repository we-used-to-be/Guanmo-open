import type { ChatMessage } from '@/services/ai/types'
import type { Memory } from '@/services/database/persistence'
import { containsForbiddenMemorySecret, containsSensitiveMemoryText, lexicalMemorySimilarity } from './memoryPolicy'
import { parseMemoryWindowCandidates } from './memoryWindowCandidates'
import type { MemoryWindowCandidate } from './memoryWindowCandidates'
import type { MemoryWindowPacket } from './memoryWindowInput'
import { isMemoryWindowLeaseCurrent, reserveMemoryWindowFormatRepair } from './memoryWindowLedger'
import type { MemoryWindowClaim } from './memoryWindowLedger'
import { classifyGlobalMemoryInputGap, isVisibleSelectionQuestion } from './memoryInputPolicy'

export const MEMORY_WINDOW_PROMPT = `从连续对话中提取适合跨所有工作区和文档长期使用的全局记忆。只提取用户明确表达或明确接受的稳定事实；用户明确陈述的长期学习方向和长期目标也是稳定事实，应分别提取，不因“正在学习”而一概忽略。用户明确表达并长期保持的重复习惯也应提取，保留实际频率和持续时间，不要将一次性行为当作习惯。用户明确表达的长期否定偏好也应提取，保留“不喜欢”等否定词，不要误写为肯定偏好。助手建议、引用、临时请求、普通闲聊和项目/文档限定内容不保存。逐项判断适用范围，跳过仅在某个项目、文档、工作区或当前任务内生效的约定，继续检查其他事实。用户明确表达的稳定身份（例如“我是某项目的开发者”）描述的是用户本人，可以跨工作区提取。把“以后聊到时留意一下”理解为可能希望在未来对话复用的信号，提取其中明确的稳定事实，保留“可能”等限定，不要把试验说明或临时说法提取为长期指令。前缀只提供上下文，事实来源必须包含新用户消息。含糊、推测或来源不足时返回空数组。
只输出 JSON 数组，最多六项；无事实输出 []。每项包含 content、category（preference/learning/profile/instruction）、kind（semantic/episodic）、scope（必须为 global）、primarySourceId、supportingSourceIds、subject、factKey、factValue、evidenceQuote、confidence 和 sensitivity（normal/sensitive）。evidenceQuote 必须从 primarySourceId 对应的用户消息逐字复制能支持该事实的完整片段，不得改写；content 是事实概括，不得扩大含义。supportingSourceIds 只包含其他必要来源的消息 ID，不能包含 primarySourceId；没有其他来源时使用空数组 []。confidence 必须是 0 到 1 之间的 JSON 数字，例如 0.95，不能写 high 或字符串。优先让 factValue 是来源文本和 content 中同时逐字出现的简短核心词；允许基于原文忠实概括，禁止添加原文没有的事实。拆分两个独立事实，同一批次的同义事实只返回一次。例如用户说“我的职业是独立开发者，我长期从事软件开发”，可使用 factValue“独立开发者”、content“用户的职业是独立开发者”、evidenceQuote“我的职业是独立开发者”。疾病、诊断、治疗或具体财务状态标记 sensitive；普通的健康饮食偏好不因此标记 sensitive。密码、密钥、验证码、证件号、账户号、精确地址及联系方式不得提取。来源必须使用消息 ID；引用助手建议时，必须同时提供该助手回复及其 parent 用户消息，并由 primarySourceId 对应的新用户消息明确接受。`
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
        || turn.text.includes('【上下文') || turn.role === 'user' && classifyGlobalMemoryInputGap(turn.text,
          packet.policyVersion === 3 && packet.snapshots.some(snapshot => snapshot.id === turn.id && snapshot.role === 'user'
            && isVisibleSelectionQuestion(turn.text!, snapshot.metadata)))))) throw new Error('unsafe_memory_window_turn')
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
type ProposalResult = { kind: 'proposals'; candidates: MemoryWindowCandidate[]; rejected: number; rejectionReasons: string[]; formatRepaired?: boolean;
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

export type MemoryRelation = { action: 'add' | 'duplicate' | 'enrich' | 'coexist' | 'replace' | 'review'; targetId?: string; content?: string }

/** Compare a bounded set of related global memories; IDs in the response must refer to supplied records. */
export async function compareMemoryWindowCandidates(claim: MemoryWindowClaim, candidates: readonly MemoryWindowCandidate[],
  memories: readonly Memory[], client: ModelClient, options: ModelOptions): Promise<{ kind: 'compared'; relations: MemoryRelation[] }
    | { kind: 'deferred' | 'lost_lease' | 'retry' }> {
  return compareMemoryWindowCandidatesWithCall(candidates, memories, options,
    request => callMemoryWindowModel(claim, request, client, options))
}

export async function compareMemoryWindowCandidatesForSimulation(candidates: readonly MemoryWindowCandidate[],
  memories: readonly Memory[], client: ModelClient): Promise<{ kind: 'compared'; relations: MemoryRelation[] }
    | { kind: 'deferred' | 'lost_lease' | 'retry' }> {
  return compareMemoryWindowCandidatesWithCall(candidates, memories, { foregroundBusy: () => false }, async request => {
    try { return { kind: 'response', content: (await client.chat(request)).content, usage: null, elapsedMs: 0 } }
    catch { return { kind: 'retry' } }
  }, false)
}

async function compareMemoryWindowCandidatesWithCall(candidates: readonly MemoryWindowCandidate[], memories: readonly Memory[],
  options: ModelOptions, call: (request: ModelRequest) => Promise<CallResult>, allowEmbedding = true): Promise<{ kind: 'compared'; relations: MemoryRelation[] }
    | { kind: 'deferred' | 'lost_lease' | 'retry' }> {
  const existing = memories.filter(memory => memory.status === 'active' && (memory.scopeType || 'global') === 'global'
    && !memory.scopeKey && !containsSensitiveMemoryText([memory.content, memory.factKey, memory.factValue].filter(Boolean).join(' ')))
  if (!existing.length) return { kind: 'compared', relations: candidates.map(() => ({ action: 'add' })) }
  let semanticIds = new Set<string>()
  try {
    const ai = await import('@/services/ai/aiClient')
    if (allowEmbedding && ai.isEmbeddingReady()) {
      const embeddingClient = ai.getEmbeddingClient()
      if (embeddingClient) {
        const { searchMemories } = await import('./memoryService')
        const found = await searchMemories(candidates.map(candidate => candidate.content).join('；'), {
          mode: 'strong', topK: 20, threshold: 0.25, scopeType: 'global', signal: options.signal,
          embedding: async (text, signal) => (await embeddingClient.embedding(text, signal)).embedding,
          embeddingModel: ai.getEmbeddingConfig()?.embeddingModel,
        })
        semanticIds = new Set(found.map(memory => memory.id))
      }
    }
  } catch { /* Lexical retrieval remains available if vector retrieval fails. */ }
  if (options.signal?.aborted || options.foregroundBusy()) return { kind: 'deferred' }
  const lists = candidates.map(candidate => existing.map(memory => ({ memory,
    score: lexicalMemorySimilarity(candidate.content + ' ' + candidate.factKey, memory.content + ' ' + (memory.factKey || ''))
      + (semanticIds.has(memory.id) ? 0.2 : 0) }))
    .sort((a, b) => b.score - a.score || b.memory.updatedAt - a.memory.updatedAt).slice(0, 8).map(({ memory }) => memory))
  const request: ModelRequest = { messages: [
    { role: 'system', content: '比较新提取的用户记忆与提供的已有记忆。逐项返回 JSON 数组，包含 index、action 和 targetId；action 为 add（无关）、duplicate（同义重复）、enrich（明确补充原事实）、coexist（不同事实可共存）、replace（明确改变旧事实）、review（不确定）。除 add 外 targetId 必须是该项提供的已有记忆 ID。enrich 必须另返回 content，保留新旧事实并简洁合并，不得臆造；不确定时使用 review。不要输出解释。' },
    { role: 'user', content: JSON.stringify(candidates.map((candidate, index) => ({ index, content: candidate.content,
      existing: lists[index].map(memory => ({ id: memory.id, content: memory.content })) }))) },
  ], temperature: 0.1, maxTokens: 800, reasoningMode: 'off' }
  if (new TextEncoder().encode(JSON.stringify(request)).length + 256 > 36_000) return { kind: 'retry' }
  const result = await call(request)
  if (result.kind !== 'response') return result
  try {
    const text = result.content.trim(), fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
    const parsed: unknown = JSON.parse(fenced ? fenced[1] : text)
    if (!Array.isArray(parsed) || parsed.length !== candidates.length) return { kind: 'retry' }
    const relations: MemoryRelation[] = Array(candidates.length)
    for (const value of parsed) {
      if (!value || typeof value !== 'object' || !Number.isSafeInteger(value.index) || value.index < 0 || value.index >= candidates.length
        || relations[value.index] || !['add', 'duplicate', 'enrich', 'coexist', 'replace', 'review'].includes(value.action)) return { kind: 'retry' }
      if (value.action !== 'add' && (typeof value.targetId !== 'string' || !lists[value.index].some(memory => memory.id === value.targetId))) return { kind: 'retry' }
      if (value.action === 'enrich' && (typeof value.content !== 'string' || value.content.trim().length < 6
        || Array.from(value.content.trim()).length > 80 || containsSensitiveMemoryText(value.content))) return { kind: 'retry' }
      relations[value.index] = { action: value.action, ...(value.action !== 'add' ? { targetId: value.targetId } : {}),
        ...(value.action === 'enrich' ? { content: value.content.trim() } : {}) }
    }
    return { kind: 'compared', relations }
  } catch { return { kind: 'retry' } }
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

/** One extraction and, for an entirely malformed v3 result, at most one durable format correction. */
export async function requestMemoryWindowProposals(claim: MemoryWindowClaim, packet: MemoryWindowPacket, memories: readonly Memory[],
  client: ModelClient, options: ModelOptions): Promise<ProposalResult> {
  if (!packet.needsModel) return { kind: 'noop' }
  if (options.signal?.aborted || options.foregroundBusy()) return { kind: 'deferred' }
  const prepared = preparePacket(claim, packet)
  const built = createMemoryWindowRequest(prepared.packet, prepared.scopeKey, memories)
  if (built.kind === 'oversize') return built
  let result = await callMemoryWindowModel(claim, built.request, client, options)
  if (result.kind !== 'response') return result
  const firstUsage = result.usage, firstElapsedMs = result.elapsedMs
  let parsed: ReturnType<typeof parseMemoryWindowCandidates> | null = null
  try {
    parsed = parseMemoryWindowCandidates(result.content, prepared.packet, prepared.scopeKey)
  } catch { /* A malformed JSON response can be corrected once. */ }
  const needsFormatRepair = !parsed || (parsed.candidates.length === 0 && parsed.rejections.length > 0
    && parsed.rejections.every(reason => reason === 'shape'))
  let formatRepaired = false
  if (packet.policyVersion === 3 && needsFormatRepair) {
    const correction: ModelRequest = { ...built.request, messages: [...built.request.messages, {
      role: 'user', content: '上次输出的 JSON 格式或字段类型无效。请重新按要求输出；confidence 必须是 0 至 1 的数字，禁止使用 high 等字符串。不要输出解释。',
    }] }
    if (new TextEncoder().encode(JSON.stringify(correction)).length + 256 <= 36_000) {
      const reservation = await reserveMemoryWindowFormatRepair(claim)
      if (reservation === 'lost_lease') return { kind: 'lost_lease' }
      if (reservation === 'reserved') {
        result = await callMemoryWindowModel(claim, correction, client, options)
        if (result.kind !== 'response') return result
        formatRepaired = true
        try { parsed = parseMemoryWindowCandidates(result.content, prepared.packet, prepared.scopeKey) }
        catch { return { kind: 'retry' } }
      }
    }
  }
  if (!parsed) return { kind: 'retry' }
  const usage = formatRepaired
    ? firstUsage && result.usage ? { promptTokens: firstUsage.promptTokens + result.usage.promptTokens,
      completionTokens: firstUsage.completionTokens + result.usage.completionTokens } : null
    : firstUsage
  return { kind: 'proposals', candidates: parsed.candidates, rejected: parsed.rejections.length, rejectionReasons: parsed.rejections,
    usage, elapsedMs: formatRepaired ? firstElapsedMs + result.elapsedMs : firstElapsedMs,
    ...(formatRepaired ? { formatRepaired: true } : {}) }
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
