import { act, fireEvent, render, renderHook, screen } from '@testing-library/react'
import { EditorView } from '@codemirror/view'
import { createRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

if (!Range.prototype.getClientRects) {
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList
}
if (!Range.prototype.getBoundingClientRect) {
  Range.prototype.getBoundingClientRect = () => new DOMRect()
}

// Mock IntersectionObserver for jsdom
if (typeof IntersectionObserver === 'undefined') {
  globalThis.IntersectionObserver = class IntersectionObserver {
    constructor(_callback: IntersectionObserverCallback, _options?: IntersectionObserverInit) {}
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords(): IntersectionObserverEntry[] { return [] }
    root: Element | null = null
    rootMargin = ''
    thresholds: ReadonlyArray<number> = []
  } as unknown as typeof IntersectionObserver
}

if (typeof ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class ResizeObserver {
    constructor(_callback: ResizeObserverCallback) {}
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
}

const scheduledCallbacks = vi.hoisted(() => ({
  raf: new Set<number>(),
  idle: new Set<number>(),
  rafTimers: new Map<number, number>(),
  idleTimers: new Map<number, number>(),
}))

vi.mock('@/hooks/useActiveHeading', () => ({ useActiveHeading: () => null }))
vi.mock('@/hooks/useTauri', () => ({ isTauri: () => false, openFileDialog: vi.fn(), openUrl: vi.fn() }))
vi.mock('@/services/fileSystem', () => ({ saveFile: vi.fn(), saveFileAs: vi.fn() }))
vi.mock('@/services/rag/indexer', () => ({ scheduleMarkdownDocumentIndex: vi.fn() }))
vi.mock('@/services/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}))
vi.mock('@/services/eventMarker', () => ({
  eventMarker: {
    start: vi.fn(),
    mark: vi.fn(),
  },
}))
const aiContextMocks = vi.hoisted(() => ({
  addSelectionContextTag: vi.fn(),
  setAiShortcutPrompt: vi.fn(),
}))
vi.mock('@/services/aiContext', () => aiContextMocks)
vi.mock('@/services/editorViewRef', () => ({
  setActiveEditorView: vi.fn(),
  getActiveEditorView: vi.fn(() => null),
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
  return { ...actual, replaceMarkdownBlock: vi.fn((content: string) => ({ status: 'applied' as const, content })) }
})

import { EditorArea } from '@/components/editor/EditorArea'
import { useReadingPositionBridge } from '@/components/editor/useReadingPositionBridge'
import type { MarkdownPreviewHandle } from '@/components/editor/markdownPreviewTypes'
import { MarkdownDiffView, type MarkdownDiffViewHandle } from '@/components/editor/MarkdownDiffView'
import { useEditorStore, type Tab, type ViewMode } from '@/stores/editorStore'
import { useAppStore } from '@/stores/appStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { runtimeFileReadingPositions, ScrollSyncSession } from '@/services/editorSession'

function anonymousTab(id: string, content: string): Tab {
  return {
    id,
    title: `匿名文档-${id}.md`,
    filePath: null,
    content,
    savedContent: content,
    originalContent: content,
    modified: false,
  }
}

function setupEditor(
  tabs: Tab[],
  activeTabId: string,
  viewMode: ViewMode,
  options?: { syncScroll?: boolean; modePerformancePolicy?: string },
) {
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
    readingPositions: {},
  })
  useSettingsStore.setState((state) => ({
    editor: {
      ...state.editor,
      syncScroll: options?.syncScroll ?? false,
      modePerformancePolicy: (options?.modePerformancePolicy as 'memory' | 'balanced' | 'speed') ?? 'balanced',
      inlinePreviewEdit: false,
    },
  }))
}

beforeEach(() => {
  runtimeFileReadingPositions.clear()
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
})

afterEach(() => {
  vi.useRealTimers()
})

function getLeftPreviewContainer(container: HTMLElement): HTMLElement | null {
  const all = container.querySelectorAll('.select-text.bg-gm-surface')
  for (let i = 0; i < all.length; i++) {
    const el = all[i] as HTMLElement
    if (!el.classList.contains('hidden')) return el
  }
  return all[0] as HTMLElement | null
}

async function settleLazyEditorModules() {
  await act(async () => {
    await vi.dynamicImportSettled()
  })
}

describe('preview horizontal overflow boundary', () => {
  it('hides pane-wide horizontal overflow while preserving local scrollers', async () => {
    const content = [
      '# 横向溢出边界',
      '',
      '```text',
      'a'.repeat(200),
      '```',
      '',
      '| 列一 | 列二 |',
      '| --- | --- |',
      `| ${'b'.repeat(120)} | 内容 |`,
    ].join('\n')
    const tabs = [
      anonymousTab('tab-a', content),
      anonymousTab('tab-b', content),
    ]
    setupEditor(tabs, 'tab-a', 'dual-preview')
    useEditorStore.setState({
      rightPaneTabId: 'tab-b',
      rightPaneUserSelected: true,
    })

    const { container } = render(<EditorArea />)
    await settleLazyEditorModules()
    const previewPanes = container.querySelectorAll(
      '.overflow-y-auto.overflow-x-hidden.select-text.bg-gm-surface',
    )

    expect(previewPanes).toHaveLength(2)
    previewPanes.forEach((pane) => {
      expect(pane).not.toHaveClass('overflow-auto')
    })
    expect(container.querySelectorAll('pre.overflow-x-auto, div.overflow-x-auto').length).toBeGreaterThanOrEqual(4)
  })
})

describe('Ctrl+滚轮字号锚点', () => {
  it('阻止字号快捷滚轮的默认行为，同时保留普通滚轮与字号边界', async () => {
    setupEditor([anonymousTab('tab-a', '# 标题\n\n正文')], 'tab-a', 'edit')
    useSettingsStore.getState().updateEditorSettings({ fontSize: 14 })
    render(<EditorArea />)
    await settleLazyEditorModules()

    const zoomResult = fireEvent.wheel(window, { ctrlKey: true, deltaY: -100 })
    expect(zoomResult).toBe(false)
    expect(useSettingsStore.getState().editor.fontSize).toBe(15)

    const ordinaryResult = fireEvent.wheel(window, { deltaY: 100 })
    expect(ordinaryResult).toBe(true)
    expect(useSettingsStore.getState().editor.fontSize).toBe(15)

    act(() => useSettingsStore.getState().updateEditorSettings({ fontSize: 24 }))
    const boundaryResult = fireEvent.wheel(window, { ctrlKey: true, deltaY: -100 })
    expect(boundaryResult).toBe(false)
    expect(useSettingsStore.getState().editor.fontSize).toBe(24)
  })

  it('预览字号放大后按新布局恢复顶部源码行', async () => {
    const content = Array.from({ length: 180 }, (_, index) => `第 ${index + 1} 段\n第二行`).join('\n\n')
    setupEditor([anonymousTab('tab-a', content)], 'tab-a', 'preview')
    useSettingsStore.getState().updateEditorSettings({ fontSize: 14 })
    const { container } = render(<EditorArea />)
    await settleLazyEditorModules()
    act(() => vi.advanceTimersByTime(50))

    const preview = getLeftPreviewContainer(container)!
    preview.scrollTop = 1_200
    fireEvent.scroll(preview)

    fireEvent.wheel(preview, { ctrlKey: true, deltaY: -100 })
    act(() => vi.advanceTimersByTime(1))

    expect(useSettingsStore.getState().editor.fontSize).toBe(15)
    expect(preview.scrollTop).not.toBe(1_200)
  })

  it('编辑模式按新行高恢复顶部源码行和行内偏移', async () => {
    const content = Array.from({ length: 120 }, (_, index) => `第 ${index + 1} 行`).join('\n')
    setupEditor([anonymousTab('tab-a', content)], 'tab-a', 'edit')
    useSettingsStore.getState().updateEditorSettings({ fontSize: 14 })
    const view = render(<EditorArea />)
    await settleLazyEditorModules()
    act(() => vi.advanceTimersByTime(50))

    const lineBlockAtHeightSpy = vi.spyOn(EditorView.prototype, 'lineBlockAtHeight')
      .mockImplementation(function (height) {
        const rowHeight = useSettingsStore.getState().editor.fontSize * 2
        const lineNumber = Math.min(this.state.doc.lines, Math.floor(height / rowHeight) + 1)
        const line = this.state.doc.line(lineNumber)
        const top = (lineNumber - 1) * rowHeight
        return { from: line.from, to: line.to, top, bottom: top + rowHeight, height: rowHeight } as any
      })
    const lineBlockAtSpy = vi.spyOn(EditorView.prototype, 'lineBlockAt')
      .mockImplementation(function (pos) {
        const rowHeight = useSettingsStore.getState().editor.fontSize * 2
        const line = this.state.doc.lineAt(pos)
        const top = (line.number - 1) * rowHeight
        return { from: line.from, to: line.to, top, bottom: top + rowHeight, height: rowHeight } as any
      })

    const beforeScroller = view.container.querySelector<HTMLElement>('.cm-scroller')!
    beforeScroller.scrollTop = 320
    fireEvent.wheel(beforeScroller, { ctrlKey: true, deltaY: -100 })
    act(() => vi.advanceTimersByTime(1))

    const afterScroller = view.container.querySelector<HTMLElement>('.cm-scroller')!
    expect(afterScroller).not.toBe(beforeScroller)
    expect(afterScroller.scrollTop).toBe(344)
    lineBlockAtHeightSpy.mockRestore()
    lineBlockAtSpy.mockRestore()
  })

  it('双预览分别恢复左右窗格的顶部源码行', async () => {
    const content = Array.from({ length: 180 }, (_, index) => `第 ${index + 1} 段\n第二行`).join('\n\n')
    setupEditor([
      anonymousTab('tab-a', content),
      anonymousTab('tab-b', content.replaceAll('段', '节')),
    ], 'tab-a', 'dual-preview', { syncScroll: true })
    useEditorStore.setState({ rightPaneTabId: 'tab-b', rightPaneUserSelected: true })
    useSettingsStore.getState().updateEditorSettings({ fontSize: 14 })
    const { container } = render(<EditorArea />)
    await settleLazyEditorModules()
    act(() => vi.advanceTimersByTime(50))

    const panes = container.querySelectorAll<HTMLElement>('.overflow-y-auto.overflow-x-hidden.select-text.bg-gm-surface')
    expect(panes).toHaveLength(2)
    panes[0].scrollTop = 700
    panes[1].scrollTop = 1_100

    fireEvent.wheel(panes[0], { ctrlKey: true, deltaY: -100 })
    act(() => vi.advanceTimersByTime(1))

    expect(panes[0].scrollTop).not.toBe(700)
    expect(panes[1].scrollTop).not.toBe(1_100)
  })

  it('快速连续缩放只执行最后一代的两帧恢复', async () => {
    const content = Array.from({ length: 180 }, (_, index) => `第 ${index + 1} 段\n第二行`).join('\n\n')
    setupEditor([anonymousTab('tab-a', content)], 'tab-a', 'preview')
    useSettingsStore.getState().updateEditorSettings({ fontSize: 14 })
    const { container } = render(<EditorArea />)
    await settleLazyEditorModules()
    act(() => vi.advanceTimersByTime(50))

    const preview = getLeftPreviewContainer(container)!
    let scrollTop = 1_200
    const writes: number[] = []
    Object.defineProperty(preview, 'scrollTop', {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = value
        writes.push(value)
      },
    })

    fireEvent.wheel(preview, { ctrlKey: true, deltaY: -100 })
    fireEvent.wheel(preview, { ctrlKey: true, deltaY: -100 })
    act(() => vi.advanceTimersByTime(1))

    expect(useSettingsStore.getState().editor.fontSize).toBe(16)
    expect(writes).toHaveLength(2)
  })

  it('缩放恢复前切换标签页会丢弃旧文档锚点', async () => {
    const content = Array.from({ length: 120 }, (_, index) => `第 ${index + 1} 段`).join('\n\n')
    setupEditor([
      anonymousTab('tab-a', content),
      anonymousTab('tab-b', '# 文档 B\n\n正文 B'),
    ], 'tab-a', 'preview')
    useSettingsStore.getState().updateEditorSettings({ fontSize: 14 })
    const view = render(<EditorArea />)
    await settleLazyEditorModules()
    act(() => vi.advanceTimersByTime(50))

    const previewA = getLeftPreviewContainer(view.container)!
    previewA.scrollTop = 900
    fireEvent.wheel(previewA, { ctrlKey: true, deltaY: -100 })
    act(() => useEditorStore.getState().setActiveTab('tab-b'))
    await settleLazyEditorModules()
    act(() => vi.advanceTimersByTime(1))

    const previewB = getLeftPreviewContainer(view.container)!
    expect(previewB).not.toBe(previewA)
    expect(previewB.scrollTop).toBe(0)
    expect(useEditorStore.getState().readingPositions['tab-b']?.previewScrollTop).not.toBe(900)
  })

  it('Diff 视图按行索引与行内偏移恢复顶部锚点', () => {
    const ref = createRef<MarkdownDiffViewHandle>()
    const props = {
      original: 'A\nB\nC\nD',
      current: 'A\nB2\nC\nD',
      fontSize: 14,
      lineHeight: 1.65,
      fontFamily: 'monospace',
      wordWrap: true,
      lineNumbers: true,
    }
    const view = render(<MarkdownDiffView ref={ref} {...props} />)
    const root = view.container.firstElementChild as HTMLElement
    const rows = Array.from(root.querySelectorAll<HTMLElement>('[data-diff-row-index]'))
    let rowHeight = 20
    vi.spyOn(root, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 100, 600, 400))
    rows.forEach((row, index) => {
      vi.spyOn(row, 'getBoundingClientRect').mockImplementation(() => (
        new DOMRect(0, 100 + 40 + index * rowHeight - root.scrollTop, 600, rowHeight)
      ))
    })
    root.scrollTop = 50
    const anchor = ref.current?.getTopRowAnchor(32)
    expect(anchor).toEqual({ row: 2, offset: 2 })

    rowHeight = 24
    ref.current?.restoreTopRowAnchor(anchor!, 32)
    expect(root.scrollTop).toBe(58)
  })
})

