import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/hooks/useTauri', () => ({
  isTauri: () => true,
}))

import {
  BOOT_SNAPSHOT_CONTENT_LIMIT,
  BOOT_SNAPSHOT_STORAGE_KEY,
  BOOT_SNAPSHOT_VERSION,
  applyBootSnapshot,
  createBootSnapshot,
  readBootSnapshot,
  resetBootSnapshotCacheForTest,
} from '@/services/bootSnapshot'
import type { Tab } from '@/stores/editorStore'

function tab(overrides: Partial<Tab> = {}): Tab {
  return {
    id: 'active',
    title: 'active.md',
    filePath: 'D:\\notes\\active.md',
    content: '# cached',
    savedContent: '# cached',
    originalContent: '# cached',
    modified: false,
    ...overrides,
  }
}

beforeEach(() => {
  localStorage.clear()
  resetBootSnapshotCacheForTest()
})

describe('boot snapshot', () => {
  it('stores only the active disk document and essential first-screen state', () => {
    const snapshot = createBootSnapshot({
      tabs: [tab(), tab({ id: 'other', filePath: null, content: 'draft', modified: true })],
      activeTabId: 'active',
      viewMode: 'preview',
      readingPositions: { active: { editorScrollTop: 120 } },
    })

    expect(snapshot.activeTab?.content).toBe('# cached')
    expect(snapshot.viewMode).toBe('preview')
    expect(snapshot.readingPosition?.editorScrollTop).toBe(120)
  })

  it('drops large document bodies while keeping metadata for disk fallback', () => {
    const snapshot = createBootSnapshot({
      tabs: [tab({ content: 'x'.repeat(BOOT_SNAPSHOT_CONTENT_LIMIT + 1) })],
      activeTabId: 'active',
      viewMode: 'edit',
      readingPositions: {},
    })

    expect(snapshot.activeTab?.content).toBeNull()
  })

  it('applies matching cached content without touching modified or mismatched tabs', () => {
    const snapshot = createBootSnapshot({
      tabs: [tab()],
      activeTabId: 'active',
      viewMode: 'edit',
      readingPositions: {},
    })
    const compacted = tab({ content: '', savedContent: '', originalContent: '' })

    expect(applyBootSnapshot([compacted], 'active', snapshot)[0].content).toBe('# cached')
    expect(applyBootSnapshot([{ ...compacted, modified: true }], 'active', snapshot)[0].content).toBe('')
    expect(applyBootSnapshot([{ ...compacted, filePath: 'D:\\other.md' }], 'active', snapshot)[0].content).toBe('')
  })

  it('rejects corrupt and incompatible snapshots', () => {
    localStorage.setItem(BOOT_SNAPSHOT_STORAGE_KEY, '{broken')
    expect(readBootSnapshot()).toBeNull()
    expect(localStorage.getItem(BOOT_SNAPSHOT_STORAGE_KEY)).toBeNull()

    resetBootSnapshotCacheForTest()
    localStorage.setItem(BOOT_SNAPSHOT_STORAGE_KEY, JSON.stringify({
      version: BOOT_SNAPSHOT_VERSION + 1,
      viewMode: 'edit',
      activeTab: null,
    }))
    expect(readBootSnapshot()).toBeNull()
  })

  it('rejects snapshot bodies above the startup content limit', () => {
    localStorage.setItem(BOOT_SNAPSHOT_STORAGE_KEY, JSON.stringify({
      version: BOOT_SNAPSHOT_VERSION,
      capturedAt: Date.now(),
      viewMode: 'edit',
      readingPosition: null,
      activeTab: {
        id: 'active',
        title: 'active.md',
        filePath: 'D:\\notes\\active.md',
        content: 'x'.repeat(BOOT_SNAPSHOT_CONTENT_LIMIT + 1),
      },
    }))

    expect(readBootSnapshot()).toBeNull()
    expect(localStorage.getItem(BOOT_SNAPSHOT_STORAGE_KEY)).toBeNull()
  })

  it('does not duplicate unsaved tabs into the snapshot', () => {
    const snapshot = createBootSnapshot({
      tabs: [tab({ filePath: null, content: 'unsaved', modified: true })],
      activeTabId: 'active',
      viewMode: 'edit',
      readingPositions: {},
    })
    expect(snapshot.activeTab).toBeNull()
  })
})
