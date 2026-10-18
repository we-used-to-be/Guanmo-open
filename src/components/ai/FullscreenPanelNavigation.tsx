import { useEffect, useRef, useState } from 'react'
import { motion } from 'motion/react'
import { useMorphingMotion } from '@/components/common/useMorphingMotion'
import type { AiPanelView } from '@/services/aiPanelNavigation'
import { FullscreenNavigationHint } from './FullscreenNavigationHint'

interface Props {
  active: boolean
  view: AiPanelView
  databaseEnabled: boolean
  productTourActive?: boolean
  onSelect: (view: AiPanelView) => void
}

export function FullscreenPanelNavigation({ active, view, databaseEnabled, productTourActive = false, onSelect }: Props) {
  const [expanded, setExpanded] = useState(false)
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const restoreFocusRef = useRef(false)
  const focusNavigationRef = useRef(false)
  const delayRef = useRef(2000)
  const { surface, reducedMotion } = useMorphingMotion(
    { width: 32, height: 12, borderRadius: 6, padding: 0 },
    { width: expanded ? 312 : 32, height: expanded ? 44 : 12, borderRadius: expanded ? 22 : 6, padding: expanded ? 4 : 0 },
  )

  useEffect(() => {
    delayRef.current = 2000
    setExpanded(false)
    setHovered(false)
    setFocused(false)
  }, [active])

  useEffect(() => {
    if (!active || !expanded || hovered || focused) return
    const timer = window.setTimeout(() => setExpanded(false), delayRef.current)
    return () => window.clearTimeout(timer)
  }, [active, expanded, hovered, focused])

  useEffect(() => {
    if (active && expanded && focusNavigationRef.current) {
      focusNavigationRef.current = false
      rootRef.current?.querySelector<HTMLButtonElement>('nav button:not(:disabled)')?.focus()
    }
    if (active && !expanded && restoreFocusRef.current) {
      restoreFocusRef.current = false
      triggerRef.current?.focus()
    }
  }, [active, expanded])

  useEffect(() => {
    if (!active) return
    const collapse = () => {
      restoreFocusRef.current = Boolean(rootRef.current?.contains(document.activeElement))
      setExpanded(false)
      setHovered(false)
      setFocused(false)
    }
    const handlePointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) collapse()
    }
    document.addEventListener('pointerdown', handlePointerDown, true)
    window.addEventListener('resize', collapse)
    const header = rootRef.current?.parentElement?.parentElement
    let previousWidth: number | undefined
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(([entry]) => {
      if (!entry) return
      if (previousWidth !== undefined && previousWidth !== entry.contentRect.width) collapse()
      previousWidth = entry.contentRect.width
    })
    if (header) observer?.observe(header)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true)
      window.removeEventListener('resize', collapse)
      observer?.disconnect()
    }
  }, [active])

  return (
    <div
      ref={rootRef}
      className="pointer-events-none absolute left-1/2 top-1 w-[calc(100%_-_24px)] max-w-[312px] -translate-x-1/2 flex items-start justify-center"
      onPointerDown={(event) => event.stopPropagation()}
      onPointerEnter={(event) => {
        if (event.currentTarget.contains(event.target as Node)) setHovered(true)
      }}
      onPointerLeave={(event) => {
        if (!event.currentTarget.contains(event.target as Node)) return
        delayRef.current = 2000
        setHovered(false)
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || !expanded) return
        event.preventDefault()
        event.stopPropagation()
        restoreFocusRef.current = true
        setExpanded(false)
      }}
    >
      <motion.div
        {...surface}
        initial={false}
        transition={reducedMotion ? { duration: 0 } : { type: 'tween', duration: 0.24, ease: 'easeInOut' }}
        className="pointer-events-auto relative max-w-full origin-top overflow-hidden border border-transparent"
      >
        <motion.div
          aria-hidden="true"
          initial={false}
          animate={{ opacity: expanded ? 1 : 0 }}
          transition={reducedMotion ? { duration: 0 } : { duration: 0.24, ease: 'easeInOut' }}
          className="pointer-events-none absolute inset-0 rounded-[inherit] border border-gm-border bg-gm-surface"
        />
        <motion.button
          data-product-tour="fullscreen-page-switcher"
          ref={triggerRef}
          type="button"
          aria-label="切换页面"
          aria-expanded={expanded}
          aria-hidden={expanded}
          initial={false}
          animate={{ opacity: expanded ? 0 : 1 }}
          transition={{ duration: reducedMotion ? 0 : 0.08, delay: expanded || reducedMotion ? 0 : 0.16, ease: 'easeInOut' }}
          tabIndex={expanded ? -1 : 0}
          onClick={(event) => {
            delayRef.current = 2000
            focusNavigationRef.current = event.detail === 0
            setExpanded(true)
          }}
          className={`absolute left-1/2 top-0 flex h-3 w-8 -translate-x-1/2 cursor-pointer items-center justify-center gap-1 py-1 text-gm-text-secondary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-gm-primary ${expanded ? 'pointer-events-none' : ''}`}
        >
          {[0, 1, 2].map((dot) => <span key={dot} aria-hidden="true" className="h-1 w-1 rounded-full bg-current" />)}
        </motion.button>
        <motion.nav
          aria-label="侧栏页面"
          aria-hidden={!expanded}
          initial={false}
          animate={{ opacity: expanded ? 1 : 0 }}
          transition={{ duration: reducedMotion ? 0 : 0.1, delay: expanded && !reducedMotion ? 0.14 : 0, ease: 'easeInOut' }}
          className={`absolute left-1/2 top-1 flex h-[34px] w-[calc(100%_-_12px)] -translate-x-1/2 items-center gap-1 ${expanded ? '' : 'pointer-events-none'}`}
          onFocus={() => setFocused(true)}
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
              delayRef.current = 2000
              setFocused(false)
            }
          }}
        >
          {([['chat', 'AI 助手'], ['artifacts', '阅读成果'], ['reminders', '阅读提醒']] as const).map(([target, label]) => (
            <button
              key={target}
              type="button"
              aria-current={view === target ? 'page' : undefined}
              disabled={target !== 'chat' && !databaseEnabled}
              tabIndex={expanded ? 0 : -1}
              onClick={() => { delayRef.current = 2000; onSelect(target) }}
              className={`h-full min-w-0 flex-1 whitespace-nowrap rounded-full text-[14px] font-medium leading-tight transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-gm-primary disabled:cursor-not-allowed disabled:opacity-50 ${view === target ? 'bg-gm-primary/10 text-gm-primary' : 'text-gm-text-secondary hover:bg-gm-surface-hover hover:text-gm-text'}`}
            >
              {label}
            </button>
          ))}
        </motion.nav>
      </motion.div>
      <FullscreenNavigationHint
        active={active}
        suppressed={productTourActive}
        navigationExpanded={expanded}
        anchorRef={triggerRef}
        databaseEnabled={databaseEnabled}
        onDismiss={() => triggerRef.current?.focus()}
      />
    </div>
  )
}