describe('preview source reveal', () => {
  it('首次从编辑模式切到预览时在阅读位置恢复后消费来源定位', async () => {
    const content = Array.from({ length: 260 }, (_, index) => `第 ${index + 1} 段独立内容`).join('\n\n')
    setupEditor([anonymousTab('tab-a', content)], 'tab-a', 'edit', { modePerformancePolicy: 'memory' })
    useEditorStore.setState({ readingPositions: { 'tab-a': { previewScrollTop: 480 } } })
    const { container } = render(<EditorArea />)
    await settleLazyEditorModules()

    act(() => {
      useEditorStore.getState().setViewMode('preview')
      useEditorStore.getState().requestReveal('tab-a', 499, 499, 'preview')
    })
    await settleLazyEditorModules()
    const preview = getLeftPreviewContainer(container)!
    expect(preview.scrollTop).toBe(480)
    let currentScrollTop = preview.scrollTop
    Object.defineProperty(preview, 'scrollTop', {
      configurable: true,
      get: () => currentScrollTop,
      set: (value: number) => { currentScrollTop = value },
    })
    const scrollTo = vi.fn()
    Object.defineProperty(preview, 'scrollTo', {
      configurable: true,
      value: scrollTo,
    })
    act(() => {
      vi.advanceTimersByTime(0)
      vi.advanceTimersByTime(100)
    })
    expect(preview.querySelector<HTMLElement>('.gm-markdown-preview')?.style.opacity).toBe('0')
    expect(preview.style.opacity).toBe('')
    act(() => {
      vi.advanceTimersByTime(0)
      vi.advanceTimersByTime(0)
      vi.advanceTimersByTime(0)
    })

    expect(useEditorStore.getState().pendingReveal).not.toBeNull()
    act(() => fireEvent.scroll(preview))
    expect(scrollTo).not.toHaveBeenCalled()
    expect(preview.scrollTop).not.toBe(480)
    act(() => {
      vi.runOnlyPendingTimers()
    })
    expect(useEditorStore.getState().pendingReveal).toBeNull()
  })

  it('不消费非活动标签的预览定位请求', async () => {
    const content = Array.from({ length: 40 }, (_, index) => `第 ${index + 1} 行`).join('\n')
    setupEditor([anonymousTab('tab-a', content), anonymousTab('tab-b', content)], 'tab-a', 'preview')
    render(<EditorArea />)
    await settleLazyEditorModules()

    act(() => {
      useEditorStore.getState().requestReveal('tab-b', 30, 31, 'preview')
      vi.advanceTimersByTime(0)
    })

    expect(useEditorStore.getState().pendingReveal?.tabId).toBe('tab-b')
  })

  it('切换到新标签页后不会由旧预览实例消费来源定位', async () => {
    const shortContent = Array.from({ length: 8 }, (_, index) => `旧文档第 ${index + 1} 段`).join('\n\n')
    const longContent = Array.from({ length: 260 }, (_, index) => `新文档第 ${index + 1} 段`).join('\n\n')
    setupEditor([anonymousTab('tab-a', shortContent), anonymousTab('tab-b', longContent)], 'tab-a', 'preview')
    const { container } = render(<EditorArea />)
    await settleLazyEditorModules()

    act(() => {
      useEditorStore.getState().setActiveTab('tab-b')
      useEditorStore.getState().requestReveal('tab-b', 499, 499, 'preview')
    })
    await settleLazyEditorModules()
    const preview = getLeftPreviewContainer(container)!
    let currentScrollTop = preview.scrollTop
    Object.defineProperty(preview, 'scrollTop', {
      configurable: true,
      get: () => currentScrollTop,
      set: (value: number) => { currentScrollTop = value },
    })
    const scrollTo = vi.fn()
    Object.defineProperty(preview, 'scrollTo', { configurable: true, value: scrollTo })

    act(() => {
      vi.advanceTimersByTime(0)
      vi.advanceTimersByTime(100)
      vi.advanceTimersByTime(0)
      vi.advanceTimersByTime(0)
    })
    act(() => fireEvent.scroll(preview))
    act(() => {
      vi.runOnlyPendingTimers()
    })

    expect(container.textContent).toContain('新文档第 249 段')
    expect(scrollTo).not.toHaveBeenCalled()
    expect(preview.scrollTop).toBeGreaterThan(0)
    expect(useEditorStore.getState().pendingReveal).toBeNull()
  })
})

