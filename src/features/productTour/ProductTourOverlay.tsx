import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { PRODUCT_TOUR_TOPICS, type ProductTourPlacement, type ProductTourStep, type ProductTourTopic } from './productTourContent'
import productTourStyles from './product-tour.css?inline'

interface RectLike { left: number; top: number; right: number; bottom: number; width: number; height: number }
interface TourLayout { rects: RectLike[]; anchor: RectLike }
interface CardPosition { left: number; top: number; placement: ProductTourPlacement; startX: number; startY: number; endX: number; endY: number }
interface ProductTourOverlayProps {
  open: boolean
  topic: ProductTourTopic | 'topics'
  steps: ProductTourStep[]
  stepIndex: number
  onStepChange: (index: number) => void
  onTopicChange: (topic: ProductTourTopic | 'topics') => void
  onClose: () => void
  compact?: boolean
  headerIcon?: ReactNode
  trackingElement?: HTMLElement | null
}

const CARD_WIDTH = 360
const CARD_GAP = 20
const VIEWPORT_PADDING = 16
const PRODUCT_TOUR_STYLE_ID = 'guanmo-product-tour-styles'

function readRect(element: Element): RectLike {
  const { left, top, right, bottom, width, height } = element.getBoundingClientRect()
  return { left, top, right, bottom, width, height }
}

export function clipTourRectToViewport(rect: RectLike, viewport: RectLike): RectLike | null {
  const left = Math.max(rect.left, viewport.left)
  const top = Math.max(rect.top, viewport.top)
  const right = Math.min(rect.right, viewport.right)
  const bottom = Math.min(rect.bottom, viewport.bottom)
  if (right <= left || bottom <= top) return null
  return { left, top, right, bottom, width: right - left, height: bottom - top }
}

function findTargetElement(target: string | string[]): Element | null {
  const selectors = Array.isArray(target) ? target : [target]
  return selectors
    .flatMap((selector) => Array.from(document.querySelectorAll(selector)))
    .find((element) => {
      const rect = element.getBoundingClientRect()
      return rect.width > 0 && rect.height > 0
    }) ?? null
}

export function scrollTourTargetIntoView(target: string | string[]): boolean {
  if (typeof window === 'undefined' || typeof document === 'undefined') return false
  const element = findTargetElement(target)
  if (!element) return false
  const rect = element.getBoundingClientRect()
  const visible = rect.top >= VIEWPORT_PADDING
    && rect.left >= VIEWPORT_PADDING
    && rect.bottom <= window.innerHeight - VIEWPORT_PADDING
    && rect.right <= window.innerWidth - VIEWPORT_PADDING
  if (!visible) element.scrollIntoView({ behavior: 'auto', block: 'center', inline: 'nearest' })
  return true
}

function readLayout(target: string | string[], targetExclude?: string): TourLayout | null {
  const element = findTargetElement(target)
  const elementRect = element ? readRect(element) : null
  const viewport = element?.closest('[data-product-tour-viewport="settings"]')
  const rect = elementRect && viewport ? clipTourRectToViewport(elementRect, readRect(viewport)) : elementRect
  if (!rect || !(rect.right > 0 && rect.bottom > 0 && rect.left < innerWidth && rect.top < innerHeight)) return null
  let rects = [rect]
  const excluded = targetExclude ? document.querySelector(targetExclude)?.getBoundingClientRect() : null
  if (excluded && excluded.width > 0 && excluded.right > rect.left && excluded.left < rect.right && excluded.bottom > rect.top && excluded.top < rect.bottom) {
    rects = [
      { ...rect, right: Math.max(rect.left, excluded.left - 6), width: Math.max(0, excluded.left - 6 - rect.left) },
      { ...rect, left: Math.min(rect.right, excluded.right + 6), width: Math.max(0, rect.right - excluded.right - 6) },
    ].filter((part) => part.width > 0)
    if (rects.length === 0) return null
  }
  const left = Math.min(...rects.map((rect) => rect.left))
  const top = Math.min(...rects.map((rect) => rect.top))
  const right = Math.max(...rects.map((rect) => rect.right))
  const bottom = Math.max(...rects.map((rect) => rect.bottom))
  return { rects, anchor: { left, top, right, bottom, width: right - left, height: bottom - top } }
}

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(value, Math.max(min, max)))

