import type { ActionProposal, ActionProposalKind, EditConfirmation } from '@/services/ai/types'

const ACTION_PROPOSAL_VERSION = 1 as const
const ACTION_PROPOSAL_TTL_MS = 15 * 60 * 1000
const ARTIFACT_TYPES = ['summary', 'question_set', 'annotation', 'note'] as const
const MEMORY_CATEGORIES = ['preference', 'project', 'learning', 'profile', 'instruction'] as const

type PendingActionPayload = Omit<ActionProposal, 'id' | 'messageId' | 'status' | 'createdAt' | 'expiresAt' | 'updatedAt'>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function decodeEditConfirmation(value: unknown): EditConfirmation | undefined {
  if (
    !isRecord(value)
    || typeof value.id !== 'string'
    || typeof value.oldText !== 'string'
    || typeof value.newText !== 'string'
    || typeof value.tabId !== 'string'
    || typeof value.tabTitle !== 'string'
    || !['pending', 'applied', 'rejected'].includes(String(value.status))
  ) return undefined
  return {
    id: value.id,
    messageId: typeof value.messageId === 'string' ? value.messageId : undefined,
    oldText: value.oldText,
    newText: value.newText,
    tabId: value.tabId,
    tabTitle: value.tabTitle,
    replaceFrom: typeof value.replaceFrom === 'number' ? value.replaceFrom : undefined,
    replaceTo: typeof value.replaceTo === 'number' ? value.replaceTo : undefined,
    replaceWholeDocument: typeof value.replaceWholeDocument === 'boolean' ? value.replaceWholeDocument : undefined,
    changeSummary: typeof value.changeSummary === 'string' ? value.changeSummary : undefined,
    selectionFrom: typeof value.selectionFrom === 'number' ? value.selectionFrom : undefined,
    selectionTo: typeof value.selectionTo === 'number' ? value.selectionTo : undefined,
    status: value.status as EditConfirmation['status'],
  }
}

function requiredString(value: unknown, field: string, maxLength = 20_000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength) {
    throw new Error(`行动提案字段 ${field} 无效`)
  }
  return value.trim()
}

function optionalString(value: unknown, field: string, maxLength = 20_000): string | undefined {
  if (value === undefined) return undefined
  return requiredString(value, field, maxLength)
}

function assertAllowedKeys(payload: Record<string, unknown>, keys: readonly string[]) {
  const allowed = new Set(keys)
  const invalid = Object.keys(payload).find((key) => !allowed.has(key))
  if (invalid) throw new Error(`行动提案包含未注册字段 ${invalid}`)
}