describe('preview selection bridge', () => {
  it('routes a native preview selection through the production context-menu path', async () => {
    setupEditor([anonymousTab('tab-a', '# 选区桥接\n\n选择内容')], 'tab-a', 'preview')
    const { container } = render(<EditorArea />)
    await settleLazyEditorModules()

    const preview = getLeftPreviewContainer(container)!
    const walker = document.createTreeWalker(preview, NodeFilter.SHOW_TEXT)
    let textNode: Text | null = null
    while (walker.nextNode()) {
      const current = walker.currentNode
      if (current.textContent?.includes('选择内容')) {
        textNode = current as Text
        break
      }
    }
    expect(textNode).toBeTruthy()

    const selection = window.getSelection()!
    const range = document.createRange()
    range.setStart(textNode!, 0)
    range.setEnd(textNode!, textNode!.textContent!.length)
    selection.removeAllRanges()
    selection.addRange(range)

    fireEvent.contextMenu(preview, { clientX: 20, clientY: 20 })
    fireEvent.click(screen.getByRole('button', { name: '添加到 AI 上下文' }))

    expect(aiContextMocks.addSelectionContextTag).toHaveBeenCalledWith(expect.objectContaining({
      title: '匿名文档-tab-a.md',
      text: expect.stringContaining('选择内容'),
    }))
  })
})

