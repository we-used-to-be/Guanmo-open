import { act, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EditorSelection } from '@codemirror/state'

// Mock IntersectionObserver for jsdom
if (typeof IntersectionObserver === 'undefined') {
  globalThis.IntersectionObserver = class IntersectionObserver {
    constructor(_callback: IntersectionObserverCallback, _options?: IntersectionObserverInit) { }
    observe() { }
    unobserve() { }
    disconnect() { }
    takeRecords(): IntersectionObserverEntry[] { return [] }
    root: Element | null = null
    rootMargin = ''
    thresholds: ReadonlyArray<number> = []
  } as unknown as typeof IntersectionObserver
}

// Mock ResizeObserver for jsdom (CodeMirror might use it)
if (typeof ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class ResizeObserver {
    constructor(_callback: ResizeObserverCallback) { }
    observe() { }
    unobserve() { }
    disconnect() { }
  } as unknown as typeof ResizeObserver
}

const lifecycle = vi.hoisted(() => ({
  events: [] as Array<{ type: string; metadata?: Record<string, unknown> }>,
}))

const scheduledCallbacks = vi.hoisted(() => ({
  raf: new Set<number>(),
  idle: new Set<number>(),
  rafTimers: new Map<number, number>(),
  idleTimers: new Map<number, number>(),
}))

// Capture EditorView instances for real CodeMirror tests
const capturedViews = vi.hoisted(() => {
  const views: Array<{ editor: unknown }> = []
  return { views }
})

// Mock replaceMarkdownBlock for pending/conflict tests
const replaceMarkdownBlockMock = vi.hoisted(() => vi.fn())

vi.mock('@/hooks/useActiveHeading', () => ({ useActiveHeading: () => null }))
vi.mock('@/hooks/useTauri', () => ({ isTauri: false, openFileDialog: vi.fn(), openUrl: vi.fn() }))
vi.mock('@/services/fileSystem', () => ({ saveFile: vi.fn(), saveFileAs: vi.fn() }))
vi.mock('@/services/rag/indexer', () => ({ scheduleMarkdownDocumentIndex: vi.fn() }))
vi.mock('@/services/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}))
vi.mock('@/services/eventMarker', () => ({
  eventMarker: {
    start: vi.fn(),
    mark: vi.fn((type: string, metadata?: Record<string, unknown>) => {
      lifecycle.events.push({ type, metadata })
    }),
  },
}))
vi.mock('@/services/aiContext', () => ({ addSelectionContextTag: vi.fn(), setAiShortcutPrompt: vi.fn() }))
vi.mock('@/services/editorViewRef', () => ({
  setActiveEditorView: vi.fn((view: unknown) => {
    if (view) capturedViews.views.push({ editor: view })
  }),
  getActiveEditorView: vi.fn(() => {
    const last = capturedViews.views[capturedViews.views.length - 1]
    return last?.editor ?? null
  }),
}))
vi.mock('@/services/markdownImages', () => ({
  saveExternalImageForMarkdown: vi.fn(),
  saveImageFileForMarkdown: vi.fn(),
}))
vi.mock('@/hooks/useFileOperations', () => ({
  useFileOperations: () => ({ handleNewFile: vi.fn(), handleOpenFile: vi.fn() }),
}))
vi.mock('@/services/fileOperationErrors', () => ({ describeFileOperationError: vi.fn(() => 'anonymous error') }))
vi.mock('@tauri-apps/api/core', () => ({ convertFileSrc: vi.fn((src: string) => src) }))

vi.mock('@/services/markdownBlocks', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/markdownBlocks')>()
  return {
    ...actual,
    replaceMarkdownBlock: replaceMarkdownBlockMock,
  }
})

import { EditorArea } from '@/components/editor/EditorArea'
import { useEditorStore, type Tab, type ViewMode } from '@/stores/editorStore'
import { useSettingsStore } from '@/stores/settingsStore'
import {
  BALANCED_LARGE_DOC_TTL_MS,
  BALANCED_SMALL_DOC_TTL_MS,
  MODE_PREWARM_ACTIVITY_PAUSE,
} from '@/services/editorSession'

function anonymousTab(id: string, content: string): Tab {
  return {
    id,
    title: `anonymous-${id}.md`,
    filePath: null,
    content,
    savedContent: content,
    originalContent: content,
    modified: false,
  }
}

function setup(tabs: Tab[], activeTabId: string, viewMode: ViewMode, options?: {
  modePerformancePolicy?: 'memory' | 'balanced' | 'speed'
}) {
  useEditorStore.setState({
    tabs,
    activeTabId,
    viewMode,
    rightPaneTabId: null,
    rightPaneUserSelected: false,
    viewModeUsage: {},
    previewVisible: false,
    previewSwitchingTabId: null,
    pendingReveal: null,
    recentFiles: [],
    favorites: [],
  })
  const policy = options?.modePerformancePolicy ?? 'balanced'
  useSettingsStore.setState((state) => ({
    editor: {
      ...state.editor,
      inlinePreviewEdit: true,
      modePerformancePolicy: policy,
    },
  }))
}

function countEvent(type: string) {
  return lifecycle.events.filter((e) => e.type === type).length
}

function countResourceEvent(type: string, resource: string, documentKey?: string) {
  return lifecycle.events.filter((event) => (
    event.type === type &&
    event.metadata?.resource === resource &&
    (documentKey === undefined || event.metadata?.documentKey === documentKey)
  )).length
}

function resourceBalance(resource: 'editor' | 'left-preview' | 'right-preview' | 'diff') {
  if (resource === 'editor') {
    return countResourceEvent('editor-create', resource) - countResourceEvent('editor-dispose', resource)
  }
  if (resource === 'diff') {
    return countResourceEvent('diff-create', resource) - countResourceEvent('diff-dispose', resource)
  }
  return countResourceEvent('model-create', resource) - countResourceEvent('model-dispose', resource)
}

async function waitForAsyncCommit(expectedCalls: number) {
  await act(async () => {
    await vi.dynamicImportSettled()
    await vi.waitFor(() => {
      expect(replaceMarkdownBlockMock).toHaveBeenCalledTimes(expectedCalls)
    })
  })
}

