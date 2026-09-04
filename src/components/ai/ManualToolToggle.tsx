import { useState, useEffect, useCallback, useRef } from 'react'
import { Button } from '@/vendor/animal-island-ui'

export type ManualCapability = 'knowledge' | 'memory' | 'web'

interface ManualToolToggleProps {
  onChange: (capabilities: ManualCapability[]) => void
  onReasoningModeChange?: (mode: 'off' | 'on') => void
  disabled?: boolean
  resetKey?: number // 用于外部触发重置
}

export function ManualToolToggle({ onChange, onReasoningModeChange, disabled = false, resetKey }: ManualToolToggleProps) {
  const [reasoningMode, setReasoningMode] = useState<'off' | 'on'>('off')

  // 外部触发重置
  useEffect(() => {
    if (resetKey !== undefined) {
      setReasoningMode('off')
    }
  }, [resetKey])

  const toggleReasoning = useCallback(() => {
    if (disabled) return
    const newMode = reasoningMode === 'off' ? 'on' : 'off'
    setReasoningMode(newMode)
    onReasoningModeChange?.(newMode)
  }, [disabled, reasoningMode, onReasoningModeChange])

  return (
    <div className="relative group flex-shrink-0">
      <Button
        type="default"
        size="small"
        disabled={disabled}
        onClick={toggleReasoning}
        aria-label="深度思考"
        aria-pressed={reasoningMode === 'on'}
        title="开启深度思考"
          icon={
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M9 18h6" />
              <path d="M10 22h4" />
              <path d="M12 2a7 7 0 0 0-4 12.74V17h8v-2.26A7 7 0 0 0 12 2Z" />
            </svg>
          }
          className={`
          gm-manual-tool-toggle gm-manual-tool-toggle--icon !h-8 !px-1 !py-0 !rounded-xl
          ${reasoningMode === 'on'
            ? 'gm-manual-tool-toggle--active font-semibold'
            : 'text-gm-text-tertiary'
          }
        `}
      >
        <span className="text-micro leading-none">深度思考</span>
        {reasoningMode === 'on' && <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden="true" />}
      </Button>
    </div>
  )
}