function decodePayload(kind: ActionProposalKind, value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error('行动提案 payload 无效')
  if (kind === 'save_memory') {
    assertAllowedKeys(value, ['content', 'category'])
    const category = optionalString(value.category, 'category', 32) ?? 'preference'
    if (!MEMORY_CATEGORIES.includes(category as typeof MEMORY_CATEGORIES[number])) {
      throw new Error('行动提案记忆分类无效')
    }
    return { content: requiredString(value.content, 'content', 4_000), category }
  }
  if (kind === 'save_reading_artifact') {
    assertAllowedKeys(value, ['artifactType', 'title', 'content', 'sourceMessageId'])
    const artifactType = requiredString(value.artifactType, 'artifactType', 32)
    if (!ARTIFACT_TYPES.includes(artifactType as typeof ARTIFACT_TYPES[number])) {
      throw new Error('行动提案成果类型无效')
    }
    return {
      artifactType,
      title: requiredString(value.title, 'title', 200),
      content: requiredString(value.content, 'content'),
      ...(optionalString(value.sourceMessageId, 'sourceMessageId', 200)
        ? { sourceMessageId: optionalString(value.sourceMessageId, 'sourceMessageId', 200) }
        : {}),
    }
  }
  if (kind === 'create_markdown_note') {
    assertAllowedKeys(value, ['title', 'content', 'sourceMessageId'])
    return {
      title: requiredString(value.title, 'title', 200),
      content: requiredString(value.content, 'content'),
      ...(optionalString(value.sourceMessageId, 'sourceMessageId', 200)
        ? { sourceMessageId: optionalString(value.sourceMessageId, 'sourceMessageId', 200) }
        : {}),
    }
  }
  assertAllowedKeys(value, ['title', 'description', 'dueAt', 'timezone', 'sourceMessageId'])
  const dueAt = requiredString(value.dueAt, 'dueAt', 64)
  const computerTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone
  const explicitTimezone = optionalString(value.timezone, 'timezone', 100)
  const timezone = explicitTimezone ?? computerTimezone
  const hasOffset = /(?:Z|[+-]\d{2}:\d{2})$/i.test(dueAt)
  if (!hasOffset && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?$/i.test(dueAt)) {
    throw new Error('行动提案提醒时间必须是明确的 ISO 日期时间')
  }
  if (!hasOffset && explicitTimezone && explicitTimezone !== computerTimezone) {
    throw new Error('非电脑时区的提醒时间必须包含明确时区偏移')
  }
  const dueTime = Date.parse(dueAt)
  if (!Number.isFinite(dueTime) || dueTime <= Date.now()) {
    throw new Error('行动提案提醒时间必须晚于当前时间')
  }
  try {
    new Intl.DateTimeFormat('zh-CN', { timeZone: timezone }).format(dueTime)
  } catch {
    throw new Error('行动提案提醒时区无效')
  }
  return {
    title: requiredString(value.title, 'title', 200),
    ...(optionalString(value.description, 'description', 2_000) ? { description: optionalString(value.description, 'description', 2_000) } : {}),
    dueAt: new Date(dueTime).toISOString(),
    timezone,
    ...(optionalString(value.sourceMessageId, 'sourceMessageId', 200)
      ? { sourceMessageId: optionalString(value.sourceMessageId, 'sourceMessageId', 200) }
      : {}),
  }
}

const ACTION_META: Record<ActionProposalKind, Omit<PendingActionPayload, 'payload' | 'preview' | 'title' | 'target'>> = {
  save_memory: {
    version: ACTION_PROPOSAL_VERSION,
    kind: 'save_memory',
    effect: 'write_local',
    capability: 'memory',
    reversible: false,
    reversibleDescription: '保存后可在记忆管理中手动删除',
    riskDescription: '会把确认内容持久化到本地长期记忆',
  },
  save_reading_artifact: {
    version: ACTION_PROPOSAL_VERSION,
    kind: 'save_reading_artifact',
    effect: 'write_local',
    capability: 'reading_artifact',
    reversible: true,
    reversibleDescription: '可在阅读成果中删除',
    riskDescription: '会向本地 SQLite 写入一条阅读成果',
  },
  create_markdown_note: {
    version: ACTION_PROPOSAL_VERSION,
    kind: 'create_markdown_note',
    effect: 'write_local',
    capability: 'markdown_file',
    reversible: false,
    reversibleDescription: '保存后需在文件系统中手动删除',
    riskDescription: '确认后仍需在系统保存对话框中选择 Markdown 目标',
  },
  create_reading_reminder: {
    version: ACTION_PROPOSAL_VERSION,
    kind: 'create_reading_reminder',
    effect: 'schedule',
    capability: 'reading_reminder',
    reversible: true,
    reversibleDescription: '可在提醒列表中取消',
    riskDescription: '会创建一次性本地提醒并可能请求系统通知权限',
  },
}