async function settleLazyEditorModules() {
  await act(async () => {
    await vi.dynamicImportSettled()
    await Promise.resolve()
  })
  await act(async () => {
    await vi.dynamicImportSettled()
  })
  // 阶段 2：预热只允许从真实编辑器/预览首屏回调之后开始计时。
  act(() => vi.advanceTimersByTime(1))
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'Date'] })
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
  scheduledCallbacks.raf.clear()
  scheduledCallbacks.idle.clear()
  scheduledCallbacks.rafTimers.clear()
  scheduledCallbacks.idleTimers.clear()
  let nextHandle = 1
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((fn: FrameRequestCallback) => {
    const handle = nextHandle++
    scheduledCallbacks.raf.add(handle)
    const timer = window.setTimeout(() => {
      scheduledCallbacks.raf.delete(handle)
      scheduledCallbacks.rafTimers.delete(handle)
      fn(performance.now())
    }, 0)
    scheduledCallbacks.rafTimers.set(handle, timer)
    return handle
  })
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((handle: number) => {
    scheduledCallbacks.raf.delete(handle)
    const timer = scheduledCallbacks.rafTimers.get(handle)
    if (timer !== undefined) window.clearTimeout(timer)
    scheduledCallbacks.rafTimers.delete(handle)
  })
  if ('requestIdleCallback' in window) {
    vi.spyOn(window as any, 'requestIdleCallback').mockImplementation((fn: (...args: any[]) => void) => {
      const handle = nextHandle++
      scheduledCallbacks.idle.add(handle)
      const timer = window.setTimeout(() => {
        scheduledCallbacks.idle.delete(handle)
        scheduledCallbacks.idleTimers.delete(handle)
        fn({ didTimeout: false, timeRemaining: () => 50 })
      }, 0)
      scheduledCallbacks.idleTimers.set(handle, timer)
      return handle
    })
  }
  if ('cancelIdleCallback' in window) {
    vi.spyOn(window as any, 'cancelIdleCallback').mockImplementation((handle: number) => {
      scheduledCallbacks.idle.delete(handle)
      const timer = scheduledCallbacks.idleTimers.get(handle)
      if (timer !== undefined) window.clearTimeout(timer)
      scheduledCallbacks.idleTimers.delete(handle)
    })
  }
  lifecycle.events.length = 0
  capturedViews.views.length = 0
  replaceMarkdownBlockMock.mockReset()
  // Default: replaceMarkdownBlock returns applied
  replaceMarkdownBlockMock.mockImplementation((content: string, _block: unknown, draft: string) => {
    const block = _block as { startOffset: number; endOffset: number; rawSource: string }
    const newContent = content.slice(0, block.startOffset) + draft + content.slice(block.endOffset)
    return { status: 'applied' as const, content: newContent }
  })
})

afterEach(() => {
  vi.useRealTimers()
})

// ============================================================
// 1. Real component TTL evidence
// ============================================================
describe('Real component TTL lifecycle', () => {
  it('balanced small doc stays mounted for 45s then disposes via real create/dispose events', async () => {
    setup([anonymousTab('doc-a', '# Small')], 'doc-a', 'edit-preview')
    render(<EditorArea />)
    await settleLazyEditorModules()

    expect(resourceBalance('left-preview')).toBe(1)

    act(() => useEditorStore.getState().setViewMode('edit'))
    act(() => vi.advanceTimersByTime(BALANCED_SMALL_DOC_TTL_MS - 1))
    expect(countEvent('model-dispose')).toBe(0)

    act(() => vi.advanceTimersByTime(1))
    expect(countEvent('model-dispose')).toBeGreaterThanOrEqual(1)
    expect(resourceBalance('left-preview')).toBe(0)
  })

  it('balanced 100000-char doc stays mounted for 5s then disposes', async () => {
    const content = 'x'.repeat(100000)
    setup([anonymousTab('doc-big', content)], 'doc-big', 'edit-preview')
    render(<EditorArea />)
    await settleLazyEditorModules()

    act(() => useEditorStore.getState().setViewMode('edit'))
    act(() => vi.advanceTimersByTime(BALANCED_LARGE_DOC_TTL_MS - 1))
    expect(countEvent('model-dispose')).toBe(0)

    act(() => vi.advanceTimersByTime(1))
    expect(countEvent('model-dispose')).toBeGreaterThanOrEqual(1)
  })

  it('rerenders do not reset or cancel TTL', async () => {
    setup([anonymousTab('doc-a', '# Small')], 'doc-a', 'edit-preview')
    const result = render(<EditorArea />)
    await settleLazyEditorModules()

    act(() => useEditorStore.getState().setViewMode('edit'))
    act(() => vi.advanceTimersByTime(10000))
    // Rerender should not affect TTL
    result.rerender(<EditorArea />)
    act(() => vi.advanceTimersByTime(BALANCED_SMALL_DOC_TTL_MS - 10000))
    expect(countEvent('model-dispose')).toBeGreaterThanOrEqual(1)
  })

  it('showing a hidden preview again cancels its old TTL', async () => {
    setup([anonymousTab('doc-a', '# Small')], 'doc-a', 'edit-preview')
    render(<EditorArea />)
    await settleLazyEditorModules()

    act(() => useEditorStore.getState().setViewMode('edit'))
    act(() => vi.advanceTimersByTime(10000))
    act(() => useEditorStore.getState().setViewMode('edit-preview'))
    act(() => vi.advanceTimersByTime(BALANCED_SMALL_DOC_TTL_MS))

    // preview was hidden but still mounted (balanced keeps it), so prewarm
    // doesn't create a duplicate; balance stays at 1
    expect(resourceBalance('left-preview')).toBe(1)
    expect(countResourceEvent('model-dispose', 'left-preview', 'doc-a')).toBe(0)

    act(() => useEditorStore.getState().setViewMode('edit'))
    act(() => vi.advanceTimersByTime(BALANCED_SMALL_DOC_TTL_MS))
    // 2 creates (initial + prewarm), 1 dispose (TTL) = balance 1
    expect(resourceBalance('left-preview')).toBe(1)
  })

  it('switching policy cancels the old balanced TTL', async () => {
    setup([anonymousTab('doc-a', '# Small')], 'doc-a', 'edit-preview')
    render(<EditorArea />)
    await settleLazyEditorModules()

    act(() => useEditorStore.getState().setViewMode('edit'))
    act(() => vi.advanceTimersByTime(10000))
    act(() => useSettingsStore.getState().updateEditorSettings({ modePerformancePolicy: 'memory' }))

    expect(countResourceEvent('model-dispose', 'left-preview', 'doc-a')).toBe(1)
    act(() => vi.advanceTimersByTime(BALANCED_SMALL_DOC_TTL_MS))
    expect(countResourceEvent('model-dispose', 'left-preview', 'doc-a')).toBe(1)
  })
})

