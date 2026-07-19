import { useState, useEffect, useCallback, useRef } from 'react'
import { useSettingsStore } from '@/stores/settingsStore'
import { getRagStatsAsync } from '@/services/rag/pipeline'
import { isDatabaseReady } from '@/services/database/db'
import { Button } from '@/vendor/animal-island-ui'

export type ManualCapability = 'knowledge' | 'memory' | 'web'

interface ManualToolToggleProps {
  onChange: (capabilities: ManualCapability[]) => void
  disabled?: boolean
  resetKey?: number // 用于外部触发重置
}

interface ToggleOption {
  id: ManualCapability
  label: string
  tooltip: string
  icon: React.ReactNode
  checkEnabled: () => Promise<boolean>
}

async function checkKnowledgeEnabled(): Promise<boolean> {
  try {
    // 先检查数据库是否就绪
    if (!isDatabaseReady()) return false
    const stats = await getRagStatsAsync()
    return stats.documents > 0
  } catch {
    return false
  }
}

const TOGGLE_OPTIONS: ToggleOption[] = [
  {
    id: 'knowledge',
    label: '查知识库',
    tooltip: '选中后强制检索本地知识库，确保回答基于文档内容',
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
        <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
      </svg>
    ),
    checkEnabled: checkKnowledgeEnabled,
  },
  {
    id: 'memory',
    label: '查记忆',
    tooltip: '选中后强制查询长期记忆，回答基于您的历史偏好和习惯',
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2z" />
        <path d="M12 6v6l4 2" />
      </svg>
    ),
    checkEnabled: async () => {
      // Memory 始终可用（本地存储）
      return true
    },
  },
  {
    id: 'web',
    label: '联网搜索',
    tooltip: '选中后强制联网搜索，获取最新信息和资料',
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="10" />
        <line x1="2" y1="12" x2="22" y2="12" />
        <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
      </svg>
    ),
    checkEnabled: async () => {
      const { ai } = useSettingsStore.getState()
      return Boolean(ai.webSearchEnabled)
    },
  },
]

export function ManualToolToggle({ onChange, disabled = false, resetKey }: ManualToolToggleProps) {
  const [selected, setSelected] = useState<ManualCapability[]>([])
  const [enabledStates, setEnabledStates] = useState<Record<ManualCapability, boolean>>({
    knowledge: true,
    memory: true,
    web: true,
  })
  const retryCountRef = useRef(0)

  // 检查各工具的启用状态
  const checkAllEnabled = useCallback(async () => {
    const states: Record<string, boolean> = {}
    for (const option of TOGGLE_OPTIONS) {
      states[option.id] = await option.checkEnabled()
    }
    setEnabledStates(states as Record<ManualCapability, boolean>)

    // 如果知识库未启用，延迟重试（数据库可能还没初始化完成）
    if (!states.knowledge && retryCountRef.current < 3) {
      retryCountRef.current++
      setTimeout(checkAllEnabled, 1000)
    }
  }, [])

  useEffect(() => {
    // 延迟首次检查，等待数据库初始化
    const timer = setTimeout(checkAllEnabled, 500)
    return () => clearTimeout(timer)
  }, [checkAllEnabled])

  // 外部触发重置
  useEffect(() => {
    if (resetKey !== undefined) {
      setSelected([])
    }
  }, [resetKey])

  const toggleCapability = useCallback((capability: ManualCapability) => {
    if (disabled || !enabledStates[capability]) return

    const newSelected = selected.includes(capability)
      ? selected.filter((c) => c !== capability)
      : [...selected, capability]

    setSelected(newSelected)
    onChange(newSelected)
  }, [disabled, enabledStates, selected, onChange])

  return (
    <div className="flex items-center gap-1.5 px-2 pt-0.5 pb-1">
      {TOGGLE_OPTIONS.map((option) => {
        const isSelected = selected.includes(option.id)
        const isEnabled = enabledStates[option.id]

        return (
          <div key={option.id} className="relative group">
            <Button
              type="default"
              size="small"
              disabled={disabled || !isEnabled}
              onClick={() => toggleCapability(option.id)}
              icon={option.icon}
              className={`
                gm-manual-tool-toggle !px-2 !py-1 !h-7 !text-micro !font-medium !rounded-2xl
                ${isSelected
                  ? 'gm-manual-tool-toggle--active'
                  : ''
                }
                ${!isEnabled ? '!opacity-50 !cursor-not-allowed' : ''}
              `}
            >
              {option.label}
            </Button>
            {/* Tooltip */}
            <div className="gm-manual-tool-tooltip absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-2 py-1 rounded-lg text-micro whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-50">
              {isEnabled ? option.tooltip : `${option.label}不可用`}
            </div>
          </div>
        )
      })}
    </div>
  )
}
