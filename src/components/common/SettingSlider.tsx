import { useCallback, useEffect, useId, useRef, useState, type CSSProperties } from 'react'

interface SettingSliderProps {
  label: string
  value: number
  min: number
  max: number
  step: number
  onChange: (value: number) => void
  format?: (value: number) => string
  debounceMs?: number
  className?: string
  valueClassName?: string
}

export function SettingSlider({
  label,
  value,
  min,
  max,
  step,
  onChange,
  format,
  debounceMs,
  className = '',
  valueClassName = 'w-12',
}: SettingSliderProps) {
  const precision = step < 1 ? (step.toString().split('.')[1]?.length ?? 1) : 0
  const datalistId = useId()
  const ticks: number[] = []
  for (let tick = min; tick <= max + step * 0.5; tick = +(tick + step).toFixed(10)) {
    ticks.push(+tick.toFixed(precision))
  }

  const [localValue, setLocalValue] = useState(value)
  const debounceRef = useRef<number | null>(null)
  const pendingValueRef = useRef<number | null>(null)
  const draggingRef = useRef(false)

  useEffect(() => {
    if (!draggingRef.current) setLocalValue(value)
  }, [value])

  const displayValue = debounceMs ? localValue : value
  const progress = Math.max(0, Math.min(100, ((displayValue - min) / (max - min)) * 100))
  const sliderStyle = {
    '--gm-setting-slider-thumb-position': `calc(${progress}% + ${9 - progress * 0.18}px)`,
    '--gm-setting-slider-fill-width': `calc(${progress}% + ${18 - progress * 0.18}px)`,
  } as CSSProperties

  const commitValue = useCallback((nextValue: number) => {
    if (debounceRef.current !== null) window.clearTimeout(debounceRef.current)
    debounceRef.current = null
    pendingValueRef.current = null
    draggingRef.current = false
    onChange(nextValue)
  }, [onChange])

  const flushPendingValue = useCallback(() => {
    if (pendingValueRef.current !== null) commitValue(pendingValueRef.current)
  }, [commitValue])

  const handleChange = useCallback((rawValue: number) => {
    const nextValue = +rawValue.toFixed(precision)
    if (!debounceMs) {
      onChange(nextValue)
      return
    }
    draggingRef.current = true
    pendingValueRef.current = nextValue
    setLocalValue(nextValue)
    if (debounceRef.current !== null) window.clearTimeout(debounceRef.current)
    debounceRef.current = window.setTimeout(() => commitValue(nextValue), debounceMs)
  }, [commitValue, debounceMs, onChange, precision])

  useEffect(() => () => {
    if (debounceRef.current !== null) window.clearTimeout(debounceRef.current)
  }, [])

  return (
    <div className={`flex min-w-0 items-center gap-3 ${className}`}>
      <div className="gm-setting-slider" style={sliderStyle}>
        <div className="gm-setting-slider__track" aria-hidden="true">
          <span className="gm-setting-slider__fill" />
          <span className="gm-setting-slider__thumb" />
        </div>
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={displayValue}
          list={datalistId}
          aria-label={label}
          onChange={(event) => handleChange(Number.parseFloat(event.target.value))}
          onPointerUp={flushPendingValue}
          onKeyUp={flushPendingValue}
          className="gm-setting-slider__input"
        />
      </div>
      <datalist id={datalistId}>
        {ticks.map((tick) => <option key={tick} value={tick} />)}
      </datalist>
      <span className={`text-mono text-caption text-gm-text-secondary text-right tabular-nums ${valueClassName}`}>
        {format ? format(displayValue) : displayValue}
      </span>
    </div>
  )
}
