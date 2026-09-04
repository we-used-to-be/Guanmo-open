import { useCallback, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react'

import './SegmentedTabs.css'

export interface SegmentedTabItem<T extends string = string> {
  value: T
  label: ReactNode
  disabled?: boolean
}

export interface SegmentedTabsProps<T extends string = string> {
  items: readonly SegmentedTabItem<T>[]
  value: T
  onChange: (value: T) => void
  disabled?: boolean
  size?: 'small' | 'medium'
  className?: string
  ariaLabel: string
}

type IndicatorPosition = {
  left: number
  width: number
  initial: boolean
}

export function SegmentedTabs<T extends string = string>({
  items,
  value,
  onChange,
  disabled = false,
  size = 'small',
  className = '',
  ariaLabel,
}: SegmentedTabsProps<T>) {
  const rootRef = useRef<HTMLDivElement>(null)
  const itemRefs = useRef(new Map<T, HTMLButtonElement>())
  const [indicator, setIndicator] = useState<IndicatorPosition | null>(null)

  const activeItem = items.find((item) => item.value === value)
  const activeValue = activeItem?.value ?? null
  const activeItemDisabled = Boolean(activeItem?.disabled)
  const focusableValue = activeItem && !activeItemDisabled
    ? activeValue
    : (items.find((item) => !item.disabled)?.value ?? null)
  const itemSignature = items.map((item) => item.value).join('\u0000')

  const measureIndicator = useCallback(() => {
    const activeButton = activeValue === null ? undefined : itemRefs.current.get(activeValue)
    if (!activeButton || activeValue === null) {
      setIndicator(null)
      return
    }

    if (activeButton.offsetWidth <= 0) {
      setIndicator(null)
      return
    }

    const nextPosition = {
      left: activeButton.offsetLeft,
      width: activeButton.offsetWidth,
    }
    setIndicator((current) => (
      current && !current.initial && current.left === nextPosition.left && current.width === nextPosition.width
        ? current
        : { ...nextPosition, initial: current === null }
    ))
  }, [activeValue])

  useLayoutEffect(() => {
    measureIndicator()

    const root = rootRef.current
    if (!root || typeof ResizeObserver !== 'function') return

    const observer = new ResizeObserver(measureIndicator)
    observer.observe(root)
    itemRefs.current.forEach((item) => observer.observe(item))
    return () => observer.disconnect()
  }, [itemSignature, measureIndicator])

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>, currentValue: T) => {
    if (disabled) return

    const currentIndex = items.findIndex((item) => item.value === currentValue)
    if (currentIndex < 0) return

    let nextIndex: number | null = null
    if (event.key === 'Home') {
      nextIndex = items.findIndex((item) => !item.disabled)
    } else if (event.key === 'End') {
      for (let index = items.length - 1; index >= 0; index -= 1) {
        if (!items[index].disabled) {
          nextIndex = index
          break
        }
      }
    } else if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      const direction = event.key === 'ArrowRight' ? 1 : -1
      for (let step = 1; step <= items.length; step += 1) {
        const candidateIndex = (currentIndex + direction * step + items.length) % items.length
        if (!items[candidateIndex].disabled) {
          nextIndex = candidateIndex
          break
        }
      }
    }

    if (nextIndex === null || nextIndex < 0) return
    const nextItem = items[nextIndex]
    if (!nextItem || nextItem.disabled) return

    event.preventDefault()
    if (nextItem.value !== value) onChange(nextItem.value)
    itemRefs.current.get(nextItem.value)?.focus()
  }

  const indicatorStyle = indicator
    ? {
        '--gm-segmented-tabs-indicator-left': `${indicator.left}px`,
        '--gm-segmented-tabs-indicator-width': `${indicator.width}px`,
      } as CSSProperties
    : undefined

  return (
    <div
      ref={rootRef}
      className={`gm-segmented-tabs gm-segmented-tabs--${size} ${className}`.trim()}
      role="tablist"
      aria-label={ariaLabel}
      aria-orientation="horizontal"
      aria-disabled={disabled || undefined}
      data-indicator-initial={indicator?.initial ? 'true' : 'false'}
      style={indicatorStyle}
    >
      {indicator && <span className="gm-segmented-tabs__indicator" aria-hidden="true" />}
      {items.map((item) => {
        const isActive = item.value === value
        const isDisabled = disabled || Boolean(item.disabled)
        return (
          <button
            key={item.value}
            ref={(element) => {
              if (element) itemRefs.current.set(item.value, element)
              else itemRefs.current.delete(item.value)
            }}
            type="button"
            role="tab"
            className="gm-segmented-tabs__item"
            aria-selected={isActive}
            aria-disabled={isDisabled || undefined}
            disabled={isDisabled}
            tabIndex={!isDisabled && item.value === focusableValue ? 0 : -1}
            onClick={() => {
              if (!isDisabled && item.value !== value) onChange(item.value)
            }}
            onKeyDown={(event) => handleKeyDown(event, item.value)}
          >
            {item.label}
          </button>
        )
      })}
    </div>
  )
}
