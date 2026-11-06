import { containsForbiddenMemorySecret, containsSensitiveMemoryText, validateMemoryCandidate } from './memoryPolicy'
import type { MemoryWindowPacket, MemoryWindowTurn } from './memoryWindowInput'

const categories = ['preference', 'project', 'learning', 'profile', 'instruction'] as const
type Category = typeof categories[number]
type Rejection = 'shape' | 'source' | 'sensitive' | 'scope' | 'unsupported_value' | 'content_mismatch' | 'undecided' | 'negation' | 'policy'

export interface MemoryWindowCandidate {
  content: string
  category: Category
  kind: 'semantic' | 'episodic'
  scope: 'global' | 'project'
  primarySourceId: string
  supportingSourceIds: string[]
  subject: string
  factKey: string
  factValue: string
  evidenceQuote?: string
  semanticReview?: boolean
  confidence: number
  sensitivity?: 'normal' | 'sensitive'
  segmented: boolean
  /** Valid IDs and literal values do not establish semantic correctness. */
  requiresSemanticReview: true
}

const indecision = /(?:还没|尚未|没有|没|未曾|暂未|暂不|尚不).{0,6}(?:决定|确定|选择|选定|选好|定下来)|(?:不|没有).{0,4}(?:决定|确定|选好)/
const acceptance = /(?:选择|选用|选|确定|决定|定|采用|使用|用|同意|就|前者|后者|前一|后一|第[一二三四1-4]|那个|这样|习惯|偏好|更喜欢)/
const negative = /(?:不喜欢|不使用|不用|不采用|不需要|不要|不允许|不支持|不选择|不喝|不吃|不愿|不想|不去|不做|不能|不会|禁止|禁用|无需|不再)/
const crossProject = /(?:其他|其它|所有|后续|以后|今后|未来|每个|任何).{0,8}(?:项目|工程|工作区)|\b(?:all|future|other|every)\s+(?:projects?|workspaces?)\b/i
const projectSpecific = /(?:本项目|当前项目|这个项目|该项目|本工程|本工作区|this\s+(?:project|workspace))/i
const documentSpecific = /(?:这篇|本文|这份文档|当前文档|这个文件|该文件|上述文章|此文档|this\s+(?:document|file|article))/i

function sameText(haystack: string, needle: string): boolean {
  return haystack.toLowerCase().includes(needle.toLowerCase())
}

