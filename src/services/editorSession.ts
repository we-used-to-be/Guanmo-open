import type { ViewMode, ViewModeUsageStat } from '@/stores/editorStore'

export const SCROLL_SYNC_LOCK_MS = 220
export const MODE_PREWARM_IDLE_DELAY = 650
export const MODE_PREWARM_ACTIVITY_PAUSE = 1200
const MODE_PREWARM_HUGE_DOC_LENGTH = 100000
const MODE_PREWARM_DIFF_LINE_LIMIT = 900

export type ScrollSyncSource = 'editor' | 'preview'
export type PrewarmTargetMode = Exclude<ViewMode, 'edit'>
export type PrewarmedModeKeys = Partial<Record<PrewarmTargetMode, string>>

export interface ReadingPosition {
  editorScrollTop?: number
  previewScrollTop?: number
  topLine?: number
}

export class ReadingPositionSession {
  private positions: Record<string, ReadingPosition> = {}

  get(tabId: string | null | undefined): ReadingPosition | undefined {
    return tabId ? this.positions[tabId] : undefined
  }

  save(tabId: string, position: ReadingPosition): void {
    this.positions[tabId] = { ...this.positions[tabId], ...position }
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

export function scheduleIdlePrewarm(callback: () => void): void {
  const idleWindow = window as Window & {
    requestIdleCallback?: (cb: IdleRequestCallback, options?: IdleRequestOptions) => number
  }
  if (idleWindow.requestIdleCallback) {
    idleWindow.requestIdleCallback(callback, { timeout: 900 })
    return
  }
  window.setTimeout(callback, 120)
}
