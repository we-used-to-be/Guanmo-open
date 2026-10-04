import { getTool } from './toolRegistry'

export interface ParsedToolCall {
  name: string
  args: Record<string, unknown>
  rawJson: string
  actionMessage?: string
}

const ACTION_MESSAGE_MAX_LENGTH = 120

/**
 * 只接受短的单行纯文本过程说明，避免把 JSON、路径或大段模型输出带到用户界面。
 */
export function normalizeActionMessage(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const message = value.trim()
  if (
    !message
    || message.length > ACTION_MESSAGE_MAX_LENGTH
    || /[\r\n]/.test(message)
    || message.startsWith('```')
    || message.startsWith('{')
    || message.startsWith('[')
    || /(?:https?:\/\/|[A-Za-z]:[\\/]|\\\\|^\/)/.test(message)
  ) return undefined
  if (/"(?:tool|args|needsEditConfirmation|actionMessage)"\s*:/.test(message)) return undefined
  return message
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function getJsonCandidates(text: string): string[] {
  const candidates: string[] = []
  const codeBlockRegex = /```(?:json)?\s*\n?([\s\S]*?)\n?```/gi
  let blockMatch: RegExpExecArray | null

  while ((blockMatch = codeBlockRegex.exec(text))) {
    candidates.push(blockMatch[1].trim())
  }

  const source = candidates.length > 0 ? candidates.join('\n') : text
  let depth = 0
  let start = -1
  let inString = false
  let escaped = false

  for (let i = 0; i < source.length; i++) {
    const ch = source[i]

    if (inString) {
      if (escaped) {
        escaped = false
      } else if (ch === '\\') {
        escaped = true
      } else if (ch === '"') {
        inString = false
      }
      continue
    }

    if (ch === '"') {
      inString = true
    } else if (ch === '{') {
      if (depth === 0) start = i
      depth++
    } else if (ch === '}') {
      depth--
      if (depth === 0 && start >= 0) {
        candidates.push(source.slice(start, i + 1))
        start = -1
      }
    }
  }

  return Array.from(new Set(candidates.filter(Boolean)))
}

export function parseToolCall(text: string): ParsedToolCall | null {
  const trimmed = text.trim()
  if (!trimmed) return null

  for (const candidate of getJsonCandidates(trimmed)) {
    try {
      const parsed = JSON.parse(candidate)
      if (parsed.tool && typeof parsed.tool === 'string' && getTool(parsed.tool)) {
        return {
          name: parsed.tool,
          args: isRecord(parsed.args) ? parsed.args : {},
          rawJson: candidate,
          actionMessage: normalizeActionMessage(parsed.actionMessage),
        }
      }
      if (parsed.needsEditConfirmation === true) {
        return {
          name: 'replace_current_tab_text',
          args: {
            ...(typeof parsed.targetId === 'string' ? { targetId: parsed.targetId } : {}),
            ...(typeof parsed.oldText === 'string' ? { oldText: parsed.oldText } : {}),
            ...(typeof parsed.newText === 'string' ? { newText: parsed.newText } : {}),
            ...(typeof parsed.path === 'string' ? { path: parsed.path } : {}),
            ...(parsed.replaceWholeDocument === true ? { replaceWholeDocument: true } : {}),
            ...(typeof parsed.changeSummary === 'string' ? { changeSummary: parsed.changeSummary } : {}),
          },
          rawJson: candidate,
          actionMessage: normalizeActionMessage(parsed.actionMessage),
        }
      }
    } catch {
      // Try the next candidate.
    }
  }

  return null
}

export function stripToolCallJson(text: string): string {
  let clean = text

  for (const candidate of getJsonCandidates(text)) {
    try {
      const parsed = JSON.parse(candidate)
      if ((parsed.tool && typeof parsed.tool === 'string') || parsed.needsEditConfirmation === true) {
        clean = clean.replace(new RegExp('```(?:json)?\\s*\\n?' + escapeRegExp(candidate) + '\\n?```', 'g'), '')
        clean = clean.replace(candidate, '')
      }
    } catch {
      // Ignore invalid JSON fragments.
    }
  }

  return clean.trim()
}

export function hideLikelyToolJsonPrefix(text: string): string {
  const trimmed = text.trimStart()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('```')) return text
  const keyMatch = /^\{\s*["']?([A-Za-z]*)/.exec(trimmed)
  const firstKey = keyMatch?.[1]?.toLowerCase() || ''
  const afterBrace = trimmed.slice(1)
  const startsLikeJsonObject = afterBrace === '' || /^[\s"']/.test(afterBrace)
  const looksLikeStructuredToolCall = trimmed.startsWith('{') && (
    (startsLikeJsonObject && firstKey === '')
    || (firstKey.length > 0 && (
      'tool'.startsWith(firstKey)
      || firstKey.startsWith('tool')
      || 'needseditconfirmation'.startsWith(firstKey)
      || firstKey.startsWith('needseditconfirmation')
      || 'actionmessage'.startsWith(firstKey)
      || firstKey.startsWith('actionmessage')
    ))
  )
  const fencedBody = trimmed.replace(/^```(?:json)?\s*/i, '')
  const looksLikeFencedToolCall = trimmed.startsWith('```')
    && (fencedBody === '' || (fencedBody.startsWith('{') && (fencedBody.length === 1 || /^[\s"']/.test(fencedBody.slice(1)))))
  if (looksLikeStructuredToolCall || looksLikeFencedToolCall || /"(?:tool|actionMessage)"\s*:|needsEditConfirmation/.test(trimmed)) {
    const stripped = stripToolCallJson(text)
    return stripped === text.trim() ? '' : stripped
  }
  return text
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
