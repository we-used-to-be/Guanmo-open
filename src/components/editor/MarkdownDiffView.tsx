import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import { eventMarker } from '@/services/eventMarker'
import { useAppStore } from '@/stores/appStore'

interface DiffLine {
  type: 'same' | 'added' | 'removed'
  oldLine?: number
  newLine?: number
  text: string
}

interface MarkdownDiffViewProps {
  original: string
  current: string
  fontSize: number
  lineHeight: number
  fontFamily: string
  wordWrap: boolean
  lineNumbers: boolean
  documentKey?: string
  resource?: 'diff'
}

export interface MarkdownDiffViewHandle {
  getTopRowAnchor: (topOffset: number) => { row: number; offset: number } | undefined
  restoreTopRowAnchor: (anchor: { row: number; offset: number }, topOffset: number) => void
}

function buildLineDiff(original: string, current: string): DiffLine[] {
  const a = original.split(/\r?\n/)
  const b = current.split(/\r?\n/)
  const rows = a.length + 1
  const cols = b.length + 1
  const dp = Array.from({ length: rows }, () => Array<number>(cols).fill(0))

  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }

  const lines: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      lines.push({ type: 'same', oldLine: i + 1, newLine: j + 1, text: a[i] })
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      lines.push({ type: 'removed', oldLine: i + 1, text: a[i] })
      i++
    } else {
      lines.push({ type: 'added', newLine: j + 1, text: b[j] })
      j++
    }
  }
  while (i < a.length) lines.push({ type: 'removed', oldLine: i + 1, text: a[i++] })
  while (j < b.length) lines.push({ type: 'added', newLine: j + 1, text: b[j++] })
  return lines
}

export const MarkdownDiffView = forwardRef<MarkdownDiffViewHandle, MarkdownDiffViewProps>(function MarkdownDiffView({
  original,
  current,
  fontSize,
  lineHeight,
  fontFamily,
  wordWrap,
  lineNumbers,
  documentKey,
  resource = 'diff',
}, ref) {
  const isFullscreen = useAppStore((s) => s.isFullscreen)
  const lifecycleMetadataRef = useRef({ documentKey, resource })
  const rootRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const lifecycleMetadata = lifecycleMetadataRef.current
    eventMarker.mark('diff-create', lifecycleMetadata)
    return () => eventMarker.mark('diff-dispose', lifecycleMetadata)
  }, [])

  const lines = buildLineDiff(original, current)
  const changed = lines.filter((line) => line.type !== 'same').length

  useImperativeHandle(ref, () => ({
    getTopRowAnchor(topOffset) {
      const root = rootRef.current
      if (!root) return undefined
      const targetTop = root.scrollTop + topOffset
      const rootTop = root.getBoundingClientRect().top
      const rows = Array.from(root.querySelectorAll<HTMLElement>('[data-diff-row-index]'))
      let candidate: HTMLElement | undefined
      let candidateTop = 0
      for (const row of rows) {
        const rect = row.getBoundingClientRect()
        const rowTop = rect.top - rootTop + root.scrollTop
        const rowBottom = rowTop + rect.height
        if (rowTop <= targetTop && targetTop < rowBottom) {
          candidate = row
          candidateTop = rowTop
          break
        }
        if (rowTop > targetTop) break
        candidate = row
        candidateTop = rowTop
      }
      if (!candidate) return undefined
      const rowIndex = Number(candidate.dataset.diffRowIndex)
      if (!Number.isFinite(rowIndex)) return undefined
      return { row: rowIndex, offset: targetTop - candidateTop }
    },
    restoreTopRowAnchor(anchor, topOffset) {
      const root = rootRef.current
      const row = root?.querySelector<HTMLElement>(`[data-diff-row-index="${anchor.row}"]`)
      if (!root || !row) return
      const rowTop = row.getBoundingClientRect().top - root.getBoundingClientRect().top + root.scrollTop
      root.scrollTop = Math.max(0, rowTop + anchor.offset - topOffset)
    },
  }), [])

  return (
    <div ref={rootRef} className={`h-full min-w-0 flex-1 overflow-auto bg-gm-surface ${isFullscreen ? 'gm-fullscreen-diff-content' : ''}`}>
      <div className="sticky top-0 z-10 flex items-center justify-between border-b border-gm-border-subtle bg-gm-surface/95 px-4 py-2">
        <div className="text-caption font-bold text-gm-text">Markdown Diff</div>
        <div className="text-micro text-gm-text-tertiary">{changed} 行变化</div>
      </div>
      <div style={{ fontSize: `${fontSize}px`, lineHeight, fontFamily }}>
        {changed === 0 ? (
          <div className="px-4 py-8 text-center font-sans text-caption text-gm-text-tertiary">
            当前内容与保存基准一致
          </div>
        ) : lines.map((line, index) => (
          <div
            key={`${index}-${line.type}`}
            data-diff-row-index={index}
            className={`grid border-b border-gm-border-subtle px-3 ${
              line.type === 'added'
                ? 'bg-gm-success/10'
                : line.type === 'removed'
                  ? 'bg-gm-error/10'
                  : 'bg-transparent'
            }`}
            style={{ gridTemplateColumns: lineNumbers ? '56px 56px 24px minmax(0, 1fr)' : '24px minmax(0, 1fr)' }}
          >
            {lineNumbers && (
              <>
                <span className="select-none text-right text-gm-text-disabled">{line.oldLine ?? ''}</span>
                <span className="select-none text-right text-gm-text-disabled">{line.newLine ?? ''}</span>
              </>
            )}
            <span className={`select-none text-center ${
              line.type === 'added' ? 'text-gm-success' : line.type === 'removed' ? 'text-gm-error' : 'text-gm-text-disabled'
            }`}>
              {line.type === 'added' ? '+' : line.type === 'removed' ? '-' : ''}
            </span>
            <span className={`${wordWrap ? 'whitespace-pre-wrap break-words' : 'whitespace-pre'} pl-2 text-gm-text`}>{line.text || ' '}</span>
          </div>
        ))}
      </div>
    </div>
  )
})
