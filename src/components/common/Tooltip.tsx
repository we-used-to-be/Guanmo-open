import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type Dispatch,
  type ReactNode,
  type RefObject,
  type SetStateAction,
} from 'react'
import { createPortal } from 'react-dom'

interface TooltipProps {
  content: ReactNode
  children: ReactNode
  className?: string
  onlyWhenTruncated?: boolean
}

type TooltipPosition = {
  left: number
  top: number
  arrowLeft: number
  anchorCenter: number
}

const TOOLTIP_MARGIN = 8
const TOOLTIP_ARROW_MARGIN = 12
const TOOLTIP_FALLBACK_WIDTH = 264

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max)
}

function getTooltipPosition(anchorCenter: number, top: number, tooltipWidth = TOOLTIP_FALLBACK_WIDTH): TooltipPosition {
  const width = Math.min(tooltipWidth, window.innerWidth - TOOLTIP_MARGIN * 2)
  const left = clamp(anchorCenter - width / 2, TOOLTIP_MARGIN, window.innerWidth - width - TOOLTIP_MARGIN)
  const arrowLeft = clamp(anchorCenter - left, TOOLTIP_ARROW_MARGIN, width - TOOLTIP_ARROW_MARGIN)
  return { left, top, arrowLeft, anchorCenter }
}

function getTriggerTooltipPosition(trigger: HTMLElement) {
  const rect = trigger.getBoundingClientRect()
  return getTooltipPosition(rect.left + rect.width / 2, rect.bottom + 7)
}

function getTooltipStyle(position: TooltipPosition): CSSProperties {
  return {
    left: position.left,
    top: position.top,
    '--gm-tooltip-arrow-left': `${position.arrowLeft}px`,
  } as CSSProperties
}

function useMeasuredTooltipPosition<T extends TooltipPosition>(
  tooltipRef: RefObject<HTMLDivElement>,
  position: T | null,
  setPosition: Dispatch<SetStateAction<T | null>>,
) {
  useLayoutEffect(() => {
    if (!position || !tooltipRef.current) return
    const next = getTooltipPosition(position.anchorCenter, position.top, tooltipRef.current.offsetWidth)
    if (next.left === position.left && next.arrowLeft === position.arrowLeft) return
    setPosition(current => current ? { ...current, left: next.left, arrowLeft: next.arrowLeft } : current)
  }, [position, setPosition, tooltipRef])
}

export function Tooltip({ content, children, className = '', onlyWhenTruncated = false }: TooltipProps) {
  const triggerRef = useRef<HTMLSpanElement>(null)
  const tooltipRef = useRef<HTMLDivElement>(null)
  const timerRef = useRef<number | null>(null)
  const [position, setPosition] = useState<TooltipPosition | null>(null)

  useMeasuredTooltipPosition(tooltipRef, position, setPosition)

  const hide = () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current)
    timerRef.current = null
    setPosition(null)
  }

  const show = () => {
    const trigger = triggerRef.current
    if (!trigger || (onlyWhenTruncated && trigger.scrollWidth <= trigger.clientWidth)) return
    const nextPosition = getTriggerTooltipPosition(trigger)
    timerRef.current = window.setTimeout(() => {
      setPosition(nextPosition)
    }, 320)
  }

  useEffect(() => () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current)
  }, [])

  return (
    <>
      <span
        ref={triggerRef}
        className={className}
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
      >
        {children}
      </span>
      {position && createPortal(
        <div ref={tooltipRef} role="tooltip" className="gm-tooltip" style={getTooltipStyle(position)}>
          {content}
        </div>,
        document.body,
      )}
    </>
  )
}

export function GlobalTooltip() {
  const activeRef = useRef<{ element: HTMLElement; title: string } | null>(null)
  const tooltipRef = useRef<HTMLDivElement>(null)
  const timerRef = useRef<number | null>(null)
  const [tooltip, setTooltip] = useState<(TooltipPosition & { content: string }) | null>(null)

  useMeasuredTooltipPosition(tooltipRef, tooltip, setTooltip)

  useEffect(() => {
    const clear = () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current)
      timerRef.current = null
      setTooltip(null)
      const active = activeRef.current
      if (active && active.element.isConnected) active.element.setAttribute('title', active.title)
      activeRef.current = null
    }

    const show = (element: HTMLElement) => {
      if (activeRef.current?.element === element) return
      clear()
      const title = element.getAttribute('title')
      if (!title) return
      element.removeAttribute('title')
      activeRef.current = { element, title }
      const nextPosition = getTriggerTooltipPosition(element)
      timerRef.current = window.setTimeout(() => {
        setTooltip({
          content: title,
          ...nextPosition,
        })
      }, 320)
    }

    const findTrigger = (target: EventTarget | null) =>
      target instanceof Element ? target.closest<HTMLElement>('[title]') : null

    const handlePointerOver = (event: PointerEvent) => {
      const trigger = findTrigger(event.target)
      if (trigger) show(trigger)
    }
    const handlePointerOut = (event: PointerEvent) => {
      const active = activeRef.current?.element
      if (!active || (event.relatedTarget instanceof Node && active.contains(event.relatedTarget))) return
      clear()
    }
    const handleFocusIn = (event: FocusEvent) => {
      const trigger = findTrigger(event.target)
      if (trigger) show(trigger)
    }
    const handleFocusOut = () => clear()

    document.addEventListener('pointerover', handlePointerOver)
    document.addEventListener('pointerout', handlePointerOut)
    document.addEventListener('focusin', handleFocusIn)
    document.addEventListener('focusout', handleFocusOut)
    return () => {
      document.removeEventListener('pointerover', handlePointerOver)
      document.removeEventListener('pointerout', handlePointerOut)
      document.removeEventListener('focusin', handleFocusIn)
      document.removeEventListener('focusout', handleFocusOut)
      clear()
    }
  }, [])

  return tooltip ? createPortal(
    <div ref={tooltipRef} role="tooltip" className="gm-tooltip" style={getTooltipStyle(tooltip)}>
      {tooltip.content}
    </div>,
    document.body,
  ) : null
}

export function TruncatedText({ text, className = '' }: { text: string; className?: string }) {
  return (
    <Tooltip content={text} onlyWhenTruncated className={`min-w-0 truncate ${className}`}>
      {text}
    </Tooltip>
  )
}
