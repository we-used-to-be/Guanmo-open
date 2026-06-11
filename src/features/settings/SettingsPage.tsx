import { useEffect, useState } from 'react'
import { Button, Collapse, Divider, Footer, Icon, Input, Select, Switch, Table, Tabs } from 'animal-island-ui'
import appIcon from '@/assets/icon.png'
import type { IconName } from 'animal-island-ui'
import { useSettingsStore } from '@/stores/settingsStore'
import type { WebSearchConfig } from '@/services/webSearch'
import { initEmbeddingClient } from '@/services/ai/aiClient'
import { AI_CHAT_PRESETS, AI_EMBEDDING_PRESETS } from '@/services/ai/types'
import { updateSearchConfig } from '@/services/webSearch'
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
  clearAllChatSessions,
  clearMemoriesByStatus,
  confirmMemoryCandidate,
  loadAllMemories,
  removeMemory,
  toggleMemoryLocked,
  persistMemory,
  updateMemoryStatus,
  type Memory,
} from '@/services/database/persistence'
import { toast } from '@/services/toast'
import { useAppStore } from '@/stores/appStore'
import { cleanupMissingWorkspaceDocuments, rebuildWorkspaceDocuments } from '@/services/workspaceIndex'
import { exportDataBackup, importDataBackup } from '@/services/dataBackup'
import { useChatStore } from '@/stores/chatStore'

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
  { key: 'ai', icon: 'icon-chat' as IconName, text: 'AI 模型', children: <AiSettings /> },
  { key: 'editor', icon: 'icon-design' as IconName, text: '编辑器', children: <EditorSettings /> },
  { key: 'memory', icon: 'icon-critterpedia' as IconName, text: '记忆', children: <MemorySettings /> },
  { key: 'shortcuts', icon: 'icon-diy' as IconName, text: '快捷键', children: <ShortcutSettings /> },
  { key: 'general', icon: 'icon-map' as IconName, text: '通用', children: <GeneralSettings /> },
]

function TabLabel({ icon, text, isActive }: { icon: IconName; text: string; isActive?: boolean }) {
  return (
    <span className="inline-flex items-center gap-2">
      <Icon name={icon} size={20} bounce={isActive} />
      <span className="text-body">{text}</span>
    </span>
  )
}

