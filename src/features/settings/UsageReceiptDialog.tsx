import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { useReducedMotion } from 'motion/react'
import { Scissors } from 'lucide-react'
import { saveFileDialog, writeBinaryFile } from '@/hooks/useTauri'
import { toast } from '@/services/toast'
import type { UsageReceipt } from './usageReceipt'
import './usageReceipt.css'

const RECEIPT_PALETTES = {
  light: { paper: '#fcfaf4', ink: '#39352f', secondary: '#82796d', muted: '#938a7d', quote: '#655d52', rule: '#c7bdae' },
  dark: { paper: '#1d1a15', ink: '#eee4d2', secondary: '#b9af9e', muted: '#9f9585', quote: '#d0c5b3', rule: '#625849' },
}

function getCutEdge(progress: number): Array<{ x: number; y: number }> {
  const end = progress * 360
  const points = Array.from({ length: Math.floor(end / 6) + 1 }, (_, i) => ({ x: i * 6, y: (i % 2) * 3 }))
  const last = points[points.length - 1]
  if (last.x < end) {
    const fraction = (end - last.x) / 6
    points.push({ x: end, y: last.y + (last.y === 0 ? 3 : -3) * fraction })
  }
  return points
}

function ReceiptPaper({ receipt, paperRef, cutEdge }: {
  receipt: UsageReceipt
  paperRef: React.RefObject<SVGSVGElement>
  cutEdge: Array<{ x: number; y: number }>
}) {
  const palette = RECEIPT_PALETTES[receipt.theme]
  const quoteLines = receipt.quote.match(/.{1,22}/gu) ?? []
  const durationParts = receipt.total.match(/^(\d+) 小时 (\d+) 分钟$/)
  const minuteParts = receipt.total.match(/^(\d+) 分钟$/)
  return (
    <svg ref={paperRef} xmlns="http://www.w3.org/2000/svg" viewBox="0 0 360 500"
      width="360" height="500" className="gm-receipt-paper" role="img" aria-label="时光回顾统计卡片">
      <path d={`${cutEdge.map((point, i) => `${i === 0 ? 'M' : 'L'}${point.x} ${point.y}`).join(' ')} L${cutEdge[cutEdge.length - 1].x} 0 H360 V488 ${Array.from({ length: 30 }, (_, i) => `L${354 - i * 12} 494 L${348 - i * 12} 488`).join(' ')} Z`}
        fill={palette.paper} />
      <g fontFamily="'Microsoft YaHei', 'PingFang SC', sans-serif" fill={palette.ink}>
        <text id="usage-receipt-title" x="180" y="43" textAnchor="middle" fontSize="18" fontWeight="600" letterSpacing="2">时光回顾</text>
        <text x="180" y="64" textAnchor="middle" fontSize="9" fill={palette.muted}>生成于 {receipt.generatedDate.replace(/-/g, '.')}</text>
        <path d="M32 84 H328 M32 206 H328 M32 346 H328" stroke={palette.rule} strokeDasharray="3 5" />
        <text x="180" y="113" textAnchor="middle" fontSize="11" fill={palette.secondary}>累计使用时长</text>
        <text x="180" y="156" textAnchor="middle" fontSize="34" fontWeight="600" aria-label={receipt.total}>
          {durationParts ? <>
            <tspan>{durationParts[1]}</tspan><tspan fontSize="12" fontWeight="400"> 小时 </tspan>
            <tspan>{durationParts[2]}</tspan><tspan fontSize="12" fontWeight="400"> 分钟</tspan>
          </> : minuteParts ? <>
            <tspan>{minuteParts[1]}</tspan><tspan fontSize="12" fontWeight="400"> 分钟</tspan>
          </> : <tspan fontSize="25">{receipt.total}</tspan>}
        </text>
        <text x="32" y="185" fontSize="12" fill={palette.secondary}>今日使用</text>
        <text x="328" y="185" textAnchor="end" fontSize="13">{receipt.today}</text>
        <text x="32" y="233" fontSize="10" fill={palette.secondary}>近十二个月</text>
        <text x="328" y="233" textAnchor="end" fontSize="8" fill={palette.muted}>{receipt.range}</text>
        <text x="32" y="270" fontSize="12" fill={palette.secondary}>使用天数</text>
        <text x="328" y="270" textAnchor="end" fontSize="13">{receipt.activeDays} 天</text>
        <text x="32" y="305" fontSize="12" fill={palette.secondary}>单日最长</text>
        <text x="328" y="305" textAnchor="end" fontSize="13">{receipt.longest}</text>
        <text x="328" y="324" textAnchor="end" fontSize="9" fill={palette.muted}>{receipt.longestDate}</text>
        {quoteLines.map((line, i) => (
          <text key={i} x="180" y={391 - (quoteLines.length - 1) * 11 + i * 22} textAnchor="middle" fontSize="12" fill={palette.quote}>{line}</text>
        ))}
        <text x="180" y="456" textAnchor="middle" fontSize="9" fill={palette.muted}>
          <tspan fontWeight="600">观墨</tspan><tspan> · 开源 / Markdown / AI</tspan>
        </text>
      </g>
    </svg>
  )
}

