import { act, render } from '@testing-library/react'
import { EditorSelection } from '@codemirror/state'
import { type EditorView } from '@codemirror/view'
import { undo, redo } from '@codemirror/commands'
import { describe, expect, it, vi } from 'vitest'
import { CodeMirrorEditor } from '@/components/editor/CodeMirrorEditor'

vi.mock('@/services/eventMarker', () => ({ eventMarker: { mark: vi.fn() } }))
if (!Range.prototype.getClientRects) Range.prototype.getClientRects = () => [] as unknown as DOMRectList
if (!Range.prototype.getBoundingClientRect) Range.prototype.getBoundingClientRect = () => new DOMRect()

describe('CodeMirror 外部局部修改', () => {
  it('保留未修改区域与多选区，并支持撤销和重做', () => {
    const content = 'before\nreplace this\nafter\nlast line'
    const next = content.replace('replace this', 'new text')
    const viewRef = { current: null as EditorView | null }
    const onChange = vi.fn()
    const { rerender } = render(<CodeMirrorEditor content={content} documentKey="doc" viewRef={viewRef} onChange={onChange} />)
    const view = viewRef.current!
    const before = content.indexOf('before') + 2
    const after = content.indexOf('last line') + 3
    act(() => view.dispatch({ selection: EditorSelection.create([
      EditorSelection.cursor(before), EditorSelection.cursor(after),
    ], 1) }))
    rerender(<CodeMirrorEditor content={next} documentKey="doc" viewRef={viewRef} onChange={onChange} />)
    expect(viewRef.current).toBe(view)
    expect(view.state.doc.toString()).toBe(next)
    expect(view.state.selection.ranges.map((range) => range.anchor)).toEqual([before, after - 4])
    expect(view.state.selection.mainIndex).toBe(1)
    act(() => { expect(undo(view)).toBe(true) })
    expect(view.state.doc.toString()).toBe(content)
    act(() => { expect(redo(view)).toBe(true) })
    expect(view.state.doc.toString()).toBe(next)
  })
})
