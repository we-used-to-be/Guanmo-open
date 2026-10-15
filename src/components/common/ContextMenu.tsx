import { useEffect, useLayoutEffect, useRef, useState, type ButtonHTMLAttributes, type HTMLAttributes } from 'react'
import { createPortal } from 'react-dom'

const MENU_OPTION_FEEDBACK_CLASS = 'gm-menu-option'

export interface ContextMenuPosition {
  x: number
  y: number
}

interface ContextMenuProps extends Omit<HTMLAttributes<HTMLDivElement>, 'role' | 'style'> {
  position?: ContextMenuPosition
  anchor?: HTMLElement | null
  placement?: 'bottom-start' | 'bottom-end' | 'top-end'
  onClose: () => void
  minWidth?: number
  maxWidth?: number
  role?: 'menu' | 'listbox' | 'dialog'
}

export function ContextMenu({ position, anchor, placement = 'bottom-start', onClose, children, minWidth = 160, maxWidth, role = 'menu', className = '', ...props }: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  const originRef = useRef(anchor ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null))
  const restoreFocusRef = useRef(true)
  const [adjusted, setAdjusted] = useState(position ?? { x: 0, y: 0 })

  useLayoutEffect(() => {
    const menu = menuRef.current
    if (!menu) return
    const margin = 8
    const width = menu.offsetWidth
    const height = menu.offsetHeight
    const rect = anchor?.getBoundingClientRect()
    const preferAbove = placement === 'top-end'
    const sourceX = rect ? (placement === 'bottom-start' ? rect.left : rect.right - width) : position?.x ?? margin
    const below = rect ? rect.bottom + 4 : position?.y ?? margin
    const above = rect ? rect.top - height - 4 : below - height
    const preferredY = preferAbove && above >= margin ? above
      : below + height > window.innerHeight - margin && above >= margin ? above : below
    const x = Math.max(margin, Math.min(sourceX, window.innerWidth - width - margin))
    const y = Math.max(margin, Math.min(preferredY, window.innerHeight - height - margin))
    setAdjusted((current) => current.x === x && current.y === y ? current : { x, y })
  }, [anchor, placement, position?.x, position?.y, children, minWidth, maxWidth, role])

  useLayoutEffect(() => {
    const menu = menuRef.current
    if (!menu) return
    const selected = menu.querySelector<HTMLElement>('[data-menu-item]:not(:disabled)[data-selected="true"]')
    const first = role === 'dialog'
      ? menu.querySelector<HTMLElement>('input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [contenteditable="true"]')
        ?? menu.querySelector<HTMLElement>('button:not(:disabled), [tabindex="0"]')
      : menu.querySelector<HTMLElement>('[data-menu-item]:not(:disabled)')
    const target = selected ?? first ?? menu
    target.focus({ preventScroll: true })
    target.scrollIntoView?.({ block: 'nearest' })
  }, [role])

  useEffect(() => {
    const menu = menuRef.current
    const outside = (event: Event) => {
      if (event.target instanceof Node && (menu?.contains(event.target) || anchor?.contains(event.target))) return
      restoreFocusRef.current = false
      closeRef.current()
    }
    const scroll = (event: Event) => {
      if (!(event.target instanceof Node) || !menu?.contains(event.target)) closeRef.current()
    }
    const resize = () => closeRef.current()
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopImmediatePropagation()
        closeRef.current()
        return
      }
      const target = event.target instanceof HTMLElement ? event.target : null
      if (!target || !menu?.contains(target) || role === 'dialog') return
      if (event.key === 'Tab') {
        originRef.current?.focus({ preventScroll: true })
        closeRef.current()
        return
      }
      if (target.closest('input, textarea, select, [contenteditable="true"], [role="slider"], [role="spinbutton"]')) return
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
      const items = Array.from(menu.querySelectorAll<HTMLButtonElement>('[data-menu-item]:not(:disabled)'))
      if (!items.length) return
      event.preventDefault()
      event.stopImmediatePropagation()
      const index = items.findIndex((item) => item === document.activeElement)
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
        : (index + (event.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length
      items[next].focus({ preventScroll: true })
      items[next].scrollIntoView?.({ block: 'nearest' })
    }
    window.addEventListener('pointerdown', outside, true)
    window.addEventListener('click', outside)
    window.addEventListener('scroll', scroll, true)
    window.addEventListener('resize', resize)
    window.addEventListener('keydown', key, true)
    return () => {
      window.removeEventListener('pointerdown', outside, true)
      window.removeEventListener('click', outside)
      window.removeEventListener('scroll', scroll, true)
      window.removeEventListener('resize', resize)
      window.removeEventListener('keydown', key, true)
    }
  }, [anchor, role])

  useEffect(() => {
    const menu = menuRef.current
    const origin = originRef.current
    return () => {
      if (restoreFocusRef.current && origin?.isConnected && (menu?.contains(document.activeElement) || document.activeElement === document.body)) {
        origin.focus({ preventScroll: true })
      }
    }
  }, [])

  return createPortal(
    <div
      {...props}
      ref={menuRef}
      role={role}
      tabIndex={-1}
      data-context-menu="true"
      className={`gm-menu-surface fixed z-[1100] max-h-[70vh] overflow-y-auto rounded-xl border border-gm-border bg-gm-surface shadow-lg animate-context-menu-in ${role === 'dialog' ? 'p-2' : 'py-1.5'} ${className}`}
      style={{ left: adjusted.x, top: adjusted.y, minWidth: Math.min(minWidth, window.innerWidth - 16), maxWidth: Math.min(maxWidth ?? window.innerWidth - 16, window.innerWidth - 16) }}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      {children}
    </div>,
    document.body,
  )
}

export function ContextMenuItem({
  children,
  onClick,
  disabled = false,
  selected = false,
  danger = false,
  role = 'menuitem',
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { selected?: boolean; danger?: boolean }) {
  if (!children) return null

  return (
    <button
      {...props}
      type="button"
      role={role}
      data-menu-item="true"
      data-selected={selected || undefined}
      data-danger={danger || undefined}
      aria-checked={role === 'menuitemradio' || role === 'menuitemcheckbox' ? selected : undefined}
      aria-selected={role === 'option' ? selected : undefined}
      onClick={onClick}
      disabled={disabled}
      className={`${MENU_OPTION_FEEDBACK_CLASS} mx-1.5 flex w-[calc(100%-0.75rem)] items-center gap-2 rounded-md px-2 py-1.5 text-left text-caption font-medium text-gm-text disabled:cursor-not-allowed disabled:opacity-45 ${className}`}
    >
      <span className="min-w-0 flex-1">{children}</span>
      {selected && <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="shrink-0"><path d="m5 12 4 4L19 6" /></svg>}
    </button>
  )
}

export function ContextMenuGroupTitle({
  children,
  variant = 'default',
}: {
  children: React.ReactNode
  variant?: 'default' | 'strong'
}) {
  const className = variant === 'strong'
    ? 'mx-1.5 mt-1 rounded-md border-l-2 border-gm-text-secondary/75 bg-gm-primary-subtle/25 px-2 py-1 text-[10px] font-medium uppercase leading-none tracking-[0.14em] text-gm-text-tertiary'
    : 'mx-1.5 mt-1 rounded-md border-l-2 border-gm-primary/45 bg-gm-primary-subtle/25 px-2 py-1 text-[10px] font-medium uppercase leading-none tracking-[0.14em] text-gm-text-tertiary'

  return (
    <div className={className}>
      {children}
    </div>
  )
}

export function ContextMenuSeparator() {
  return <div className="my-1 h-px bg-gm-border-subtle" />
}
