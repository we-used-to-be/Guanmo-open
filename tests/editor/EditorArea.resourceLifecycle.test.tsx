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
import { BALANCED_LARGE_DOC_TTL_MS, BALANCED_SMALL_DOC_TTL_MS } from '@/services/editorSession'

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
  policy?: 'memory' | 'balanced' | 'speed'
  prewarm?: 'off' | 'smart' | 'turbo'
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
  useSettingsStore.setState((state) => ({
    editor: {
      ...state.editor,
      inlinePreviewEdit: true,
      modeResourcePolicy: options?.policy ?? 'balanced',
      modePrewarm: options?.prewarm ?? 'off',
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
  it('balanced small doc stays mounted for 45s then disposes via real create/dispose events', () => {
    setup([anonymousTab('doc-a', '# Small')], 'doc-a', 'edit-preview')
    render(<EditorArea />)

    expect(resourceBalance('left-preview')).toBe(1)

    act(() => useEditorStore.getState().setViewMode('edit'))
    act(() => vi.advanceTimersByTime(BALANCED_SMALL_DOC_TTL_MS - 1))
    expect(countEvent('model-dispose')).toBe(0)

    act(() => vi.advanceTimersByTime(1))
    expect(countEvent('model-dispose')).toBeGreaterThanOrEqual(1)
    expect(resourceBalance('left-preview')).toBe(0)
  })

  it('balanced 100000-char doc stays mounted for 5s then disposes', () => {
    const content = 'x'.repeat(100000)
    setup([anonymousTab('doc-big', content)], 'doc-big', 'edit-preview')
    render(<EditorArea />)

    act(() => useEditorStore.getState().setViewMode('edit'))
    act(() => vi.advanceTimersByTime(BALANCED_LARGE_DOC_TTL_MS - 1))
    expect(countEvent('model-dispose')).toBe(0)

    act(() => vi.advanceTimersByTime(1))
    expect(countEvent('model-dispose')).toBeGreaterThanOrEqual(1)
  })

  it('rerenders do not reset or cancel TTL', () => {
    setup([anonymousTab('doc-a', '# Small')], 'doc-a', 'edit-preview')
    const result = render(<EditorArea />)

    act(() => useEditorStore.getState().setViewMode('edit'))
    act(() => vi.advanceTimersByTime(10000))
    // Rerender should not affect TTL
    result.rerender(<EditorArea />)
    act(() => vi.advanceTimersByTime(BALANCED_SMALL_DOC_TTL_MS - 10000))
    expect(countEvent('model-dispose')).toBeGreaterThanOrEqual(1)
  })

  it('showing a hidden preview again cancels its old TTL', () => {
    setup([anonymousTab('doc-a', '# Small')], 'doc-a', 'edit-preview')
    render(<EditorArea />)

    act(() => useEditorStore.getState().setViewMode('edit'))
    act(() => vi.advanceTimersByTime(10000))
    act(() => useEditorStore.getState().setViewMode('edit-preview'))
    act(() => vi.advanceTimersByTime(BALANCED_SMALL_DOC_TTL_MS))

    expect(resourceBalance('left-preview')).toBe(1)
    expect(countResourceEvent('model-dispose', 'left-preview', 'doc-a')).toBe(0)

    act(() => useEditorStore.getState().setViewMode('edit'))
    act(() => vi.advanceTimersByTime(BALANCED_SMALL_DOC_TTL_MS))
    expect(resourceBalance('left-preview')).toBe(0)
  })

  it('switching policy cancels the old balanced TTL', () => {
    setup([anonymousTab('doc-a', '# Small')], 'doc-a', 'edit-preview')
    render(<EditorArea />)

    act(() => useEditorStore.getState().setViewMode('edit'))
    act(() => vi.advanceTimersByTime(10000))
    act(() => useSettingsStore.getState().updateEditorSettings({ modeResourcePolicy: 'memory' }))

    expect(countResourceEvent('model-dispose', 'left-preview', 'doc-a')).toBe(1)
    act(() => vi.advanceTimersByTime(BALANCED_SMALL_DOC_TTL_MS))
    expect(countResourceEvent('model-dispose', 'left-preview', 'doc-a')).toBe(1)
  })
})

// ============================================================
// 2. Real right preview pending/conflict integration
// ============================================================
describe('Right preview pending/conflict', () => {
  /** Find a block in the right preview pane (second .overflow-auto.select-text in dual-preview). */
  function altClickRightBlock(container: HTMLElement, blockIndex: number) {
    const panes = container.querySelectorAll('.overflow-auto.select-text.bg-gm-surface')
    // In dual-preview mode the right pane is the second .overflow-auto.select-text
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
    setup(tabs, 'doc-a', 'dual-preview', { policy: 'balanced' })
    useEditorStore.setState({ rightPaneTabId: 'doc-b', rightPaneUserSelected: true })
    const { container } = render(<EditorArea />)

    // Verify right preview is mounted
    expect(countEvent('model-create')).toBeGreaterThanOrEqual(1)

    // Alt+click to enter block editing in right preview
    altClickRightBlock(container, 0)

    // Click outside to trigger submit
    fireEvent.pointerDown(document.body, { pointerId: 2, clientX: 500, clientY: 500 })
    await act(() => vi.advanceTimersByTime(100))
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
    setup(tabs, 'doc-a', 'dual-preview', { policy: 'memory' })
    useEditorStore.setState({ rightPaneTabId: 'doc-b', rightPaneUserSelected: true })
    const { container } = render(<EditorArea />)

    // Alt+click to enter block editing in right preview
    altClickRightBlock(container, 0)

    // Click outside to trigger submit
    fireEvent.pointerDown(document.body, { pointerId: 2, clientX: 500, clientY: 500 })
    await act(() => vi.advanceTimersByTime(100))
    expect(replaceMarkdownBlockMock).toHaveBeenCalledTimes(1)

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
    setup(tabs, 'doc-a', 'dual-preview', { policy: 'memory' })
    useEditorStore.setState({ rightPaneTabId: 'doc-b', rightPaneUserSelected: true })
    const { container } = render(<EditorArea />)

    altClickRightBlock(container, 0)
    fireEvent.pointerDown(document.body, { pointerId: 2, clientX: 500, clientY: 500 })
    await act(() => vi.advanceTimersByTime(100))

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
  it('create/dispose balance across repeated 100000-char mode/document switches', () => {
    const tabs = [
      anonymousTab('doc-a', 'a'.repeat(100000)),
      anonymousTab('doc-b', 'b'.repeat(100000)),
    ]
    setup(tabs, 'doc-a', 'edit-preview', { prewarm: 'off', policy: 'balanced' })
    const result = render(<EditorArea />)

    const modes: ViewMode[] = ['edit', 'edit-preview', 'preview', 'dual-preview', 'diff-preview', 'edit-preview', 'edit']
    const docs = ['doc-a', 'doc-b', 'doc-a', 'doc-b', 'doc-a', 'doc-b', 'doc-a']
    const timerBaselines = new Map<ViewMode, number>()

    for (let round = 0; round < 3; round++) {
      for (let i = 0; i < modes.length; i++) {
        act(() => {
          useEditorStore.getState().setActiveTab(docs[i])
          useEditorStore.getState().setViewMode(modes[i])
        })
        act(() => vi.advanceTimersByTime(BALANCED_LARGE_DOC_TTL_MS + 100))
        act(() => vi.advanceTimersByTime(1))

        const expected = {
          editor: modes[i] === 'edit' || modes[i] === 'edit-preview' ? 1 : 0,
          'left-preview': ['preview', 'edit-preview', 'dual-preview'].includes(modes[i]) ? 1 : 0,
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

  it('old document callbacks do not release new document instances', () => {
    const tabs = [
      anonymousTab('doc-a', 'a'.repeat(100000)),
      anonymousTab('doc-b', 'b'.repeat(100000)),
    ]
    setup(tabs, 'doc-a', 'edit-preview', { policy: 'balanced' })
    const result = render(<EditorArea />)

    // Switch to doc-b
    act(() => {
      useEditorStore.getState().setActiveTab('doc-b')
    })
    // Advance past doc-a's TTL
    act(() => vi.advanceTimersByTime(BALANCED_LARGE_DOC_TTL_MS + 100))

    // doc-b should still be mounted (its own TTL hasn't started since it's visible)
    expect(resourceBalance('editor')).toBe(1)
    // doc-a's dispose should have happened
    expect(countEvent('model-dispose')).toBeGreaterThanOrEqual(1)
    // But doc-b should still be alive
    expect(resourceBalance('left-preview')).toBe(1)

    result.unmount()
    act(() => vi.runAllTimers())
  })
})

// ============================================================
// 4. Smart/turbo candidate coverage
// ============================================================
describe('Prewarm candidate lifecycle', () => {
  it('smart creates real left preview candidate', () => {
    setup([anonymousTab('doc-a', '# A')], 'doc-a', 'edit', { prewarm: 'smart', policy: 'balanced' })
    render(<EditorArea />)

    // No preview yet
    expect(countEvent('model-create')).toBeGreaterThanOrEqual(1) // editor

    // Wait for prewarm timer + idle callback
    act(() => vi.advanceTimersByTime(2500))
    // Preview candidate should be created
    expect(countEvent('model-create')).toBeGreaterThanOrEqual(2)
  })

  it('turbo creates editor candidate based on usage', () => {
    // memory policy releases the initial hidden editor immediately,
    // so the prewarm can create a fresh candidate.
    setup([anonymousTab('doc-a', '# A')], 'doc-a', 'preview', { prewarm: 'turbo', policy: 'memory' })
    useEditorStore.setState({
      viewModeUsage: { 'edit-preview': { count: 15, lastUsedAt: Date.now() } },
    })
    render(<EditorArea />)

    // Initial editor-create from the mount, then memory policy releases it.
    // After TTL we should see a new editor candidate created by prewarm.
    const editorCreatesBefore = countEvent('editor-create')

    act(() => vi.advanceTimersByTime(2500))
    // Editor candidate should be created by prewarm
    expect(countEvent('editor-create')).toBeGreaterThan(editorCreatesBefore)
  })

  it('turbo creates right preview candidate', () => {
    const tabs = [anonymousTab('doc-a', '# A'), anonymousTab('doc-b', '# B')]
    setup(tabs, 'doc-a', 'edit', { prewarm: 'turbo' })
    useEditorStore.setState({
      viewModeUsage: { 'dual-preview': { count: 20, lastUsedAt: Date.now() } },
    })
    useEditorStore.setState({ rightPaneTabId: 'doc-b', rightPaneUserSelected: true })
    render(<EditorArea />)

    act(() => vi.advanceTimersByTime(2500))
    act(() => vi.advanceTimersByTime(2500))
    expect(countResourceEvent('model-create', 'right-preview', 'doc-b')).toBe(1)
  })

  it('turbo creates diff candidate and releases it', () => {
    setup([anonymousTab('doc-a', '# A')], 'doc-a', 'preview', { prewarm: 'turbo' })
    useEditorStore.setState({
      viewModeUsage: { 'diff-preview': { count: 12, lastUsedAt: Date.now() } },
    })
    render(<EditorArea />)

    expect(countEvent('diff-create')).toBe(0)

    act(() => vi.advanceTimersByTime(2500))
    // Flush RAF
    act(() => vi.advanceTimersByTime(1))
    expect(countEvent('diff-create')).toBeGreaterThanOrEqual(1)
    // Diff should be released after RAF
    act(() => vi.advanceTimersByTime(1))
    expect(countEvent('diff-dispose')).toBeGreaterThanOrEqual(1)
  })

  it('prewarm-off releases all hidden candidates', () => {
    setup([anonymousTab('doc-a', '# A')], 'doc-a', 'edit', { prewarm: 'smart', policy: 'balanced' })
    render(<EditorArea />)

    act(() => vi.advanceTimersByTime(2500))
    expect(countResourceEvent('model-create', 'left-preview', 'doc-a')).toBe(1)

    act(() => useSettingsStore.getState().updateEditorSettings({ modePrewarm: 'off' }))
    expect(countResourceEvent('model-dispose', 'left-preview', 'doc-a')).toBe(1)
  })

  it('user activity cancels idle prewarm', () => {
    setup([anonymousTab('doc-a', '# A')], 'doc-a', 'edit', { prewarm: 'smart' })
    render(<EditorArea />)

    // Trigger user activity before prewarm timer fires
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' })))
    act(() => vi.advanceTimersByTime(2500))

    // No prewarm should have happened
    const modelCreates = countEvent('model-create')
    expect(modelCreates).toBeGreaterThanOrEqual(1) // editor only
    // Should not have a preview model-create
    expect(modelCreates).toBeLessThanOrEqual(1)
  })

  it('leaving diff releases diff instance', () => {
    setup([anonymousTab('doc-a', '# A')], 'doc-a', 'diff-preview', { prewarm: 'off' })
    render(<EditorArea />)

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
    setup([anonymousTab('doc-a', content)], 'doc-a', 'edit', { policy: 'balanced' })
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
    setup([anonymousTab('doc-a', content)], 'doc-a', 'edit', { policy: 'memory' })
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
    setup(tabs, 'doc-a', 'edit', { policy: 'memory' })
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
    setup(tabs, 'doc-a', 'edit', { policy: 'memory' })
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