function validateItem(item: unknown, packet: MemoryWindowPacket, scopeKey: string | null): MemoryWindowCandidate | Rejection {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return 'shape'
  const raw = item as Record<string, unknown>
  if (typeof raw.content !== 'string' || typeof raw.category !== 'string' || !categories.includes(raw.category as Category)
    || !['semantic', 'episodic'].includes(String(raw.kind)) || !['global', 'project'].includes(String(raw.scope))
    || typeof raw.primarySourceId !== 'string' || !Array.isArray(raw.supportingSourceIds)
    || raw.supportingSourceIds.length > 11 || raw.supportingSourceIds.some(id => typeof id !== 'string')
    || typeof raw.subject !== 'string' || !raw.subject.trim() || raw.subject.length > 80
    || typeof raw.factKey !== 'string' || !raw.factKey.trim() || raw.factKey.length > 80
    || typeof raw.factValue !== 'string' || !raw.factValue.trim() || raw.factValue.length > 160
    || typeof raw.confidence !== 'number' || !Number.isFinite(raw.confidence) || raw.confidence < 0 || raw.confidence > 1
    || packet.policyVersion === 3 && !['normal', 'sensitive'].includes(String(raw.sensitivity))) return 'shape'
  const content = raw.content.trim(), value = raw.factValue.trim(), primaryId = raw.primarySourceId
  // The primary source is already carried separately; remove only its redundant
  // repetition before running the same attribution checks on all other IDs.
  const supportIds = packet.policyVersion === 3
    ? (raw.supportingSourceIds as string[]).filter(id => id !== primaryId)
    : raw.supportingSourceIds as string[]
  if (new Set(supportIds).size !== supportIds.length || supportIds.includes(primaryId)) return 'source'
  const turns = packet.turns.filter(turn => typeof turn.text === 'string')
  const matches = turns.filter(turn => turn.id === primaryId && turn.role === 'user' && !turn.contextOnly)
  if (matches.length !== 1 || !packet.newSourceIds.includes(primaryId)) return 'source'
  const primary = matches[0], primaryIndex = turns.indexOf(primary)
  const supports: MemoryWindowTurn[] = []
  for (const id of supportIds) {
    const candidates = turns.filter(turn => turn.id === id)
    if (candidates.length !== 1 || turns.indexOf(candidates[0]) > primaryIndex) return 'source'
    supports.push(candidates[0])
  }
  for (const turn of supports) {
    if (turn.role === 'assistant' && (!turn.parentId || !supportIds.includes(turn.parentId)
      || !supports.some(parent => parent.id === turn.parentId && parent.role === 'user'))) return 'source'
  }
  const visibleEvidence = [primary, ...supports].map(turn => turn.text!)
  const userEvidence = [primary, ...supports.filter(turn => turn.role === 'user')].map(turn => turn.text!)
  if (visibleEvidence.some(containsForbiddenMemorySecret)
    || [content, value, raw.subject, raw.factKey].some(text => containsForbiddenMemorySecret(text as string))) return 'sensitive'
  if (Number(packet.policyVersion) === 3) {
    if (scopeKey !== null || raw.scope !== 'global' || raw.category === 'project') return 'scope'
    if (Array.from(content).length < 6 || Array.from(content).length > 80) return 'shape'
    const reviewableSensitive = visibleEvidence.some(containsSensitiveMemoryText)
      || [content, value, raw.subject, raw.factKey].some(text => containsSensitiveMemoryText(text as string))
    return { content, category: raw.category, kind: raw.kind, scope: raw.scope, primarySourceId: primaryId,
      supportingSourceIds: supportIds, subject: raw.subject.trim(), factKey: raw.factKey.trim(), factValue: value,
      confidence: raw.confidence, sensitivity: raw.sensitivity === 'sensitive' || reviewableSensitive ? 'sensitive' : 'normal',
      segmented: packet.segmentedSourceIds.includes(primaryId), requiresSemanticReview: true } as MemoryWindowCandidate
  }
  if (indecision.test(primary.text!)) return 'undecided'
  if (!sameText(primary.text!, value) && supports.some(turn => turn.role === 'assistant' && sameText(turn.text!, value))
    && !acceptance.test(primary.text!)) return 'unsupported_value'
  const valueSupported = visibleEvidence.some(text => sameText(text, value))
  const primarySupported = sameText(primary.text!, value) || acceptance.test(primary.text!)
  const contentSupported = sameText(content, value)
  // An exact keyword alone cannot establish that every assertion in the
  // paraphrase is supported; only a directly traceable summary can auto-activate.
  // Keep the first-person subject when comparing the summary to the user turn;
  // dropping it would make “我姐姐是摄影师” appear to support “用户是摄影师”.
  const directSummary = content.replace(/^用户/, '我').replace(/[。！？!?]+$/, '').trim()
  const directSummarySupported = Boolean(directSummary) && sameText(primary.text!, directSummary)
  const acceptedAssistant = /(?:同意|接受|就用|就按|选这个|选第|按你说的|按这个|以后就|没错|确实|是的|i agree|use that|choose that)/i.test(primary.text!)
    && supports.some(turn => turn.role === 'assistant' && sameText(turn.text!, value))
  const semanticReview = packet.policyVersion === 3 && (/现在/.test(content) || !valueSupported || !primarySupported || !contentSupported
    || sameText(primary.text!, value) && !directSummarySupported && !acceptedAssistant)
  const modelQuote = raw.evidenceQuote
  if (semanticReview && modelQuote !== undefined && (typeof modelQuote !== 'string' || !modelQuote.trim()
    || modelQuote.length > 1200 || !primary.text!.includes(modelQuote) || containsForbiddenMemorySecret(modelQuote))) {
    return !valueSupported || !primarySupported ? 'unsupported_value' : 'content_mismatch'
  }
  // Use the complete visible user turn, not a selectively cropped excerpt, so
  // the user can judge context and negation when confirming the candidate.
  const evidenceQuote = semanticReview && primary.text!.length <= 1200 ? primary.text : undefined
  if (semanticReview && !evidenceQuote) return !valueSupported || !primarySupported ? 'unsupported_value' : 'content_mismatch'
  if (!semanticReview && !valueSupported) return 'unsupported_value'
  if (!semanticReview && !primarySupported) return 'unsupported_value'
  if (!semanticReview && !contentSupported) return 'content_mismatch'
  if (userEvidence.some(text => negative.test(text)) !== negative.test(content)) return 'negation'
  if (raw.scope === 'project' && (scopeKey === null || crossProject.test(content))) return 'scope'
  if (packet.policyVersion === 3 && (scopeKey !== null || raw.scope !== 'global' || raw.category === 'project'
    || projectSpecific.test(content) || documentSpecific.test(content)
    || userEvidence.some(text => projectSpecific.test(text) || documentSpecific.test(text)))) return 'scope'
  if (raw.scope === 'global' && (raw.category === 'project' || projectSpecific.test(content) || documentSpecific.test(content)
    || userEvidence.some(text => projectSpecific.test(text) || documentSpecific.test(text)))) return 'scope'
  const reviewableSensitive = visibleEvidence.some(containsSensitiveMemoryText)
    || [content, value, raw.subject, raw.factKey].some(text => containsSensitiveMemoryText(text as string))
  const sensitivity = packet.policyVersion === 3 && raw.sensitivity === 'sensitive' || reviewableSensitive ? 'sensitive' : 'normal'
  const candidate = { content, category: raw.category, kind: raw.kind, scope: raw.scope, primarySourceId: primaryId,
    supportingSourceIds: supportIds, subject: raw.subject.trim(), factKey: raw.factKey.trim(), factValue: value,
    confidence: raw.confidence, sensitivity, segmented: packet.segmentedSourceIds.includes(primaryId), requiresSemanticReview: true,
    ...(semanticReview ? { semanticReview: true, evidenceQuote } : {}) } as MemoryWindowCandidate
  if (!validateMemoryCandidate(candidate, { allowSensitive: packet.policyVersion === 3 && sensitivity === 'sensitive',
    allowCurrentForReview: Boolean(semanticReview) }).valid) return 'policy'
  return candidate
}

/** Parses proposals only; accepted items are not permission to persist without semantic validation. */
export function parseMemoryWindowCandidates(text: string, packet: MemoryWindowPacket, scopeKey: string | null): {
  candidates: MemoryWindowCandidate[]; rejections: Rejection[]; reasons?: string
} {
  const trimmed = text.trim(), fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  const parsed: unknown = JSON.parse(fenced ? fenced[1] : trimmed)
  const object = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null
  const items = object ? object.candidates : parsed
  if (!Array.isArray(items) || items.length > 6) throw new Error('invalid_memory_window_model_output')
  const reason = typeof object?.reasons === 'string' ? object.reasons.trim() : ''
  const reasons = reason && reason.length <= 200 && !containsForbiddenMemorySecret(reason) && !containsSensitiveMemoryText(reason)
    ? reason : undefined
  const candidates: MemoryWindowCandidate[] = [], rejections: Rejection[] = []
  for (const item of items) {
    const checked = validateItem(item, packet, scopeKey)
    if (typeof checked === 'string') rejections.push(checked)
    else candidates.push(checked)
  }
  return { candidates, rejections, ...(reasons ? { reasons } : {}) }
}
