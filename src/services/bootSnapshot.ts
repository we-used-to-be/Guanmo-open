import type { ReadingPosition } from '@/services/editorSession'
import type { Tab, ViewMode } from '@/stores/editorStore'
import { isWebRuntime } from '@/services/runtimeCapabilities'

export const BOOT_SNAPSHOT_STORAGE_KEY = 'guanmo-boot-snapshot'
export const BOOT_SNAPSHOT_VERSION = 1
export const BOOT_SNAPSHOT_CONTENT_LIMIT = 256_000

export interface BootSnapshot {
  version: typeof BOOT_SNAPSHOT_VERSION
  capturedAt: number
  activeTab: {
    id: string
    title: string
    filePath: string
    content: string | null
  } | null
  viewMode: ViewMode
  readingPosition: ReadingPosition | null
}

interface BootSnapshotState {
  tabs: Tab[]
  activeTabId: string | null
  viewMode: ViewMode
  readingPositions: Record<string, ReadingPosition>
}

let cachedSnapshot: BootSnapshot | null | undefined
let pendingSnapshot: BootSnapshot | null = null
let writeTimer: ReturnType<typeof setTimeout> | null = null

function isViewMode(value: unknown): value is ViewMode {
  return value === 'edit'
    || value === 'preview'
    || value === 'edit-preview'
    || value === 'dual-preview'
    || value === 'diff-preview'
}

export function parseBootSnapshot(raw: string | null): BootSnapshot | null {
  if (!raw) return null
  try {
    const value = JSON.parse(raw) as Partial<BootSnapshot>
    const activeTab = value.activeTab
    if (value.version !== BOOT_SNAPSHOT_VERSION || !isViewMode(value.viewMode)) return null
    if (activeTab !== null && (
      !activeTab
      || typeof activeTab.id !== 'string'
      || typeof activeTab.title !== 'string'
      || typeof activeTab.filePath !== 'string'
      || (activeTab.content !== null && typeof activeTab.content !== 'string')
      || (typeof activeTab.content === 'string' && activeTab.content.length > BOOT_SNAPSHOT_CONTENT_LIMIT)
    )) return null
    return value as BootSnapshot
  } catch {
    return null
  }
}

export function createBootSnapshot(state: BootSnapshotState): BootSnapshot {
  const activeTab = state.tabs.find((tab) => tab.id === state.activeTabId)
  const snapshotTab = activeTab?.filePath && !activeTab.modified
    ? {
        id: activeTab.id,
        title: activeTab.title,
        filePath: activeTab.filePath,
        content: activeTab.content.length <= BOOT_SNAPSHOT_CONTENT_LIMIT
          ? activeTab.content
          : null,
      }
    : null
  return {
    version: BOOT_SNAPSHOT_VERSION,
    capturedAt: Date.now(),
    activeTab: snapshotTab,
    viewMode: state.viewMode,
    readingPosition: activeTab
      ? state.readingPositions[`${activeTab.id}:left`] ?? state.readingPositions[activeTab.id] ?? null
      : null,
  }
}

export function applyBootSnapshot(tabs: Tab[], activeTabId: string | null, snapshot: BootSnapshot | null): Tab[] {
  if (!snapshot?.activeTab || snapshot.activeTab.id !== activeTabId || snapshot.activeTab.content === null) {
    return tabs
  }
  const snapshotTab = snapshot.activeTab
  const snapshotContent = snapshotTab.content as string
  return tabs.map((tab) => {
    if (
      tab.id !== snapshotTab.id
      || tab.filePath !== snapshotTab.filePath
      || tab.modified
    ) return tab
    return {
      ...tab,
      title: snapshotTab.title,
      content: snapshotContent,
      savedContent: snapshotContent,
      originalContent: snapshotContent,
      modified: false,
    }
  })
}

export function readBootSnapshot(): BootSnapshot | null {
  if (isWebRuntime()) return null
  if (cachedSnapshot !== undefined) return cachedSnapshot
  if (typeof localStorage === 'undefined') return null
  const raw = localStorage.getItem(BOOT_SNAPSHOT_STORAGE_KEY)
  cachedSnapshot = parseBootSnapshot(raw)
  if (raw && !cachedSnapshot) localStorage.removeItem(BOOT_SNAPSHOT_STORAGE_KEY)
  return cachedSnapshot
}

export function hasBootSnapshotContent(tab: Tab): boolean {
  const snapshot = readBootSnapshot()
  return Boolean(
    snapshot?.activeTab
    && snapshot.activeTab.id === tab.id
    && snapshot.activeTab.filePath === tab.filePath
    && snapshot.activeTab.content === tab.content,
  )
}

export function flushBootSnapshotWrite(): void {
  if (isWebRuntime()) {
    pendingSnapshot = null
    return
  }
  if (writeTimer !== null) {
    clearTimeout(writeTimer)
    writeTimer = null
  }
  if (!pendingSnapshot || typeof localStorage === 'undefined') return
  cachedSnapshot = pendingSnapshot
  localStorage.setItem(BOOT_SNAPSHOT_STORAGE_KEY, JSON.stringify(pendingSnapshot))
  pendingSnapshot = null
}

export function scheduleBootSnapshotWrite(snapshot: BootSnapshot): void {
  if (isWebRuntime()) return
  pendingSnapshot = snapshot
  if (writeTimer !== null) clearTimeout(writeTimer)
  writeTimer = setTimeout(flushBootSnapshotWrite, 250)
}

export function resetBootSnapshotCacheForTest(): void {
  cachedSnapshot = undefined
  pendingSnapshot = null
  if (writeTimer !== null) clearTimeout(writeTimer)
  writeTimer = null
}
