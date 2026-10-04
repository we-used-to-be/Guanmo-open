export interface AiShortcutAction {
  id: string
  label: string
  prompt: string
  enabled: boolean
}

export const AI_SHORTCUT_LABEL_MAX_LENGTH = 12
export const AI_SHORTCUT_PROMPT_MAX_LENGTH = 1000

const DEFAULT_AI_SHORTCUT_ACTIONS: readonly AiShortcutAction[] = [
  { id: 'explain', label: '解释', prompt: '请解释这段内容', enabled: true },
  {
    id: 'explain-with-context',
    label: '结合上下文解释',
    prompt: '请结合上下文解释这段内容，优先读取选区附近内容，不要默认阅读全文',
    enabled: true,
  },
  { id: 'translate', label: '翻译', prompt: '翻译，直接输出译文，并在关键词或专业术语后用括号标注其音标，不要添加任何解释。', enabled: true },
  { id: 'web-search', label: '联网搜索', prompt: '联网搜索', enabled: true },
  { id: 'knowledge-search', label: '检索知识库相关内容', prompt: '检索知识库中与这有关的内容', enabled: true },
]

export function createDefaultAiShortcutActions(): AiShortcutAction[] {
  return DEFAULT_AI_SHORTCUT_ACTIONS.map((action) => ({ ...action }))
}

export function normalizeAiShortcutActions(value: unknown): AiShortcutAction[] {
  if (!Array.isArray(value)) return createDefaultAiShortcutActions()
  if (value.length === 0) return []

  const seenIds = new Set<string>()
  const normalized: AiShortcutAction[] = []

  for (const candidate of value) {
    if (!candidate || typeof candidate !== 'object') continue
    const record = candidate as Record<string, unknown>
    const id = typeof record.id === 'string' ? record.id.trim() : ''
    const label = typeof record.label === 'string' ? record.label.trim() : ''
    const prompt = typeof record.prompt === 'string' ? record.prompt.trim() : ''
    if (!id || !label || !prompt || seenIds.has(id)) continue

    seenIds.add(id)
    normalized.push({
      id,
      label: label.slice(0, AI_SHORTCUT_LABEL_MAX_LENGTH),
      prompt: prompt.slice(0, AI_SHORTCUT_PROMPT_MAX_LENGTH),
      enabled: typeof record.enabled === 'boolean' ? record.enabled : true,
    })
  }

  return normalized.length > 0 ? normalized : createDefaultAiShortcutActions()
}
