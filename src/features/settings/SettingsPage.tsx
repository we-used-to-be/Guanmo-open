import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { Button, Collapse, Divider, Footer, Icon, Input, Modal, Select, Switch, Table, Tabs } from 'animal-island-ui'
import appIcon from '@/assets/icon-settings.png'

import { isTauri } from '@/hooks/useTauri'
import { SegmentedTabs } from '@/components/common/SegmentedTabs'
import { useSettingsStore } from '@/stores/settingsStore'
import type { WebSearchConfig } from '@/services/webSearch'
import {
  CHAT_PROTOCOL_CAPABILITIES,
  SUPPORTED_CHAT_PROTOCOLS,
  getChatProtocolCapabilities,
  initAiClient,
  initEmbeddingClient,
  isLocalApi,
  testAiConnection,
  validateAiStatus,
} from '@/services/ai/aiClient'
import { AI_CHAT_PRESETS, AI_EMBEDDING_PRESETS } from '@/services/ai/types'
import type { AiConfig, ChatProtocol, CustomPreset, EmbeddingProtocol, ValidateResult } from '@/services/ai/types'
import { testWebSearchConnection, updateSearchConfig } from '@/services/webSearch'
import { externalFetch } from '@/services/externalHttp'
import type { WebSearchTestResult } from '@/services/webSearch'
import {
  embedPendingChunks,
  getEmbeddingJobStats,
  getKnowledgeIndexStateSummary,
  getRagStatsAsync,
  processEmbeddingQueue,
  retryFailedEmbeddingJobs,
} from '@/services/rag/pipeline'
import { SHORTCUTS, findShortcutConflicts } from '@/services/shortcuts'
import {
  archiveSettingsMemory,
  clearCandidateMemories,
  clearSavedChatSessions,
  confirmSettingsMemoryCandidate,
  deleteSettingsMemory,
  ignoreSettingsMemoryCandidate,
  loadSettingsMemoryCount,
  loadSettingsMemoryPage,
  persistSettingsMemory,
  toggleSettingsMemoryLocked,
  type Memory,
} from '@/services/settings/settingsCommands'
import { toast } from '@/services/toast'
import { selectPrimaryWorkspacePath, useAppStore } from '@/stores/appStore'
import { cleanupMissingWorkspaceDocuments, rebuildWorkspaceDocuments } from '@/services/workspaceIndex'
import { exportDataBackup, importDataBackup } from '@/services/dataBackup'
import { useChatStore } from '@/stores/chatStore'
import { SettingSlider } from '@/components/common/SettingSlider'
import { contentHash, inferMemoryScope, normalizeMemoryScopeKey } from '@/services/memory/memoryPolicy'
import {
  GITHUB_REPOSITORY_URL,
  getCurrentAppVersion,
  getCurrentVersionRelease,
  openReleaseInSystemBrowser,
} from '@/services/updateService'
import { runManualUpdateCheck, type ManualUpdateCheckFeedback } from '@/services/updateNotifications'
import { useUpdateStore } from '@/stores/updateStore'
import { listAuthorizedApiOrigins, revokeApiOrigin, type AuthorizedApiOrigin } from '@/services/externalHttp'
import { LegacyMigrationEntry } from '@/components/legacy/LegacyMigrationEntry'
import { KnowledgeBaseManager } from '@/features/settings/KnowledgeBaseManager'
import { AiShortcutSettings } from '@/features/settings/AiShortcutSettings'
import { UsageActivity } from '@/features/settings/UsageActivity'
import { DEFAULT_REQUEST_TIMEOUT_MS } from '@/services/requestTimeout'
import { AdvancedTimeoutSettings } from '@/features/settings/AdvancedTimeoutSettings'
import { ThemePicker } from '@/features/settings/ThemePicker'
import { requestProductTour } from '@/features/productTour/productTourEvents'
import { AssistantVisual } from '@/components/ai/AssistantVisual'
import type { AssistantState } from '@/services/assistantState'
import { getRuntimeCapabilities } from '@/services/runtimeCapabilities'
import {
  clearWebApiKeys,
  getWebSecretRuntimeState,
  persistWebApiKeys,
  setWebSessionApiKeys,
  subscribeWebSecretRuntime,
  unlockWebApiKeys,
} from '@/web/webSecretRuntime'
import type { WebApiSecrets } from '@/web/webSecretStorage'

const AI_ROUTING_GUIDE_URL = 'https://github.com/we-used-to-be/Guanmo-open/blob/main/docs/AI_ROUTING_GUIDE.md'

const AI_SPRITE_PREVIEW_STATES: ReadonlyArray<{
  state: AssistantState
  label: string
  description: string
}> = [
  { state: 'idle', label: '空闲', description: '等待任务' },
  { state: 'reading', label: '读取', description: '读取文档' },
  { state: 'retrieving', label: '检索', description: '检索知识库' },
  { state: 'searching', label: '搜索', description: '联网搜索' },
  { state: 'thinking', label: '思考', description: '规划回答' },
  { state: 'generating', label: '生成', description: '输出回答' },
  { state: 'success', label: '完成', description: '任务完成' },
  { state: 'error', label: '失败', description: '请求失败' },
]

async function openUrl(url: string, external: boolean) {
  if (external) {
    try {
      const { open } = await import('@tauri-apps/plugin-shell')
      await open(url)
    } catch {
      window.open(url, '_blank', 'noopener,noreferrer')
    }
  } else {
    window.open(url, '_blank', 'noopener,noreferrer')
  }
}

const TABS_CONFIG = [
  { key: 'ai', text: 'AI 模型' },
  { key: 'editor', text: '编辑器', children: <EditorSettings /> },
  { key: 'memory', text: '记忆', children: <MemorySettings /> },
  { key: 'ai-shortcuts', text: '快捷操作', children: <AiShortcutSettings /> },
  { key: 'shortcuts', text: '快捷键', children: <ShortcutSettings /> },
  { key: 'general', text: '通用', children: <GeneralSettings /> },
]

export function SettingsPage({ initialSection = null }: { initialSection?: string | null }) {
  const [active, setActive] = useState('ai')
  const [showKnowledgeManager, setShowKnowledgeManager] = useState(false)
  const openKnowledgeManager = useCallback(() => setShowKnowledgeManager(true), [])
  const closeKnowledgeManager = useCallback(() => setShowKnowledgeManager(false), [])

  const tabs = TABS_CONFIG.map((tab) => ({
    key: tab.key,
    label: <span className="text-body">{tab.text}</span>,
    children: tab.key === 'ai'
      ? <AiSettings onOpenKnowledgeManager={openKnowledgeManager} />
      : tab.children,
  }))

  return (
    <div className="h-full flex flex-col">
      <div className="flex-shrink-0 mb-4">
        <h2 className="text-heading font-bold text-gm-text">设置</h2>
      </div>
      <div className="flex-1 flex flex-col" style={{ minHeight: 0 }}>
        <Tabs
          items={tabs}
          activeKey={active}
          onChange={setActive}
          className="gm-settings-tabs"
          leafAnimation={false}
          shadow={false}
        />
      </div>
      <KnowledgeBaseManager
        open={showKnowledgeManager}
        onClose={closeKnowledgeManager}
      />
    </div>
  )
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-micro font-bold text-gm-text-tertiary uppercase tracking-wider mt-5 mb-2 first:mt-0">
      {children}
    </h3>
  )
}

function Sep() {
  return <Divider type="line-brown" className="gm-settings-sep my-3 opacity-45" />
}

function ApiKeyInput({ value, onChange, placeholder, disabled, ariaLabel }: {
  value: string
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void
  placeholder: string
  disabled?: boolean
  ariaLabel?: string
}) {
  const [show, setShow] = useState(false)
  return (
    <Input
      type={show ? 'text' : 'password'}
      value={value}
      onChange={onChange}
      placeholder={placeholder}
      disabled={disabled}
      aria-label={ariaLabel}
      suffix={
        <span
          onClick={() => setShow(!show)}
          className="cursor-pointer select-none text-gm-text-tertiary hover:text-gm-text-secondary inline-flex items-center"
          role="button"
          tabIndex={-1}
          title={show ? '隐藏' : '显示'}
        >
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            {show ? (
              <>
                <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
                <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
                <path d="m1 1 22 22" />
                <path d="m14.12 14.12a3 3 0 1 1-4.24-4.24" />
              </>
            ) : (
              <>
                <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                <circle cx="12" cy="12" r="3" />
              </>
            )}
          </svg>
        </span>
      }
    />
  )
}

function SettingField({
  label,
  description,
  descriptionClassName = '',
  children,
}: {
  label: string
  description?: string
  descriptionClassName?: string
  children: React.ReactNode
}) {
  return (
    <div className="gm-setting-field flex items-center justify-between py-1.5 min-h-[42px]">
      <div className="pr-6" style={{ width: 260, flexShrink: 0 }}>
        <span className="text-body text-gm-text">{label}</span>
        {description && <p className={`text-caption text-gm-text-tertiary mt-0.5 ${descriptionClassName}`}>{description}</p>}
      </div>
      <div className="gm-setting-control flex-1 flex items-center justify-end min-w-0">{children}</div>
    </div>
  )
}

