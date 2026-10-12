import { act, render, screen } from '@testing-library/react'
import { useCallback, useMemo, useRef, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useEditorResourceLifecycle } from '@/components/editor/useEditorResourceLifecycle'
import type { Tab, ViewMode } from '@/stores/editorStore'
import type { PrewarmTargetMode } from '@/services/editorSession'

const mocks = vi.hoisted(() => ({
  listeners: new Set<(pressure: 'normal' | 'pressure') => void>(),
  tasks: [] as Array<{ run: () => Promise<void>; eligible: () => boolean }>,
  prepare: vi.fn(),
}))
vi.mock('@/hooks/useTauri', () => ({ isTauri: () => true }))
vi.mock('@/services/systemMemory', () => ({
  subscribeMemoryPressure: (listener: (pressure: 'normal' | 'pressure') => void) => {
    mocks.listeners.add(listener)
    return () => mocks.listeners.delete(listener)
  },
  scheduleMemoryAwareTask: (run: () => Promise<void>, _budget: unknown, eligible: () => boolean) => {
    mocks.tasks.push({ run, eligible })
    return vi.fn()
  },
  readSystemMemory: vi.fn().mockResolvedValue({}),
  canAffordWarmup: () => true,
}))

function Harness({ mode = 'edit', draft = false, ready = true, id = 'anonymous-a' }: {
  mode?: ViewMode; draft?: boolean; ready?: boolean; id?: string
}) {
  const tab = useMemo<Tab>(() => ({ id, title: `${id}.md`, filePath: null, content: '# Anonymous', savedContent: '# Anonymous', originalContent: '# Anonymous', modified: false }), [id])
  const [left, setLeft] = useState(false)
  const [right, setRight] = useState(false)
  const [editor, setEditor] = useState(false)
  const [diff, setDiff] = useState(false)
  const readyRef = useRef(ready)
  readyRef.current = ready
  const leftDraft = useRef(draft)
  leftDraft.current = draft
  const rightDraft = useRef(false)
  const retained = useRef<Tab | null>(null)
  const content = useRef<{ content: string; filePath?: string | null }>({ content: tab.content })
  const restored = useRef<{ left: string | null; right: string | null }>({ left: null, right: null })
  const renderKey = useCallback((target: PrewarmTargetMode) => `${id}:${target}`, [id])
  const prepare = useCallback((target: PrewarmTargetMode) => mocks.prepare(target) as Promise<void>, [])
  useEditorResourceLifecycle({
    activeTab: tab, activeTabId: id, viewMode: mode,
    editorVisible: mode === 'edit' || mode === 'edit-preview',
    leftPreviewVisible: mode === 'preview' || mode === 'edit-preview',
    activeDocumentFirstScreenReady: ready, activeDocumentFirstScreenReadyRef: readyRef,
    activePreviewPending: false, rightPreviewPending: false, activeDiffLineCount: 1,
    modePrewarm: 'turbo', modePerformancePolicy: 'speed', modeResourcePolicy: 'speed',
    viewModeUsage: {}, getModeRenderKey: renderKey, prepareModePrewarm: prepare, warmScope: id,
    leftPreviewMounted: left, rightPreviewMounted: right, editorMounted: editor, diffMounted: diff,
    draftDecisionVersion: Number(draft), setLeftPreviewMounted: setLeft, setRightPreviewMounted: setRight,
    setEditorMounted: setEditor, setDiffMounted: setDiff, retainedRightTabRef: retained,
    leftPreviewDraftRef: leftDraft, rightPreviewDraftRef: rightDraft, leftPreviewRenderRef: content,
    restoredPreviewKeysRef: restored,
  })
  return <div data-testid="resources" data-editor={String(editor)} data-left={String(left)}>{tab.content}</div>
}

beforeEach(() => {
  vi.useFakeTimers()
  mocks.listeners.clear()
  mocks.tasks.length = 0
  mocks.prepare.mockReset().mockResolvedValue(undefined)
})
afterEach(() => vi.useRealTimers())

describe('memory pressure and editor ownership', () => {
  it('samples and prewarms only after the real document surface', () => {
    const { rerender, unmount } = render(<Harness ready={false} />)
    act(() => vi.advanceTimersByTime(2000))
    expect(mocks.listeners.size).toBe(0)
    expect(mocks.tasks).toHaveLength(0)
    rerender(<Harness ready />)
    act(() => vi.advanceTimersByTime(1200))
    expect(mocks.listeners.size).toBe(1)
    expect(mocks.tasks).toHaveLength(1)
    unmount()
    expect(mocks.listeners.size).toBe(0)
    expect(mocks.tasks[0].eligible()).toBe(false)
  })

  it('releases only hidden resources and keeps drafts until they settle', () => {
    const { rerender } = render(<Harness mode="edit-preview" draft />)
    rerender(<Harness mode="edit" draft />)
    act(() => mocks.listeners.forEach((listener) => listener('pressure')))
    expect(screen.getByTestId('resources')).toHaveAttribute('data-editor', 'true')
    expect(screen.getByTestId('resources')).toHaveAttribute('data-left', 'true')
    expect(screen.getByTestId('resources')).toHaveTextContent('# Anonymous')
    rerender(<Harness mode="edit" draft={false} />)
    expect(screen.getByTestId('resources')).toHaveAttribute('data-left', 'false')
    expect(screen.getByTestId('resources')).toHaveAttribute('data-editor', 'true')
  })

  it('rejects a late prewarm import after rapid document switches', async () => {
    let finish!: () => void
    mocks.prepare.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve }))
    const { rerender } = render(<Harness />)
    act(() => vi.advanceTimersByTime(1200))
    const task = mocks.tasks[0]
    let pending!: Promise<void>
    act(() => { pending = task.run() })
    rerender(<Harness id="anonymous-b" />)
    rerender(<Harness id="anonymous-a" />)
    await act(async () => { finish(); await pending })
    expect(screen.getByTestId('resources')).toHaveAttribute('data-left', 'false')
  })

  it('holds the optional queue until hidden resources have committed', async () => {
    render(<Harness />)
    act(() => vi.advanceTimersByTime(1200))
    let pending!: Promise<void>
    await act(async () => {
      pending = mocks.tasks[0].run()
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
    await act(async () => { await pending })
    expect(screen.getByTestId('resources')).toHaveAttribute('data-left', 'true')
  })
})
