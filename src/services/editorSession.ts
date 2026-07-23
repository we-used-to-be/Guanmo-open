import type { ViewMode, ViewModeUsageStat } from '@/stores/editorStore'

export const SCROLL_SYNC_LOCK_MS = 220
export const MODE_PREWARM_IDLE_DELAY = 650
export const MODE_PREWARM_ACTIVITY_PAUSE = 1200
const MODE_PREWARM_HUGE_DOC_LENGTH = 100000
const MODE_PREWARM_DIFF_LINE_LIMIT = 900

// 资源策略常量
export const BALANCED_SMALL_DOC_TTL_MS = 45000
export const BALANCED_LARGE_DOC_THRESHOLD = 100000
export const BALANCED_LARGE_DOC_TTL_MS = 5000

export type ResourcePolicy = 'memory' | 'balanced' | 'speed'
export type InstanceType = 'editor' | 'preview' | 'diff'

export interface ResourceDecisionInput {
  policy: ResourcePolicy
  /** 当前活跃文档 ID */
  docId: string | null
  /** 候选实例关联的文档 ID */
  candidateDocId: string | null
  /** 候选实例对应文档的字符数 */
  docCharCount: number
  instanceType: InstanceType
  isCurrentlyVisible: boolean
  /** 最后一次真正可见或使用的时间（ms 时间戳） */
  lastUsedAt: number
  /** 当前时间 */
  now: number
  hasUncommittedDraft: boolean
}

export type ResourceDecision =
  | { action: 'keep' }
  | { action: 'keepUntil'; deadline: number }
  | { action: 'release' }

export function decideResource(input: ResourceDecisionInput): ResourceDecision {
  if (input.hasUncommittedDraft) return { action: 'keep' }
  if (input.isCurrentlyVisible) return { action: 'keep' }

  if (input.instanceType === 'diff') return { action: 'release' }

  // 不同文档：非 speed 策略释放
  if (input.docId && input.candidateDocId && input.docId !== input.candidateDocId) {
    return { action: 'release' }
  }

  switch (input.policy) {
    case 'memory':
      return { action: 'release' }

    case 'balanced': {
      const ttl = input.docCharCount >= BALANCED_LARGE_DOC_THRESHOLD
        ? BALANCED_LARGE_DOC_TTL_MS
        : BALANCED_SMALL_DOC_TTL_MS
      const deadline = input.lastUsedAt + ttl
      if (deadline <= input.now) return { action: 'release' }
      return { action: 'keepUntil', deadline }
    }

    case 'speed':
      return { action: 'keep' }

    default:
      return { action: 'release' }
  }
}

/** 切换文档时始终释放旧文档实例，所有策略统一。 */
export type ScrollSyncSource = 'editor' | 'preview'
export type PrewarmTargetMode = Exclude<ViewMode, 'edit'>
export type PrewarmedModeKeys = Partial<Record<PrewarmTargetMode, string>>

export interface ReadingPosition {
  editorScrollTop?: number
  previewScrollTop?: number
  topLine?: number
  /** 编辑器光标位置 */
  cursor?: number
  /** 编辑器主选区 {anchor, head} */
  selection?: { anchor: number; head: number }
  /** 编辑器多选区（含主选区），保留 anchor/head 方向 */
  ranges?: Array<{ anchor: number; head: number }>
  /** 主选区在 ranges 数组中的索引 */
  mainIndex?: number
}

export class ReadingPositionSession {
  private positions: Record<string, ReadingPosition> = {}

  get(tabId: string | null | undefined): ReadingPosition | undefined {
    return tabId ? this.positions[tabId] : undefined
  }

  getForPane(tabId: string | null | undefined, pane: 'left' | 'right'): ReadingPosition | undefined {
    return tabId ? this.positions[`${tabId}:${pane}`] : undefined
  }

  save(tabId: string, position: ReadingPosition): void {
    this.positions[tabId] = { ...this.positions[tabId], ...position }
  }

  saveForPane(tabId: string, pane: 'left' | 'right', position: ReadingPosition): void {
    const key = `${tabId}:${pane}`
    this.positions[key] = { ...this.positions[key], ...position }
  }
}

export class ScrollSyncSession {
  source: ScrollSyncSource | null = null
  private timer: number | null = null

  lock(source: ScrollSyncSource): void {
    this.source = source
    if (this.timer !== null) window.clearTimeout(this.timer)
    this.timer = window.setTimeout(() => {
      this.source = null
      this.timer = null
    }, SCROLL_SYNC_LOCK_MS)
  }

  dispose(): void {
    if (this.timer !== null) window.clearTimeout(this.timer)
    this.timer = null
    this.source = null
  }
}

export function getNextPrewarmTarget({
  activeMode,
  contentLength,
  diffLineCount,
  level,
  resolveKey,
  warmedKeys,
  usage,
}: {
  activeMode: ViewMode
  contentLength: number
  diffLineCount: number
  level: 'smart' | 'turbo'
  resolveKey: (mode: PrewarmTargetMode) => string | null
  warmedKeys: Set<string>
  usage: Partial<Record<PrewarmTargetMode, ViewModeUsageStat>>
}): PrewarmTargetMode | null {
  const extraCount = level === 'smart' ? 1 : 2
  const targets: PrewarmTargetMode[] = ['preview']
  if (contentLength < MODE_PREWARM_HUGE_DOC_LENGTH) {
    targets.push(...getFrequentPrewarmModes(usage).slice(0, extraCount))
  }
  for (const target of targets) {
    if (target === activeMode) continue
    if (target === 'diff-preview' && diffLineCount > MODE_PREWARM_DIFF_LINE_LIMIT) continue
    const key = resolveKey(target)
    if (key && !warmedKeys.has(key)) return target
  }
  return null
}

function getFrequentPrewarmModes(
  usage: Partial<Record<PrewarmTargetMode, ViewModeUsageStat>>
): PrewarmTargetMode[] {
  const fallbackOrder: PrewarmTargetMode[] = ['edit-preview', 'dual-preview', 'diff-preview']
  return fallbackOrder
    .map((mode, index) => ({ mode, index, count: usage[mode]?.count ?? 0, lastUsedAt: usage[mode]?.lastUsedAt ?? 0 }))
    .sort((a, b) => b.count - a.count || b.lastUsedAt - a.lastUsedAt || a.index - b.index)
    .map((item) => item.mode)
}

export function scheduleIdlePrewarm(callback: () => void): () => void {
  const idleWindow = window as Window & {
    requestIdleCallback?: (cb: IdleRequestCallback, options?: IdleRequestOptions) => number
    cancelIdleCallback?: (id: number) => void
  }
  if (idleWindow.requestIdleCallback) {
    const id = idleWindow.requestIdleCallback(callback, { timeout: 900 })
    return () => {
      if (idleWindow.cancelIdleCallback) idleWindow.cancelIdleCallback(id)
    }
  }
  const id = window.setTimeout(callback, 120)
  return () => window.clearTimeout(id)
}