export function chooseTourPosition(anchor: RectLike, preferred: ProductTourPlacement, cardWidth: number, cardHeight: number, viewportWidth: number, viewportHeight: number): CardPosition {
  const space = {
    top: anchor.top,
    right: viewportWidth - anchor.right,
    bottom: viewportHeight - anchor.bottom,
    left: anchor.left,
  }
  const needed = { top: cardHeight, right: cardWidth, bottom: cardHeight, left: cardWidth }
  const order: ProductTourPlacement[] = [preferred, 'bottom', 'right', 'top', 'left']
  const placement = order.find((side) => space[side] >= needed[side] + CARD_GAP + VIEWPORT_PADDING)
    ?? order.reduce((best, side) => space[side] > space[best] ? side : best, preferred)
  let left = anchor.left + anchor.width / 2 - cardWidth / 2
  let top = anchor.bottom + CARD_GAP
  if (placement === 'top') top = anchor.top - CARD_GAP - cardHeight
  if (placement === 'right') { left = anchor.right + CARD_GAP; top = anchor.top + anchor.height / 2 - cardHeight / 2 }
  if (placement === 'left') { left = anchor.left - CARD_GAP - cardWidth; top = anchor.top + anchor.height / 2 - cardHeight / 2 }
  left = clamp(left, VIEWPORT_PADDING, viewportWidth - cardWidth - VIEWPORT_PADDING)
  top = clamp(top, VIEWPORT_PADDING, viewportHeight - cardHeight - VIEWPORT_PADDING)
  const targetX = clamp(anchor.left + anchor.width / 2, VIEWPORT_PADDING, viewportWidth - VIEWPORT_PADDING)
  const targetY = clamp(anchor.top + anchor.height / 2, VIEWPORT_PADDING, viewportHeight - VIEWPORT_PADDING)
  const startX = placement === 'right' ? left : placement === 'left' ? left + cardWidth : clamp(targetX, left + 20, left + cardWidth - 20)
  const startY = placement === 'bottom' ? top : placement === 'top' ? top + cardHeight : clamp(targetY, top + 20, top + cardHeight - 20)
  const endX = placement === 'right' ? clamp(anchor.right + 5, 0, viewportWidth) : placement === 'left' ? clamp(anchor.left - 5, 0, viewportWidth) : targetX
  const endY = placement === 'bottom' ? clamp(anchor.bottom + 5, 0, viewportHeight) : placement === 'top' ? clamp(anchor.top - 5, 0, viewportHeight) : targetY
  return { left, top, placement, startX, startY, endX, endY }
}

function getConnectorPath(position: CardPosition): string {
  const { placement, startX, startY, endX, endY } = position
  if (placement === 'right') return `M ${startX} ${startY} C ${startX - 28} ${startY}, ${endX + 28} ${endY}, ${endX} ${endY}`
  if (placement === 'left') return `M ${startX} ${startY} C ${startX + 28} ${startY}, ${endX - 28} ${endY}, ${endX} ${endY}`
  if (placement === 'top') return `M ${startX} ${startY} C ${startX} ${startY + 28}, ${endX} ${endY - 28}, ${endX} ${endY}`
  return `M ${startX} ${startY} C ${startX} ${startY - 28}, ${endX} ${endY + 28}, ${endX} ${endY}`
}

function AnnotationExample() {
  return <div className="mt-3 rounded-xl border border-gm-border-subtle bg-gm-surface-elevated p-3" aria-label="批注工具栏只读示意">
    <p className="mb-2 text-micro text-gm-text-tertiary">批注工具栏示意 · 不会保存</p>
    <div className="flex items-center gap-2">
      {['#eab308', '#22a35a', '#3b82f6', '#ec4899'].map((color) => <span key={color} className="h-5 w-5 rounded-full border border-gm-border" style={{ backgroundColor: color }} />)}
      <span className="ml-2 rounded-md border border-gm-border px-2 py-1 text-micro text-gm-text-secondary">添加文字批注</span>
    </div>
  </div>
}

