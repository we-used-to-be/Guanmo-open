import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const { exportReport } = vi.hoisted(() => ({ exportReport: vi.fn(async (_report: string) => false) }))
vi.mock('@/services/previewSelectionDiagnostics', async (original) => ({
  ...await original<typeof import('@/services/previewSelectionDiagnostics')>(),
  PREVIEW_SELECTION_DIAGNOSTICS_ENABLED: true,
}))
vi.mock('@/services/previewSelectionDiagnosticsExport', () => ({ exportPreviewSelectionDiagnostics: exportReport }))
import { MarkdownPreview } from '@/components/editor/MarkdownPreview'

let host: HTMLDivElement
let caret: PropertyDescriptor | undefined
let hit: PropertyDescriptor | undefined
beforeEach(() => {
  exportReport.mockClear()
  host = document.createElement('div')
  Object.defineProperties(host, { clientHeight: { value: 600 }, clientWidth: { value: 700 } })
  document.body.append(host)
  caret = Object.getOwnPropertyDescriptor(document, 'caretRangeFromPoint')
  hit = Object.getOwnPropertyDescriptor(document, 'elementFromPoint')
  Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => host.querySelector('h2 span') })
  Object.defineProperty(document, 'caretRangeFromPoint', { configurable: true, value: (x: number) => {
    const node = host.querySelector('h2 span')?.firstChild
    if (!node) return null
    const range = document.createRange()
    range.setStart(node, x < 50 ? 0 : node.textContent!.length)
    range.collapse(true)
    return range
  } })
})
afterEach(() => {
  cleanup()
  host.remove()
  if (caret) Object.defineProperty(document, 'caretRangeFromPoint', caret)
  else Reflect.deleteProperty(document, 'caretRangeFromPoint')
  if (hit) Object.defineProperty(document, 'elementFromPoint', hit)
  else Reflect.deleteProperty(document, 'elementFromPoint')
})

it('captures the first padding drag and its transitions, exports on F8, and detaches on unmount', async () => {
  const view = render(<MarkdownPreview content="## Anonymous heading" readingMarks={[]} />, { container: host })
  fireEvent.mouseDown(host, { button: 0, buttons: 1, clientX: 10, clientY: 100 })
  fireEvent.mouseMove(document, { buttons: 1, clientX: 100, clientY: 100 })
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 40)) })
  fireEvent.mouseUp(document, { button: 0, clientX: 100, clientY: 100 })
  fireEvent.keyDown(document, { key: 'F8' })
  await waitFor(() => expect(exportReport).toHaveBeenCalledTimes(1))
  const report = JSON.parse(exportReport.mock.calls[0][0] as string)
  expect(report.entries.some((e: { kind: string }) => e.kind === 'mousedown')).toBe(true)
  expect(report.entries.some((e: { cause: string }) => e.cause === 'drag-release')).toBe(true)
  expect(report.entries.at(-1).kind).toBe('capture')
  expect(exportReport.mock.calls[0][0]).not.toContain('Anonymous heading')
  view.unmount()
  fireEvent.keyDown(document, { key: 'F8' })
  expect(exportReport).toHaveBeenCalledTimes(1)
})
