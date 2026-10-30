import { describe, expect, it } from 'vitest'
import { PreviewSelectionDiagnostics, type SelectionDiagnosticSnapshot } from '@/services/previewSelectionDiagnostics'

const snapshot: SelectionDiagnosticSnapshot = {
  from: 2, to: 10, anchor: 2, focus: 10, hit: 10, hitTag: 'SPAN', hitBlock: 1,
  scrollTop: 100, viewportHeight: 600, modelLength: 1000,
  nativeRangeCount: 0, nativeCollapsed: true, highlightRanges: 1, connectedHighlightRanges: 1,
}

describe('preview selection diagnostics', () => {
  it('bounds history, preserves chronological order and freezes each capture', () => {
    let time = 0
    const recorder = new PreviewSelectionDiagnostics(() => snapshot, () => ++time)
    for (let i = 0; i < 1400; i++) recorder.record('wheel', undefined, { deltaY: i })
    const frozen = recorder.capture()
    const entries = JSON.parse(frozen).entries
    expect(entries).toHaveLength(1200)
    expect(entries[0].deltaY).toBe(201)
    expect(entries.at(-1).kind).toBe('capture')
    expect(entries.every((entry: { time: number }, i: number) => !i || entry.time > entries[i - 1].time)).toBe(true)
    recorder.record('selection', 'transient-clear')
    expect(JSON.parse(frozen).entries.at(-1).kind).toBe('capture')
  })

  it('samples movement but never drops a selection clearing transition', () => {
    let time = 0
    let state = snapshot
    const recorder = new PreviewSelectionDiagnostics(() => state, () => time)
    recorder.record('mousemove')
    time = 20
    recorder.record('mousemove')
    recorder.record('selection', 'drag-frame')
    time = 30
    recorder.record('selection', 'drag-frame')
    state = { ...snapshot, from: null, to: null }
    recorder.record('selection', 'transient-clear')
    expect(JSON.parse(recorder.capture()).entries.map((e: { kind: string }) => e.kind)).toEqual(['mousemove', 'selection', 'selection', 'capture'])
  })

  it('omits text, paths, DOM markup, raw stacks and unknown tag strings', () => {
    const unsafe = { ...snapshot, hitTag: 'secret-document-title', content: 'private paragraph', filePath: 'C:/Users/private/file.md', stack: 'private stack' }
    const recorder = new PreviewSelectionDiagnostics(() => unsafe)
    recorder.record('mousedown', undefined, { x: 10, y: 20, ...{ token: 'secret-key' } })
    const report = recorder.capture()
    expect(report).not.toMatch(/private|secret|filePath|content|stack|token/)
    expect(JSON.parse(report).entries[0].hitTag).toBeNull()
  })
})
