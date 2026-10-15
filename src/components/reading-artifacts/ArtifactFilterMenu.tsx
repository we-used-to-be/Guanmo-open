import { ChevronDown } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import { ContextMenu, ContextMenuItem } from '@/components/common/ContextMenu'

export function ArtifactFilterMenu({ value, onChange, label, ariaLabel, menuLabel, options, disabled = false }: {
  value: string
  onChange: (value: string, trigger: HTMLButtonElement) => void
  label: string
  ariaLabel: string
  menuLabel: string
  options: { value: string; label: string }[]
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuId = useId()

  useEffect(() => {
    if (disabled) setOpen(false)
  }, [disabled])

  const select = (next: string) => {
    if (triggerRef.current) onChange(next, triggerRef.current)
    setOpen(false)
  }

  return (
    <div className="relative min-w-0 shrink-0 max-w-[160px]">
      <button
        ref={triggerRef}
        type="button"
        aria-label={ariaLabel}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((current) => !current)}
        className="flex h-8 max-w-full items-center gap-1.5 rounded-md border border-gm-border bg-gm-surface px-2.5 text-micro font-bold text-gm-text-secondary outline-none transition-colors hover:bg-gm-surface-hover focus-visible:border-gm-primary focus-visible:ring-1 focus-visible:ring-gm-primary/30 disabled:opacity-50"
      >
        <span className="truncate">{label}</span>
        <ChevronDown size={14} strokeWidth={1.8} className={`transition-transform duration-150 ${open ? 'rotate-180' : ''}`} aria-hidden="true" />
      </button>
      {open && !disabled && (
        <ContextMenu id={menuId} anchor={triggerRef.current} placement="bottom-end" aria-label={menuLabel} minWidth={160} maxWidth={240} onClose={() => setOpen(false)}>
          {options.map((option) => {
            const selected = value === option.value
            return (
              <ContextMenuItem
                key={option.value}
                role="menuitemradio"
                selected={selected}
                onClick={() => select(option.value)}
              >
                <span className="truncate">{option.label}</span>
              </ContextMenuItem>
            )
          })}
        </ContextMenu>
      )}
    </div>
  )
}
