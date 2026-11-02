// Experimental, offline-only window construction. It does not write memories.
import { containsSensitiveMemoryText, isExplicitMemoryWriteIntent } from '../src/services/memory/memoryPolicy.ts'
import { TextEncoder } from 'node:util'

const transformation = /^(?:请|帮我|麻烦|能否)?(?:翻译|改写|润色|重写|总结|概括|解释|分析|生成|编写|仿写|创作|虚构|假设|举例)|^(?:引用|原文|文章|文档|书中|摘录|示例|小说|角色)(?:里|中|写|说|提到|内容|记录|[：:\s])|^[“「"]/
const refuses = /(?:不要|别|无需|不必|不用|禁止).{0,8}(?:记住|记下|记忆|保存)/
const maxSingleChars = 6000

export function buildExperimentalWindow(messages, { sessionId, scope, maxBytes = 12_000 }) {
  if (!sessionId || !Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error('invalid window parameters')
  const seen = new Map(), result = []
  let lastSequence = 0, users = 0
  for (const message of messages) {
    if (!message.id || seen.has(message.id) || message.sessionId !== sessionId || message.scope !== scope
      || !Number.isSafeInteger(message.sequence) || message.sequence <= lastSequence) throw new Error('invalid source boundary')
    if (!['user', 'assistant'].includes(message.role)) throw new Error('unsupported role')
    lastSequence = message.sequence
    if (message.role === 'user' && ++users > 6) throw new Error('too many user turns')
    // Callers must supply a separately validated visible snapshot; never fall back to raw content.
    const text = message.hidden ? '' : message.visibleText
    if (typeof text !== 'string') throw new Error('missing visible text')
    let reason = message.hidden ? 'hidden' : containsSensitiveMemoryText(text) ? 'sensitive'
      : refuses.test(text) ? 'refusal' : isExplicitMemoryWriteIntent(text) ? 'explicit'
        : transformation.test(text.trim()) ? 'transformation' : null
    if (message.role === 'assistant') {
      const parent = seen.get(message.parentId)
      if (!parent || parent.role !== 'user') throw new Error('assistant parent not in window')
      if (parent.reason) reason = 'parent_gap'
    }
    // Splitting long turns is intentionally not implemented in this prototype.
    if (!reason && text.length > maxSingleChars) return { status: 'oversize', window: null }
    const entry = reason ? { id: message.id, role: message.role, sequence: message.sequence, gap: reason }
      : { id: message.id, role: message.role, sequence: message.sequence, text,
        ...(message.role === 'assistant' ? { parentId: message.parentId } : {}) }
    seen.set(message.id, { role: message.role, reason })
    result.push(entry)
  }
  const encodedBytes = new TextEncoder().encode(JSON.stringify({ sessionId, scope, messages: result })).length
  return encodedBytes > maxBytes ? { status: 'oversize', window: null }
    : { status: 'ready', window: result, estimatedBytes: encodedBytes }
}

// Valid source IDs are necessary but never sufficient evidence for semantic truth.
export function validateExperimentalSources(window, candidates) {
  const sources = new Map(window.filter(message => typeof message.text === 'string').map(message => [message.id, message]))
  return candidates.map(candidate => {
    const primary = sources.get(candidate.primarySourceId)
    if (!primary || primary.role !== 'user') return { valid: false, reason: 'invalid_primary' }
    if (!Array.isArray(candidate.supportingSourceIds) || new Set(candidate.supportingSourceIds).size !== candidate.supportingSourceIds.length
      || candidate.supportingSourceIds.includes(candidate.primarySourceId)) return { valid: false, reason: 'invalid_support' }
    for (const id of candidate.supportingSourceIds) {
      const source = sources.get(id)
      if (!source || source.role === 'assistant' && source.sequence > primary.sequence) return { valid: false, reason: 'invalid_support' }
    }
    return { valid: true, needsReview: true }
  })
}