export function SettingsPage() {
  const [active, setActive] = useState('ai')

  const tabs = TABS_CONFIG.map((tab) => ({
    key: tab.key,
    label: <TabLabel icon={tab.icon} text={tab.text} isActive={tab.key === active} />,
    children: tab.children,
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
    </div>
  )
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-micro font-bold text-gm-text-tertiary uppercase tracking-wider mt-6 mb-3 first:mt-0">
      {children}
    </h3>
  )
}

function Sep() {
  return <Divider type="line-brown" className="my-4 opacity-45" />
}

function SettingField({
  label,
  description,
  children,
}: {
  label: string
  description?: string
  children: React.ReactNode
}) {
  return (
    <div className="gm-setting-field flex items-center justify-between py-2 min-h-[44px]">
      <div className="pr-6" style={{ width: 260, flexShrink: 0 }}>
        <span className="text-body text-gm-text">{label}</span>
        {description && <p className="text-caption text-gm-text-tertiary mt-0.5">{description}</p>}
      </div>
      <div className="gm-setting-control flex-1 flex items-center justify-end min-w-0">{children}</div>
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
}: {
  label: string
  description?: string
  value: number
  min: number
  max: number
  step: number
  onChange: (v: number) => void
  format?: (v: number) => string
}) {
  const precision = step < 1 ? (step.toString().split('.')[1]?.length ?? 1) : 0
  const ticks: number[] = []
  for (let t = min; t <= max + step * 0.5; t = +(t + step).toFixed(10)) {
    ticks.push(+t.toFixed(precision))
  }
  const datalistId = `slider-${label}`

  return (
    <div className="gm-setting-field flex items-center justify-between py-2 min-h-[44px]">
      <div style={{ width: 260, flexShrink: 0 }}>
        <span className="text-body text-gm-text">{label}</span>
        {description && <p className="text-caption text-gm-text-tertiary mt-0.5">{description}</p>}
      </div>
      <div className="gm-setting-control flex-1 flex items-center gap-3 min-w-0">
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          list={datalistId}
          onChange={(e) => onChange(+parseFloat(e.target.value).toFixed(precision))}
          className="w-full h-4 accent-gm-primary bg-transparent appearance-none cursor-pointer
            [&::-webkit-slider-runnable-track]:h-1 [&::-webkit-slider-runnable-track]:rounded-full [&::-webkit-slider-runnable-track]:bg-gm-border-subtle
            [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:mt-[-3px] [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-gm-primary [&::-webkit-slider-thumb]:cursor-pointer [&::-webkit-slider-thumb]:shadow-sm
            [&::-moz-range-track]:h-1 [&::-moz-range-track]:rounded-full [&::-moz-range-track]:bg-gm-border-subtle
            [&::-moz-range-thumb]:w-3.5 [&::-moz-range-thumb]:h-3.5 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-gm-primary [&::-moz-range-thumb]:cursor-pointer [&::-moz-range-thumb]:shadow-sm"
        />
        <datalist id={datalistId}>
          {ticks.map((t) => <option key={t} value={t} />)}
        </datalist>
        <span className="text-mono text-caption text-gm-text-secondary w-12 text-right tabular-nums">
          {format ? format(value) : value}
        </span>
      </div>
    </div>
  )
}

function AiSettings() {
  const { ai, webSearch, updateAiConfig, updateEmbeddingConfig, updateWebSearchConfig } = useSettingsStore()

  useEffect(() => {
    updateSearchConfig(webSearch)
  }, [webSearch])

  const currentChatPreset =
    AI_CHAT_PRESETS.find((preset) =>
      preset.key !== 'custom' &&
      preset.baseUrl === ai.baseUrl &&
      preset.chatModel === ai.chatModel
    )?.key ?? 'custom'

  const currentEmbeddingPreset =
    AI_EMBEDDING_PRESETS.find((preset) =>
      preset.key !== 'custom' &&
      preset.baseUrl === ai.embedding.baseUrl &&
      preset.embeddingModel === ai.embedding.embeddingModel
    )?.key ?? 'custom'

  return (
    <div className="w-full pb-6">
      <SectionTitle>对话 API 配置</SectionTitle>
      <SettingField label="服务预设" description="选择后自动填入地址和模型">
        <Select
          options={AI_CHAT_PRESETS.map((preset) => ({ key: preset.key, label: preset.label }))}
          value={currentChatPreset}
          onChange={(key) => {
            const preset = AI_CHAT_PRESETS.find((item) => item.key === key)
            if (!preset || preset.key === 'custom') return
            updateAiConfig({
              baseUrl: preset.baseUrl,
              chatModel: preset.chatModel ?? '',
            })
          }}
        />
      </SettingField>
      <SettingField label="API Base URL" description="OpenAI-compatible API 地址">
        <Input value={ai.baseUrl} onChange={(e) => updateAiConfig({ baseUrl: e.target.value })} placeholder="https://api.openai.com/v1" />
      </SettingField>
      <SettingField label="API Key" description="通过系统安全存储保存，不写入普通设置">
        <Input type="password" value={ai.apiKey} onChange={(e) => updateAiConfig({ apiKey: e.target.value })} placeholder="sk-..." />
      </SettingField>
      <SettingField label="对话模型" description="用于日常对话和 Agent 执行的模型">
        <Input value={ai.chatModel} onChange={(e) => updateAiConfig({ chatModel: e.target.value })} placeholder="gpt-4o-mini" />
      </SettingField>

      <Sep />

      <SectionTitle>Embedding 配置</SectionTitle>
      <SettingField label="服务预设" description="可与对话使用不同服务商">
        <Select
          options={AI_EMBEDDING_PRESETS.map((preset) => ({ key: preset.key, label: preset.label }))}
          value={currentEmbeddingPreset}
          onChange={(key) => {
            const preset = AI_EMBEDDING_PRESETS.find((item) => item.key === key)
            if (!preset || preset.key === 'custom') return
            updateEmbeddingConfig({
              baseUrl: preset.baseUrl,
              embeddingModel: preset.embeddingModel ?? '',
            })
          }}
        />
      </SettingField>
      <SettingField label="API Base URL" description="Embedding 服务地址">
        <Input value={ai.embedding.baseUrl} onChange={(e) => updateEmbeddingConfig({ baseUrl: e.target.value })} placeholder="https://api.openai.com/v1" />
      </SettingField>
      <SettingField label="API Key" description="通过系统安全存储保存">
        <Input type="password" value={ai.embedding.apiKey} onChange={(e) => updateEmbeddingConfig({ apiKey: e.target.value })} placeholder="sk-..." />
      </SettingField>
      <SettingField label="Embedding 模型" description="将文本转为向量，用于知识库语义检索">
        <Input value={ai.embedding.embeddingModel} onChange={(e) => updateEmbeddingConfig({ embeddingModel: e.target.value })} placeholder="text-embedding-3-small" />
      </SettingField>

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
        <SettingField label="搜索 API Key" description="同样通过系统安全存储保存">
          <Input
            type="password"
            value={webSearch.apiKey}
            onChange={(e) => updateWebSearchConfig({ apiKey: e.target.value })}
            placeholder={webSearch.provider === 'tavily' ? 'tvly-...' : webSearch.provider === 'custom' ? '可选，用于 Authorization 头' : '...'}
          />
        </SettingField>
      )}

      <Sep />

      <SectionTitle>知识库</SectionTitle>
      <KnowledgeStats />
    </div>
  )
}

function KnowledgeStats() {
  const { ai } = useSettingsStore()
  const workspacePath = useAppStore((s) => s.workspacePath)
  const [stats, setStats] = useState({ documents: 0, totalChunks: 0, embeddedChunks: 0, pendingEmbeddings: 0 })
  const [jobStats, setJobStats] = useState({ pending: 0, running: 0, done: 0, failed: 0 })
  const [stateSummary, setStateSummary] = useState({ PENDING: 0, CHUNKED: 0, EMBEDDING: 0, INDEXED: 0, FAILED: 0 })
  const [embedding, setEmbedding] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [lastIndexedAt, setLastIndexedAt] = useState<number | null>(null)

  const refreshStats = async () => {
    setStats(await getRagStatsAsync())
    setJobStats(await getEmbeddingJobStats())
    setStateSummary(await getKnowledgeIndexStateSummary())
  }

  useEffect(() => {
    refreshStats()
  }, [])

  const runEmbedding = async (retryFailed = false) => {
    setMessage(null)
    if (!ai.embedding.apiKey) {
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
    if (!workspacePath) {
      setMessage('请先打开工作区后再清理失效索引')
      return
    }
    setEmbedding(true)
    try {
      const result = await cleanupMissingWorkspaceDocuments(workspacePath)
      await refreshStats()
      setMessage(result.removed > 0 ? `已清理 ${result.removed} 个失效索引` : '未发现失效索引')
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err))
    } finally {
      setEmbedding(false)
    }
  }

  const handleRebuildWorkspace = async () => {
    if (!workspacePath) {
      setMessage('请先打开工作区后再重建索引')
      return
    }
    setEmbedding(true)
    try {
      const result = await rebuildWorkspaceDocuments(workspacePath)
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
        <Button type="default" size="small" loading={embedding} disabled={stats.pendingEmbeddings === 0 && jobStats.pending === 0} onClick={() => runEmbedding(false)}>
          处理嵌入队列
        </Button>
        <Button type="text" size="small" disabled={jobStats.failed === 0} onClick={() => runEmbedding(true)}>
          重试失败
        </Button>
        <Button type="text" size="small" onClick={refreshStats}>
          刷新统计
        </Button>
        <Button type="text" size="small" loading={embedding} onClick={handleCleanupWorkspace}>
          清理失效索引
        </Button>
        <Button type="text" size="small" loading={embedding} onClick={handleRebuildWorkspace}>
          重建当前工作区
        </Button>
        {message && <span className="text-caption text-gm-text-secondary">{message}</span>}
      </div>
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

  return (
    <div className="w-full pb-6">
      <SectionTitle>外观</SectionTitle>
      <SliderField label="字号" description="编辑区与预览区文字大小，推荐 14-16px，Ctrl+滚轮可快捷调节" value={editor.fontSize} min={10} max={24} step={1} onChange={(v) => updateEditorSettings({ fontSize: Math.round(v) })} format={(v) => `${v}px`} />
      <SliderField label="行高" description="编辑区与预览区行间距倍数，影响阅读舒适度" value={editor.lineHeight} min={1.2} max={2.0} step={0.05} onChange={(v) => updateEditorSettings({ lineHeight: v })} format={(v) => v.toFixed(2)} />
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
      <SettingField label="自动换行" description="长行自动折行显示">
        <Switch checked={editor.wordWrap} onChange={(v) => updateEditorSettings({ wordWrap: v })} />
      </SettingField>
      <SettingField label="行号" description="显示行号">
        <Switch checked={editor.lineNumbers} onChange={(v) => updateEditorSettings({ lineNumbers: v })} />
      </SettingField>
      <SettingField label="自动保存" description="编辑后自动保存">
        <Switch checked={editor.autoSave} onChange={(v) => updateEditorSettings({ autoSave: v })} />
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
  const { appearance, updateAiConfig, updateEmbeddingConfig, updateEditorSettings, updateAppearanceSettings, updateWebSearchConfig } = useSettingsStore()
  const [busy, setBusy] = useState(false)

  const handleRestoreDefaults = () => {
    updateAiConfig({
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
      baseUrl: '',
      embeddingModel: '',
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
    })
    updateAppearanceSettings({ customCursorEnabled: true })
    updateWebSearchConfig({ provider: 'duckduckgo', apiKey: '', maxResults: 5, customUrl: '' })
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
      toast.success(`已导入 ${result.sessions} 个会话、${result.messages} 条消息、${result.memories} 条记忆`)
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
      await clearAllChatSessions()
      const nextSessionId = `session-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
      useChatStore.setState((state) => ({
        messages: [],
        currentSessionId: nextSessionId,
        historyOffset: 0,
        hasMoreHistory: false,
        streaming: false,
        error: null,
        agentMode: false,
        agentSteps: [],
        ragStatus: 'idle',
        ragSources: [],
        timeline: [],
        draftInput: '',
        pendingEdit: null,
        contextTags: [],
      }))
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
      await clearMemoriesByStatus(['candidate'])
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
      <div className="flex items-center gap-3 py-2">
        <div className="w-10 h-10 rounded-xl overflow-hidden flex items-center justify-center">
          <img src={appIcon} alt="观墨" className="w-full h-full object-cover" />
        </div>
        <div>
          <div className="text-body font-bold text-gm-text">观墨 v0.1.0</div>
          <div className="text-caption text-gm-text-tertiary">AI 驱动的 Markdown 知识管理</div>
        </div>
      </div>
      <div className="mt-3 space-y-2 rounded-xl border border-gm-border bg-gm-surface-elevated p-3 text-caption text-gm-text-secondary">
        <div>
          项目仓库：
          <a
            href="https://github.com/we-used-to-be/Guanmo-open"
            className="ml-1 font-bold text-gm-primary hover:underline cursor-pointer"
            onClick={(e) => { e.preventDefault(); openUrl('https://github.com/we-used-to-be/Guanmo-open', e.ctrlKey || e.metaKey) }}
          >
            we-used-to-be/Guanmo-open
          </a>
        </div>
        <div>
          组件库：
          <a
            href="https://github.com/guokaigdg/animal-island-ui"
            className="ml-1 font-bold text-gm-primary hover:underline cursor-pointer"
            onClick={(e) => { e.preventDefault(); openUrl('https://github.com/guokaigdg/animal-island-ui', e.ctrlKey || e.metaKey) }}
          >
            guokaigdg/animal-island-ui
          </a>
        </div>
      </div>

      <Sep />
      <SectionTitle>外观</SectionTitle>
      <SettingField label="定制光标" description="使用 animal-island-ui 的手作风光标">
        <Switch checked={appearance.customCursorEnabled} onChange={(v) => updateAppearanceSettings({ customCursorEnabled: v })} />
      </SettingField>
      <Sep />
      <Button type="default" block onClick={handleRestoreDefaults}>恢复默认设置</Button>
      <Sep />

      <SectionTitle>数据管理</SectionTitle>
      <div className="space-y-2 rounded-xl border border-gm-border bg-gm-surface-elevated p-3">
        <p className="text-caption text-gm-text-secondary">
          普通备份只包含会话、消息和长期记忆，不包含 API Key 等敏感密钥；知识库文档索引可在新设备重新打开工作区后重建。
        </p>
        <div className="flex flex-wrap gap-2">
          <Button type="default" size="small" loading={busy} onClick={handleExportBackup}>导出备份</Button>
          <Button type="default" size="small" loading={busy} onClick={handleImportBackup}>导入备份</Button>
          <Button type="text" size="small" loading={busy} onClick={handleClearCandidates}>清空候选记忆</Button>
          <Button type="text" size="small" loading={busy} onClick={handleClearSessions}>清空已保存会话</Button>
        </div>
      </div>
      <Sep />

      <Collapse
        question="隐私说明"
        answer={
          <p className="text-caption text-gm-text-secondary py-1">
            观墨完全在本地运行。AI API Key 和 Web 搜索 API Key 会通过系统加密能力保存，不写入普通设置；Web 预览环境不会持久化 API Key。
          </p>
        }
      />
      <Footer type="tree" className="mt-6 opacity-70" />
    </div>
  )
}

const MEMORY_CATEGORY_LABELS: Record<string, string> = {
  preference: '偏好',
  project: '项目',
  context: '上下文',
  general: '其他',
}

const MEMORY_SOURCE_LABELS: Record<string, string> = {
  user_explicit: '用户记忆',
  auto_extracted: '自动候选',
  manual_created: '手动创建',
}

function MemorySettings() {
  const [memories, setMemories] = useState<Memory[]>([])
  const [filter, setFilter] = useState<string>('all')
  const [loading, setLoading] = useState(false)
  const [showForm, setShowForm] = useState(false)
  const [newContent, setNewContent] = useState('')
  const [newCategory, setNewCategory] = useState('preference')

  const refresh = async () => {
    const all = await loadAllMemories()
    setMemories(all)
  }

  useEffect(() => { refresh() }, [])

  const activeMemories = memories.filter((m) => m.status === 'active')
  const candidateMemories = memories.filter((m) => m.status === 'candidate')
  const filtered = filter === 'all'
    ? activeMemories
    : activeMemories.filter((m) => m.category === filter)

  const handleDelete = async (id: string) => {
    setLoading(true)
    try {
      await removeMemory(id)
      await refresh()
      toast.success('记忆已删除')
    } finally {
      setLoading(false)
    }
  }

  const handleToggleLock = async (id: string, locked: boolean) => {
    setLoading(true)
    try {
      await toggleMemoryLocked(id, !locked)
      await refresh()
    } finally {
      setLoading(false)
    }
  }

  const handleConfirmCandidate = async (id: string) => {
    setLoading(true)
    try {
      const candidate = memories.find((memory) => memory.id === id)
      const confirmed = await confirmMemoryCandidate(id)
      if (!confirmed) {
        await refresh()
        toast.error('候选记忆确认失败：数据库中没有可确认的候选记录')
        return
      }
      if (candidate) {
        setMemories((current) => current.map((memory) =>
          memory.id === id
            ? { ...memory, status: 'active', source: 'user_explicit', updatedAt: Date.now() }
            : memory
        ))
        setFilter(candidate.category || 'all')
      }
      await refresh()
      toast.success('候选记忆已确认并保存')
    } finally {
      setLoading(false)
    }
  }

  const handleIgnoreCandidate = async (id: string) => {
    setLoading(true)
    try {
      await updateMemoryStatus(id, 'ignored')
      await refresh()
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
      await persistMemory({
        id: `mem-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        content,
        category: newCategory,
        source: 'manual_created',
        locked: false,
        status: 'active',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
      setNewContent('')
      setNewCategory('preference')
      setShowForm(false)
      await refresh()
      toast.success('记忆已添加')
    } finally {
      setLoading(false)
    }
  }

  const categories = ['all', 'preference', 'project', 'context', 'general']

  return (
    <div className="w-full pb-6">
      <SectionTitle>长期记忆</SectionTitle>
      <div className="flex items-center justify-between mb-3">
        <div className="text-caption text-gm-text-secondary">
          共 {activeMemories.length} 条已保存记忆，{candidateMemories.length} 条候选记忆
        </div>
        <div className="flex items-center gap-2">
          <Button type="text" size="small" onClick={refresh}>刷新</Button>
          <Button type="primary" size="small" onClick={() => setShowForm(!showForm)}>
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
                { key: 'context', label: '上下文' },
                { key: 'general', label: '其他' },
              ]}
              value={newCategory}
              onChange={setNewCategory}
            />
            <Button
              type="primary"
              size="small"
              onClick={handleAdd}
              disabled={!newContent.trim() || loading}
            >
              保存
            </Button>
          </div>
        </div>
      )}

      {candidateMemories.length > 0 && (
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
                  </div>
                  <div className="flex items-center gap-1 flex-shrink-0">
                    <Button
                      type="primary"
                      size="small"
                      onClick={() => handleConfirmCandidate(memory.id)}
                      disabled={loading}
                    >
                      确认保存
                    </Button>
                    <Button
                      type="text"
                      size="small"
                      onClick={() => handleIgnoreCandidate(memory.id)}
                      disabled={loading}
                      className="text-gm-text-tertiary hover:text-gm-error"
                    >
                      忽略
                    </Button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="flex gap-1.5 mb-3">
        {categories.map((cat) => (
          <button
            key={cat}
            onClick={() => setFilter(cat)}
            className={`px-2.5 py-1 rounded-full text-micro transition-colors ${
              filter === cat
                ? 'bg-gm-primary text-white'
                : 'bg-gm-surface-elevated text-gm-text-secondary hover:text-gm-text'
            }`}
          >
            {cat === 'all' ? '全部' : MEMORY_CATEGORY_LABELS[cat] || cat}
          </button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <div className="text-center py-8 text-caption text-gm-text-tertiary">
          {activeMemories.length === 0 ? '还没有已保存的长期记忆，可以手动添加或确认候选记忆' : '当前分类没有记忆'}
        </div>
      ) : (
        <Table
          rowKey="id"
          striped
          className="gm-animal-table"
          dataSource={filtered.map((memory) => ({ ...memory }))}
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
                  </div>
                )
              },
            },
            {
              title: '操作',
              width: 132,
              align: 'right',
              render: (_value, record) => {
                const memory = record as unknown as Memory
                return (
                  <div className="flex items-center justify-end gap-1">
                    <Button
                      type="text"
                      size="small"
                      onClick={() => handleToggleLock(memory.id, memory.locked)}
                      disabled={loading}
                      className={memory.locked ? 'text-gm-warning' : 'text-gm-text-tertiary hover:text-gm-warning'}
                    >
                      {memory.locked ? '解锁' : '锁定'}
                    </Button>
                    <Button
                      type="text"
                      size="small"
                      onClick={() => handleDelete(memory.id)}
                      disabled={loading}
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
    </div>
  )
}