// ============================================================
// 2. Real right preview pending/conflict integration
// ============================================================
describe('Right preview pending/conflict', () => {
  /** Find a block in the right preview pane (second scrollable preview in dual-preview). */
  function altClickRightBlock(container: HTMLElement, blockIndex: number) {
    const panes = container.querySelectorAll('.overflow-y-auto.select-text.bg-gm-surface')
    // In dual-preview mode the right pane is the second scrollable preview.
    const rightPane = panes[panes.length - 1] as HTMLElement | undefined
    if (!rightPane) throw new Error('Right preview pane not found')
    const wrapper = rightPane.querySelector(`[data-md-block-index="${blockIndex}"]`)
    if (!wrapper) throw new Error(`Block ${blockIndex} not found in right pane`)
    fireEvent.pointerDown(wrapper, { altKey: true, pointerId: 1, clientX: 10, clientY: 10 })
    fireEvent.pointerUp(wrapper, { altKey: true, pointerId: 1, clientX: 10, clientY: 10 })
    fireEvent.click(wrapper, { altKey: true, clientX: 10, clientY: 10 })
  }

  it('pending onBlockCommit: right preview is not unmounted when leaving dual-preview', async () => {
    // Setup a resolve function to control the promise
    let resolveCommit: ((value: { status: 'applied'; content: string }) => void) | null = null
    replaceMarkdownBlockMock.mockImplementation(() => {
      return new Promise<{ status: 'applied'; content: string }>((resolve) => {
        resolveCommit = resolve
      })
    })

    const tabs = [anonymousTab('doc-a', '# Left\n\nParagraph A'), anonymousTab('doc-b', '# Right\n\nParagraph B')]
    setup(tabs, 'doc-a', 'dual-preview', { modePerformancePolicy: 'balanced' })
    useEditorStore.setState({ rightPaneTabId: 'doc-b', rightPaneUserSelected: true })
    const { container } = render(<EditorArea />)
    await settleLazyEditorModules()

    // Verify right preview is mounted
    expect(countEvent('model-create')).toBeGreaterThanOrEqual(1)

    // Alt+click to enter block editing in right preview
    altClickRightBlock(container, 0)

    // Click outside to trigger submit
    fireEvent.pointerDown(document.body, { pointerId: 2, clientX: 500, clientY: 500 })
    await act(() => vi.advanceTimersByTime(100))
    await waitForAsyncCommit(1)
    expect(replaceMarkdownBlockMock).toHaveBeenCalledTimes(1)

    // Switch away from dual-preview (draft is pending, so right preview should stay)
    act(() => useEditorStore.getState().setViewMode('preview'))
    act(() => vi.advanceTimersByTime(BALANCED_SMALL_DOC_TTL_MS))

    // Right preview should NOT be disposed (draft is pending)
    const rightDisposes = lifecycle.events.filter(
      (e) => e.type === 'model-dispose' && e.metadata?.documentKey === 'doc-b'
    ).length
    expect(rightDisposes).toBe(0)

    // Resolve the pending commit
    await act(async () => {
      resolveCommit?.({ status: 'applied', content: '# Right\n\nParagraph B' })
      await vi.advanceTimersByTime(100)
    })
    expect(replaceMarkdownBlockMock).toHaveBeenCalledTimes(1)

    // After resolution, draft ends and release should happen
    act(() => vi.advanceTimersByTime(BALANCED_SMALL_DOC_TTL_MS))
    expect(countEvent('model-dispose')).toBeGreaterThanOrEqual(1)
  })

  it('conflict onBlockCommit: right preview and draft retained, released after successful commit', async () => {
    replaceMarkdownBlockMock.mockReturnValue({ status: 'conflict' as const, currentSource: '# Right\n\nParagraph B' })

    const tabs = [anonymousTab('doc-a', '# Left\n\nParagraph A'), anonymousTab('doc-b', '# Right\n\nParagraph B')]
    setup(tabs, 'doc-a', 'dual-preview', { modePerformancePolicy: 'memory' })
    useEditorStore.setState({ rightPaneTabId: 'doc-b', rightPaneUserSelected: true })
    const { container } = render(<EditorArea />)
    await settleLazyEditorModules()

    // Alt+click to enter block editing in right preview
    altClickRightBlock(container, 0)

    // Click outside to trigger submit
    fireEvent.pointerDown(document.body, { pointerId: 2, clientX: 500, clientY: 500 })
    await act(() => vi.advanceTimersByTime(100))
    await waitForAsyncCommit(1)
    expect(replaceMarkdownBlockMock).toHaveBeenCalledTimes(1)
    await act(async () => {
      await vi.waitFor(() => {
        expect(container.querySelector('.gm-inline-markdown-editor--conflict')).not.toBeNull()
      })
    })

    // Switch away from dual-preview (memory policy = immediate release)
    act(() => useEditorStore.getState().setViewMode('preview'))
    await act(() => vi.advanceTimersByTime(100))

    // Right preview should NOT be disposed (conflict = draft retained)
    const rightDisposes = lifecycle.events.filter(
      (e) => e.type === 'model-dispose' && e.metadata?.documentKey === 'doc-b'
    ).length
    expect(rightDisposes).toBe(0)

    // Now make commit succeed
    replaceMarkdownBlockMock.mockReturnValue({ status: 'applied' as const, content: '# Right\n\nModified' })
    // Click outside again to re-submit
    fireEvent.pointerDown(document.body, { pointerId: 3, clientX: 500, clientY: 500 })
    await act(() => vi.advanceTimersByTime(500))
    await waitForAsyncCommit(2)
    expect(replaceMarkdownBlockMock).toHaveBeenCalledTimes(2)

    // After successful commit, draft ends and release should happen
    act(() => vi.advanceTimersByTime(100))
    const rightDisposesAfter = lifecycle.events.filter(
      (e) => e.type === 'model-dispose' && e.metadata?.documentKey === 'doc-b'
    ).length
    expect(rightDisposesAfter).toBeGreaterThanOrEqual(1)
  })

  it('memory policy: draft blocks immediate release, release after draft ends', async () => {
    let resolveCommit: ((value: { status: 'applied'; content: string }) => void) | null = null
    replaceMarkdownBlockMock.mockImplementation(() => {
      return new Promise<{ status: 'applied'; content: string }>((resolve) => {
        resolveCommit = resolve
      })
    })

    const tabs = [anonymousTab('doc-a', '# Left\n\nParagraph A'), anonymousTab('doc-b', '# Right\n\nParagraph B')]
    setup(tabs, 'doc-a', 'dual-preview', { modePerformancePolicy: 'memory' })
    useEditorStore.setState({ rightPaneTabId: 'doc-b', rightPaneUserSelected: true })
    const { container } = render(<EditorArea />)
    await settleLazyEditorModules()

    altClickRightBlock(container, 0)
    fireEvent.pointerDown(document.body, { pointerId: 2, clientX: 500, clientY: 500 })
    await act(() => vi.advanceTimersByTime(100))
    await waitForAsyncCommit(1)

    // Switch away (memory = immediate)
    act(() => useEditorStore.getState().setViewMode('preview'))
    await act(() => vi.advanceTimersByTime(100))

    // Draft blocks release
    const rightDisposes = lifecycle.events.filter(
      (e) => e.type === 'model-dispose' && e.metadata?.documentKey === 'doc-b'
    ).length
    expect(rightDisposes).toBe(0)

    // Resolve
    await act(async () => {
      resolveCommit?.({ status: 'applied', content: '# Right\n\nParagraph B' })
      await vi.advanceTimersByTime(100)
    })
    const rightDisposesAfter = lifecycle.events.filter(
      (e) => e.type === 'model-dispose' && e.metadata?.documentKey === 'doc-b'
    ).length
    expect(rightDisposesAfter).toBeGreaterThanOrEqual(1)
  })
})