// ============================================================
// CORE BUG: "Document switch" useEffect clears restoredPreviewKeysRef
// after restore useLayoutEffect set it, causing leftPreviewMasked = true
// ============================================================
describe('preview visibility regression: restoredPreviewKeysRef race', () => {
  it('restores the editor position after renaming, closing, and reopening a file', async () => {
    const content = '# 文档 A\n\n' + '正文 A\n\n'.repeat(80)
    const tabA = { ...anonymousTab('tab-a', content), filePath: 'C:/fixtures/old.md' }
    const tabB = { ...anonymousTab('tab-b', '# 文档 B'), filePath: 'C:/fixtures/b.md' }
    setupEditor([tabA, tabB], tabA.id, 'edit')
    const width = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth')
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 500 })
    try {
      const { container } = render(<EditorArea />)
      await settleLazyEditorModules()
      act(() => vi.advanceTimersByTime(50))
      const scroller = container.querySelector<HTMLElement>('.cm-scroller')!
      act(() => {
        scroller.scrollTop = 480
        fireEvent.scroll(scroller)
        useEditorStore.getState().renameFilePath('C:/fixtures/old.md', 'C:/fixtures/new.md', 'new.md')
        useEditorStore.getState().closeTab(tabA.id)
      })
      act(() => useEditorStore.getState().addTab('C:/fixtures/new.md', 'new.md', content))
      act(() => vi.advanceTimersByTime(50))
      expect(useEditorStore.getState().activeTabId).not.toBe(tabA.id)
      expect(container.querySelector<HTMLElement>('.cm-scroller')?.scrollTop).toBe(480)
    } finally {
      if (width) Object.defineProperty(HTMLElement.prototype, 'clientWidth', width)
      else Reflect.deleteProperty(HTMLElement.prototype, 'clientWidth')
    }
  })

  describe('进入对照阅读时同步共享阅读位置', () => {
    it('keeps the right pane position when its file is closed and reopened', async () => {
      const content = '# 文档\n\n' + '正文\n\n'.repeat(80)
      const tabA = { ...anonymousTab('tab-a', content), filePath: 'C:/fixtures/a.md' }
      const tabB = { ...anonymousTab('tab-b', content), filePath: 'C:/fixtures/b.md' }
      setupEditor([tabA, tabB], tabA.id, 'dual-preview')
      useEditorStore.setState({ rightPaneTabId: tabB.id, rightPaneUserSelected: true })
      const width = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth')
      Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 500 })
      try {
        const { container } = render(<EditorArea />)
        await settleLazyEditorModules()
        act(() => vi.advanceTimersByTime(50))
        const panes = container.querySelectorAll<HTMLElement>('.overflow-y-auto.overflow-x-hidden.select-text.bg-gm-surface')
        act(() => {
          panes[1].scrollTop = 720
          fireEvent.scroll(panes[1])
          useEditorStore.getState().closeTab(tabB.id)
        })
        act(() => useEditorStore.getState().addTab(tabB.filePath, tabB.title, content))
        act(() => vi.advanceTimersByTime(50))
        const reopenedPanes = container.querySelectorAll<HTMLElement>('.overflow-y-auto.overflow-x-hidden.select-text.bg-gm-surface')
        expect(reopenedPanes[1].scrollTop).toBe(720)
      } finally {
        if (width) Object.defineProperty(HTMLElement.prototype, 'clientWidth', width)
        else Reflect.deleteProperty(HTMLElement.prototype, 'clientWidth')
      }
    })

    it('未指定右栏文件时把共享行号播种到左右两栏', async () => {
      const content = Array.from({ length: 120 }, (_, index) => `第 ${index + 1} 段`).join('\n\n')
      setupEditor([anonymousTab('tab-a', content)], 'tab-a', 'preview')
      useEditorStore.setState({
        readingPositions: {
          'tab-a': { topLine: 40 },
          'tab-a:left': { previewScrollTop: 120 },
          'tab-a:right': { previewScrollTop: 840 },
        },
      })

      const { container } = render(<EditorArea />)
      await settleLazyEditorModules()

      act(() => useEditorStore.getState().setViewMode('dual-preview'))
      act(() => vi.advanceTimersByTime(600))

      expect(useEditorStore.getState().readingPositions['tab-a:left']).toEqual({ topLine: 40 })
      expect(useEditorStore.getState().readingPositions['tab-a:right']).toEqual({ topLine: 40 })
      expect(container.querySelectorAll('.overflow-y-auto.overflow-x-hidden.select-text.bg-gm-surface')).toHaveLength(2)
    })

    it('已指定不同右栏文件时保留右栏自己的阅读位置', async () => {
      const content = Array.from({ length: 120 }, (_, index) => `第 ${index + 1} 段`).join('\n\n')
      setupEditor([
        anonymousTab('tab-a', content),
        anonymousTab('tab-b', content.replaceAll('段', '节')),
      ], 'tab-a', 'preview')
      useEditorStore.setState({
        rightPaneTabId: 'tab-b',
        rightPaneUserSelected: true,
        readingPositions: {
          'tab-a': { topLine: 40 },
          'tab-b:right': { previewScrollTop: 700 },
        },
      })

      const { container } = render(<EditorArea />)
      await settleLazyEditorModules()

      act(() => useEditorStore.getState().setViewMode('dual-preview'))
      act(() => vi.advanceTimersByTime(100))

      const panes = container.querySelectorAll<HTMLElement>('.overflow-y-auto.overflow-x-hidden.select-text.bg-gm-surface')
      expect(panes).toHaveLength(2)
      expect(panes[1].scrollTop).toBe(700)
    })
  })

  describe('mode switch on same tab with saved scroll position', () => {
    it('preview→edit→preview cycle does not permanently hide preview', async () => {
      // The "Document switch" useEffect has viewMode in its dependency array.
      // When viewMode changes (even without tab change), the effect body runs.
      // But the guard `if (prev && activeTabId && prev !== activeTabId)` prevents
      // clearing restoredPreviewKeysRef for mode-only changes.
      // The restore useLayoutEffect also has viewMode in deps, so it re-runs
      // and re-sets restoredPreviewKeysRef.
      const longContent = '# 模式切换\n\n' + Array.from({ length: 80 }, (_, i) => `段落 ${i + 1}`).join('\n\n')
      const tab = anonymousTab('tab-a', longContent)
      setupEditor([tab], 'tab-a', 'preview', { modePerformancePolicy: 'balanced' })
      const { container } = render(<EditorArea />)
      await settleLazyEditorModules()

      const preview = getLeftPreviewContainer(container)
      expect(preview).toBeTruthy()
      expect(preview!.style.visibility).not.toBe('hidden')

      // Save non-zero scroll position
      act(() => {
        Object.defineProperty(preview!, 'scrollTop', { value: 200, writable: true, configurable: true })
        fireEvent.scroll(preview!)
      })
      act(() => vi.advanceTimersByTime(50))

      // preview → edit (container stays mounted, balanced policy)
      act(() => useEditorStore.getState().setViewMode('edit'))
      act(() => vi.advanceTimersByTime(200))

      // edit → preview
      act(() => useEditorStore.getState().setViewMode('preview'))
      act(() => vi.advanceTimersByTime(200))

      const previewAfter = getLeftPreviewContainer(container)
      expect(previewAfter).toBeTruthy()
      expect(previewAfter!.style.visibility).not.toBe('hidden')
      expect(container.textContent).toContain('模式切换')
    })

    it('edit-preview→edit→edit-preview cycle preserves preview visibility', async () => {
      const longContent = '# 编辑预览模式\n\n' + Array.from({ length: 80 }, (_, i) => `内容 ${i + 1}`).join('\n\n')
      const tab = anonymousTab('tab-a', longContent)
      setupEditor([tab], 'tab-a', 'edit-preview', { syncScroll: true, modePerformancePolicy: 'balanced' })
      const { container } = render(<EditorArea />)
      await settleLazyEditorModules()

      const preview = getLeftPreviewContainer(container)
      expect(preview).toBeTruthy()

      // Save scroll position
      act(() => {
        Object.defineProperty(preview!, 'scrollTop', { value: 180, writable: true, configurable: true })
        fireEvent.scroll(preview!)
      })
      act(() => vi.advanceTimersByTime(50))

      // edit-preview → edit
      act(() => useEditorStore.getState().setViewMode('edit'))
      act(() => vi.advanceTimersByTime(200))

      // edit → edit-preview
      act(() => useEditorStore.getState().setViewMode('edit-preview'))
      act(() => vi.advanceTimersByTime(200))

      const previewAfter = getLeftPreviewContainer(container)
      expect(previewAfter).toBeTruthy()
      expect(previewAfter!.style.visibility).not.toBe('hidden')

      // Editor should also be present for bidirectional sync
      const cmEditor = container.querySelector('.cm-editor')
      expect(cmEditor).toBeTruthy()
    })
  })

  describe('tab switch in preview mode', () => {
    it('corrects a late virtual measurement and stops correcting after user input', () => {
      setupEditor([anonymousTab('tab-a', '# A')], 'tab-a', 'preview')
      useEditorStore.setState({ readingPositions: { 'tab-a': { previewScrollTop: 400, topLine: 25, previewLineOffset: 100 } } })
      const container = document.createElement('div')
      Object.defineProperty(container, 'clientHeight', { value: 600 })
      let measuredLine = 25
      let measuredTop = 600
      const handle = {
        getLineForTop: () => measuredLine,
        getTopForLine: () => measuredTop,
      } as unknown as MarkdownPreviewHandle
      const restoredKeys = { current: { left: null as string | null, right: null as string | null } }
      const { result } = renderHook(() => useReadingPositionBridge({
        activeTabId: 'tab-a',
        viewMode: 'preview',
        viewModeRef: { current: 'preview' },
        editorViewRef: { current: null },
        leftPreviewContainerRef: { current: container },
        rightPreviewContainerRef: { current: null },
        leftMarkdownPreviewRef: { current: handle },
        rightMarkdownPreviewRef: { current: null },
        restoredPreviewKeysRef: restoredKeys,
        scrollSyncSessionRef: { current: new ScrollSyncSession() },
        clearPreviewSwitching: vi.fn(),
        setPreviewRestoreTick: vi.fn(),
        flushReadingPositions: vi.fn(),
        updateEditorHeading: vi.fn(),
        setTocFocus: vi.fn(),
      }))

      act(() => {
        result.current.restorePreviewReadingPosition('tab-a', container, 'left')
        result.current.readingPositionsRef.current.save('tab-a', { previewScrollTop: 0, topLine: 1 })
        result.current.restorePreviewReadingPosition('tab-a', container, 'left')
        expect(container.scrollTop).toBe(400)
        vi.advanceTimersByTime(50)
      })
      expect(restoredKeys.current.left).toBe('tab-a')
      expect(container.scrollTop).toBe(668)
      measuredLine = 10
      measuredTop = 650
      act(() => vi.advanceTimersByTime(250))
      expect(container.scrollTop).toBe(718)

      act(() => result.current.allowPreviewPositionUpdates('tab-a', 'left'))
      container.scrollTop = 700
      act(() => result.current.savePreviewReadingPosition('tab-a', container, handle, 'left'))
      expect(result.current.readingPositionsRef.current.get('tab-a')).toMatchObject({ previewLineOffset: 82 })
      measuredLine = 10
      act(() => vi.advanceTimersByTime(800))
      expect(container.scrollTop).toBe(700)
    })

    it('uses a measured line target on the first preview-to-editor switch', async () => {
      const content = Array.from({ length: 120 }, (_, index) => `第 ${index + 1} 行`).join('\n')
      setupEditor([anonymousTab('tab-a', content)], 'tab-a', 'preview', { modePerformancePolicy: 'memory' })
      useEditorStore.setState({ readingPositions: { 'tab-a': { previewScrollTop: 900, topLine: 80 } } })
      const { container } = render(<EditorArea />)
      await settleLazyEditorModules()
      act(() => vi.advanceTimersByTime(50))

      expect(container.querySelector('.cm-editor')).toBeNull()
      const scrollIntoViewSpy = vi.spyOn(EditorView, 'scrollIntoView')
      act(() => useEditorStore.getState().setViewMode('edit'))
      act(() => vi.advanceTimersByTime(50))

      const target = content.split('\n').slice(0, 79).join('\n').length + 1
      expect(scrollIntoViewSpy).toHaveBeenCalledWith(target, { y: 'start', yMargin: 32 })
    })

    it('saves the first user scroll even while the initial restore frame is pending', async () => {
      const contentA = '# 文档 A\n\n' + '正文 A\n\n'.repeat(100)
      const tabA = anonymousTab('tab-a', contentA)
      const tabB = anonymousTab('tab-b', '# 文档 B')
      setupEditor([tabA, tabB], tabA.id, 'preview')
      useEditorStore.setState({ readingPositions: { [tabA.id]: { previewScrollTop: 400, topLine: 25 } } })

      const { container } = render(<EditorArea />)
      await settleLazyEditorModules()
      const preview = getLeftPreviewContainer(container)!
      act(() => {
        preview.scrollTop = 520
        fireEvent.wheel(preview, { deltaY: 120 })
        fireEvent.scroll(preview)
        useEditorStore.getState().setActiveTab(tabB.id)
      })

      expect(useEditorStore.getState().readingPositions[tabA.id]?.previewScrollTop).toBe(520)
    })

    it('saves only after scrolling stops and captures the final position before switching tabs', async () => {
      const tabA = anonymousTab('tab-a', '# 文档 A\n\n' + '正文 A\n\n'.repeat(100))
      const tabB = anonymousTab('tab-b', '# 文档 B')
      setupEditor([tabA, tabB], tabA.id, 'preview')
      const { container } = render(<EditorArea />)
      await settleLazyEditorModules()
      act(() => vi.advanceTimersByTime(50))
      const preview = getLeftPreviewContainer(container)!
      const log = vi.spyOn(console, 'info').mockImplementation(() => {})
      const savedCount = () => log.mock.calls.filter(([label, data]) =>
        label === '[阅读位置][预览保存]' && data?.success === true).length
      try {
        act(() => {
          fireEvent.wheel(preview, { deltaY: 120 })
          preview.scrollTop = 100
          fireEvent.scroll(preview)
        })
        expect(savedCount()).toBe(0)
        act(() => vi.advanceTimersByTime(100))
        act(() => {
          preview.scrollTop = 300
          fireEvent.scroll(preview)
        })
        act(() => vi.advanceTimersByTime(149))
        expect(savedCount()).toBe(0)
        act(() => vi.advanceTimersByTime(1))
        expect(savedCount()).toBe(1)

        act(() => {
          preview.scrollTop = 400
          fireEvent.scroll(preview)
          preview.scrollTop = 500
          fireEvent.scroll(preview)
          expect(savedCount()).toBe(1)
          useEditorStore.getState().setActiveTab(tabB.id)
        })
        expect(useEditorStore.getState().readingPositions[tabA.id]?.previewScrollTop).toBe(500)
      } finally {
        log.mockRestore()
      }
    })

    it('does not replace a restored position with a later layout scroll before user input', async () => {
      const content = '# 文档 A\n\n' + '正文 A\n\n'.repeat(100)
      setupEditor([anonymousTab('tab-a', content), anonymousTab('tab-b', '# 文档 B')], 'tab-a', 'preview')
      useEditorStore.setState({ readingPositions: { 'tab-a': { previewScrollTop: 400, topLine: 25 } } })
      const clientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight')
      Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 600 })
      try {
        const { container } = render(<EditorArea />)
        await settleLazyEditorModules()
        act(() => vi.advanceTimersByTime(300))

        const preview = getLeftPreviewContainer(container)!
        act(() => {
          fireEvent.pointerDown(preview, { pointerType: 'mouse', clientX: 100 })
          preview.scrollTop = 64
          fireEvent.scroll(preview)
          useEditorStore.getState().setActiveTab('tab-b')
        })
        expect(useEditorStore.getState().readingPositions['tab-a']?.previewScrollTop).toBe(400)

        act(() => useEditorStore.getState().setActiveTab('tab-a'))
        act(() => vi.advanceTimersByTime(300))
        const restored = getLeftPreviewContainer(container)!
        act(() => {
          fireEvent.wheel(restored, { deltaY: 120 })
          restored.scrollTop = 520
          fireEvent.scroll(restored)
          useEditorStore.getState().setActiveTab('tab-b')
        })
        expect(useEditorStore.getState().readingPositions['tab-a']?.previewScrollTop).toBe(520)
      } finally {
        if (clientHeight) Object.defineProperty(HTMLElement.prototype, 'clientHeight', clientHeight)
        else Reflect.deleteProperty(HTMLElement.prototype, 'clientHeight')
      }
    })

    it('keeps a restored preview hidden until its line correction finishes', async () => {
      const content = Array.from({ length: 80 }, (_, index) => `## Section ${index + 1}\n\nParagraph ${index + 1}`).join('\n\n')
      setupEditor([anonymousTab('tab-a', content), anonymousTab('tab-b', content)], 'tab-a', 'preview')
      useEditorStore.setState({ readingPositions: { 'tab-a': { previewScrollTop: 400, topLine: 25 } } })
      const clientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight')
      Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 600 })
      try {
        const { container } = render(<EditorArea />)
        await settleLazyEditorModules()
        act(() => vi.advanceTimersByTime(50))
        act(() => useEditorStore.getState().setActiveTab('tab-b'))
        act(() => useEditorStore.getState().setActiveTab('tab-a'))
        const preview = getLeftPreviewContainer(container)!
        expect(preview.style.visibility).toBe('hidden')
        act(() => vi.advanceTimersByTime(50))
        expect(preview.style.visibility).not.toBe('hidden')
      } finally {
        if (clientHeight) Object.defineProperty(HTMLElement.prototype, 'clientHeight', clientHeight)
        else Reflect.deleteProperty(HTMLElement.prototype, 'clientHeight')
      }
    })

    it('keeps the fullscreen background container visible while switching files', async () => {
      const content = Array.from({ length: 80 }, (_, index) => `## Section ${index + 1}\n\nParagraph ${index + 1}`).join('\n\n')
      setupEditor([anonymousTab('tab-a', content), anonymousTab('tab-b', content)], 'tab-a', 'preview')
      useEditorStore.setState({ readingPositions: { 'tab-a': { previewScrollTop: 400, topLine: 25 } } })
      useAppStore.setState({ isFullscreen: true })
      const clientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight')
      Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 600 })
      try {
        const { container } = render(<EditorArea />)
        await settleLazyEditorModules()
        act(() => vi.advanceTimersByTime(50))
        act(() => useEditorStore.getState().setActiveTab('tab-b'))
        act(() => useEditorStore.getState().setActiveTab('tab-a'))
        const preview = getLeftPreviewContainer(container)!
        expect(preview.style.visibility).not.toBe('hidden')
        expect(preview).toHaveAttribute('data-preview-masked')
        act(() => vi.advanceTimersByTime(50))
        expect(preview).not.toHaveAttribute('data-preview-masked')
      } finally {
        useAppStore.setState({ isFullscreen: false })
        if (clientHeight) Object.defineProperty(HTMLElement.prototype, 'clientHeight', clientHeight)
        else Reflect.deleteProperty(HTMLElement.prototype, 'clientHeight')
      }
    })

    it('restores a file after its tab is closed and reopened with a new ID', async () => {
      const contentA = '# 文档 A\n\n' + '正文 A\n\n'.repeat(60)
      const tabA = { ...anonymousTab('tab-a', contentA), filePath: 'C:/fixtures/a.md' }
      const tabB = { ...anonymousTab('tab-b', '# 文档 B\n\n正文 B'), filePath: 'C:/fixtures/b.md' }
      setupEditor([tabA, tabB], tabA.id, 'preview')
      const width = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth')
      Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 500 })
      try {
        const { container } = render(<EditorArea />)
        await settleLazyEditorModules()
        act(() => vi.advanceTimersByTime(50))
        const preview = getLeftPreviewContainer(container)!
        act(() => {
          preview.scrollTop = 380
          fireEvent.scroll(preview)
          useEditorStore.getState().closeTab(tabA.id)
        })

        act(() => useEditorStore.getState().addTab('c:\\fixtures\\a.md', '文档 A.md', contentA))
        const reopenedId = useEditorStore.getState().activeTabId
        expect(reopenedId).not.toBe(tabA.id)
        act(() => vi.advanceTimersByTime(50))
        expect(getLeftPreviewContainer(container)?.scrollTop).toBe(380)
      } finally {
        if (width) Object.defineProperty(HTMLElement.prototype, 'clientWidth', width)
        else Reflect.deleteProperty(HTMLElement.prototype, 'clientWidth')
      }
    })

    it('tab switch remounts container and keeps preview visible', async () => {
      // When switching tabs, the preview container's key changes, causing a remount.
      // The new container starts with scrollTop=0, so leftPreviewMasked should be false.
      // The restore useLayoutEffect fires because activePreview.version changes.
      const tabA = anonymousTab('tab-a', [
        '---',
        'ai_question: |-',
        '  联网搜索一下广东什么时候才会正式进入秋天',
        '---',
        '',
        '# 文档 A',
        '',
        '段落 A\n'.repeat(40),
      ].join('\n'))
      const tabB = anonymousTab('tab-b', '# 文档 B\n\n段落 B\n'.repeat(40))
      setupEditor([tabA, tabB], 'tab-a', 'preview')
      const { container } = render(<EditorArea />)
      await settleLazyEditorModules()

      expect(container.textContent).toContain('文档 A')

      // Save scroll for tab-a
      const preview = getLeftPreviewContainer(container)
      act(() => {
        Object.defineProperty(preview!, 'scrollTop', { value: 100, writable: true, configurable: true })
        fireEvent.scroll(preview!)
      })

      // Switch to tab-b
      act(() => useEditorStore.getState().setActiveTab('tab-b'))
      act(() => vi.advanceTimersByTime(500))
      expect(container.textContent).toContain('文档 B')

      // Switch back to tab-a
      act(() => useEditorStore.getState().setActiveTab('tab-a'))
      act(() => vi.advanceTimersByTime(500))

      // Preview should be visible with correct content
      const previewAfter = getLeftPreviewContainer(container)
      expect(previewAfter).toBeTruthy()
      expect(previewAfter!.style.visibility).not.toBe('hidden')
      expect(container.textContent).toContain('文档 A')
      expect(container.textContent).toContain('段落 A')
      const blocks = previewAfter!.querySelectorAll<HTMLElement>('[data-md-block-index]')
      expect(blocks[0]).toHaveAttribute('data-md-block-type', 'frontmatter')
      expect(blocks[0]).toHaveAttribute('data-md-line', '1')
      expect(blocks[0]).toHaveAttribute('data-md-end-line', '5')
      expect(blocks[1]).toHaveAttribute('data-md-block-type', 'heading')
      expect(blocks[1]).toHaveAttribute('data-md-line', '6')
    })

    it('three-way tab switch preserves preview visibility', async () => {
      const tabs = [
        anonymousTab('tab-a', '# A\n\n' + '内容 A\n'.repeat(50)),
        anonymousTab('tab-b', '# B\n\n内容 B'),
        anonymousTab('tab-c', '# C\n\n内容 C'),
      ]
      setupEditor(tabs, 'tab-a', 'preview')
      const { container } = render(<EditorArea />)
      await settleLazyEditorModules()

      // Save scroll for tab-a
      const preview = getLeftPreviewContainer(container)
      act(() => {
        Object.defineProperty(preview!, 'scrollTop', { value: 150, writable: true, configurable: true })
        fireEvent.scroll(preview!)
      })

      // A → B → C → A
      act(() => useEditorStore.getState().setActiveTab('tab-b'))
      act(() => vi.advanceTimersByTime(100))
      act(() => useEditorStore.getState().setActiveTab('tab-c'))
      act(() => vi.advanceTimersByTime(100))
      act(() => useEditorStore.getState().setActiveTab('tab-a'))
      act(() => vi.advanceTimersByTime(200))

      const previewA = getLeftPreviewContainer(container)
      expect(previewA).toBeTruthy()
      expect(previewA!.style.visibility).not.toBe('hidden')
      expect(container.textContent).toContain('内容 A')
    })
  })

  describe('tab switch in edit-preview mode', () => {
    it('switching tabs in edit-preview keeps both editor and preview visible', async () => {
      const tabA = anonymousTab('tab-a', '# 编辑预览 A\n\n' + '段落\n'.repeat(50))
      const tabB = anonymousTab('tab-b', '# 编辑预览 B\n\n其他内容')
      setupEditor([tabA, tabB], 'tab-a', 'edit-preview', { syncScroll: true })
      const { container } = render(<EditorArea />)
      await settleLazyEditorModules()

      // Save scroll for tab-a's preview
      const preview = getLeftPreviewContainer(container)
      act(() => {
        Object.defineProperty(preview!, 'scrollTop', { value: 200, writable: true, configurable: true })
        fireEvent.scroll(preview!)
      })

      // Switch to tab-b
      act(() => useEditorStore.getState().setActiveTab('tab-b'))
      act(() => vi.advanceTimersByTime(200))

      // Switch back to tab-a
      act(() => useEditorStore.getState().setActiveTab('tab-a'))
      act(() => vi.advanceTimersByTime(200))

      // Both editor and preview should be present and visible
      const cmEditor = container.querySelector('.cm-editor')
      expect(cmEditor).toBeTruthy()
      const previewAfter = getLeftPreviewContainer(container)
      expect(previewAfter).toBeTruthy()
      expect(previewAfter!.style.visibility).not.toBe('hidden')
      expect(container.textContent).toContain('编辑预览 A')
    })
  })

  describe('scheduled preview content boundary', () => {
    it('document switch cancels a pending update from the previous document', async () => {
      const tabA = anonymousTab('tab-a', '# 文档 A\n\n旧内容')
      const tabB = anonymousTab('tab-b', '# 文档 B\n\n文档 B 内容')
      setupEditor([tabA, tabB], 'tab-a', 'preview')
      const { container } = render(<EditorArea />)
      await settleLazyEditorModules()

      expect(container.textContent).toContain('旧内容')

      act(() => {
        useEditorStore.getState().updateTabContent('tab-a', '# 文档 A\n\n新内容')
        vi.advanceTimersByTime(100)
      })
      expect(container.textContent).toContain('旧内容')

      act(() => {
        useEditorStore.getState().setActiveTab('tab-b')
        vi.advanceTimersByTime(1)
      })
      expect(container.textContent).toContain('文档 B 内容')

      act(() => vi.advanceTimersByTime(400))
      expect(container.textContent).toContain('文档 B 内容')
      expect(container.textContent).not.toContain('新内容')
    })
  })

  describe('virtualized preview scroll synchronization', () => {
    it('keeps advancing the editor after the preview scrolls beyond the initially mounted blocks', async () => {
      const scrollIntoViewSpy = vi.spyOn(EditorView, 'scrollIntoView')
      const longContent = '# 连续同步测试\n\n' + Array.from({ length: 240 }, (_, i) => `段落 ${i + 1}\n第二行 ${i + 1}`).join('\n\n')
      const tab = anonymousTab('tab-a', longContent)
      setupEditor([tab], 'tab-a', 'edit-preview', { syncScroll: true, modePerformancePolicy: 'balanced' })
      const { container } = render(<EditorArea />)
      await settleLazyEditorModules()
      act(() => vi.advanceTimersByTime(50))

      const preview = getLeftPreviewContainer(container)
      expect(preview).toBeTruthy()
      expect(preview).toHaveStyle({ overflowAnchor: 'none' })
      const editorScroller = container.querySelector<HTMLElement>('.cm-scroller')
      expect(editorScroller).toBeTruthy()

      act(() => {
        Object.defineProperty(preview!, 'scrollTop', { value: 600, writable: true, configurable: true })
        fireEvent.wheel(preview!, { deltaY: 300 })
        fireEvent.scroll(preview!)
        vi.advanceTimersByTime(20)
      })
      const firstTargetPos = scrollIntoViewSpy.mock.calls.at(-1)?.[0]

      act(() => {
        preview!.scrollTop = 4_000
        fireEvent.wheel(preview!, { deltaY: 800 })
        fireEvent.scroll(preview!)
        vi.advanceTimersByTime(20)
      })
      const secondTargetPos = scrollIntoViewSpy.mock.calls.at(-1)?.[0]

      expect(firstTargetPos).toEqual(expect.any(Number))
      expect(secondTargetPos).toEqual(expect.any(Number))
      expect(secondTargetPos!).toBeGreaterThan(firstTargetPos!)
      expect(scrollIntoViewSpy).toHaveBeenLastCalledWith(
        secondTargetPos,
        { y: 'start', yMargin: 32 },
      )
      scrollIntoViewSpy.mockRestore()

      act(() => {
        fireEvent.scroll(editorScroller!)
        vi.advanceTimersByTime(600)
      })
      expect(useEditorStore.getState().readingPositions['tab-a']).toMatchObject({
        previewScrollTop: 4_000,
        editorScrollTop: undefined,
      })
    })

    it('does not persist the preview target scroll produced by an editor scroll', async () => {
      const longContent = '# 来源隔离测试\n\n' + Array.from({ length: 160 }, (_, i) => `段落 ${i + 1}`).join('\n\n')
      setupEditor([anonymousTab('tab-a', longContent)], 'tab-a', 'edit-preview', { syncScroll: true })
      const { container } = render(<EditorArea />)
      await settleLazyEditorModules()
      act(() => vi.advanceTimersByTime(50))

      const preview = getLeftPreviewContainer(container)!
      const editorScroller = container.querySelector<HTMLElement>('.cm-scroller')!
      // 同步滚动动画通过直接写 scrollTop 平滑跟随（不调用 scrollTo），
      // 这里捕获 scrollTop 写入以断言“编辑器滚动确实驱动了预览”
      const previewScrollWrites: number[] = []
      let previewScrollTopValue = preview.scrollTop
      Object.defineProperty(preview, 'scrollTop', {
        configurable: true,
        get: () => previewScrollTopValue,
        set: (value: number) => {
          previewScrollTopValue = value
          previewScrollWrites.push(value)
        },
      })

      act(() => {
        editorScroller.scrollTop = 1_200
        fireEvent.wheel(editorScroller, { deltaY: 500 })
        fireEvent.scroll(editorScroller)
        vi.advanceTimersByTime(20)
      })
      expect(previewScrollWrites.length).toBeGreaterThan(0)

      act(() => {
        fireEvent.scroll(preview)
        vi.advanceTimersByTime(600)
      })
      expect(useEditorStore.getState().readingPositions['tab-a']).toMatchObject({
        editorScrollTop: 1_200,
        previewScrollTop: undefined,
      })
    })

    it('flushes the previous document reading position immediately when switching tabs', async () => {
      setupEditor([
        anonymousTab('tab-a', '# 文档 A\n\n正文 A'),
        anonymousTab('tab-b', '# 文档 B\n\n正文 B'),
      ], 'tab-a', 'edit', { syncScroll: false })
      const { container } = render(<EditorArea />)
      await settleLazyEditorModules()
      act(() => vi.advanceTimersByTime(50))

      const editorScroller = container.querySelector<HTMLElement>('.cm-scroller')!
      editorScroller.scrollTop = 480
      fireEvent.scroll(editorScroller)

      act(() => useEditorStore.getState().setActiveTab('tab-b'))

      expect(useEditorStore.getState().readingPositions['tab-a']).toMatchObject({
        editorScrollTop: 480,
      })
    })

    it('preview render-induced scroll and content update never move the left editor', async () => {
      const longContent = '# 左侧稳定测试\n\n' + Array.from({ length: 160 }, (_, i) => `段落 ${i + 1}\n第二行 ${i + 1}`).join('\n\n')
      const tab = anonymousTab('tab-a', longContent)
      setupEditor([tab], 'tab-a', 'edit-preview', { syncScroll: true, modePerformancePolicy: 'balanced' })
      const { container } = render(<EditorArea />)
      await settleLazyEditorModules()
      act(() => vi.advanceTimersByTime(50))

      const preview = getLeftPreviewContainer(container)!
      const editorScroller = container.querySelector<HTMLElement>('.cm-scroller')!
      expect(editorScroller).toBeTruthy()

      // 模拟右侧渲染补偿产生的预览滚动（无任何用户手势）：预览自身滚动位置变化
      act(() => {
        Object.defineProperty(preview!, 'scrollTop', { value: 2_000, writable: true, configurable: true })
        fireEvent.scroll(preview!)
        vi.advanceTimersByTime(20)
      })
      // 渲染补偿滚动不得反向移动编辑器
      expect(editorScroller!.scrollTop).toBe(0)

      // 左侧内容变化 → 预览防抖后同步渲染（版本变化）
      act(() => {
        useEditorStore.getState().updateTabContent('tab-a', tab.content + '\n\n新增段落')
        vi.advanceTimersByTime(350)
      })

      // 预览更新后，编辑器滚动位置仍保持原样 —— 右侧渲染不得影响左侧位置
      expect(editorScroller!.scrollTop).toBe(0)
    })
  })
})

