export const PREVIEW_SELECTION_DIAGNOSTICS_ENABLED = import.meta.env.VITE_PREVIEW_SELECTION_DIAGNOSTICS === 'true'

export type SelectionDiagnosticCause =
  | 'apply' | 'drag-start' | 'drag-frame' | 'drag-release' | 'secondary-down'
  | 'transient-clear' | 'content-change' | 'listener-cleanup'

export interface SelectionDiagnosticSnapshot {
  from: number | null
  to: number | null
  anchor: number | null
  focus: number | null
  hit: number | null
  hitTag: string | null
  hitBlock: number | null
  scrollTop: number
  viewportHeight: number
  modelLength: number
  nativeRangeCount: number
  nativeCollapsed: boolean
  highlightRanges: number
  connectedHighlightRanges: number
}

type Input = { x?: number; y?: number; buttons?: number; button?: number; deltaY?: number }
type Kind = 'mousedown' | 'mousemove' | 'mouseup' | 'wheel' | 'scroll' | 'drag-tick' | 'selection' | 'lifecycle' | 'capture'
interface Entry extends SelectionDiagnosticSnapshot, Input {
  time: number
  kind: Kind
  cause?: SelectionDiagnosticCause
}

/** Temporary local diagnostics. No document identity, text, DOM serialization or raw stacks. */
export class PreviewSelectionDiagnostics {
  private entries: Entry[] = []
  private cursor = 0
  private lastSample = new Map<Kind, number>()

  constructor(private readonly readSnapshot: () => SelectionDiagnosticSnapshot, private readonly now = () => performance.now()) {}

  record(kind: Kind, cause?: SelectionDiagnosticCause, input: Input = {}): void {
    const time = this.now()
    if ((kind === 'mousemove' || kind === 'scroll' || kind === 'drag-tick') && time - (this.lastSample.get(kind) ?? -Infinity) < 100) return
    const s = this.readSnapshot()
    if (kind === 'selection' && cause === 'drag-frame' && s.from !== null && time - (this.lastSample.get(kind) ?? -Infinity) < 50) return
    this.lastSample.set(kind, time)
    // Explicit fields are intentional: never spread caller metadata into a report.
    const entry: Entry = {
      time: Math.round(time), kind, cause,
      x: input.x, y: input.y, button: input.button, buttons: input.buttons, deltaY: input.deltaY,
      from: s.from, to: s.to, anchor: s.anchor, focus: s.focus, hit: s.hit,
      hitTag: s.hitTag && ['H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'P', 'PRE', 'CODE', 'SPAN', 'DIV'].includes(s.hitTag) ? s.hitTag : null,
      hitBlock: s.hitBlock,
      scrollTop: s.scrollTop, viewportHeight: s.viewportHeight, modelLength: s.modelLength,
      nativeRangeCount: s.nativeRangeCount, nativeCollapsed: s.nativeCollapsed,
      highlightRanges: s.highlightRanges, connectedHighlightRanges: s.connectedHighlightRanges,
    }
    if (this.entries.length < 1200) this.entries.push(entry)
    else { this.entries[this.cursor] = entry; this.cursor = (this.cursor + 1) % 1200 }
  }

  capture(): string {
    this.record('capture')
    const entries = this.cursor ? [...this.entries.slice(this.cursor), ...this.entries.slice(0, this.cursor)] : [...this.entries]
    return JSON.stringify({ schemaVersion: 1, diagnostic: 'preview-selection', entries }, null, 2)
  }
}