// ============================================================
// 3. 100000-char loop test with real create/dispose balance
// ============================================================
describe('Large document lifecycle balance', () => {
  it('create/dispose balance across repeated 100000-char mode/document switches with balanced policy', async () => {
    const tabs = [
      anonymousTab('doc-a', 'a'.repeat(100000)),
      anonymousTab('doc-b', 'b'.repeat(100000)),
    ]
    setup(tabs, 'doc-a', 'edit-preview', { modePerformancePolicy: 'balanced' })
    const result = render(<EditorArea />)
    await settleLazyEditorModules()

    const modes: ViewMode[] = ['edit', 'edit-preview', 'preview', 'dual-preview', 'diff-preview', 'edit-preview', 'edit']
    const docs = ['doc-a', 'doc-b', 'doc-a', 'doc-b', 'doc-a', 'doc-b', 'doc-a']
    const timerBaselines = new Map<ViewMode, number>()

    for (let round = 0; round < 1; round++) {
      for (let i = 0; i < modes.length; i++) {
        act(() => {
          useEditorStore.getState().setActiveTab(docs[i])
          useEditorStore.getState().setViewMode(modes[i])
        })
        await settleLazyEditorModules()
        act(() => vi.advanceTimersByTime(BALANCED_LARGE_DOC_TTL_MS + 100))
        act(() => vi.advanceTimersByTime(1))

        // Balanced smart + large doc: no hidden preview prewarm.
        // left-preview is 1 only when visible (preview/edit-preview/dual-preview).
        const expected = {
          editor: modes[i] === 'edit' || modes[i] === 'edit-preview' ? 1 : 0,
          'left-preview': modes[i] === 'preview' || modes[i] === 'edit-preview' || modes[i] === 'dual-preview' ? 1 : 0,
          'right-preview': modes[i] === 'dual-preview' ? 1 : 0,
          diff: modes[i] === 'diff-preview' ? 1 : 0,
        }
        expect(resourceBalance('editor'), `round ${round}/${i} editor`).toBe(expected.editor)
        expect(resourceBalance('left-preview'), `round ${round}/${i} left preview`).toBe(expected['left-preview'])
        expect(resourceBalance('right-preview'), `round ${round}/${i} right preview`).toBe(expected['right-preview'])
        expect(resourceBalance('diff'), `round ${round}/${i} diff`).toBe(expected.diff)
        const timerCount = vi.getTimerCount()
        const timerBaseline = timerBaselines.get(modes[i])
        if (timerBaseline === undefined) timerBaselines.set(modes[i], timerCount)
        else expect(timerCount, `round ${round}/${i} timers`).toBeLessThanOrEqual(timerBaseline)
        expect(scheduledCallbacks.idle.size, `round ${round}/${i} idle callbacks`).toBe(0)
        expect(scheduledCallbacks.raf.size, `round ${round}/${i} animation frames`).toBe(0)
      }
    }

    // Unmount should clean up
    result.unmount()
    act(() => vi.runAllTimers())
    expect(resourceBalance('editor')).toBe(0)
    expect(resourceBalance('left-preview')).toBe(0)
    expect(resourceBalance('right-preview')).toBe(0)
    expect(resourceBalance('diff')).toBe(0)
    expect(scheduledCallbacks.idle.size).toBe(0)
    expect(scheduledCallbacks.raf.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  }, 15000)

  it('old document callbacks do not release new document instances', async () => {
    const tabs = [
      anonymousTab('doc-a', 'a'.repeat(100000)),
      anonymousTab('doc-b', 'b'.repeat(100000)),
    ]
    // balanced policy: large doc TTL = 5s
    setup(tabs, 'doc-a', 'edit-preview', { modePerformancePolicy: 'balanced' })
    const result = render(<EditorArea />)
    await settleLazyEditorModules()

    // Switch to doc-b — doc-a's instances start their 5s TTL
    act(() => {
      useEditorStore.getState().setActiveTab('doc-b')
    })
    // Advance past doc-a's TTL
    act(() => vi.advanceTimersByTime(BALANCED_LARGE_DOC_TTL_MS + 100))

    // doc-b should still be visible (its own TTL hasn't started)
    expect(resourceBalance('editor')).toBe(1)
    // doc-a's dispose should have happened
    expect(countEvent('model-dispose')).toBeGreaterThanOrEqual(1)
    // doc-b's preview should still be alive
    expect(resourceBalance('left-preview')).toBe(1)

    result.unmount()
    act(() => vi.runAllTimers())
  })
})

// ============================================================
// 4. Smart/turbo candidate coverage
// ============================================================
describe('Prewarm candidate lifecycle', () => {
  it.each(['balanced', 'speed'] as const)('restores %s prewarm after switching preview tabs and ignores the old schedule', async (policy) => {
    setup([
      anonymousTab('doc-a', '# A'),
      anonymousTab('doc-b', '# B'),
    ], 'doc-a', 'preview', { modePerformancePolicy: policy })
    render(<EditorArea />)
    await settleLazyEditorModules()

    const initialSchedules = lifecycle.events.filter((event) => event.type === 'prewarm-schedule')
    const oldScheduleId = initialSchedules.at(-1)?.metadata?.scheduleId
    expect(oldScheduleId).toBeTruthy()

    act(() => useEditorStore.getState().setActiveTab('doc-b'))
    await settleLazyEditorModules()

    const switchedSchedules = lifecycle.events.filter((event) => event.type === 'prewarm-schedule')
    const newScheduleId = switchedSchedules.at(-1)?.metadata?.scheduleId
    expect(newScheduleId).toBeTruthy()
    expect(newScheduleId).not.toBe(oldScheduleId)

    act(() => vi.advanceTimersByTime(2500))
    await settleLazyEditorModules()

    const prewarmCreates = lifecycle.events.filter((event) => (
      event.type === 'prewarm-create' && event.metadata?.resource === 'editor'
    ))
    expect(prewarmCreates).toHaveLength(1)
    expect(prewarmCreates[0].metadata?.scheduleId).toBe(newScheduleId)
    expect(countResourceEvent('editor-create', 'editor', 'doc-a')).toBe(0)
    expect(countResourceEvent('editor-create', 'editor', 'doc-b')).toBe(1)
  })

  it('does not prewarm after a preview tab switch under the memory policy', async () => {
    setup([
      anonymousTab('doc-a', '# A'),
      anonymousTab('doc-b', '# B'),
    ], 'doc-a', 'preview', { modePerformancePolicy: 'memory' })
    render(<EditorArea />)
    await settleLazyEditorModules()

    act(() => useEditorStore.getState().setActiveTab('doc-b'))
    await settleLazyEditorModules()
    act(() => vi.advanceTimersByTime(2500))

    expect(lifecycle.events.some((event) => event.type === 'prewarm-schedule')).toBe(false)
    expect(countResourceEvent('editor-create', 'editor', 'doc-b')).toBe(0)
  })

  it('smart creates real left preview candidate', async () => {
    setup([anonymousTab('doc-a', '# A')], 'doc-a', 'edit', { modePerformancePolicy: 'balanced' })
    render(<EditorArea />)

    // 首屏真实可见回调尚未 flush 时，不得创建隐藏预览。
    expect(countResourceEvent('model-create', 'left-preview', 'doc-a')).toBe(0)
    await settleLazyEditorModules()

    // No preview yet
    expect(countEvent('model-create')).toBeGreaterThanOrEqual(1) // editor

    // Wait for prewarm timer + idle callback
    act(() => vi.advanceTimersByTime(2500))
    // Preview candidate should be created
    expect(countEvent('model-create')).toBeGreaterThanOrEqual(2)
  })

  it('turbo creates editor candidate based on usage', async () => {
    // Preview mode: editor is not initially mounted (editorMounted=false).
    // turbo prewarms edit-preview based on high usage, creating the editor.
    setup([anonymousTab('doc-a', '# A')], 'doc-a', 'preview', { modePerformancePolicy: 'speed' })
    useEditorStore.setState({
      viewModeUsage: { 'edit-preview': { count: 15, lastUsedAt: Date.now() } },
    })
    render(<EditorArea />)
    await settleLazyEditorModules()

    // Editor not mounted initially in preview-only mode
    expect(countEvent('editor-create')).toBe(0)

    act(() => vi.advanceTimersByTime(2500))
    // turbo prewarms edit-preview (editor) based on usage
    expect(countEvent('editor-create')).toBeGreaterThanOrEqual(1)
  })

  it('turbo creates right preview candidate', async () => {
    const tabs = [anonymousTab('doc-a', '# A'), anonymousTab('doc-b', '# B')]
    setup(tabs, 'doc-a', 'edit', { modePerformancePolicy: 'speed' })
    useEditorStore.setState({
      viewModeUsage: { 'dual-preview': { count: 20, lastUsedAt: Date.now() } },
    })
    useEditorStore.setState({ rightPaneTabId: 'doc-b', rightPaneUserSelected: true })
    render(<EditorArea />)
    await settleLazyEditorModules()

    act(() => vi.advanceTimersByTime(2500))
    act(() => vi.advanceTimersByTime(2500))
    expect(countResourceEvent('model-create', 'right-preview', 'doc-b')).toBe(1)
  })

  it('turbo creates diff candidate and releases it', async () => {
    setup([anonymousTab('doc-a', '# A')], 'doc-a', 'preview', { modePerformancePolicy: 'speed' })
    useEditorStore.setState({
      viewModeUsage: { 'diff-preview': { count: 12, lastUsedAt: Date.now() } },
    })
    render(<EditorArea />)
    await settleLazyEditorModules()

    expect(countEvent('diff-create')).toBe(0)

    act(() => vi.advanceTimersByTime(2500))
    await act(async () => {
      await vi.dynamicImportSettled()
    })
    // Flush RAF
    act(() => vi.advanceTimersByTime(1))
    expect(countEvent('diff-create')).toBeGreaterThanOrEqual(1)
    // Diff should be released after RAF
    act(() => vi.advanceTimersByTime(1))
    expect(countEvent('diff-dispose')).toBeGreaterThanOrEqual(1)
  })

  it('prewarm-off releases all hidden candidates', async () => {
    setup([anonymousTab('doc-a', '# A')], 'doc-a', 'edit', { modePerformancePolicy: 'balanced' })
    render(<EditorArea />)
    await settleLazyEditorModules()

    act(() => vi.advanceTimersByTime(2500))
    expect(countResourceEvent('model-create', 'left-preview', 'doc-a')).toBe(1)

    act(() => useSettingsStore.getState().updateEditorSettings({ modePerformancePolicy: 'memory' }))
    expect(countResourceEvent('model-dispose', 'left-preview', 'doc-a')).toBe(1)
  })

  it('user activity cancels idle prewarm', () => {
    setup([anonymousTab('doc-a', '# A')], 'doc-a', 'edit', { modePerformancePolicy: 'balanced' })
    render(<EditorArea />)

    // 先完成真实编辑器首屏，再在空闲窗口内模拟用户活动。
    act(() => vi.advanceTimersByTime(1))

    // Trigger user activity before prewarm timer fires
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' })))
    act(() => vi.advanceTimersByTime(2500))

    // No prewarm should have happened
    const modelCreates = countEvent('model-create')
    expect(modelCreates).toBeGreaterThanOrEqual(1) // editor only
    // Should not have a preview model-create
    expect(modelCreates).toBeLessThanOrEqual(1)
    const cancelled = lifecycle.events.find((event) => (
      event.type === 'prewarm-cancel' && event.metadata?.reason === 'user-activity'
    ))
    const scheduled = lifecycle.events.find((event) => (
      event.type === 'prewarm-schedule' &&
      event.metadata?.scheduleId === cancelled?.metadata?.scheduleId
    ))
    expect(cancelled?.metadata).toMatchObject({
      reason: 'user-activity',
      scheduleId: scheduled?.metadata?.scheduleId,
      target: scheduled?.metadata?.target,
    })
  })

  it('unmount cancels a pending prewarm before it creates a hidden resource', async () => {
    setup([anonymousTab('doc-a', '# A')], 'doc-a', 'edit', { modePerformancePolicy: 'balanced' })
    const result = render(<EditorArea />)
    await settleLazyEditorModules()

    expect(countResourceEvent('model-create', 'left-preview', 'doc-a')).toBe(0)

    act(() => vi.advanceTimersByTime(MODE_PREWARM_ACTIVITY_PAUSE - 1))
    result.unmount()
    act(() => vi.runAllTimers())

    expect(countResourceEvent('model-create', 'left-preview', 'doc-a')).toBe(0)
    expect(scheduledCallbacks.idle.size).toBe(0)
    expect(scheduledCallbacks.raf.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('leaving diff releases diff instance', async () => {
    setup([anonymousTab('doc-a', '# A')], 'doc-a', 'diff-preview', { modePerformancePolicy: 'memory' })
    render(<EditorArea />)
    await settleLazyEditorModules()

    expect(countEvent('diff-create')).toBe(1)
    expect(countEvent('diff-dispose')).toBe(0)

    act(() => useEditorStore.getState().setViewMode('edit'))
    expect(countEvent('diff-dispose')).toBe(1)
  })
})

// ============================================================
// 5. Real CodeMirror multi-selection restore
// ============================================================
describe('Real CodeMirror multi-selection restore', () => {
  it('restores 3 ranges with mixed directions and non-last mainIndex after balanced TTL', () => {
    const content = 'x'.repeat(40)
    setup([anonymousTab('doc-a', content)], 'doc-a', 'edit', { modePerformancePolicy: 'balanced' })
    render(<EditorArea />)

    // Get the real EditorView from captured views
    const view = capturedViews.views[capturedViews.views.length - 1]?.editor as {
      dispatch: (tr: unknown) => void
      state: { selection: { ranges: Array<{ anchor: number; head: number }>; main: { anchor: number; head: number } } }
    } | undefined
    expect(view).toBeTruthy()

    // Set multi-selection with mixed directions
    act(() => {
      view?.dispatch({
        selection: EditorSelection.create([
          EditorSelection.range(8, 3),   // anchor > head (backward)
          EditorSelection.range(12, 18),  // anchor < head (forward)
          EditorSelection.range(24, 20),  // anchor > head (backward)
        ], 1), // mainIndex = 1 (second range)
      })
    })

    // Switch to preview to trigger release
    act(() => useEditorStore.getState().setViewMode('preview'))
    act(() => vi.advanceTimersByTime(BALANCED_SMALL_DOC_TTL_MS))
    expect(countEvent('editor-dispose')).toBeGreaterThanOrEqual(1)

    // Switch back to edit
    act(() => useEditorStore.getState().setViewMode('edit'))

    // Get the new EditorView
    const newView = capturedViews.views[capturedViews.views.length - 1]?.editor as {
      state: { selection: { ranges: Array<{ anchor: number; head: number }>; main: { anchor: number; head: number } } }
    } | undefined
    expect(newView).toBeTruthy()

    // Verify ranges were restored
    const ranges = newView!.state.selection.ranges
    expect(ranges).toHaveLength(3)
    expect(ranges[0].anchor).toBe(8)
    expect(ranges[0].head).toBe(3)
    expect(ranges[1].anchor).toBe(12)
    expect(ranges[1].head).toBe(18)
    expect(ranges[2].anchor).toBe(24)
    expect(ranges[2].head).toBe(20)

    // Verify mainIndex
    const main = newView!.state.selection.main
    expect(main.anchor).toBe(12)
    expect(main.head).toBe(18)
  })

  it('restores selections after mode switch (edit -> preview -> edit)', () => {
    const content = 'a'.repeat(30)
    setup([anonymousTab('doc-a', content)], 'doc-a', 'edit', { modePerformancePolicy: 'memory' })
    render(<EditorArea />)

    const view = capturedViews.views[capturedViews.views.length - 1]?.editor as {
      dispatch: (tr: unknown) => void
      state: { selection: { ranges: Array<{ anchor: number; head: number }>; main: { anchor: number; head: number } } }
    } | undefined

    act(() => {
      view?.dispatch({
        selection: EditorSelection.create([
          EditorSelection.range(5, 10),
          EditorSelection.range(20, 15),
        ], 0),
      })
    })

    act(() => useEditorStore.getState().setViewMode('preview'))
    expect(countEvent('editor-dispose')).toBeGreaterThanOrEqual(1)

    act(() => useEditorStore.getState().setViewMode('edit'))
    const newView = capturedViews.views[capturedViews.views.length - 1]?.editor as {
      state: { selection: { ranges: Array<{ anchor: number; head: number }>; main: { anchor: number; head: number } } }
    } | undefined

    const ranges = newView!.state.selection.ranges
    expect(ranges).toHaveLength(2)
    expect(ranges[0].anchor).toBe(5)
    expect(ranges[0].head).toBe(10)
    expect(ranges[1].anchor).toBe(20)
    expect(ranges[1].head).toBe(15)
  })

  it('restores selections after documentKey switch', () => {
    const tabs = [
      anonymousTab('doc-a', 'a'.repeat(30)),
      anonymousTab('doc-b', 'b'.repeat(30)),
    ]
    setup(tabs, 'doc-a', 'edit', { modePerformancePolicy: 'memory' })
    render(<EditorArea />)

    const view = capturedViews.views[capturedViews.views.length - 1]?.editor as {
      dispatch: (tr: unknown) => void
      state: { selection: { ranges: Array<{ anchor: number; head: number }>; main: { anchor: number; head: number } } }
    } | undefined

    act(() => {
      view?.dispatch({
        selection: EditorSelection.create([
          EditorSelection.range(10, 5),  // backward
        ], 0),
      })
    })

    // Switch to doc-b
    act(() => useEditorStore.getState().setActiveTab('doc-b'))
    // Switch back to doc-a
    act(() => useEditorStore.getState().setActiveTab('doc-a'))

    const newView = capturedViews.views[capturedViews.views.length - 1]?.editor as {
      state: { selection: { ranges: Array<{ anchor: number; head: number }>; main: { anchor: number; head: number } } }
    } | undefined

    const ranges = newView!.state.selection.ranges
    expect(ranges).toHaveLength(1)
    expect(ranges[0].anchor).toBe(10)
    expect(ranges[0].head).toBe(5)
  })

  it('old EditorView saves position before destroy, not new doc state', () => {
    const tabs = [
      anonymousTab('doc-a', 'a'.repeat(30)),
      anonymousTab('doc-b', 'b'.repeat(30)),
    ]
    setup(tabs, 'doc-a', 'edit', { modePerformancePolicy: 'memory' })
    render(<EditorArea />)

    const viewA = capturedViews.views[capturedViews.views.length - 1]?.editor as {
      dispatch: (tr: unknown) => void
      state: { selection: { ranges: Array<{ anchor: number; head: number }>; main: { anchor: number; head: number } } }
    } | undefined

    act(() => {
      viewA?.dispatch({
        selection: EditorSelection.create([
          EditorSelection.range(3, 8),
        ], 0),
      })
    })

    // Switch to doc-b (this should trigger onBeforeDestroy for doc-a)
    act(() => useEditorStore.getState().setActiveTab('doc-b'))

    // Switch back to doc-a
    act(() => useEditorStore.getState().setActiveTab('doc-a'))

    const newView = capturedViews.views[capturedViews.views.length - 1]?.editor as {
      state: { selection: { ranges: Array<{ anchor: number; head: number }>; main: { anchor: number; head: number } } }
    } | undefined

    // Should restore doc-a's selection, not doc-b's
    const ranges = newView!.state.selection.ranges
    expect(ranges[0].anchor).toBe(3)
    expect(ranges[0].head).toBe(8)
  })
})

// ============================================================
// Keep existing mock-based tests for multi-selection save timing
// ============================================================
describe('Multi-selection save timing (mock-based)', () => {
  // These tests verify the save/restore timing contract via mocked components
  // and are kept alongside the real CodeMirror tests above.

  it('saves directional multi-selections and mainIndex before a document-key recreation', () => {
    const tabs = [
      anonymousTab('doc-a', 'a'.repeat(40)),
      anonymousTab('doc-b', 'b'.repeat(40)),
    ]
    setup(tabs, 'doc-a', 'edit')
    render(<EditorArea />)

    // Get the real EditorView and set selections
    const view = capturedViews.views[capturedViews.views.length - 1]?.editor as {
      dispatch: (tr: unknown) => void
      state: { selection: { ranges: Array<{ anchor: number; head: number }> } }
    } | undefined
    act(() => {
      view?.dispatch({
        selection: EditorSelection.create([
          EditorSelection.range(8, 3),
          EditorSelection.range(12, 18),
          EditorSelection.range(24, 20),
        ], 1),
      })
    })

    act(() => useEditorStore.getState().setActiveTab('doc-b'))
    act(() => useEditorStore.getState().setActiveTab('doc-a'))

    const newView = capturedViews.views[capturedViews.views.length - 1]?.editor as {
      state: { selection: { ranges: Array<{ anchor: number; head: number }>; main: { anchor: number; head: number } } }
    } | undefined
    const ranges = newView!.state.selection.ranges
    expect(ranges).toHaveLength(3)
    expect(ranges[0].anchor).toBe(8)
    expect(ranges[0].head).toBe(3)
    expect(ranges[1].anchor).toBe(12)
    expect(ranges[1].head).toBe(18)
    expect(ranges[2].anchor).toBe(24)
    expect(ranges[2].head).toBe(20)
    expect(newView!.state.selection.main.anchor).toBe(12)
  })
})

// ============================================================
// 6. Performance policy enforcement
// ============================================================
describe('Performance policy enforcement', () => {
  it('memory policy does not create hidden instances after idle', () => {
    setup([anonymousTab('doc-a', '# A')], 'doc-a', 'edit', { modePerformancePolicy: 'memory' })
    useEditorStore.setState({
      viewModeUsage: { 'edit-preview': { count: 10, lastUsedAt: Date.now() } },
    })
    render(<EditorArea />)

    const createsBefore = countEvent('model-create')
    const editorCreatesBefore = countEvent('editor-create')
    const diffCreatesBefore = countEvent('diff-create')

    act(() => vi.advanceTimersByTime(2500))
    act(() => vi.advanceTimersByTime(2500))

    // No hidden instances should be created
    expect(countEvent('model-create')).toBe(createsBefore)
    expect(countEvent('editor-create')).toBe(editorCreatesBefore)
    expect(countEvent('diff-create')).toBe(diffCreatesBefore)
  })

  it('idle callback scheduled before switching to memory does not remount', () => {
    setup([anonymousTab('doc-a', '# A')], 'doc-a', 'edit', { modePerformancePolicy: 'balanced' })
    useEditorStore.setState({
      viewModeUsage: { preview: { count: 10, lastUsedAt: Date.now() } },
    })
    render(<EditorArea />)

    // Advance past the prewarm timeout (650ms) + idle callback window (1200ms total)
    // to confirm the idle callback is scheduled
    act(() => vi.advanceTimersByTime(1200))

    const createsBefore = countEvent('model-create')

    // Switch to memory — should cancel the idle callback
    act(() => useSettingsStore.getState().updateEditorSettings({ modePerformancePolicy: 'memory' }))

    // Let any remaining timers fire
    act(() => vi.advanceTimersByTime(1000))

    // No new instances should be created after the switch
    expect(countEvent('model-create')).toBe(createsBefore)
  })

  it('old TTL does not release a re-visible instance', () => {
    setup([anonymousTab('doc-a', '# Small')], 'doc-a', 'edit-preview')
    render(<EditorArea />)

    const initialBalance = resourceBalance('left-preview')

    // Switch to edit, start TTL
    act(() => useEditorStore.getState().setViewMode('edit'))
    act(() => vi.advanceTimersByTime(10000))

    // Switch back to edit-preview (cancels old TTL)
    act(() => useEditorStore.getState().setViewMode('edit-preview'))

    // The old TTL timer should have been cancelled
    act(() => vi.advanceTimersByTime(BALANCED_SMALL_DOC_TTL_MS))
    expect(countResourceEvent('model-dispose', 'left-preview', 'doc-a')).toBe(0)
    expect(resourceBalance('left-preview')).toBeGreaterThanOrEqual(initialBalance)
  })

  it('same content does not create create/dispose cycle', () => {
    setup([anonymousTab('doc-a', '# Small')], 'doc-a', 'edit-preview', { modePerformancePolicy: 'balanced' })
    render(<EditorArea />)

    // Switch to edit — preview hidden, TTL starts
    act(() => useEditorStore.getState().setViewMode('edit'))

    // Advance past the 45s TTL + a prewarm window
    act(() => vi.advanceTimersByTime(BALANCED_SMALL_DOC_TTL_MS + 2000))

    const createsAfter = countEvent('model-create')
    const disposesAfter = countEvent('model-dispose')

    // Advance another prewarm window — no new create/dispose cycle
    act(() => vi.advanceTimersByTime(2000))

    expect(countEvent('model-create')).toBe(createsAfter)
    expect(countEvent('model-dispose')).toBe(disposesAfter)
  })
})

// ============================================================
// 7. Smart large doc: no hidden preview prewarm
// ============================================================
describe('Smart large doc prewarm suppression', () => {
  it('smart + 100000-char doc in edit mode does not create hidden preview', async () => {
    const content = 'x'.repeat(100000)
    setup([anonymousTab('doc-a', content)], 'doc-a', 'edit', { modePerformancePolicy: 'balanced' })
    render(<EditorArea />)
    await settleLazyEditorModules()

    const modelCreatesBefore = countEvent('model-create')

    // Wait for prewarm timer + idle callback
    act(() => vi.advanceTimersByTime(2500))
    act(() => vi.advanceTimersByTime(2500))

    // No hidden preview should be created
    expect(countEvent('model-create')).toBe(modelCreatesBefore)
    expect(resourceBalance('left-preview')).toBe(0)
  })

  it('smart + 200000-char doc in edit mode does not create hidden preview', async () => {
    const content = 'x'.repeat(200000)
    setup([anonymousTab('doc-a', content)], 'doc-a', 'edit', { modePerformancePolicy: 'balanced' })
    render(<EditorArea />)
    await settleLazyEditorModules()

    const modelCreatesBefore = countEvent('model-create')

    act(() => vi.advanceTimersByTime(2500))
    act(() => vi.advanceTimersByTime(2500))

    expect(countEvent('model-create')).toBe(modelCreatesBefore)
    expect(resourceBalance('left-preview')).toBe(0)
  })

  it('smart + small doc (50000 chars) still creates hidden preview', async () => {
    const content = 'x'.repeat(50000)
    setup([anonymousTab('doc-a', content)], 'doc-a', 'edit', { modePerformancePolicy: 'balanced' })
    render(<EditorArea />)
    await settleLazyEditorModules()

    const modelCreatesBefore = countEvent('model-create')

    act(() => vi.advanceTimersByTime(2500))
    act(() => vi.advanceTimersByTime(2500))

    // Small doc should still prewarm preview
    expect(countEvent('model-create')).toBeGreaterThan(modelCreatesBefore)
    expect(resourceBalance('left-preview')).toBe(1)
  })

  it('turbo + 100000-char doc does not create a blocking hidden preview', async () => {
    const content = 'x'.repeat(100000)
    setup([anonymousTab('doc-a', content)], 'doc-a', 'edit', { modePerformancePolicy: 'speed' })
    render(<EditorArea />)
    await settleLazyEditorModules()

    const modelCreatesBefore = countEvent('model-create')

    act(() => vi.advanceTimersByTime(2500))
    act(() => vi.advanceTimersByTime(2500))

    expect(countEvent('model-create')).toBe(modelCreatesBefore)
    expect(resourceBalance('left-preview')).toBe(0)
  })
})

// ============================================================
// 8. Preview mode: no hidden editor creation
// ============================================================
describe('Preview mode editor suppression', () => {
  it('edit mode does not request or mount the preview implementation', async () => {
    setup([anonymousTab('doc-a', '# A')], 'doc-a', 'edit', { modePerformancePolicy: 'memory' })
    render(<EditorArea />)

    expect(countResourceEvent('model-create', 'left-preview')).toBe(0)
    await settleLazyEditorModules()
    expect(countResourceEvent('model-create', 'left-preview')).toBe(0)
    expect(lifecycle.events.some((event) => event.type === 'preview-first-visible')).toBe(false)
  })

  it('preview mode does not create editor instance', () => {
    setup([anonymousTab('doc-a', '# A')], 'doc-a', 'preview', { modePerformancePolicy: 'balanced' })
    render(<EditorArea />)

    // No editor should be created in preview-only mode
    expect(countEvent('editor-create')).toBe(0)
    expect(resourceBalance('editor')).toBe(0)
  })

  it('switching from preview to edit creates editor', () => {
    setup([anonymousTab('doc-a', '# A')], 'doc-a', 'preview', { modePerformancePolicy: 'balanced' })
    render(<EditorArea />)

    expect(countEvent('editor-create')).toBe(0)

    act(() => useEditorStore.getState().setViewMode('edit'))

    expect(countEvent('editor-create')).toBe(1)
    expect(resourceBalance('editor')).toBe(1)
  })

  it('switching from preview to edit-preview creates editor and preview works', async () => {
    setup([anonymousTab('doc-a', '# A')], 'doc-a', 'preview', { modePerformancePolicy: 'balanced' })
    render(<EditorArea />)
    await settleLazyEditorModules()

    act(() => useEditorStore.getState().setViewMode('edit-preview'))

    expect(countEvent('editor-create')).toBe(1)
    expect(resourceBalance('editor')).toBe(1)
    expect(resourceBalance('left-preview')).toBe(1)
  })

  it('edit mode creates editor immediately', () => {
    setup([anonymousTab('doc-a', '# A')], 'doc-a', 'edit', { modePerformancePolicy: 'balanced' })
    render(<EditorArea />)

    expect(countEvent('editor-create')).toBe(1)
    expect(resourceBalance('editor')).toBe(1)
  })
})

// ============================================================
// 9. First-visible events
// ============================================================
describe('First-visible events', () => {
  it('emits editor-first-visible after editor mount in edit mode', () => {
    setup([anonymousTab('doc-a', '# A')], 'doc-a', 'edit', { modePerformancePolicy: 'balanced' })
    render(<EditorArea />)

    // Flush RAF to trigger first-visible event
    act(() => vi.advanceTimersByTime(1))

    const editorVisibleEvents = lifecycle.events.filter((e) => e.type === 'editor-first-visible')
    expect(editorVisibleEvents.length).toBe(1)
    expect(editorVisibleEvents[0].metadata).toMatchObject({
      charCount: 3,
      mode: 'edit',
    })
  })

  it('emits preview-first-visible after preview mount', async () => {
    setup([anonymousTab('doc-a', '# A')], 'doc-a', 'preview', { modePerformancePolicy: 'balanced' })
    render(<EditorArea />)
    await settleLazyEditorModules()

    act(() => vi.advanceTimersByTime(1))

    const previewVisibleEvents = lifecycle.events.filter((e) => e.type === 'preview-first-visible')
    expect(previewVisibleEvents.length).toBe(1)
    expect(previewVisibleEvents[0].metadata).toMatchObject({
      charCount: 3,
      mode: 'preview',
    })
  })

  it('first-visible events do not contain path or content', () => {
    setup([anonymousTab('doc-a', '# A')], 'doc-a', 'edit-preview', { modePerformancePolicy: 'balanced' })
    render(<EditorArea />)

    act(() => vi.advanceTimersByTime(1))

    const allEvents = lifecycle.events.filter(
      (e) => e.type === 'editor-first-visible' || e.type === 'preview-first-visible'
    )
    for (const event of allEvents) {
      expect(event.metadata?.path).toBeUndefined()
      expect(event.metadata?.content).toBeUndefined()
      expect(event.metadata?.filePath).toBeUndefined()
      expect(event.metadata?.fileName).toBeUndefined()
    }
  })

  it('preview mode does not emit editor-first-visible', () => {
    setup([anonymousTab('doc-a', '# A')], 'doc-a', 'preview', { modePerformancePolicy: 'balanced' })
    render(<EditorArea />)

    act(() => vi.advanceTimersByTime(1))

    const editorVisibleEvents = lifecycle.events.filter((e) => e.type === 'editor-first-visible')
    expect(editorVisibleEvents.length).toBe(0)
  })
})