describe('editor TOC jump settling', () => {
  it('eases through the latest measured target before the final CodeMirror snap', async () => {
    let frameTime = 0
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback: FrameRequestCallback) => {
      return window.setTimeout(() => {
        frameTime += 16
        callback(frameTime)
      }, 16)
    })
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((handle: number) => {
      window.clearTimeout(handle)
    })

    const content = [
      '# 起始标题',
      ...Array.from({ length: 80 }, (_, index) => `\n\n正文 ${index + 1}`),
      '\n\n## 远端标题',
    ].join('')
    setupEditor([anonymousTab('tab-a', content)], 'tab-a', 'edit')
    const view = render(<EditorArea />)
    await settleLazyEditorModules()
    act(() => vi.advanceTimersByTime(50))

    const editorScroller = view.container.querySelector<HTMLElement>('.cm-scroller')!
    let scrollTop = 0
    const scrollTopWrites: number[] = []
    Object.defineProperties(editorScroller, {
      clientHeight: { configurable: true, value: 800 },
      scrollHeight: { configurable: true, value: 2_000 },
      scrollTop: {
        configurable: true,
        get: () => scrollTop,
        set: (value: number) => {
          scrollTop = value
          scrollTopWrites.push(value)
        },
      },
      scrollTo: {
        configurable: true,
        value: (options: ScrollToOptions) => {
          scrollTop = Number(options.top)
          scrollTopWrites.push(scrollTop)
          window.setTimeout(() => editorScroller.dispatchEvent(new Event('scrollend')), 0)
        },
      },
    })

    let measurementCount = 0
    vi.spyOn(EditorView.prototype, 'lineBlockAt').mockImplementation(() => {
      const top = measurementCount++ === 0 ? 800 : 1_000
      return { from: 0, to: 0, top, bottom: top + 24, height: 24 }
    })
    const scrollIntoViewSpy = vi.spyOn(EditorView, 'scrollIntoView')

    fireEvent.click(view.getByRole('button', { name: '远端标题' }))
    act(() => vi.advanceTimersByTime(260))

    const terminalSteps = scrollTopWrites
      .slice(1)
      .map((position, index) => Math.abs(position - scrollTopWrites[index]))
      .filter((step) => step > 0.1)
    const finalFourSteps = terminalSteps.slice(-4)
    expect(finalFourSteps).toHaveLength(4)
    expect(finalFourSteps[1]).toBeLessThan(finalFourSteps[0])
    expect(finalFourSteps[2]).toBeLessThan(finalFourSteps[1])
    expect(finalFourSteps[3]).toBeLessThan(finalFourSteps[2])
    expect(scrollTop).toBeCloseTo(1_000 - 32, 0)
    expect(scrollIntoViewSpy).toHaveBeenCalledTimes(1)
    expect(scrollIntoViewSpy).toHaveBeenCalledWith(expect.any(Number), { y: 'start', yMargin: 32 })
  })
})