function WebApiKeySettings() {
  const runtime = useSyncExternalStore(subscribeWebSecretRuntime, getWebSecretRuntimeState, getWebSecretRuntimeState)
  const chatApiKey = useSettingsStore((state) => state.ai.apiKey)
  const webSearchApiKey = useSettingsStore((state) => state.webSearch.apiKey)
  const [mode, setMode] = useState<'session' | 'plaintext' | 'encrypted'>(runtime.mode)
  const [password, setPassword] = useState('')
  const [message, setMessage] = useState('')
  const [showPlaintextWarning, setShowPlaintextWarning] = useState(false)

  useEffect(() => {
    if (runtime.unlocked) {
      useSettingsStore.getState().applyWebRuntimeApiKeys({ chatApiKey: runtime.chatApiKey, webSearchApiKey: runtime.webSearchApiKey })
    }
    setMode(runtime.mode)
  }, [runtime.chatApiKey, runtime.webSearchApiKey, runtime.mode, runtime.unlocked])

  const save = async () => {
    setMessage('')
    const secrets: WebApiSecrets = { chatApiKey, webSearchApiKey }
    try {
      if (mode === 'session') setWebSessionApiKeys(secrets)
      else if (mode === 'plaintext') {
        setShowPlaintextWarning(true)
        return
      } else {
        await persistWebApiKeys(secrets, mode, password)
        setPassword('')
      }
      setMessage('已保存')
    } catch (error) {
      setMessage((error as Error).message || '保存失败')
    }
  }

  const confirmPlaintextSave = async () => {
    setShowPlaintextWarning(false)
    try {
      await persistWebApiKeys({ chatApiKey, webSearchApiKey }, 'plaintext')
      setMessage('已保存')
    } catch (error) {
      setMessage((error as Error).message || '保存失败')
    }
  }

  const unlock = async () => {
    try {
      await unlockWebApiKeys(password)
      setPassword('')
      setMessage('已解锁')
    } catch (error) {
      setMessage((error as Error).message || '解锁失败')
    }
  }

  return (
    <div className="mb-4 rounded-xl border border-gm-border bg-gm-surface-elevated p-3">
      <div className="mb-2 text-body font-semibold text-gm-text">Web API Key</div>
      <p className="mb-2 text-caption text-gm-text-tertiary">API Key 仍在下方对话 API / 搜索 API 配置中填写；此处只选择保存方式。文档正文默认不会发送。</p>
      {!runtime.unlocked && (
        <div className="mb-2 flex gap-2">
          <Input aria-label="本地密码" type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="输入密码解锁已保存的 Key" />
          <Button type="primary" size="small" onClick={() => void unlock()} disabled={!password}>解锁</Button>
        </div>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Select
          options={[{ key: 'session', label: '仅当前页面内存' }, { key: 'plaintext', label: '明文 LocalStorage（低安全性）' }, { key: 'encrypted', label: '密码加密 LocalStorage' }]}
          value={mode}
          onChange={(value) => setMode(value as typeof mode)}
        />
        {mode === 'encrypted' && <Input aria-label="本地密码" type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="保存密码" style={{ width: 160 }} />}
        <Button type="primary" size="small" onClick={() => void save()} disabled={!runtime.unlocked || (mode === 'encrypted' && !password)}>保存 Key</Button>
        {runtime.saved && <Button type="text" size="small" onClick={() => {
          clearWebApiKeys()
          useSettingsStore.getState().applyWebRuntimeApiKeys({ chatApiKey: '', webSearchApiKey: '' })
          setMessage('已清除')
        }}>清除已保存 Key</Button>}
        {message && <span className="text-caption text-gm-text-secondary">{message}</span>}
      </div>
      {showPlaintextWarning && (
        <div className="gm-settings-mask fixed inset-0 z-[1200] flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-labelledby="web-key-warning-title">
          <div className="gm-settings-modal w-full max-w-md rounded-xl border border-gm-border bg-gm-surface p-5 shadow-lg">
            <h3 id="web-key-warning-title" className="text-body font-semibold text-gm-text">低安全性存储</h3>
            <p className="mt-2 text-caption text-gm-text-secondary">明文 LocalStorage 可能被同源脚本读取，仅建议用于免费且可随时撤销的 API Key。</p>
            <div className="mt-4 flex justify-end gap-2">
              <Button type="text" size="small" onClick={() => setShowPlaintextWarning(false)}>取消</Button>
              <Button type="primary" size="small" onClick={() => void confirmPlaintextSave()}>仍然保存</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function AiSpritePreviewModal({
  open,
  onClose,
  visualId,
}: {
  open: boolean
  onClose: () => void
  visualId?: string | null
}) {
  if (!open) return null

  return (
    <div
      className="gm-ai-sprite-preview-scrim fixed inset-0 z-[1110] flex items-center justify-center bg-black/45 p-5"
      role="dialog"
      aria-modal="true"
      aria-labelledby="ai-sprite-preview-title"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <section className="gm-ai-sprite-preview-dialog w-full max-w-lg overflow-hidden rounded-2xl border border-gm-border bg-gm-surface shadow-2xl">
        <header className="flex items-start justify-between gap-4 border-b border-gm-border px-5 py-4">
          <div>
            <h2 id="ai-sprite-preview-title" className="text-heading font-bold text-gm-text">
              小球样式预览
            </h2>
            <p className="mt-1 text-caption text-gm-text-secondary">
              查看 AI 助手在不同工作状态下的动画表现。
            </p>
          </div>
          <Button type="text" size="small" onClick={onClose} aria-label="关闭小球样式预览">
            关闭
          </Button>
        </header>

        <div className="grid grid-cols-2 gap-2.5 p-4 sm:grid-cols-4">
          {AI_SPRITE_PREVIEW_STATES.map((item) => (
            <div
              key={item.state}
              className="flex min-h-[112px] flex-col items-center justify-center rounded-xl border border-gm-border-subtle bg-gm-surface-elevated px-2 py-3"
            >
              <AssistantVisual visualId={visualId} state={item.state} size={56} className="mb-2" />
              <span className="text-caption font-bold text-gm-text">{item.label}</span>
              <span className="mt-0.5 text-micro text-gm-text-tertiary">{item.description}</span>
            </div>
          ))}
        </div>

        <footer className="flex justify-end border-t border-gm-border px-5 py-3">
          <Button type="default" size="small" onClick={onClose}>完成</Button>
        </footer>
      </section>
    </div>
  )
}

function SliderField({
  label,
  description,
  value,
  min,
  max,
  step,
  onChange,
  format,
  debounceMs,
}: {
  label: string
  description?: string
  value: number
  min: number
  max: number
  step: number
  onChange: (v: number) => void
  format?: (v: number) => string
  debounceMs?: number
}) {
  return (
    <div className="gm-setting-field flex items-center justify-between py-1.5 min-h-[42px]">
      <div style={{ width: 260, flexShrink: 0 }}>
        <span className="text-body text-gm-text">{label}</span>
        {description && <p className="text-caption text-gm-text-tertiary mt-0.5">{description}</p>}
      </div>
      <SettingSlider
        label={label}
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={onChange}
        format={format}
        debounceMs={debounceMs}
        className="gm-setting-control flex-1"
      />
    </div>
  )
}

const MODE_PERFORMANCE_OPTIONS = [
  {
    key: 'memory',
    label: '节省内存',
    description: '关闭闲时预热，隐藏的编辑器和预览将尽快释放，减少资源占用。',
    cssClass: 'off',
  },
  {
    key: 'balanced',
    label: '平衡',
    description: '智能预热常用模式。小文档隐藏后保留 45 秒，大文档（≥10 万字符）保留 5 秒后释放。',
    cssClass: 'smart',
  },
  {
    key: 'speed',
    label: '极速切换',
    description: '积极预热多个模式，尽量保留当前文档已创建的编辑器和预览。切换文档时仍会释放旧文档资源，Diff 离开后始终释放。',
    cssClass: 'turbo',
  },
] as const

type ModePerformanceLevel = typeof MODE_PERFORMANCE_OPTIONS[number]['key']
const MODE_PERFORMANCE_KEYS = MODE_PERFORMANCE_OPTIONS.map((option) => option.key)
const MODE_PERFORMANCE_STOP_POSITIONS = ['var(--gm-mode-prewarm-stop-edge)', '50%', 'calc(100% - var(--gm-mode-prewarm-stop-edge))'] as const
const MODE_PERFORMANCE_LABEL_POSITIONS = ['var(--gm-mode-prewarm-stop-edge)', 'calc(50% - 14px)', 'calc(100% - var(--gm-mode-prewarm-stop-edge) - 26px)'] as const
const MODE_PERFORMANCE_FILL_WIDTHS = ['var(--gm-mode-prewarm-thumb-size)', 'calc(50% + var(--gm-mode-prewarm-thumb-size) / 2)', '100%'] as const

function getModePerformanceIndex(value: ModePerformanceLevel) {
  return Math.max(0, MODE_PERFORMANCE_KEYS.indexOf(value))
}

function ModePerformanceSlider({
  value,
  onChange,
}: {
  value: ModePerformanceLevel
  onChange: (value: ModePerformanceLevel) => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const committedIndex = getModePerformanceIndex(value)
  const [draftIndex, setDraftIndex] = useState(committedIndex)
  const [dragging, setDragging] = useState(false)
  const activeOption = MODE_PERFORMANCE_OPTIONS[draftIndex] ?? MODE_PERFORMANCE_OPTIONS[0]
  const thumbPosition = MODE_PERFORMANCE_STOP_POSITIONS[draftIndex] ?? MODE_PERFORMANCE_STOP_POSITIONS[0]
  const fillWidth = MODE_PERFORMANCE_FILL_WIDTHS[draftIndex] ?? MODE_PERFORMANCE_FILL_WIDTHS[0]

  useEffect(() => {
    if (!dragging) setDraftIndex(committedIndex)
  }, [committedIndex, dragging])

  const commitIndex = useCallback((index: number) => {
    const nextIndex = Math.max(0, Math.min(MODE_PERFORMANCE_OPTIONS.length - 1, Math.round(index)))
    setDraftIndex(nextIndex)
    const nextValue = MODE_PERFORMANCE_OPTIONS[nextIndex].key
    if (nextValue !== value) onChange(nextValue)
  }, [onChange, value])

  const handleRangeChange = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    commitIndex(Number(event.currentTarget.value))
  }, [commitIndex])

  const handlePointerEnd = useCallback(() => {
    setDragging(false)
    commitIndex(Number(inputRef.current?.value ?? draftIndex))
  }, [commitIndex, draftIndex])

  const handleKeyDown = useCallback((event: React.KeyboardEvent<HTMLInputElement>) => {
    const keyTargets: Record<string, number> = {
      ArrowLeft: draftIndex - 1,
      ArrowDown: draftIndex - 1,
      ArrowRight: draftIndex + 1,
      ArrowUp: draftIndex + 1,
      Home: 0,
      End: MODE_PERFORMANCE_OPTIONS.length - 1,
    }
    if (!(event.key in keyTargets)) return
    event.preventDefault()
    commitIndex(keyTargets[event.key])
  }, [commitIndex, draftIndex])

  const labelNodes = useMemo(() => MODE_PERFORMANCE_OPTIONS.map((option, index) => (
    <span
      key={option.key}
      className="gm-mode-prewarm__label"
      data-active={index === draftIndex}
      style={{ left: MODE_PERFORMANCE_LABEL_POSITIONS[index] }}
    >
      {option.label}
    </span>
  )), [draftIndex])

  return (
    <div className={`gm-mode-prewarm gm-mode-prewarm--${activeOption.cssClass}`} data-dragging={dragging}>
      <div className="gm-mode-prewarm__labels" aria-hidden="true">
        {labelNodes}
      </div>
      <div className="gm-mode-prewarm__slider">
        <div className="gm-mode-prewarm__track" aria-hidden="true">
          <span className="gm-mode-prewarm__fill" style={{ width: fillWidth }} />
          {MODE_PERFORMANCE_OPTIONS.map((option, index) => (
            <span
              key={option.key}
              className="gm-mode-prewarm__node"
              data-active={index <= draftIndex}
              style={{ left: MODE_PERFORMANCE_STOP_POSITIONS[index] }}
            />
          ))}
          <span className="gm-mode-prewarm__thumb" style={{ left: thumbPosition }} />
        </div>
        <input
          ref={inputRef}
          type="range"
          min={0}
          max={2}
          step={1}
          value={draftIndex}
          aria-label="模式性能策略"
          aria-valuetext={activeOption.label}
          className="gm-mode-prewarm__input"
          onChange={handleRangeChange}
          onPointerDown={() => setDragging(true)}
          onPointerUp={handlePointerEnd}
          onPointerCancel={handlePointerEnd}
          onBlur={handlePointerEnd}
          onKeyDown={handleKeyDown}
        />
      </div>
    </div>
  )
}

const CHAT_PROTOCOL_OPTIONS: { key: ChatProtocol; label: string }[] = [
  ...SUPPORTED_CHAT_PROTOCOLS.map((key) => ({
    key,
    label: CHAT_PROTOCOL_CAPABILITIES[key].label,
  })),
]

const EMB_PROTOCOL_OPTIONS: { key: EmbeddingProtocol; label: string }[] = [
  { key: 'openai-embedding', label: 'OpenAI Embeddings' },
]

function AiSettings({ onOpenKnowledgeManager }: { onOpenKnowledgeManager: () => void }) {
  const {
    ai, webSearch,
    customChatPresets, customEmbeddingPresets,
    knowledge, updateKnowledgeSettings,
    updateAiConfig, updateEmbeddingConfig, updateWebSearchConfig,
    addCustomChatPreset, removeCustomChatPreset,
    addCustomEmbeddingPreset, removeCustomEmbeddingPreset,
  } = useSettingsStore()
  const webRuntimeSecrets = useSyncExternalStore(subscribeWebSecretRuntime, getWebSecretRuntimeState, getWebSecretRuntimeState)

  // 测试状态
  const [chatTestResult, setChatTestResult] = useState<ValidateResult | null>(null)
  const [chatTesting, setChatTesting] = useState(false)
  const [embTestResult, setEmbTestResult] = useState<ValidateResult | null>(null)
  const [embTesting, setEmbTesting] = useState(false)
  const [webSearchTestResult, setWebSearchTestResult] = useState<WebSearchTestResult | null>(null)
  const [webSearchTesting, setWebSearchTesting] = useState(false)
  // 保存预设弹窗
  const [showChatSavePreset, setShowChatSavePreset] = useState(false)
  const [chatPresetName, setChatPresetName] = useState('')
  const [showEmbSavePreset, setShowEmbSavePreset] = useState(false)
  const [embPresetName, setEmbPresetName] = useState('')
  useEffect(() => {
    updateSearchConfig(webSearch)
  }, [webSearch])

  // AI 配置变更时重新校验连通性
  useEffect(() => {
    const timer = setTimeout(() => {
      // 重新初始化客户端
      if ((ai.apiKey || isLocalApi(ai.baseUrl)) && ai.baseUrl && ai.chatModel) {
        try { initAiClient(ai) } catch { /* ignore */ }
      }
      if ((ai.embedding.apiKey || isLocalApi(ai.embedding.baseUrl)) && ai.embedding.baseUrl && ai.embedding.embeddingModel) {
        try { initEmbeddingClient(ai.embedding) } catch { /* ignore */ }
      }
      validateAiStatus().then((status) => {
        useAppStore.getState().setAiStatus(status)
      }).catch(() => {})
    }, 1000)
    return () => clearTimeout(timer)
  }, [ai.protocol, ai.baseUrl, ai.apiKey, ai.chatModel, ai.timeout, ai.embedding.protocol, ai.embedding.baseUrl, ai.embedding.apiKey, ai.embedding.embeddingModel, ai.embedding.timeout])

  // 配置变更时清除旧测试结果
  useEffect(() => {
    setChatTestResult(null)
    setShowChatSavePreset(false)
  }, [ai.protocol, ai.baseUrl, ai.apiKey, ai.chatModel, ai.timeout])

  useEffect(() => {
    setEmbTestResult(null)
    setShowEmbSavePreset(false)
  }, [ai.embedding.protocol, ai.embedding.baseUrl, ai.embedding.apiKey, ai.embedding.embeddingModel, ai.embedding.timeout])

  const handleChatTest = async () => {
    setChatTesting(true)
    setChatTestResult(null)
    try {
      const capabilities = getChatProtocolCapabilities(ai.protocol)
      if (!capabilities.implemented) {
        setChatTestResult({
          ok: false,
          error: 'config',
          message: capabilities.unsupportedReason,
        })
        return
      }
      const result = await testAiConnection(ai)
      setChatTestResult(result)
    } catch (err) {
      setChatTestResult({ ok: false, error: 'unknown', message: (err as Error).message || String(err) })
    } finally {
      setChatTesting(false)
    }
  }

  const handleEmbTest = async () => {
    setEmbTesting(true)
    setEmbTestResult(null)
    try {
      const { baseUrl, apiKey, embeddingModel } = ai.embedding
      if (!baseUrl) {
        setEmbTestResult({ ok: false, error: 'config', message: 'Embedding Base URL 未配置' })
        return
      }
      const url = `${baseUrl.replace(/\/+$/, '')}/embeddings`
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`
      const res = await externalFetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ model: embeddingModel, input: 'test' }),
      })
      if (res.ok) {
        setEmbTestResult({ ok: true })
      } else {
        const body = await res.text().catch(() => '')
        const hint = body ? `（${body.slice(0, 200)}）` : ''
        setEmbTestResult({ ok: false, error: 'http', message: `Embedding 服务连接失败 (${res.status})${hint}` })
      }
    } catch (err) {
      setEmbTestResult({ ok: false, error: 'unknown', message: (err as Error).message || String(err) })
    } finally {
      setEmbTesting(false)
    }
  }

  const handleWebSearchTest = async () => {
    setWebSearchTesting(true)
    setWebSearchTestResult(null)
    try {
      const result = await testWebSearchConnection({ ...webSearch, apiKey: webSearch.apiKey })
      setWebSearchTestResult(result)
    } catch (err) {
      setWebSearchTestResult({ ok: false, message: (err as Error).message || String(err) })
    } finally {
      setWebSearchTesting(false)
    }
  }

  const handleSaveChatPreset = () => {
    const name = chatPresetName.trim()
    if (!name) return
    addCustomChatPreset({
      id: `custom-chat-${Date.now()}`,
      label: name,
      protocol: ai.protocol,
      provider: ai.provider,
      baseUrl: ai.baseUrl,
      chatModel: ai.chatModel,
    })
    setShowChatSavePreset(false)
    setChatPresetName('')
    toast.success(`对话预设"${name}"已保存`)
  }

  const handleSaveEmbPreset = () => {
    const name = embPresetName.trim()
    if (!name) return
    addCustomEmbeddingPreset({
      id: `custom-emb-${Date.now()}`,
      label: name,
      protocol: ai.embedding.protocol,
      provider: ai.embedding.provider,
      baseUrl: ai.embedding.baseUrl,
      embeddingModel: ai.embedding.embeddingModel,
    })
    setShowEmbSavePreset(false)
    setEmbPresetName('')
    toast.success(`Embedding 预设"${name}"已保存`)
  }

  // 按协议过滤系统预设 + 合并用户自定义预设
  const filteredSysChatPresets = AI_CHAT_PRESETS.filter((p) => p.key === 'custom' || p.protocol === ai.protocol)
  const filteredCustomChatPresets = customChatPresets.filter(
    (p) => p.protocol === ai.protocol && CHAT_PROTOCOL_CAPABILITIES[p.protocol as ChatProtocol]?.implemented
  )

  const chatPresetOptions = [
    ...filteredCustomChatPresets.map((p) => ({ key: p.id, label: p.label })),
    ...filteredSysChatPresets.map((p) => ({ key: p.key, label: p.label })),
  ]

  const filteredSysEmbPresets = AI_EMBEDDING_PRESETS.filter((p) => p.key === 'custom' || p.protocol === ai.embedding.protocol)
  const filteredCustomEmbPresets = customEmbeddingPresets.filter((p) => p.protocol === ai.embedding.protocol)

  const embPresetOptions = [
    ...filteredCustomEmbPresets.map((p) => ({ key: p.id, label: p.label })),
    ...filteredSysEmbPresets.map((p) => ({ key: p.key, label: p.label })),
  ]

  // 当前选中的预设 key（自定义预设优先，协议 + baseUrl + model 三重匹配）
  const matchedChatCustom = customChatPresets.find((p) => p.protocol === ai.protocol && p.baseUrl === ai.baseUrl && p.chatModel === ai.chatModel)
  const currentChatPreset =
    matchedChatCustom?.id ??
    AI_CHAT_PRESETS.find((preset) =>
      preset.key !== 'custom' &&
      preset.protocol === ai.protocol &&
      preset.baseUrl === ai.baseUrl &&
      preset.chatModel === ai.chatModel
    )?.key ?? 'custom'

  const matchedEmbCustom = customEmbeddingPresets.find((p) => p.protocol === ai.embedding.protocol && p.baseUrl === ai.embedding.baseUrl && p.embeddingModel === ai.embedding.embeddingModel)
  const currentEmbeddingPreset =
    matchedEmbCustom?.id ??
    AI_EMBEDDING_PRESETS.find((preset) =>
      preset.key !== 'custom' &&
      preset.protocol === ai.embedding.protocol &&
      preset.baseUrl === ai.embedding.baseUrl &&
      preset.embeddingModel === ai.embedding.embeddingModel
    )?.key ?? 'custom'
  const chatProtocolCapabilities = getChatProtocolCapabilities(ai.protocol)

  return (
    <div className="w-full pb-6">
      {!isTauri() && (
        <div className="mb-4 rounded-xl border border-gm-border bg-gm-surface-elevated p-3">
          <p className="text-caption text-gm-text-tertiary">
            浏览器模式下 AI 仅支持当前会话对话和联网搜索；Embedding、RAG、长期记忆及持久聊天历史保持禁用。
          </p>
        </div>
      )}
      {!isTauri() && <WebApiKeySettings />}
      <SettingField label="AI 使用指南" description="查看能力路由关键词和提问示例">
        <Button
          type="default"
          size="small"
          onClick={() => void openUrl(AI_ROUTING_GUIDE_URL, isTauri())}
        >
          查看指南
        </Button>
      </SettingField>

      <SectionTitle>对话 API 配置</SectionTitle>
      <SettingField label="协议类型" description="决定请求格式，大部分服务选择 OpenAI Chat Completions">
        <Select
          options={CHAT_PROTOCOL_OPTIONS}
          value={ai.protocol}
          onChange={(key) => {
            updateAiConfig({ protocol: key as ChatProtocol, provider: 'custom' })
          }}
        />
      </SettingField>
      <SettingField label="服务预设" description="按协议类型过滤，选择后自动填入">
        <Select
          options={chatPresetOptions}
          value={currentChatPreset}
          onChange={(key) => {
            const sysPreset = AI_CHAT_PRESETS.find((item) => item.key === key)
            if (sysPreset && sysPreset.key !== 'custom') {
              updateAiConfig({
                protocol: sysPreset.protocol as ChatProtocol,
                provider: sysPreset.provider,
                baseUrl: sysPreset.baseUrl,
                chatModel: sysPreset.chatModel ?? '',
              })
              return
            }
            const customPreset = customChatPresets.find((p) => p.id === key)
            if (customPreset) {
              updateAiConfig({
                protocol: customPreset.protocol as ChatProtocol,
                provider: customPreset.provider,
                baseUrl: customPreset.baseUrl,
                chatModel: customPreset.chatModel ?? '',
              })
            }
          }}
        />
      </SettingField>
      <SettingField label="API Base URL" description="OpenAI-compatible API 地址">
        <Input aria-label="对话 API 地址" value={ai.baseUrl} onChange={(e) => updateAiConfig({ baseUrl: e.target.value })} placeholder="https://api.openai.com/v1" />
      </SettingField>
      {!isLocalApi(ai.baseUrl) && (
        <SettingField label="API Key" description={isTauri() ? '通过系统安全存储保存，不写入普通设置' : '填写后在顶部选择保存方式'}>
          <ApiKeyInput ariaLabel="对话 API Key" value={ai.apiKey} onChange={(e) => updateAiConfig({ apiKey: e.target.value })} placeholder="sk-..." disabled={!isTauri() && !webRuntimeSecrets.unlocked} />
        </SettingField>
      )}
      <SettingField label="对话模型" description="用于日常对话和 Agent 执行的模型">
        <Input aria-label="对话模型" value={ai.chatModel} onChange={(e) => updateAiConfig({ chatModel: e.target.value })} placeholder="gpt-4o-mini" />
      </SettingField>
      {/* 测试连接 */}
      <div className="py-1 flex items-center gap-2">
        <Button
          type="default"
          size="small"
          loading={chatTesting}
          disabled={!chatProtocolCapabilities.implemented}
          onClick={handleChatTest}
        >
          测试连接
        </Button>
        {currentChatPreset !== 'custom' && customChatPresets.some(p => p.id === currentChatPreset) && (
          <Button type="text" size="small" className="text-gm-text-tertiary hover:text-gm-error"
            onClick={() => { removeCustomChatPreset(currentChatPreset); toast.success('预设已删除') }}>
            删除此预设
          </Button>
        )}
      </div>

      {/* 测试结果 */}
      {chatTesting && (
        <p className="text-caption text-gm-text-secondary py-1">连接中…</p>
      )}
      {chatTestResult && !chatTesting && (
        <div className={`rounded-lg border px-3 py-2 mb-1 text-caption ${
          chatTestResult.ok
            ? 'border-gm-success/30 bg-gm-success/5 text-gm-success'
            : 'border-gm-error/30 bg-gm-error/5 text-gm-error'
        }`}>
          <div className="flex items-center gap-1.5 font-semibold">
            <span>{chatTestResult.ok ? '✓' : '✗'}</span>
            <span>{chatTestResult.ok ? '连接成功' : chatTestResult.message || '连接失败'}</span>
          </div>
          {chatTestResult.ok && chatTestResult.models && chatTestResult.models.length > 0 && (
            <div className="mt-1 text-gm-text-secondary font-normal">
              可用模型：{chatTestResult.models.slice(0, 8).join(', ')}
              {chatTestResult.models.length > 8 && ` 等 ${chatTestResult.models.length} 个`}
            </div>
          )}
        </div>
      )}

      {/* 保存 / 删除预设 */}
      {chatTestResult?.ok && (
        <div className="py-1 flex items-center gap-2">
          {!showChatSavePreset ? (
            <Button type="text" size="small" onClick={() => setShowChatSavePreset(true)}>
              保存为预设
            </Button>
          ) : (
            <>
              <Input value={chatPresetName} onChange={(e) => setChatPresetName(e.target.value)} placeholder="输入预设名称" style={{ width: 180 }} />
              <Button type="primary" size="small" onClick={handleSaveChatPreset} disabled={!chatPresetName.trim()}>保存</Button>
              <Button type="text" size="small" onClick={() => { setShowChatSavePreset(false); setChatPresetName('') }}>取消</Button>
            </>
          )}
        </div>
      )}

      <AdvancedTimeoutSettings value={ai.timeout} onChange={(timeout) => updateAiConfig({ timeout })} />

      <Sep />

      <div className={!isTauri() ? 'pointer-events-none opacity-55' : undefined}>
      <SectionTitle>Embedding 配置</SectionTitle>
      <SettingField label="协议类型" description="决定 Embedding 请求格式，目前仅支持 OpenAI Embeddings">
        <Select
          options={EMB_PROTOCOL_OPTIONS}
          value={ai.embedding.protocol}
          onChange={(key) => {
            updateEmbeddingConfig({ protocol: key as EmbeddingProtocol, provider: 'custom' })
          }}
        />
      </SettingField>
      <SettingField label="服务预设" description="按协议类型过滤，可与对话使用不同服务商">
        <Select
          options={embPresetOptions}
          value={currentEmbeddingPreset}
          onChange={(key) => {
            const sysPreset = AI_EMBEDDING_PRESETS.find((item) => item.key === key)
            if (sysPreset && sysPreset.key !== 'custom') {
              updateEmbeddingConfig({
                protocol: (sysPreset.protocol as EmbeddingProtocol),
                provider: sysPreset.provider,
                baseUrl: sysPreset.baseUrl,
                embeddingModel: sysPreset.embeddingModel ?? '',
              })
              return
            }
            const customPreset = customEmbeddingPresets.find((p) => p.id === key)
            if (customPreset) {
              updateEmbeddingConfig({
                protocol: customPreset.protocol as EmbeddingProtocol,
                provider: customPreset.provider,
                baseUrl: customPreset.baseUrl,
                embeddingModel: customPreset.embeddingModel ?? '',
              })
            }
          }}
        />
      </SettingField>
      <SettingField label="API Base URL" description="Embedding 服务地址">
        <Input aria-label="Embedding API 地址" value={ai.embedding.baseUrl} onChange={(e) => updateEmbeddingConfig({ baseUrl: e.target.value })} placeholder="https://api.openai.com/v1" />
      </SettingField>
      {!isLocalApi(ai.embedding.baseUrl) && (
        <SettingField label="API Key" description="通过系统安全存储保存">
          <ApiKeyInput value={ai.embedding.apiKey} onChange={(e) => updateEmbeddingConfig({ apiKey: e.target.value })} placeholder="sk-..." disabled={!isTauri()} />
        </SettingField>
      )}
      <SettingField label="Embedding 模型" description="将文本转为向量，用于知识库语义检索">
        <Input aria-label="Embedding 模型" value={ai.embedding.embeddingModel} onChange={(e) => updateEmbeddingConfig({ embeddingModel: e.target.value })} placeholder="text-embedding-3-small" />
      </SettingField>

      {/* Embedding 测试连接 */}
      <div className="py-1 flex items-center gap-2">
        <Button type="default" size="small" loading={embTesting} onClick={handleEmbTest}>
          测试连接
        </Button>
        {currentEmbeddingPreset !== 'custom' && customEmbeddingPresets.some(p => p.id === currentEmbeddingPreset) && (
          <Button type="text" size="small" className="text-gm-text-tertiary hover:text-gm-error"
            onClick={() => { removeCustomEmbeddingPreset(currentEmbeddingPreset); toast.success('预设已删除') }}>
            删除此预设
          </Button>
        )}
      </div>

      {/* Embedding 测试结果 */}
      {embTesting && (
        <p className="text-caption text-gm-text-secondary py-1">连接中…</p>
      )}
      {embTestResult && !embTesting && (
        <div className={`rounded-lg border px-3 py-2 mb-1 text-caption ${
          embTestResult.ok
            ? 'border-gm-success/30 bg-gm-success/5 text-gm-success'
            : 'border-gm-error/30 bg-gm-error/5 text-gm-error'
        }`}>
          <div className="flex items-center gap-1.5 font-semibold">
            <span>{embTestResult.ok ? '✓' : '✗'}</span>
            <span>{embTestResult.ok ? '连接成功' : embTestResult.message || '连接失败'}</span>
          </div>
          {embTestResult.ok && embTestResult.models && embTestResult.models.length > 0 && (
            <div className="mt-1 text-gm-text-secondary font-normal">
              可用模型：{embTestResult.models.slice(0, 8).join(', ')}
              {embTestResult.models.length > 8 && ` 等 ${embTestResult.models.length} 个`}
            </div>
          )}
        </div>
      )}

      {/* Embedding 保存 / 删除预设 */}
      {embTestResult?.ok && (
        <div className="py-1 flex items-center gap-2">
          {!showEmbSavePreset ? (
            <Button type="text" size="small" onClick={() => setShowEmbSavePreset(true)}>
              保存为预设
            </Button>
          ) : (
            <>
              <Input value={embPresetName} onChange={(e) => setEmbPresetName(e.target.value)} placeholder="输入预设名称" style={{ width: 180 }} />
              <Button type="primary" size="small" onClick={handleSaveEmbPreset} disabled={!embPresetName.trim()}>保存</Button>
              <Button type="text" size="small" onClick={() => { setShowEmbSavePreset(false); setEmbPresetName('') }}>取消</Button>
            </>
          )}
        </div>
      )}

      <AdvancedTimeoutSettings value={ai.embedding.timeout} onChange={(timeout) => updateEmbeddingConfig({ timeout })} />
      </div>
      {!isTauri() && <p className="text-caption text-gm-text-tertiary">Embedding 在 Web 端固定禁用。</p>}

      <Sep />

      <SectionTitle>对话参数</SectionTitle>
      <SliderField label="AI 创造性" description="值越高回答越发散，低值更精确稳定" value={ai.temperature} min={0} max={1} step={0.1} onChange={(v) => updateAiConfig({ temperature: v })} />
      <SettingField label="流式输出" description="实时显示 AI 回复">
        <Switch checked={ai.streamEnabled} onChange={(v) => updateAiConfig({ streamEnabled: v })} />
      </SettingField>
      <SettingField label="联网搜索" description="允许 Agent 使用 Web 搜索工具">
        <Switch checked={ai.webSearchEnabled} onChange={(v) => updateAiConfig({ webSearchEnabled: v })} />
      </SettingField>
      <SettingField label="用户偏好提示词" description="只影响回答风格和偏好，不覆盖安全、工具、记忆和文件确认规则">
        <textarea
          value={ai.customPreferencePrompt}
          onChange={(e) => updateAiConfig({ customPreferencePrompt: e.target.value })}
          placeholder="例如：回答更简洁；优先用中文；给出结论后再补充依据。"
          rows={4}
          className="w-full rounded-lg border border-gm-border-subtle bg-gm-surface px-3 py-2 text-body text-gm-text placeholder:text-gm-text-tertiary resize-y focus:outline-none focus:border-gm-primary"
        />
      </SettingField>

      <Sep />

      <SectionTitle>Web 搜索</SectionTitle>
      <SettingField label="搜索引擎" description="Agent 联网搜索时使用的引擎">
        <Select
          options={[
            { key: 'duckduckgo', label: 'DuckDuckGo（免费）' },
            { key: 'tavily', label: 'Tavily' },
            { key: 'serper', label: 'Serper（Google）' },
            { key: 'brave', label: 'Brave Search' },
            { key: 'custom', label: '自定义' },
          ]}
          value={webSearch.provider}
          onChange={(v) => updateWebSearchConfig({ provider: v as WebSearchConfig['provider'] })}
        />
      </SettingField>
      {webSearch.provider === 'custom' && (
        <SettingField label="搜索 URL" description="搜索 API 的完整地址，会自动附加 ?q=关键词 参数">
          <Input
            value={webSearch.customUrl || ''}
            onChange={(e) => updateWebSearchConfig({ customUrl: e.target.value })}
            placeholder="https://api.example.com/search"
          />
        </SettingField>
      )}
      {webSearch.provider !== 'duckduckgo' && (
        <SettingField label="搜索 API Key" description={isTauri() ? '同样通过系统安全存储保存' : '填写后在顶部选择保存方式'}>
          <ApiKeyInput
            ariaLabel="联网搜索 API Key"
            value={webSearch.apiKey}
            onChange={(e) => updateWebSearchConfig({ apiKey: e.target.value })}
            placeholder={webSearch.provider === 'tavily' ? 'tvly-...' : webSearch.provider === 'custom' ? '可选，用于 Authorization 头' : '...'}
            disabled={!isTauri() && !webRuntimeSecrets.unlocked}
          />
        </SettingField>
      )}

      {/* 测试连接 */}
      <div className="py-1 flex items-center gap-2">
        <Button type="default" size="small" loading={webSearchTesting} onClick={handleWebSearchTest}>
          测试连接
        </Button>
      </div>

      {/* 测试结果 */}
      {webSearchTesting && (
        <p className="text-caption text-gm-text-secondary py-1">连接中…</p>
      )}
      {webSearchTestResult && !webSearchTesting && (
        <div className={`rounded-lg border px-3 py-2 mb-1 text-caption ${
          webSearchTestResult.ok
            ? 'border-gm-success/30 bg-gm-success/5 text-gm-success'
            : 'border-gm-error/30 bg-gm-error/5 text-gm-error'
        }`}>
          <div className="flex items-center gap-1.5 font-semibold">
            <span>{webSearchTestResult.ok ? '✓' : '✗'}</span>
            <span>{webSearchTestResult.ok ? '连接成功' : webSearchTestResult.message || '连接失败'}</span>
          </div>
        </div>
      )}

      <AdvancedTimeoutSettings value={webSearch.timeout} onChange={(timeout) => updateWebSearchConfig({ timeout })} />

      {isTauri() && <AuthorizedApiOrigins />}

      <Sep />

      <SectionTitle>知识库</SectionTitle>
      {!isTauri() && (
        <div className="mb-3 rounded-xl border border-gm-border bg-gm-surface-elevated p-3">
          <p className="text-caption text-gm-text-tertiary">
            浏览器模式下知识库不可用，请下载桌面版体验完整功能
          </p>
        </div>
      )}
      <SettingField label="自动入库" description="打开或保存 Markdown 时自动加入知识库；关闭后需通过标签右键菜单手动加入">
        <Switch checked={knowledge.autoIndexEnabled} onChange={(v) => updateKnowledgeSettings({ autoIndexEnabled: v })} disabled={!isTauri()} />
      </SettingField>
      <KnowledgeStats onOpenKnowledgeManager={onOpenKnowledgeManager} />
    </div>
  )
}

function AuthorizedApiOrigins() {
  const [origins, setOrigins] = useState<AuthorizedApiOrigin[]>([])
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    try {
      setOrigins(await listAuthorizedApiOrigins())
    } catch (error) {
      toast.error((error as Error).message || '读取 API 地址授权失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  const revoke = async (origin: string) => {
    try {
      await revokeApiOrigin(origin)
      setOrigins((current) => current.filter((item) => item.origin !== origin))
      toast.success('API 地址授权已撤销')
    } catch (error) {
      toast.error((error as Error).message || '撤销 API 地址授权失败')
    }
  }

  return (
    <>
      <Sep />
      <SectionTitle>API 地址授权</SectionTitle>
      {loading ? (
        <p className="py-2 text-caption text-gm-text-tertiary">正在读取授权…</p>
      ) : origins.length === 0 ? (
        <p className="py-2 text-caption text-gm-text-tertiary">暂无自定义 API 地址授权；内置供应商无需授权。</p>
      ) : (
        <div className="space-y-2 py-1">
          {origins.map((item) => (
            <div key={item.origin} className="flex items-center justify-between gap-3 rounded-lg border border-gm-border bg-gm-surface-elevated px-3 py-2">
              <div className="min-w-0">
                <p className="break-all text-body text-gm-text">{item.origin}</p>
                <p className="text-caption text-gm-text-tertiary">{item.persistence === 'permanent' ? '始终允许' : '仅本次'}</p>
              </div>
              <Button type="text" size="small" className="shrink-0 text-gm-error" onClick={() => void revoke(item.origin)}>
                撤销
              </Button>
            </div>
          ))}
        </div>
      )}
    </>
  )
}

function KnowledgeStats({ onOpenKnowledgeManager }: { onOpenKnowledgeManager: () => void }) {
  const { ai } = useSettingsStore()
  const workspaceRoots = useAppStore((state) => state.workspaceRoots)
  const workspacePaths = workspaceRoots.map((root) => root.path)
  const databaseEnabled = getRuntimeCapabilities().database
  const [stats, setStats] = useState({ documents: 0, totalChunks: 0, embeddedChunks: 0, pendingEmbeddings: 0 })
  const [jobStats, setJobStats] = useState({ pending: 0, running: 0, done: 0, failed: 0 })
  const [stateSummary, setStateSummary] = useState({ PENDING: 0, CHUNKED: 0, EMBEDDING: 0, INDEXED: 0, FAILED: 0 })
  const [embedding, setEmbedding] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [lastIndexedAt, setLastIndexedAt] = useState<number | null>(null)
  const [dbStatus, setDbStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const refreshStats = async () => {
    setDbStatus('loading')
    try {
      setStats(await getRagStatsAsync())
      setJobStats(await getEmbeddingJobStats())
      setStateSummary(await getKnowledgeIndexStateSummary())
      setDbStatus('ready')
    } catch {
      setDbStatus('error')
    }
  }

  useEffect(() => {
    refreshStats()
  }, [])

  const runEmbedding = async (retryFailed = false) => {
    setMessage(null)
    if (!ai.embedding.apiKey && !isLocalApi(ai.embedding.baseUrl)) {
      setMessage('请先配置 Embedding API Key')
      return
    }
    setEmbedding(true)
    try {
      initEmbeddingClient(ai.embedding)
      if (retryFailed) await retryFailedEmbeddingJobs()
      const queued = await processEmbeddingQueue()
      const pending = await embedPendingChunks()
      await refreshStats()
      setMessage(`队列完成 ${queued.embedded} 个分块，补齐 ${pending.embedded} 个历史分块，失败 ${queued.failed + pending.failed} 个`)
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err))
    } finally {
      setEmbedding(false)
    }
  }

  const handleCleanupWorkspace = async () => {
    if (workspacePaths.length === 0) {
      setMessage('请先添加工作区后再清理失效索引')
      return
    }
    setEmbedding(true)
    try {
      const result = await cleanupMissingWorkspaceDocuments(workspacePaths)
      await refreshStats()
      const summary = result.removed > 0 ? `已清理 ${result.removed} 个失效索引` : '未发现失效索引'
      setMessage(result.errors.length > 0 ? `${summary}，${result.errors.length} 个工作区不可用` : summary)
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err))
    } finally {
      setEmbedding(false)
    }
  }

  const handleRebuildWorkspace = async () => {
    if (workspacePaths.length === 0) {
      setMessage('请先添加工作区后再重建索引')
      return
    }
    setEmbedding(true)
    try {
      const result = await rebuildWorkspaceDocuments(workspacePaths)
      await refreshStats()
      setLastIndexedAt(Date.now())
      setMessage(`重建完成：移除 ${result.removed} 个旧索引，重新索引 ${result.indexed} 个文件，失败 ${result.failed} 个`)
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err))
    } finally {
      setEmbedding(false)
    }
  }

  const embeddingProviderLabel = ai.embedding.baseUrl || '未配置'

  return (
    <div className="space-y-3 py-2">
      <div className="grid grid-cols-4 gap-4">
        <StatItem label="文档" value={stats.documents} />
        <StatItem label="分块" value={stats.totalChunks} />
        <StatItem label="已嵌入" value={stats.embeddedChunks} />
        <StatItem label="待嵌入" value={stats.pendingEmbeddings} />
      </div>
      <div className="rounded-xl border border-gm-border bg-gm-surface-elevated px-3 py-2 text-caption text-gm-text-secondary">
        自动队列：待处理 {jobStats.pending} / 运行中 {jobStats.running} / 已完成 {jobStats.done} / 失败 {jobStats.failed}
      </div>
      <div className="rounded-xl border border-gm-border bg-gm-surface-elevated px-3 py-2 text-caption text-gm-text-secondary">
        状态机：PENDING {stateSummary.PENDING} / CHUNKED {stateSummary.CHUNKED} / EMBEDDING {stateSummary.EMBEDDING} / INDEXED {stateSummary.INDEXED} / FAILED {stateSummary.FAILED}
      </div>
      <div className="rounded-xl border border-gm-border bg-gm-surface-elevated px-3 py-2 text-caption text-gm-text-secondary">
        Embedding 提供方：{embeddingProviderLabel}
        {lastIndexedAt ? ` · 最近重建：${new Date(lastIndexedAt).toLocaleString('zh-CN')}` : ''}
      </div>
      <div className="flex items-center gap-2">
        <Button type="default" size="small" loading={embedding} disabled={!databaseEnabled || stats.pendingEmbeddings === 0 && jobStats.pending === 0} onClick={() => runEmbedding(false)}>
          处理嵌入队列
        </Button>
        <Button type="default" size="small" disabled={!isTauri()} onClick={onOpenKnowledgeManager}>
          管理文档
        </Button>
        <Button type="text" size="small" disabled={!databaseEnabled || jobStats.failed === 0} onClick={() => runEmbedding(true)}>
          重试失败
        </Button>
        <Button type="text" size="small" disabled={!databaseEnabled} onClick={refreshStats}>
          刷新统计
        </Button>
        <Button type="text" size="small" disabled={!databaseEnabled} loading={embedding} onClick={handleCleanupWorkspace}>
          清理失效索引
        </Button>
        <Button type="text" size="small" disabled={!databaseEnabled} loading={embedding} onClick={handleRebuildWorkspace}>
          重建当前工作区
        </Button>
        {message && <span className="text-caption text-gm-text-secondary">{message}</span>}
      </div>
      {dbStatus === 'loading' && (
        <div className="rounded-xl border border-gm-border bg-gm-surface-elevated px-3 py-2 text-caption text-gm-text-secondary flex items-center gap-2">
          <span className="inline-block animate-spin">⏳</span> 数据库加载中，请等待……
        </div>
      )}
      {dbStatus === 'error' && (
        <div className="rounded-xl border border-red-300 bg-red-50 px-3 py-2 text-caption text-red-600">
          ❌ 数据库加载失败
        </div>
      )}
    </div>
  )
}

function StatItem({ label, value }: { label: string; value: number }) {
  return (
    <div className="text-center">
      <div className="text-title font-bold text-gm-text tabular-nums">{value}</div>
      <div className="text-micro text-gm-text-tertiary mt-0.5">{label}</div>
    </div>
  )
}

function EditorSettings() {
  const { editor, updateEditorSettings } = useSettingsStore()
  const modePerformanceDescription = MODE_PERFORMANCE_OPTIONS[getModePerformanceIndex(editor.modePerformancePolicy)].description

  return (
    <div className="w-full pb-6">
      <SectionTitle>外观</SectionTitle>
      <SliderField label="字号" description="编辑区与预览区文字大小，推荐 14-16px，Ctrl+滚轮可快捷调节" value={editor.fontSize} min={10} max={24} step={1} onChange={(v) => updateEditorSettings({ fontSize: Math.round(v) })} format={(v) => `${v}px`} debounceMs={150} />
      <SliderField label="行高" description="编辑区与预览区行间距倍数，影响阅读舒适度" value={editor.lineHeight} min={1.2} max={2.0} step={0.05} onChange={(v) => updateEditorSettings({ lineHeight: v })} format={(v) => v.toFixed(2)} debounceMs={150} />
      <SettingField label="Tab 大小" description="按 Tab 键插入的空格数">
        <Select
          options={[
            { key: '2', label: '2 空格' },
            { key: '4', label: '4 空格' },
          ]}
          value={String(editor.tabSize)}
          onChange={(v) => updateEditorSettings({ tabSize: parseInt(v) })}
        />
      </SettingField>
      <Sep />
      <SectionTitle>行为</SectionTitle>
      <SettingField label="默认打开模式" description="通过文件关联冷启动打开文件时，默认使用编辑或预览模式；已启动时不改变当前模式">
        <SegmentedTabs
          ariaLabel="默认打开模式"
          className="w-[168px]"
          items={[
            { value: 'edit', label: '编辑' },
            { value: 'preview', label: '预览' },
          ]}
          value={editor.defaultOpenMode}
          onChange={(value) => updateEditorSettings({ defaultOpenMode: value })}
        />
      </SettingField>
      <SettingField label="自动换行" description="长行自动折行显示">
        <Switch checked={editor.wordWrap} onChange={(v) => updateEditorSettings({ wordWrap: v })} />
      </SettingField>
      <SettingField label="行号" description="显示行号">
        <Switch checked={editor.lineNumbers} onChange={(v) => updateEditorSettings({ lineNumbers: v })} />
      </SettingField>
      <SettingField label="同步滚动" description="编辑 + 预览模式下同步两侧滚动位置">
        <Switch checked={editor.syncScroll} onChange={(v) => updateEditorSettings({ syncScroll: v })} />
      </SettingField>
      <SettingField label="预览内源码编辑" description="预览模式下按住 Alt 并点击 Markdown 块，可直接编辑该块源码">
        <Switch checked={editor.inlinePreviewEdit} onChange={(v) => updateEditorSettings({ inlinePreviewEdit: v })} />
      </SettingField>
      <SettingField label="快捷 AI 自动发送" description="点击编辑区右键菜单中的快捷 AI 操作后立即发送；关闭时仅填入输入框">
        <Switch checked={editor.autoSendAiShortcut} onChange={(v) => updateEditorSettings({ autoSendAiShortcut: v })} />
      </SettingField>
      <SettingField label="自动保存" description={!isTauri() ? "浏览器模式下自动保存不可用" : "编辑后自动保存"}>
        <Switch checked={isTauri() && editor.autoSave} onChange={(v) => updateEditorSettings({ autoSave: v })} disabled={!isTauri()} />
      </SettingField>
      <Sep />
      <SectionTitle>性能</SectionTitle>
      <SettingField label="模式性能策略" description={modePerformanceDescription} descriptionClassName="min-h-[54px]">
        <ModePerformanceSlider
          value={editor.modePerformancePolicy}
          onChange={(modePerformancePolicy) => updateEditorSettings({ modePerformancePolicy })}
        />
      </SettingField>
    </div>
  )
}

function ShortcutSettings() {
  const conflicts = findShortcutConflicts()
  const categories = Array.from(new Set(SHORTCUTS.map((item) => item.category)))

  return (
    <div className="w-full pb-6">
      <SectionTitle>快捷键总览</SectionTitle>
      <div className={`mb-3 rounded-xl border px-3 py-2 text-caption ${
        conflicts.length > 0 ? 'border-gm-error/30 bg-gm-error/5 text-gm-error' : 'border-gm-border bg-gm-surface-elevated text-gm-text-secondary'
      }`}>
        {conflicts.length > 0 ? `发现快捷键冲突：${conflicts.join('；')}` : '当前没有快捷键冲突。第一版仅支持查看，不支持自定义改键。'}
      </div>
      <div className="space-y-5">
        {categories.map((category) => (
          <div key={category}>
            <div className="mb-2 text-micro font-bold uppercase tracking-wider text-gm-text-tertiary">{category}</div>
            <Table
              showHeader={false}
              striped
              rowKey="id"
              className="gm-animal-table"
              dataSource={SHORTCUTS.filter((item) => item.category === category).map((item) => ({ ...item }))}
              columns={[
                {
                  title: '操作',
                  dataIndex: 'label',
                  render: (value) => <span className="text-body text-gm-text">{String(value)}</span>,
                },
                {
                  title: '快捷键',
                  dataIndex: 'key',
                  align: 'right',
                  render: (value) => (
                    <kbd className="rounded-full border border-gm-border bg-gm-surface-elevated px-2 py-0.5 font-mono text-micro text-gm-text-secondary">
                      {String(value)}
                    </kbd>
                  ),
                },
              ]}
            />
          </div>
        ))}
      </div>
    </div>
  )
}

function GeneralSettings() {
  const {
    appearance,
    updateAiConfig,
    updateEmbeddingConfig,
    updateEditorSettings,
    updateAppearanceSettings,
    updateWebSearchConfig,
    updateUsageTrackingSettings,
    resetAiShortcutActions,
  } = useSettingsStore()
  const [busy, setBusy] = useState(false)
  const [currentVersion, setCurrentVersion] = useState('—')
  const [loadingReleaseNotes, setLoadingReleaseNotes] = useState(false)
  const [checkingUpdate, setCheckingUpdate] = useState(false)
  const [updateCheckFeedback, setUpdateCheckFeedback] = useState<ManualUpdateCheckFeedback | null>(null)
  const [spritePreviewOpen, setSpritePreviewOpen] = useState(false)
  const mountedRef = useRef(true)
  const databaseEnabled = getRuntimeCapabilities().database

  useEffect(() => {
    mountedRef.current = true
    let active = true
    if (!isTauri()) {
      setCurrentVersion('网页版')
      return () => { mountedRef.current = false }
    }
    void getCurrentAppVersion()
      .then((version) => { if (active) setCurrentVersion(`v${version}`) })
      .catch(() => { if (active) setCurrentVersion('未知') })
    return () => {
      active = false
      mountedRef.current = false
    }
  }, [])

  useEffect(() => {
    if (!spritePreviewOpen) return
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopImmediatePropagation()
      setSpritePreviewOpen(false)
    }
    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [spritePreviewOpen])

  const handleCheckUpdate = async () => {
    setCheckingUpdate(true)
    setUpdateCheckFeedback(null)
    try {
      const feedback = await runManualUpdateCheck()
      if (mountedRef.current) setUpdateCheckFeedback(feedback)
    } finally {
      if (mountedRef.current) setCheckingUpdate(false)
    }
  }

  const handleVersionOverview = async () => {
    setLoadingReleaseNotes(true)
    try {
      const details = await getCurrentVersionRelease()
      if (mountedRef.current) useUpdateStore.getState().showDetails(details)
    } catch {
      if (mountedRef.current) toast.error('暂时无法获取当前版本说明，请稍后重试。')
    } finally {
      if (mountedRef.current) setLoadingReleaseNotes(false)
    }
  }

  const handleStarRepository = () => {
    void openReleaseInSystemBrowser(GITHUB_REPOSITORY_URL).catch((error) => {
      toast.error(error instanceof Error ? error.message : '打开项目仓库失败')
    })
  }

  const handleRestoreDefaults = () => {
    updateAiConfig({
      protocol: 'openai-chat',
      provider: 'custom',
      baseUrl: '',
      chatModel: '',
      streamEnabled: true,
      webSearchEnabled: false,
      customPreferencePrompt: '',
      timeout: 60000,
      maxContextLength: 8192,
      temperature: 0.7,
      topP: 1,
    })
    updateEmbeddingConfig({
      protocol: 'openai-embedding',
      provider: 'custom',
      baseUrl: '',
      embeddingModel: '',
      timeout: DEFAULT_REQUEST_TIMEOUT_MS,
    })
    updateEditorSettings({
      fontSize: 14,
      lineHeight: 1.65,
      tabSize: 2,
      wordWrap: true,
      lineNumbers: true,
      minimap: false,
      autoSave: true,
      autoSaveDelay: 1000,
      syncScroll: true,
      autoSendAiShortcut: true,
      inlinePreviewEdit: true,
      modePerformancePolicy: 'balanced',
      defaultOpenMode: 'preview',
    })
    updateAppearanceSettings({ customCursorEnabled: true, aiAvatarStyle: 'sprite', themeId: 'warm' })
    updateWebSearchConfig({ provider: 'duckduckgo', apiKey: '', maxResults: 5, customUrl: '', timeout: DEFAULT_REQUEST_TIMEOUT_MS })
    updateUsageTrackingSettings({ enabled: true })
    resetAiShortcutActions()
    toast.success('已恢复默认设置')
  }

  const handleExportBackup = async () => {
    setBusy(true)
    try {
      const path = await exportDataBackup()
      toast.success(`已导出数据备份：${path}`)
    } catch (err) {
      if ((err as Error).message !== '已取消导出') {
        toast.error(err instanceof Error ? err.message : '导出失败')
      }
    } finally {
      setBusy(false)
    }
  }

  const handleImportBackup = async () => {
    setBusy(true)
    try {
      const result = await importDataBackup()
      toast.success(`已导入 ${result.sessions} 个会话、${result.messages} 条消息、${result.memories} 条记忆、${result.artifacts} 条阅读成果`)
    } catch (err) {
      if ((err as Error).message !== '已取消导入') {
        toast.error(err instanceof Error ? err.message : '导入失败')
      }
    } finally {
      setBusy(false)
    }
  }

  const handleClearSessions = async () => {
    if (!window.confirm('确认清空所有已保存会话吗？此操作不可恢复。')) return
    setBusy(true)
    try {
      await clearSavedChatSessions()
      useChatStore.getState().resetHistoryState()
      toast.success('所有已保存会话已清空')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '清空会话失败')
    } finally {
      setBusy(false)
    }
  }

  const handleClearCandidates = async () => {
    if (!window.confirm('确认清空所有候选记忆吗？此操作不可恢复。')) return
    setBusy(true)
    try {
      await clearCandidateMemories()
      toast.success('候选记忆已清空')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '清空候选记忆失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="w-full pb-6">
      <SectionTitle>关于</SectionTitle>
      <div className="flex flex-wrap items-start gap-3 py-2">
        <div className="w-14 h-14 overflow-hidden flex items-center justify-center shrink-0">
          <img src={appIcon} alt="观墨" className="w-full h-full object-cover" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-body font-bold text-gm-text">观墨 {currentVersion}</div>
          <div className="text-caption text-gm-text-tertiary">AI 驱动的 Markdown 知识管理</div>
          <div
            role="status"
            aria-live="polite"
            className={`mt-1 flex min-h-4 items-center gap-1.5 text-micro ${
              checkingUpdate
                ? 'text-gm-text-secondary'
                : updateCheckFeedback?.tone === 'success'
                  ? 'text-gm-success'
                  : updateCheckFeedback?.tone === 'error'
                    ? 'text-gm-error'
                    : 'text-gm-primary'
            }`}
          >
            {(checkingUpdate || updateCheckFeedback) && (
              <>
                <span
                  aria-hidden="true"
                  className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${
                    checkingUpdate
                      ? 'bg-gm-text-tertiary'
                      : updateCheckFeedback?.tone === 'success'
                        ? 'bg-gm-success'
                        : updateCheckFeedback?.tone === 'error'
                          ? 'bg-gm-error'
                          : 'bg-gm-primary'
                  }`}
                />
                <span>{checkingUpdate ? '正在检查更新…' : updateCheckFeedback?.message}</span>
              </>
            )}
          </div>
        </div>
        <div className="ml-auto flex flex-wrap justify-end gap-2">
          <Button
            type="default"
            size="small"
            loading={loadingReleaseNotes}
            disabled={!isTauri()}
            onClick={() => void handleVersionOverview()}
          >
            版本速览
          </Button>
          <Button type="default" size="small" onClick={handleStarRepository}>
            点亮stars
          </Button>
          <Button type="default" size="small" onClick={requestProductTour}>
            产品导览
          </Button>
          <Button
            type="default"
            size="small"
            loading={checkingUpdate}
            disabled={!isTauri()}
            onClick={() => void handleCheckUpdate()}
          >
            检查更新
          </Button>
        </div>
      </div>

      <Sep />
      {isTauri() && (
        <>
          <UsageActivity />
          <Sep />
        </>
      )}

      <SectionTitle>外观</SectionTitle>
      <div className="gm-theme-setting py-1.5">
        <div>
          <span className="text-body text-gm-text">主题</span>
          <p className="mt-0.5 text-caption text-gm-text-tertiary">选择后立即应用到编辑器、预览和应用界面</p>
        </div>
        <ThemePicker value={appearance.themeId} onChange={(themeId) => updateAppearanceSettings({ themeId })} />
      </div>
      <SettingField label="定制光标" description="使用 animal-island-ui 的手作风光标">
        <Switch checked={appearance.customCursorEnabled} onChange={(v) => updateAppearanceSettings({ customCursorEnabled: v })} />
      </SettingField>
      <SettingField label="AI 头像" description="统一使用简约小球，可预览不同工作状态下的动作表现">
        <Button type="default" size="small" onClick={() => setSpritePreviewOpen(true)}>
          预览小球样式
        </Button>
      </SettingField>
      <Sep />
      <Button type="default" block onClick={handleRestoreDefaults}>恢复默认设置</Button>
      <Sep />

      <SectionTitle>数据管理</SectionTitle>
      <div className="space-y-2 rounded-xl border border-gm-border bg-gm-surface-elevated p-3">
        <p className="text-caption text-gm-text-secondary">
          {databaseEnabled
            ? '普通备份只包含会话、消息和长期记忆，不包含 API Key 等敏感密钥；知识库文档索引可在新设备重新打开工作区后重建。'
            : '浏览器模式不提供数据库备份、迁移或持久聊天历史；刷新页面会清空本页会话与文件状态。'}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button type="default" size="small" disabled={!databaseEnabled} loading={busy} onClick={handleExportBackup}>导出备份</Button>
          <Button type="default" size="small" disabled={!databaseEnabled} loading={busy} onClick={handleImportBackup}>导入备份</Button>
          <Button type="text" size="small" disabled={!databaseEnabled} loading={busy} onClick={handleClearCandidates}>清空候选记忆</Button>
          <Button type="text" size="small" disabled={!databaseEnabled} loading={busy} onClick={handleClearSessions}>清空已保存会话</Button>
        </div>
      </div>
      <Sep />

      <SectionTitle>旧版数据迁移</SectionTitle>
      {isTauri() ? (
        <LegacyMigrationEntry />
      ) : (
        <div className="rounded-xl border border-gm-border bg-gm-surface-elevated px-3 py-2">
          <p className="text-caption text-gm-text-secondary">
            网页版不支持数据库迁移，请使用桌面版。
          </p>
        </div>
      )}
      <Sep />

      <Collapse
        question="隐私说明"
        answer={
          <p className="text-caption text-gm-text-secondary py-1">
            {databaseEnabled
              ? '观墨完全在本地运行。AI API Key 和 Web 搜索 API Key 会通过系统加密能力保存，不写入普通设置。'
              : '观墨网页版不初始化数据库。API Key 可仅保存在当前页面内存，也可在风险确认后明文保存，或使用同一密码加密保存到 LocalStorage；文件、标签页和聊天消息不会跨刷新保留。'}
          </p>
        }
      />
      <Footer type="tree" className="mt-6 opacity-70" />
      <AiSpritePreviewModal
        open={spritePreviewOpen}
        onClose={() => setSpritePreviewOpen(false)}
        visualId={appearance.assistantVisualId}
      />
    </div>
  )
}

const MEMORY_CATEGORY_LABELS: Record<string, string> = {
  preference: '偏好',
  project: '项目',
  learning: '学习',
  profile: '画像',
  instruction: '长期指令',
  context: '上下文',
  general: '其他',
}

const MEMORY_SOURCE_LABELS: Record<string, string> = {
  user_explicit: '用户记忆',
  auto_extracted: '自动候选',
  manual_created: '手动创建',
}

const MEMORY_PAGE_SIZE = 20
const CANDIDATE_PAGE_SIZE = 10

export function MemorySettings() {
  const workspacePath = useAppStore(selectPrimaryWorkspacePath)
  const databaseEnabled = getRuntimeCapabilities().database
  const [memories, setMemories] = useState<Memory[]>([])
  const [candidateMemories, setCandidateMemories] = useState<Memory[]>([])
  const [memoryCounts, setMemoryCounts] = useState({ active: 0, candidate: 0, archived: 0 })
  const [activeTotal, setActiveTotal] = useState(0)
  const [candidateTotal, setCandidateTotal] = useState(0)
  const [filter, setFilter] = useState<string>('all')
  const [scopeFilter, setScopeFilter] = useState<'all' | 'global' | 'project'>('all')
  const [activePage, setActivePage] = useState(0)
  const [candidatePage, setCandidatePage] = useState(0)
  const [refreshToken, setRefreshToken] = useState(0)
  const [loading, setLoading] = useState(false)
  const [queryLoading, setQueryLoading] = useState(false)
  const [showForm, setShowForm] = useState(false)
  const [newContent, setNewContent] = useState('')
  const [newCategory, setNewCategory] = useState('preference')
  const normalizedWorkspace = normalizeMemoryScopeKey('project', workspacePath)

  const scopeOptions = useMemo(() => {
    if (scopeFilter === 'global') return { scopeType: 'global' as const }
    if (scopeFilter === 'project') {
      return {
        scopeType: 'project' as const,
        scopeKey: normalizedWorkspace,
        includeGlobalForProject: false,
      }
    }
    return {}
  }, [normalizedWorkspace, scopeFilter])

  useEffect(() => {
    let cancelled = false
    const loadPage = async () => {
      setQueryLoading(true)
      try {
        const [activeResult, candidateResult, activeCount, candidateCount, archivedCount] = await Promise.all([
          loadSettingsMemoryPage({
            statuses: ['active'],
            category: filter === 'all' ? undefined : filter,
            ...scopeOptions,
            limit: MEMORY_PAGE_SIZE,
            offset: activePage * MEMORY_PAGE_SIZE,
          }),
          loadSettingsMemoryPage({
            statuses: ['candidate'],
            ...scopeOptions,
            limit: CANDIDATE_PAGE_SIZE,
            offset: candidatePage * CANDIDATE_PAGE_SIZE,
          }),
          loadSettingsMemoryCount({ statuses: ['active'] }),
          loadSettingsMemoryCount({ statuses: ['candidate'] }),
          loadSettingsMemoryCount({ statuses: ['archived', 'superseded'] }),
        ])
        if (cancelled) return

        const lastActivePage = Math.max(0, Math.ceil(activeResult.total / MEMORY_PAGE_SIZE) - 1)
        const lastCandidatePage = Math.max(0, Math.ceil(candidateResult.total / CANDIDATE_PAGE_SIZE) - 1)
        if (activePage > lastActivePage || candidatePage > lastCandidatePage) {
          setActivePage(Math.min(activePage, lastActivePage))
          setCandidatePage(Math.min(candidatePage, lastCandidatePage))
          return
        }

        setMemories(activeResult.memories)
        setCandidateMemories(candidateResult.memories)
        setActiveTotal(activeResult.total)
        setCandidateTotal(candidateResult.total)
        setMemoryCounts({
          active: activeCount,
          candidate: candidateCount,
          archived: archivedCount,
        })
      } finally {
        if (!cancelled) setQueryLoading(false)
      }
    }
    void loadPage()
    return () => { cancelled = true }
  }, [activePage, candidatePage, filter, refreshToken, scopeOptions])

  const refresh = () => setRefreshToken((current) => current + 1)

  const handleDelete = async (id: string) => {
    setLoading(true)
    try {
      await deleteSettingsMemory(id)
      refresh()
      toast.success('记忆已删除')
    } finally {
      setLoading(false)
    }
  }

  const handleToggleLock = async (id: string, locked: boolean) => {
    setLoading(true)
    try {
      await toggleSettingsMemoryLocked(id, !locked)
      refresh()
    } finally {
      setLoading(false)
    }
  }

  const handleArchive = async (id: string) => {
    setLoading(true)
    try {
      await archiveSettingsMemory(id)
      refresh()
      toast.success('记忆已归档')
    } finally {
      setLoading(false)
    }
  }

  const handleConfirmCandidate = async (id: string) => {
    setLoading(true)
    try {
      const candidate = candidateMemories.find((memory) => memory.id === id)
      const confirmed = await confirmSettingsMemoryCandidate(id)
      if (!confirmed) {
        refresh()
        toast.error('候选记忆确认失败：数据库中没有可确认的候选记录')
        return
      }
      if (candidate) {
        setFilter(candidate.category || 'all')
        setActivePage(0)
        setCandidatePage(0)
      }
      refresh()
      toast.success('候选记忆已确认并保存')
    } finally {
      setLoading(false)
    }
  }

  const handleIgnoreCandidate = async (id: string) => {
    setLoading(true)
    try {
      await ignoreSettingsMemoryCandidate(id)
      refresh()
      toast.success('候选记忆已忽略')
    } finally {
      setLoading(false)
    }
  }

  const handleAdd = async () => {
    const content = newContent.trim()
    if (!content) return
    setLoading(true)
    try {
      await persistSettingsMemory({
        id: `mem-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        content,
        category: newCategory,
        source: 'manual_created',
        locked: false,
        status: 'active',
        ...inferMemoryScope(newCategory, workspacePath),
        factValue: content,
        confidence: 1,
        evidence: content,
        contentHash: contentHash(content),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
      setNewContent('')
      setNewCategory('preference')
      setShowForm(false)
      setActivePage(0)
      refresh()
      toast.success('记忆已添加')
    } finally {
      setLoading(false)
    }
  }

  const categories = ['all', 'preference', 'project', 'learning', 'profile', 'instruction', 'context', 'general']

  return (
    <div className="w-full pb-6">
      <SectionTitle>长期记忆</SectionTitle>
      {!isTauri() && (
        <div className="mb-3 rounded-xl border border-gm-border bg-gm-surface-elevated p-3">
          <p className="text-caption text-gm-text-tertiary">
            浏览器模式下长期记忆不可用，请下载桌面版体验完整功能
          </p>
        </div>
      )}
      <div className="flex items-center justify-between mb-3">
        <div className="text-caption text-gm-text-secondary">
          共 {memoryCounts.active} 条已保存记忆，{memoryCounts.candidate} 条候选记忆，{memoryCounts.archived} 条已归档/替代
        </div>
        <div className="flex items-center gap-2">
          <Button type="text" size="small" onClick={refresh} disabled={!databaseEnabled || queryLoading}>刷新</Button>
          <Button type="primary" size="small" onClick={() => setShowForm(!showForm)} disabled={!databaseEnabled}>
            {showForm ? '取消' : '添加记忆'}
          </Button>
        </div>
      </div>

      {showForm && (
        <div className="mb-4 rounded-xl border border-gm-border bg-gm-surface-elevated p-3 space-y-2">
          <textarea
            value={newContent}
            onChange={(e) => setNewContent(e.target.value)}
            placeholder="输入要记住的内容..."
            rows={3}
            className="w-full rounded-lg border border-gm-border-subtle bg-gm-surface px-3 py-2 text-body text-gm-text placeholder:text-gm-text-tertiary resize-none focus:outline-none focus:border-gm-primary"
          />
          <div className="flex items-center justify-between">
            <Select
              options={[
                { key: 'preference', label: '偏好' },
                { key: 'project', label: '项目' },
                { key: 'learning', label: '学习' },
                { key: 'profile', label: '画像' },
                { key: 'instruction', label: '长期指令' },
              ]}
              value={newCategory}
              onChange={setNewCategory}
              disabled={!databaseEnabled}
            />
            <Button
              type="primary"
              size="small"
              onClick={handleAdd}
              disabled={!databaseEnabled || !newContent.trim() || loading}
            >
              保存
            </Button>
          </div>
        </div>
      )}

      {candidateTotal > 0 && (
        <div className="mb-5">
          <div className="flex items-center justify-between mb-2">
            <div>
              <div className="text-body font-bold text-gm-text">候选记忆</div>
              <div className="text-caption text-gm-text-secondary">
                AI 只会暂存这些候选，确认后才会进入长期记忆
              </div>
            </div>
          </div>
          <div className="space-y-2">
            {candidateMemories.map((memory) => (
              <div key={memory.id} className="rounded-xl border border-gm-border bg-gm-surface-elevated p-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="inline-block px-1.5 py-0.5 rounded text-micro bg-gm-primary/10 text-gm-primary">
                        {MEMORY_CATEGORY_LABELS[memory.category] || memory.category}
                      </span>
                      <span className="inline-block px-1.5 py-0.5 rounded text-micro bg-gm-warning/10 text-gm-warning">
                        待确认
                      </span>
                      <span className="text-micro text-gm-text-tertiary">
                        {new Date(memory.updatedAt).toLocaleDateString('zh-CN')}
                      </span>
                    </div>
                    <p className="text-body text-gm-text break-words">{memory.content}</p>
                    {memory.supersedesId && (
                      <p className="mt-1 text-caption text-gm-warning">
                        将替换：{memories.find((item) => item.id === memory.supersedesId)?.content || '已有记忆'}
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-1 flex-shrink-0">
                    <Button
                      type="primary"
                      size="small"
                      onClick={() => handleConfirmCandidate(memory.id)}
                       disabled={!databaseEnabled || loading}
                    >
                      确认保存
                    </Button>
                    <Button
                      type="text"
                      size="small"
                      onClick={() => handleIgnoreCandidate(memory.id)}
                       disabled={!databaseEnabled || loading}
                      className="text-gm-text-tertiary hover:text-gm-error"
                    >
                      忽略
                    </Button>
                  </div>
                </div>
              </div>
            ))}
          </div>
          {candidateTotal > CANDIDATE_PAGE_SIZE && (
            <div className="mt-3 flex items-center justify-end gap-2">
              <Button
                type="default"
                size="small"
                disabled={!databaseEnabled || candidatePage === 0 || queryLoading}
                onClick={() => setCandidatePage((page) => Math.max(0, page - 1))}
              >
                上一页
              </Button>
              <span className="text-caption text-gm-text-secondary">
                候选第 {candidatePage + 1} / {Math.ceil(candidateTotal / CANDIDATE_PAGE_SIZE)} 页
              </span>
              <Button
                type="default"
                size="small"
                disabled={!databaseEnabled || (candidatePage + 1) * CANDIDATE_PAGE_SIZE >= candidateTotal || queryLoading}
                onClick={() => setCandidatePage((page) => page + 1)}
              >
                下一页
              </Button>
            </div>
          )}
        </div>
      )}

      <div className="mb-4 space-y-3 rounded-xl border border-gm-border bg-gm-surface-elevated p-3">
        <div>
          <div className="mb-2 flex items-baseline gap-2">
            <span className="text-caption font-bold text-gm-text">作用域</span>
            <span className="text-micro text-gm-text-tertiary">先选择记忆所属范围</span>
          </div>
          <div className="flex flex-wrap gap-2" role="group" aria-label="按记忆作用域筛选">
            {(['all', 'global', 'project'] as const).map((scope) => (
              <button
                type="button"
                key={scope}
                aria-pressed={scopeFilter === scope}
                onClick={() => {
                  setScopeFilter(scope)
                  setActivePage(0)
                  setCandidatePage(0)
                }}
                 disabled={!databaseEnabled || (scope === 'project' && !workspacePath)}
                 className={`min-h-8 rounded-lg border px-3 py-1.5 text-caption font-bold transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                  scopeFilter === scope
                    ? 'border-gm-primary bg-gm-primary/10 text-gm-primary'
                    : 'border-gm-border-subtle bg-gm-surface text-gm-text-secondary hover:border-gm-primary/50 hover:text-gm-text'
                }`}
              >
                {scope === 'all' ? '全部作用域' : scope === 'global' ? '全局' : '当前项目'}
              </button>
            ))}
          </div>
        </div>

        <div className="border-t border-gm-border-subtle pt-3">
          <div className="mb-2 flex items-baseline gap-2">
            <span className="text-caption font-bold text-gm-text">记忆类型</span>
            <span className="text-micro text-gm-text-tertiary">在当前作用域内继续筛选</span>
          </div>
          <div className="flex flex-wrap gap-2" role="group" aria-label="按记忆类型筛选">
            {categories.map((cat) => (
              <button
                type="button"
                key={cat}
                aria-pressed={filter === cat}
                 onClick={() => {
                   setFilter(cat)
                   setActivePage(0)
                 }}
                 disabled={!databaseEnabled}
                className={`min-h-8 rounded-lg border px-3 py-1.5 text-caption font-bold transition-colors ${
                  filter === cat
                    ? 'border-gm-primary bg-gm-primary/10 text-gm-primary'
                    : 'border-gm-border-subtle bg-gm-surface text-gm-text-secondary hover:border-gm-primary/50 hover:text-gm-text'
                }`}
              >
                {cat === 'all' ? '全部类型' : MEMORY_CATEGORY_LABELS[cat] || cat}
              </button>
            ))}
          </div>
        </div>
      </div>

      {memories.length === 0 ? (
        <div className="text-center py-8 text-caption text-gm-text-tertiary">
          {memoryCounts.active === 0 ? '还没有已保存的长期记忆，可以手动添加或确认候选记忆' : '当前分类没有记忆'}
        </div>
      ) : (
        <Table
          rowKey="id"
          striped
          className="gm-animal-table"
          dataSource={memories.map((memory) => ({ ...memory }))}
          columns={[
            {
              title: '记忆',
              dataIndex: 'content',
              render: (value, record) => {
                const memory = record as unknown as Memory
                return (
                  <div className="min-w-0 py-1">
                    <div className="mb-1 flex flex-wrap items-center gap-2">
                      <span className="inline-block rounded px-1.5 py-0.5 text-micro bg-gm-primary/10 text-gm-text">
                        {MEMORY_CATEGORY_LABELS[memory.category] || memory.category}
                      </span>
                      <span className="inline-block rounded px-1.5 py-0.5 text-micro bg-gm-surface text-gm-text-secondary">
                        {MEMORY_SOURCE_LABELS[memory.source] || memory.source}
                      </span>
                      <span className="inline-block rounded px-1.5 py-0.5 text-micro bg-gm-surface text-gm-text-secondary">
                        {memory.scopeType === 'project' ? '当前项目' : '全局'}
                      </span>
                      {memory.locked && (
                        <span className="inline-block rounded px-1.5 py-0.5 text-micro bg-gm-warning/10 text-gm-warning">
                          已锁定
                        </span>
                      )}
                      <span className="text-micro text-gm-text-tertiary">
                        {new Date(memory.updatedAt).toLocaleDateString('zh-CN')}
                      </span>
                    </div>
                    <p className="break-words text-body text-gm-text">{String(value)}</p>
                    {memory.subject && memory.factKey && (
                      <p className="mt-1 text-caption text-gm-text-secondary">
                        事实：{memory.subject}.{memory.factKey} = {memory.factValue || memory.content}
                      </p>
                    )}
                    {memory.evidence && memory.evidence !== memory.content && (
                      <p className="mt-1 text-caption text-gm-text-tertiary">
                        依据：{memory.evidence}
                      </p>
                    )}
                  </div>
                )
              },
            },
            {
              title: '操作',
              width: 176,
              align: 'right',
              render: (_value, record) => {
                const memory = record as unknown as Memory
                return (
                  <div className="flex items-center justify-end gap-1">
                    <Button
                      type="text"
                      size="small"
                      onClick={() => handleToggleLock(memory.id, memory.locked)}
                       disabled={!databaseEnabled || loading}
                      className={memory.locked ? 'text-gm-warning' : 'text-gm-text-tertiary hover:text-gm-warning'}
                    >
                      {memory.locked ? '解锁' : '锁定'}
                    </Button>
                    <Button
                      type="text"
                      size="small"
                      onClick={() => handleArchive(memory.id)}
                       disabled={!databaseEnabled || loading}
                      className="text-gm-text-tertiary hover:text-gm-primary"
                    >
                      归档
                    </Button>
                    <Button
                      type="text"
                      size="small"
                      onClick={() => handleDelete(memory.id)}
                       disabled={!databaseEnabled || loading}
                      className="text-gm-text-tertiary hover:text-gm-error"
                    >
                      删除
                    </Button>
                  </div>
                )
              },
            },
          ]}
        />
      )}
      {activeTotal > MEMORY_PAGE_SIZE && (
        <div className="mt-3 flex items-center justify-end gap-2">
          <Button
            type="default"
            size="small"
             disabled={!databaseEnabled || activePage === 0 || queryLoading}
            onClick={() => setActivePage((page) => Math.max(0, page - 1))}
          >
            上一页
          </Button>
          <span className="text-caption text-gm-text-secondary">
            第 {activePage + 1} / {Math.ceil(activeTotal / MEMORY_PAGE_SIZE)} 页
          </span>
          <Button
            type="default"
            size="small"
             disabled={!databaseEnabled || (activePage + 1) * MEMORY_PAGE_SIZE >= activeTotal || queryLoading}
            onClick={() => setActivePage((page) => page + 1)}
          >
            下一页
          </Button>
        </div>
      )}
    </div>
  )
}
