import { useMemo } from 'react'
import { BookOpen } from 'lucide-react'
import { useEditorStore } from '@/stores/editorStore'
import { useAppStore } from '@/stores/appStore'
import { getRuntimeCapabilities } from '@/services/runtimeCapabilities'
import {
  requestOpenAiChat,
  requestOpenReadingArtifacts,
  requestToggleAiChat,
  requestToggleReadingArtifacts,
} from '@/services/aiPanelNavigation'

const STATUS_MAP: Record<string, { label: string; color: string }> = {
  ok: { label: 'AI 就绪', color: 'text-gm-success' },
  chat_unreachable: { label: '对话服务不可达', color: 'text-gm-error' },
  embedding_unreachable: { label: 'Embedding 服务不可达', color: 'text-gm-error' },
  both_unreachable: { label: '对话和 Embedding 不可达', color: 'text-gm-error' },
  search_unreachable: { label: '搜索 API 不可用', color: 'text-gm-error' },
  chat_search_unreachable: { label: '对话和搜索不可达', color: 'text-gm-error' },
  embedding_search_unreachable: { label: 'Embedding 和搜索不可达', color: 'text-gm-error' },
  all_unreachable: { label: 'AI 服务全部不可达', color: 'text-gm-error' },
  not_configured: { label: 'AI 未配置', color: 'text-gm-text-disabled' },
  unchecked: { label: 'AI 检测中…', color: 'text-gm-text-disabled' },
}

export function StatusBar() {
  const tabs = useEditorStore((s) => s.tabs)
  const activeTabId = useEditorStore((s) => s.activeTabId)
  const aiStatus = useAppStore((s) => s.aiStatus)
  const aiPanelOpen = useAppStore((s) => s.aiPanelOpen)
  const toggleAiPanel = useAppStore((s) => s.toggleAiPanel)
  const databaseEnabled = getRuntimeCapabilities().database
  const aiStatusInfo = STATUS_MAP[aiStatus] ?? STATUS_MAP.unchecked

  const activeTab = tabs.find((t) => t.id === activeTabId)

  const wordCount = useMemo(() => {
    if (!activeTab?.content) return 0
    const text = activeTab.content.trim()
    if (!text) return 0
    const chineseChars = text.match(/[一-鿿]/g)?.length || 0
    const englishWords = text.replace(/[一-鿿]/g, ' ').split(/\s+/).filter(Boolean).length
    return chineseChars + englishWords
  }, [activeTab?.content])

  return (
    <div className="h-8 flex items-center px-4 bg-gm-surface border-t border-gm-border-subtle text-caption text-gm-text-secondary gap-4">
      {/* Left */}
      <StatusItem>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
        </svg>
        <span>{activeTab?.filePath ? activeTab.title : '未打开文件'}</span>
      </StatusItem>

      <div className="flex-1" />

      {/* Right */}
      {activeTab && (
        <>
          <StatusItem>
            <span>UTF-8</span>
          </StatusItem>
          <StatusItem>
            <span>{wordCount} 词</span>
          </StatusItem>
          {activeTab.modified && (
            <StatusItem>
              <span className="text-gm-primary font-bold">已修改</span>
            </StatusItem>
          )}
          <StatusDivider />
        </>
      )}

      <div className="flex items-center gap-1">
        <StatusAction
          aria-label={databaseEnabled ? '打开阅读成果' : '阅读成果仅桌面版可用'}
          title={databaseEnabled ? '阅读成果' : '阅读成果仅桌面版可用'}
          disabled={!databaseEnabled}
          onClick={() => {
            if (!databaseEnabled) return
            if (!aiPanelOpen) {
              toggleAiPanel()
              requestOpenReadingArtifacts()
            } else {
              requestToggleReadingArtifacts()
            }
          }}
        >
          <BookOpen size={15} strokeWidth={1.7} aria-hidden="true" />
        </StatusAction>
        <StatusAction
          dataTour="ai-assistant"
          aria-label={`打开 AI 助手，${aiStatusInfo.label}`}
          title={aiStatusInfo.label}
          onClick={() => {
            if (!aiPanelOpen) {
              toggleAiPanel()
              requestOpenAiChat()
            } else {
              requestToggleAiChat()
            }
          }}
          active={aiPanelOpen}
        >
          <span className={`text-micro font-bold leading-none ${aiStatusInfo.color}`}>AI</span>
        </StatusAction>
      </div>
    </div>
  )
}

function StatusAction({
  children,
  className = '',
  onClick,
  dataTour,
  title,
  disabled = false,
  active = false,
  ...props
}: {
  children: React.ReactNode
  className?: string
  onClick?: () => void
  dataTour?: string
  title: string
  disabled?: boolean
  active?: boolean
  'aria-label': string
}) {
  return (
    <button
      type="button"
      className={`flex h-6 w-7 items-center justify-center rounded-md text-gm-text-tertiary transition-colors hover:bg-gm-surface-hover hover:text-gm-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-gm-primary disabled:cursor-not-allowed disabled:opacity-50 ${active ? 'bg-gm-surface-hover' : ''} ${className}`}
      data-product-tour={dataTour}
      title={title}
      disabled={disabled}
      onClick={onClick}
      {...props}
    >
      {children}
    </button>
  )
}

function StatusItem({
  children,
  className = '',
  onClick,
  dataTour,
}: {
  children: React.ReactNode
  className?: string
  onClick?: () => void
  dataTour?: string
}) {
  return (
    <span
      className={`flex items-center gap-1.5 select-none cursor-default hover:text-gm-text transition-colors ${className}`}
      data-product-tour={dataTour}
      style={{ cursor: onClick ? 'pointer' : 'default' }}
      onClick={onClick}
    >
      {children}
    </span>
  )
}

function StatusDivider() {
  return <span className="w-px h-3 bg-gm-border" />
}