export function ProductTourOverlay({ open, topic, steps, stepIndex, onStepChange, onTopicChange, onClose, compact = false, headerIcon, trackingElement }: ProductTourOverlayProps) {
  const maskId = useId()
  const step = steps[stepIndex]
  const cardRef = useRef<HTMLDivElement | null>(null)
  const previousFocusRef = useRef<HTMLElement | null>(null)
  const [layout, setLayout] = useState<TourLayout | null>(null)
  const [position, setPosition] = useState<CardPosition | null>(null)
  const [targetMissing, setTargetMissing] = useState(false)
  const isMenu = topic === 'topics'
  const isWeb = typeof document !== 'undefined' && document.documentElement.dataset.gmRuntime === 'web'

  useEffect(() => {
    if (typeof document === 'undefined') return
    let style = document.getElementById(PRODUCT_TOUR_STYLE_ID)
    if (!style) {
      style = document.createElement('style')
      style.id = PRODUCT_TOUR_STYLE_ID
      style.textContent = productTourStyles
      document.head.appendChild(style)
    }
    const sharedStyle = style
    sharedStyle.dataset.users = String(Number(sharedStyle.dataset.users ?? 0) + 1)
    return () => {
      const users = Number(sharedStyle.dataset.users) - 1
      if (users === 0) sharedStyle.remove()
      else sharedStyle.dataset.users = String(users)
    }
  }, [])

  const measure = useCallback(() => {
    if (!open || !step) { setLayout(null); setPosition(null); return }
    const nextLayout = readLayout(step.target, step.targetExclude)
    setLayout(nextLayout)
    setTargetMissing(!nextLayout)
    if (!nextLayout) { setPosition(null); return }
    const cardRect = cardRef.current?.getBoundingClientRect()
    setPosition(chooseTourPosition(nextLayout.anchor, step.placement, cardRect?.width || CARD_WIDTH, cardRect?.height || 220, innerWidth, innerHeight))
  }, [open, step])

  useLayoutEffect(() => {
    if (!open || isMenu) return
    let frame = 0
    let attempts = 0
    const retry = () => {
      scrollTourTargetIntoView(step.target)
      measure()
      if (++attempts < 12) frame = requestAnimationFrame(retry)
    }
    retry()
    return () => cancelAnimationFrame(frame)
  }, [isMenu, measure, open, step?.target, stepIndex])

  useEffect(() => {
    if (!open || !step) return
    const handleChange = () => measure()
    window.addEventListener('resize', handleChange)
    window.addEventListener('scroll', handleChange, true)
    const resizeObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(handleChange)
    if (cardRef.current) resizeObserver?.observe(cardRef.current)
    if (trackingElement) resizeObserver?.observe(trackingElement)
    const selectors = Array.isArray(step.target) ? step.target : [step.target]
    selectors.forEach((selector) => document.querySelectorAll(selector).forEach((element) => resizeObserver?.observe(element)))
    const mutationObserver = new MutationObserver(handleChange)
    mutationObserver.observe(document.body, { childList: true, subtree: true })
    const positionObserver = trackingElement ? new MutationObserver(handleChange) : null
    if (trackingElement) positionObserver?.observe(trackingElement, { attributes: true, attributeFilter: ['style', 'class'] })
    return () => {
      window.removeEventListener('resize', handleChange)
      window.removeEventListener('scroll', handleChange, true)
      resizeObserver?.disconnect()
      mutationObserver.disconnect()
      positionObserver?.disconnect()
    }
  }, [measure, open, step, trackingElement])

  useEffect(() => {
    if (!open) return
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    return () => {
      previousFocusRef.current?.focus()
      previousFocusRef.current = null
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const handleKeyDown = (event: KeyboardEvent) => {
      event.stopPropagation()
      if (event.key === 'Tab') {
        const buttons = Array.from(cardRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])
        if (buttons.length === 0) { event.preventDefault(); return }
        const current = buttons.indexOf(document.activeElement as HTMLButtonElement)
        if (event.shiftKey && current <= 0) { event.preventDefault(); buttons[buttons.length - 1].focus() }
        else if (!event.shiftKey && current === buttons.length - 1) { event.preventDefault(); buttons[0].focus() }
        return
      }
      if (event.key === 'Escape') { event.preventDefault(); onClose() }
      else if (event.key === 'ArrowLeft' && !isMenu && stepIndex > 0) { event.preventDefault(); onStepChange(stepIndex - 1) }
      else if (event.key === 'ArrowRight' && !isMenu && stepIndex < steps.length - 1) { event.preventDefault(); onStepChange(stepIndex + 1) }
      else event.preventDefault()
    }
    window.addEventListener('keydown', handleKeyDown, true)
    cardRef.current?.focus()
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [isMenu, onClose, onStepChange, open, stepIndex, steps.length])

  if (!open || (!step && !isMenu) || typeof document === 'undefined') return null
  const cardStyle = isMenu || targetMissing || !position
    ? { left: '50%', top: '50%', transform: 'translate(-50%, -50%)' }
    : { left: position.left, top: position.top }
  const last = stepIndex === steps.length - 1
  const cardWidth = cardRef.current?.offsetWidth ?? CARD_WIDTH
  const cardHeight = cardRef.current?.offsetHeight ?? 220
  const endpointInsideCard = position && position.endX >= position.left && position.endX <= position.left + cardWidth
    && position.endY >= position.top && position.endY <= position.top + cardHeight
  const showArrow = !compact && Boolean(position && !endpointInsideCard && Math.hypot(position.endX - position.startX, position.endY - position.startY) >= 32)
  const path = position && showArrow ? getConnectorPath(position) : ''

  return createPortal(<div className="gm-product-tour" role="presentation" onPointerDown={(event) => event.stopPropagation()}>
    <button type="button" className="gm-product-tour__scrim" style={layout && !isMenu ? { background: 'transparent' } : undefined} aria-label={compact ? '跳过小窗引导' : '关闭专题选择'} onClick={onClose} />
    {!isMenu && layout && <svg className="gm-product-tour__focus-mask" aria-hidden="true">
      <defs><mask id={maskId} maskUnits="userSpaceOnUse" x="0" y="0" width="100%" height="100%">
        <rect width="100%" height="100%" fill="white" />
        {layout.rects.map((rect, index) => <rect key={index} x={rect.left - 6} y={rect.top - 6} width={rect.width + 12} height={rect.height + 12} rx="8" fill="black" />)}
      </mask></defs>
      <rect width="100%" height="100%" fill="var(--gm-tour-scrim)" mask={`url(#${maskId})`} />
      {layout.rects.map((rect, index) => <rect key={index} data-product-tour-focus="" x={rect.left - 6} y={rect.top - 6} width={rect.width + 12} height={rect.height + 12} rx="8" fill="none" stroke="var(--gm-tour-focus)" strokeWidth="1.5" />)}
    </svg>}
    {!isMenu && showArrow && position && <svg className="gm-product-tour__connector fixed inset-0 h-full w-full" aria-hidden="true">
      <defs>
        <marker id="product-tour-arrow" markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto" markerUnits="userSpaceOnUse">
          <path d="M1 1L6 4L1 7" />
        </marker>
      </defs>
      <path d={path} markerEnd="url(#product-tour-arrow)" />
      <circle cx={position.endX} cy={position.endY} r="3" />
    </svg>}
    <div ref={cardRef} className={`gm-product-tour__card ${compact ? 'gm-product-tour__card--compact p-4' : 'p-5'}`} style={cardStyle} role="dialog" aria-modal="true" aria-labelledby="product-tour-title" aria-describedby="product-tour-description" tabIndex={-1}>
      {!compact && <div className="gm-product-tour__eyebrow mb-2">
        <span>观墨使用导览</span>
        {isMenu ? <span>选择内容</span> : <div className="flex items-center gap-3"><button type="button" className="gm-product-tour__link" onClick={() => onTopicChange('topics')}>全部专题</button><span className="gm-product-tour__progress"><span>{stepIndex + 1}/{steps.length}</span><span className="gm-product-tour__progress-bar" aria-hidden="true"><span className="gm-product-tour__progress-bar is-active" style={{ width: `${((stepIndex + 1) / steps.length) * 100}%`, display: 'block' }} /></span></span></div>}
      </div>}
      <div className={compact ? 'flex items-center gap-2.5' : undefined}>
        {compact && headerIcon && <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-gm-primary/10 text-gm-primary">{headerIcon}</span>}
        <h2 id="product-tour-title" className={compact ? 'text-[13px] font-semibold leading-5' : 'text-heading font-bold'}>{isMenu ? '选择一个专题' : step.title}</h2>
      </div>
      {isMenu ? <div id="product-tour-description" className="mt-3 space-y-2">
        <button type="button" onClick={() => onTopicChange('overview')} className="gm-product-tour__topic">快速导览<span className="block text-micro text-gm-text-tertiary">用几步认识主要界面</span></button>
        {PRODUCT_TOUR_TOPICS.filter((item) => !isWeb || !item.desktopOnly).map((item) => <button key={item.id} type="button" onClick={() => onTopicChange(item.id)} className="gm-product-tour__topic">{item.title}<span className="block text-micro text-gm-text-tertiary">{item.description}</span></button>)}
      </div> : <><p id="product-tour-description" className="mt-3 whitespace-pre-line text-body leading-relaxed text-gm-text-secondary">{step.content}</p>{targetMissing && <p className="mt-2 text-caption text-gm-warning">当前界面暂时无法定位该功能，可继续阅读下一步。</p>}{step.example === 'annotation' && <AnnotationExample />}</>}
      {compact ? <div className="mt-3 flex items-center justify-between gap-3">
        <button type="button" className="gm-product-tour__link" onClick={onClose}>跳过</button>
        <button type="button" className="gm-product-tour__action" onClick={() => last ? onClose() : onStepChange(stepIndex + 1)}>{last ? '知道了' : '下一步'}</button>
      </div> : <div className={`mt-5 flex items-center gap-3 border-t border-gm-border-subtle pt-4 ${isMenu ? 'justify-end' : 'justify-between'}`}>
        <button type="button" className="gm-product-tour__link" onClick={onClose}>{isMenu ? '关闭' : last ? '完成导览' : '跳过'}</button>
        {!isMenu && <div className="flex items-center gap-2"><button type="button" className="gm-product-tour__action" disabled={stepIndex === 0} onClick={() => onStepChange(stepIndex - 1)}>上一步</button><button type="button" className="gm-product-tour__action gm-product-tour__action--primary" onClick={() => last ? onTopicChange('topics') : onStepChange(stepIndex + 1)}>{last ? '查看专题' : '下一步'}</button></div>}
      </div>}
    </div>
  </div>, document.body)
}