export async function receiptPng(svg: SVGSVGElement): Promise<Uint8Array> {
  await document.fonts.ready
  const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(svg)], { type: 'image/svg+xml;charset=utf-8' }))
  try {
    const image = new Image()
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve()
      image.onerror = () => reject(new Error('回顾图片生成失败'))
      image.src = url
    })
    const canvas = document.createElement('canvas')
    canvas.width = 1080
    canvas.height = 1500
    const context = canvas.getContext('2d')
    if (!context) throw new Error('图片画布不可用')
    context.drawImage(image, 0, 0, canvas.width, canvas.height)
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((result) => result ? resolve(result) : reject(new Error('PNG 生成失败')), 'image/png')
    })
    return new Uint8Array(await blob.arrayBuffer())
  } finally {
    URL.revokeObjectURL(url)
  }
}

export function UsageReceiptDialog({ receipt, onClose }: { receipt: UsageReceipt; onClose: () => void }) {
  const paperRef = useRef<SVGSVGElement>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  const aliveRef = useRef(true)
  const savingRef = useRef(false)
  const dragRef = useRef<{ pointerId: number; left: number; width: number; progress: number } | null>(null)
  const reducedMotion = useReducedMotion() ?? false
  const [saving, setSaving] = useState(false)
  const [closing, setClosing] = useState(false)
  const [progress, setProgress] = useState(0)
  const [phase, setPhase] = useState<'attached' | 'falling' | 'detached'>('attached')
  const cutEdge = getCutEdge(progress)
  const palette = RECEIPT_PALETTES[receipt.theme]

  useEffect(() => {
    aliveRef.current = true
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    dialogRef.current?.focus({ preventScroll: true })
    return () => {
      aliveRef.current = false
      previousFocus?.focus()
    }
  }, [])

  useEffect(() => {
    if (!closing) return
    const timer = window.setTimeout(onClose, 160)
    return () => window.clearTimeout(timer)
  }, [closing, onClose])

  async function download() {
    if (!paperRef.current) return
    let saved = false
    try {
      const bytes = await receiptPng(paperRef.current)
      if (!aliveRef.current) return
      const path = await saveFileDialog(`观墨-时光回顾-${receipt.generatedDate}.png`, [{ name: 'PNG 图片', extensions: ['png'] }])
      if (!path || !aliveRef.current) return
      await writeBinaryFile(path, bytes)
      saved = true
      if (aliveRef.current) {
        toast.success('时光回顾已保存')
        setClosing(true)
      }
    } catch {
      if (aliveRef.current) toast.error('下载时光回顾失败，请重试')
    } finally {
      savingRef.current = false
      if (aliveRef.current) {
        setSaving(false)
        if (!saved) { setPhase('attached'); setProgress(0) }
      }
    }
  }

  function tearPaper() {
    if (savingRef.current || phase !== 'attached') return
    savingRef.current = true
    setSaving(true)
    setProgress(1)
    setPhase(reducedMotion ? 'detached' : 'falling')
    if (reducedMotion) void download()
  }

  return createPortal(
    <div className={`gm-settings-mask gm-ai-shortcut-dialog-mask gm-receipt-mask fixed inset-0 z-[1100] flex items-center justify-center p-4 ${closing ? 'is-closing pointer-events-none' : ''}`}
      onMouseDown={(event) => { if (event.target === event.currentTarget) setClosing(true) }}>
      <div className={`gm-ai-shortcut-dialog-panel gm-receipt-preview ${closing ? 'is-closing' : ''}`}>
        <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="usage-receipt-title" tabIndex={-1}
          className="gm-receipt-dialog"
          onKeyDown={(event) => {
            if (event.key === 'Escape') { event.stopPropagation(); setClosing(true) }
            if (event.key !== 'Tab') return
            const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
            if (buttons.length === 0) { event.preventDefault(); return }
            const first = buttons[0]
            const last = buttons[buttons.length - 1]
            if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) {
              event.preventDefault(); last?.focus()
            } else if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault(); first?.focus()
            }
          }}>
          <div className="gm-receipt-sheet" data-phase={phase} data-tearing={progress > 0} data-receipt-theme={receipt.theme}
            style={{ '--tear-progress': progress, '--receipt-paper': palette.paper, '--receipt-secondary': palette.secondary, '--receipt-rule': palette.rule } as CSSProperties}>
            <div className="gm-receipt-printer" aria-hidden="true"><span /></div>
            <div className="gm-receipt-stub">
              <svg className="gm-receipt-stub-edge" viewBox="0 0 360 4" width="360" height="4" aria-hidden="true">
                <path d={`M0 0 H${progress * 360} ${[...cutEdge].reverse().map((point) => `L${point.x} ${Math.max(0, point.y - 0.7)}`).join(' ')} Z`} fill={palette.paper} />
              </svg>
              <button type="button" className="gm-receipt-tear" disabled={saving || phase === 'detached'}
                aria-label="从左向右撕下并保存回顾，或按 Enter 保存"
                onClick={(event) => { if (event.detail === 0) tearPaper() }}
                onPointerDown={(event) => {
                  if (event.button !== 0 || phase !== 'attached' || savingRef.current) return
                  const rect = event.currentTarget.getBoundingClientRect()
                  if (event.clientX - rect.left > 40) return
                  event.preventDefault()
                  event.currentTarget.focus({ preventScroll: true })
                  event.currentTarget.setPointerCapture(event.pointerId)
                  const startProgress = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width))
                  dragRef.current = { pointerId: event.pointerId, left: rect.left, width: rect.width, progress: startProgress }
                  setProgress(startProgress)
                }}
                onPointerMove={(event) => {
                  const drag = dragRef.current
                  if (!drag || drag.pointerId !== event.pointerId) return
                  drag.progress = Math.min(1, Math.max(0, (event.clientX - drag.left) / drag.width))
                  setProgress(drag.progress)
                }}
                onPointerUp={(event) => {
                  const drag = dragRef.current
                  if (!drag || drag.pointerId !== event.pointerId) return
                  drag.progress = Math.min(1, Math.max(0, (event.clientX - drag.left) / drag.width))
                  dragRef.current = null
                  event.currentTarget.releasePointerCapture(event.pointerId)
                  if (drag.progress >= 0.95) tearPaper()
                  else setProgress(0)
                }}
                onPointerCancel={() => { dragRef.current = null; setProgress(0) }}
                onLostPointerCapture={() => {
                  if (dragRef.current) { dragRef.current = null; setProgress(0) }
                }}>
                <span className="gm-receipt-tear-intact" aria-hidden="true" />
                <span className="gm-receipt-tear-cut" aria-hidden="true" />
                <span className="gm-receipt-tear-tool" style={{ left: progress > 0 ? `calc(${progress * 100}% - 17px)` : '0px' }} aria-hidden="true"><Scissors size={17} /></span>
              </button>
            </div>
            <div className="gm-receipt-detachable" onAnimationEnd={(event) => {
              if (event.target === event.currentTarget && phase === 'falling') {
                setPhase('detached')
                void download()
              }
            }}>
              <div className="gm-receipt-output"><ReceiptPaper receipt={receipt} paperRef={paperRef} cutEdge={cutEdge} /></div>
            </div>
          </div>
          <div className="gm-receipt-instruction" role="status" aria-live="polite">
            {saving ? '正在保存回顾…' : phase === 'detached' ? '回顾已保存 · 点击外部关闭' : '沿虚线向右撕下，保存这段时光'}
          </div>
        </div>
      </div>
    </div>, document.body,
  )
}