export function buildPendingActionResult(
  kind: ActionProposalKind,
  payload: Record<string, unknown>,
  display: { title: string; target: string; preview: string },
): string {
  const decodedPayload = decodePayload(kind, payload)
  const target = kind === 'create_reading_reminder'
    ? new Intl.DateTimeFormat('zh-CN', {
        timeZone: String(decodedPayload.timezone),
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        weekday: 'short',
        hour: '2-digit',
        minute: '2-digit',
      }).format(new Date(String(decodedPayload.dueAt)))
    : requiredString(display.target, 'target', 200)
  return JSON.stringify({
    __pendingAction: true,
    ...ACTION_META[kind],
    title: requiredString(display.title, 'title', 200),
    target,
    preview: requiredString(display.preview, 'preview', 2_000),
    payload: decodedPayload,
  })
}

export function decodePendingAction(value: unknown): PendingActionPayload | undefined {
  if (!isRecord(value) || value.__pendingAction !== true) return undefined
  const kind = value.kind
  if (typeof kind !== 'string' || !(kind in ACTION_META)) {
    throw new Error('行动提案类型未注册')
  }
  const registered = ACTION_META[kind as ActionProposalKind]
  if (
    value.version !== ACTION_PROPOSAL_VERSION
    || value.effect !== registered.effect
    || value.capability !== registered.capability
    || value.reversible !== registered.reversible
  ) throw new Error('行动提案能力声明无效')
  return {
    ...registered,
    title: requiredString(value.title, 'title', 200),
    target: requiredString(value.target, 'target', 200),
    preview: requiredString(value.preview, 'preview', 2_000),
    payload: decodePayload(kind as ActionProposalKind, value.payload),
  }
}

export function createActionProposal(
  pending: PendingActionPayload,
  options: { id: string; messageId?: string; now?: number; memoryScopeKey?: string | null },
): ActionProposal {
  const now = options.now ?? Date.now()
  return {
    id: options.id,
    messageId: options.messageId,
    ...pending,
    ...(pending.kind === 'save_memory' && options.memoryScopeKey !== undefined ? { memoryScopeKey: options.memoryScopeKey } : {}),
    createdAt: now,
    expiresAt: now + ACTION_PROPOSAL_TTL_MS,
    updatedAt: now,
    status: 'pending',
  }
}

export function decodeActionProposal(value: unknown): ActionProposal | undefined {
  if (!isRecord(value)) return undefined
  const pending = decodePendingAction({ ...value, __pendingAction: true })
  if (!pending) return undefined
  if (value.memoryScopeKey !== undefined && value.memoryScopeKey !== null
    && (typeof value.memoryScopeKey !== 'string' || value.memoryScopeKey.length > 4000)) throw new Error('记忆作用域无效')
  const statuses: ActionProposal['status'][] = ['pending', 'executing', 'completed', 'rejected', 'expired', 'failed']
  if (
    typeof value.id !== 'string'
    || typeof value.createdAt !== 'number'
    || typeof value.expiresAt !== 'number'
    || typeof value.updatedAt !== 'number'
    || !statuses.includes(value.status as ActionProposal['status'])
  ) throw new Error('行动提案持久化状态无效')
  const errorCategories: NonNullable<ActionProposal['errorCategory']>[] = [
    'invalid', 'expired', 'target_changed', 'cancelled', 'execution_failed', 'unsupported',
  ]
  const errorCategory = typeof value.errorCategory === 'string'
    && errorCategories.includes(value.errorCategory as NonNullable<ActionProposal['errorCategory']>)
    ? value.errorCategory as NonNullable<ActionProposal['errorCategory']>
    : undefined
  const status = value.status === 'executing' ? 'failed' : value.status as ActionProposal['status']
  return {
    id: value.id,
    messageId: typeof value.messageId === 'string' ? value.messageId : undefined,
    ...pending,
    ...(pending.kind === 'save_memory' && value.memoryScopeKey !== undefined ? { memoryScopeKey: value.memoryScopeKey as string | null } : {}),
    createdAt: value.createdAt,
    expiresAt: value.expiresAt,
    updatedAt: value.updatedAt,
    status,
    errorCategory: value.status === 'executing' ? 'execution_failed' : errorCategory,
  }
}
