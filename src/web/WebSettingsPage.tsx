import { useEffect, useMemo, useState, useSyncExternalStore, type ChangeEvent, type ReactNode } from 'react'
import { Button, Collapse, Divider, Footer, Input, Select, Switch, Tabs } from 'animal-island-ui'
import { SegmentedTabs } from '@/components/common/SegmentedTabs'
import { SettingSlider } from '@/components/common/SettingSlider'
import { ThemePicker } from '@/features/settings/ThemePicker'
import { AiShortcutSettings } from '@/features/settings/AiShortcutSettings'
import { useSettingsStore } from '@/stores/settingsStore'
import { useChatStore } from '@/stores/chatStore'
import { SHORTCUTS, findShortcutConflicts } from '@/services/shortcuts'
import { testWebAiConnection } from '@/web/webAiClient'
import { AI_CHAT_PRESETS } from '@/services/ai/types'
import type { ChatProtocol, ValidateResult } from '@/services/ai/types'
import { testWebSearchConnection, updateSearchConfig } from '@/services/webSearch'
import type { WebSearchConfig, WebSearchTestResult } from '@/services/webSearch'
import { DEFAULT_REQUEST_TIMEOUT_MS } from '@/services/requestTimeout'
import { toast } from '@/services/toast'
import { requestProductTour } from '@/features/productTour/productTourEvents'
import {
  clearWebApiKeys,
  getWebSecretRuntimeState,
  persistWebApiKeys,
  setWebSessionApiKeys,
  subscribeWebSecretRuntime,
  unlockWebApiKeys,
} from '@/web/webSecretRuntime'
import type { WebApiSecrets } from '@/web/webSecretStorage'

function SectionTitle({ children }: { children: ReactNode }) {
  return <h3 className="mb-2 mt-4 text-body font-semibold text-gm-text">{children}</h3>
}

function SettingField({ label, description, children }: { label: string; description?: string; children: ReactNode }) {
  return (
    <div className="gm-setting-field flex min-h-[42px] items-center justify-between py-1.5">
      <div className="pr-6" style={{ width: 260, flexShrink: 0 }}>
        <span className="text-body text-gm-text">{label}</span>
        {description && <p className="mt-0.5 text-caption text-gm-text-tertiary">{description}</p>}
      </div>
      <div className="gm-setting-control flex min-w-0 flex-1 items-center justify-end">{children}</div>
    </div>
  )
}

function Sep() {
  return <Divider type="line-brown" className="gm-settings-sep my-3 opacity-45" />
}

function ApiKeyInput({ value, onChange, placeholder, disabled, ariaLabel }: {
  value: string
  onChange: (event: ChangeEvent<HTMLInputElement>) => void
  placeholder: string
  disabled?: boolean
  ariaLabel: string
}) {
  const [visible, setVisible] = useState(false)
  return (
    <Input
      type={visible ? 'text' : 'password'}
      value={value}
      onChange={onChange}
      placeholder={placeholder}
      disabled={disabled}
      aria-label={ariaLabel}
      suffix={<button type="button" aria-label={visible ? '隐藏' : '显示'} onClick={() => setVisible((current) => !current)}>{visible ? '隐藏' : '显示'}</button>}
    />
  )
}

function WebApiKeySettings() {
  const runtime = useSyncExternalStore(subscribeWebSecretRuntime, getWebSecretRuntimeState, getWebSecretRuntimeState)
  const chatApiKey = useSettingsStore((state) => state.ai.apiKey)
  const webSearchApiKey = useSettingsStore((state) => state.webSearch.apiKey)
  const [mode, setMode] = useState<'session' | 'plaintext' | 'encrypted'>(runtime.mode)
  const [password, setPassword] = useState('')
  const [message, setMessage] = useState('')
  const [showWarning, setShowWarning] = useState(false)

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
        setShowWarning(true)
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
    setShowWarning(false)
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
        {mode === 'encrypted' && <Input aria-label="保存密码" type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="保存密码" style={{ width: 160 }} />}
        <Button type="primary" size="small" onClick={() => void save()} disabled={!runtime.unlocked || (mode === 'encrypted' && !password)}>保存 Key</Button>
        {runtime.saved && <Button type="text" size="small" onClick={() => {
          clearWebApiKeys()
          useSettingsStore.getState().applyWebRuntimeApiKeys({ chatApiKey: '', webSearchApiKey: '' })
          setMessage('已清除')
        }}>清除已保存 Key</Button>}
        {message && <span className="text-caption text-gm-text-secondary">{message}</span>}
      </div>
      {showWarning && (
        <div className="gm-settings-mask fixed inset-0 z-[1200] flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-labelledby="web-key-warning-title">
          <div className="gm-settings-modal w-full max-w-md rounded-xl border border-gm-border bg-gm-surface p-5 shadow-lg">
            <h3 id="web-key-warning-title" className="text-body font-semibold text-gm-text">低安全性存储</h3>
            <p className="mt-2 text-caption text-gm-text-secondary">明文 LocalStorage 可能被同源脚本读取，仅建议用于免费且可随时撤销的 API Key。</p>
            <div className="mt-4 flex justify-end gap-2">
              <Button type="text" size="small" onClick={() => setShowWarning(false)}>取消</Button>
              <Button type="primary" size="small" onClick={() => void confirmPlaintextSave()}>仍然保存</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function WebAiSettings() {
  const ai = useSettingsStore((state) => state.ai)
  const webSearch = useSettingsStore((state) => state.webSearch)
  const customChatPresets = useSettingsStore((state) => state.customChatPresets)
  const updateAiConfig = useSettingsStore((state) => state.updateAiConfig)
  const updateWebSearchConfig = useSettingsStore((state) => state.updateWebSearchConfig)
  const addCustomChatPreset = useSettingsStore((state) => state.addCustomChatPreset)
  const removeCustomChatPreset = useSettingsStore((state) => state.removeCustomChatPreset)
  const runtime = useSyncExternalStore(subscribeWebSecretRuntime, getWebSecretRuntimeState, getWebSecretRuntimeState)
  const [chatTestResult, setChatTestResult] = useState<ValidateResult | null>(null)
  const [chatTesting, setChatTesting] = useState(false)
  const [searchTestResult, setSearchTestResult] = useState<WebSearchTestResult | null>(null)
  const [searchTesting, setSearchTesting] = useState(false)
  const [showChatSavePreset, setShowChatSavePreset] = useState(false)
  const [chatPresetName, setChatPresetName] = useState('')

  useEffect(() => {
    updateSearchConfig(webSearch)
  }, [webSearch])

  useEffect(() => {
    setChatTestResult(null)
    setShowChatSavePreset(false)
  }, [ai.protocol, ai.baseUrl, ai.apiKey, ai.chatModel, ai.timeout])

  const filteredCustomChatPresets = customChatPresets.filter((preset) => preset.protocol === ai.protocol)
  const chatPresetOptions = [
    ...filteredCustomChatPresets.map((preset) => ({ key: preset.id, label: preset.label })),
    ...AI_CHAT_PRESETS
      .filter((preset) => preset.key === 'custom' || preset.protocol === ai.protocol)
      .map((preset) => ({ key: preset.key, label: preset.label })),
  ]
  const matchedChatCustom = customChatPresets.find(
    (preset) => preset.protocol === ai.protocol && preset.baseUrl === ai.baseUrl && preset.chatModel === ai.chatModel,
  )
  const currentChatPreset = matchedChatCustom?.id
    ?? AI_CHAT_PRESETS.find((preset) =>
      preset.key !== 'custom' &&
      preset.protocol === ai.protocol &&
      preset.baseUrl === ai.baseUrl &&
      preset.chatModel === ai.chatModel,
    )?.key
    ?? 'custom'

  const testChat = async () => {
    setChatTesting(true)
    setChatTestResult(null)
    try {
      setChatTestResult(await testWebAiConnection({
        baseUrl: ai.baseUrl,
        apiKey: ai.apiKey,
        model: ai.chatModel,
        timeoutMs: ai.timeout,
      }))
    } catch (error) {
      setChatTestResult({ ok: false, error: 'unknown', message: (error as Error).message || String(error) })
    } finally {
      setChatTesting(false)
    }
  }

  const saveChatPreset = () => {
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

  const selectChatPreset = (key: string) => {
    const systemPreset = AI_CHAT_PRESETS.find((preset) => preset.key === key)
    if (systemPreset && systemPreset.key !== 'custom') {
      updateAiConfig({
        protocol: systemPreset.protocol as ChatProtocol,
        provider: systemPreset.provider,
        baseUrl: systemPreset.baseUrl,
        chatModel: systemPreset.chatModel ?? '',
      })
      return
    }
    const customPreset = customChatPresets.find((preset) => preset.id === key)
    if (customPreset) {
      updateAiConfig({
        protocol: customPreset.protocol as ChatProtocol,
        provider: customPreset.provider,
        baseUrl: customPreset.baseUrl,
        chatModel: customPreset.chatModel ?? '',
      })
    }
  }

  const testSearch = async () => {
    setSearchTesting(true)
    setSearchTestResult(null)
    try {
      setSearchTestResult(await testWebSearchConnection(webSearch))
    } catch (error) {
      setSearchTestResult({ ok: false, message: (error as Error).message || String(error) })
    } finally {
      setSearchTesting(false)
    }
  }

  return (
    <div className="w-full pb-6">
      <div className="mb-4 rounded-xl border border-gm-border bg-gm-surface-elevated p-3">
        <p className="text-caption text-gm-text-tertiary">浏览器模式下仅支持当前会话对话和联网搜索；RAG、长期记忆、持久聊天历史和 Embedding 不可用。</p>
      </div>
      <WebApiKeySettings />
      <SectionTitle>对话 API 配置</SectionTitle>
      <SettingField label="协议类型" description="Web 端使用 OpenAI-compatible Chat Completions">
        <Select options={[{ key: 'openai-chat', label: 'OpenAI Chat Completions' }]} value={ai.protocol} onChange={(value) => updateAiConfig({ protocol: value as ChatProtocol, provider: 'custom' })} />
      </SettingField>
      <SettingField label="服务预设" description="选择后自动填入服务商、地址和模型">
        <Select options={chatPresetOptions} value={currentChatPreset} onChange={selectChatPreset} />
      </SettingField>
      <SettingField label="API Base URL" description="OpenAI-compatible API 地址">
        <Input aria-label="对话 API 地址" value={ai.baseUrl} onChange={(event) => updateAiConfig({ baseUrl: event.target.value })} placeholder="https://api.openai.com/v1" />
      </SettingField>
      <SettingField label="API Key" description="填写后在顶部选择保存方式">
        <ApiKeyInput ariaLabel="对话 API Key" value={ai.apiKey} onChange={(event) => updateAiConfig({ apiKey: event.target.value })} placeholder="sk-..." disabled={!runtime.unlocked} />
      </SettingField>
      <SettingField label="对话模型" description="用于当前会话对话的模型">
        <Input aria-label="对话模型" value={ai.chatModel} onChange={(event) => updateAiConfig({ chatModel: event.target.value })} placeholder="gpt-4o-mini" />
      </SettingField>
      <div className="flex items-center gap-2 py-1">
        <Button type="default" size="small" loading={chatTesting} onClick={() => void testChat()}>测试连接</Button>
        {currentChatPreset !== 'custom' && customChatPresets.some((preset) => preset.id === currentChatPreset) && (
          <Button type="text" size="small" onClick={() => { removeCustomChatPreset(currentChatPreset); toast.success('预设已删除') }}>删除此预设</Button>
        )}
        {chatTestResult && <span className={chatTestResult.ok ? 'text-caption text-gm-success' : 'text-caption text-gm-error'}>{chatTestResult.ok ? '连接成功' : chatTestResult.message || '连接失败'}</span>}
      </div>
      {chatTestResult?.ok && (
        <div className="flex items-center gap-2 py-1">
          {!showChatSavePreset ? (
            <Button type="text" size="small" onClick={() => setShowChatSavePreset(true)}>保存为预设</Button>
          ) : (
            <>
              <Input value={chatPresetName} onChange={(event) => setChatPresetName(event.target.value)} placeholder="输入预设名称" style={{ width: 180 }} />
              <Button type="primary" size="small" onClick={saveChatPreset} disabled={!chatPresetName.trim()}>保存</Button>
              <Button type="text" size="small" onClick={() => { setShowChatSavePreset(false); setChatPresetName('') }}>取消</Button>
            </>
          )}
        </div>
      )}
      <Sep />
      <SectionTitle>对话参数</SectionTitle>
      <SettingField label="AI 创造性" description="值越高回答越发散，低值更精确稳定">
        <SettingSlider label="AI 创造性" value={ai.temperature} min={0} max={1} step={0.1} onChange={(value) => updateAiConfig({ temperature: value })} />
      </SettingField>
      <SettingField label="流式输出" description="实时显示 AI 回复"><Switch checked={ai.streamEnabled} onChange={(value) => updateAiConfig({ streamEnabled: value })} /></SettingField>
      <SettingField label="联网搜索" description="允许 Agent 使用 Web 搜索工具"><Switch checked={ai.webSearchEnabled} onChange={(value) => updateAiConfig({ webSearchEnabled: value })} /></SettingField>
      <SettingField label="用户偏好提示词" description="只影响回答风格和偏好，不覆盖安全与工具规则">
        <textarea aria-label="用户偏好提示词" value={ai.customPreferencePrompt} onChange={(event) => updateAiConfig({ customPreferencePrompt: event.target.value })} placeholder="例如：回答更简洁；优先用中文。" rows={3} className="w-full resize-y rounded-lg border border-gm-border-subtle bg-gm-surface px-3 py-2 text-body text-gm-text placeholder:text-gm-text-tertiary focus:border-gm-primary focus:outline-none" />
      </SettingField>
      <Sep />
      <SectionTitle>Embedding</SectionTitle>
      <div className="rounded-xl border border-gm-border bg-gm-surface-elevated p-3"><p className="text-caption text-gm-text-tertiary">Embedding 在 Web 端固定禁用。</p></div>
      <Sep />
      <SectionTitle>Web 搜索</SectionTitle>
      <SettingField label="搜索引擎" description="Agent 联网搜索时使用的引擎">
        <Select options={[{ key: 'duckduckgo', label: 'DuckDuckGo（免费）' }, { key: 'tavily', label: 'Tavily' }, { key: 'serper', label: 'Serper（Google）' }, { key: 'brave', label: 'Brave Search' }, { key: 'custom', label: '自定义' }]} value={webSearch.provider} onChange={(value) => updateWebSearchConfig({ provider: value as WebSearchConfig['provider'] })} />
      </SettingField>
      {webSearch.provider === 'custom' && <SettingField label="搜索 URL" description="搜索 API 的完整地址"><Input value={webSearch.customUrl || ''} onChange={(event) => updateWebSearchConfig({ customUrl: event.target.value })} placeholder="https://api.example.com/search" /></SettingField>}
      {webSearch.provider !== 'duckduckgo' && <SettingField label="搜索 API Key" description="填写后在顶部选择保存方式"><ApiKeyInput ariaLabel="联网搜索 API Key" value={webSearch.apiKey} onChange={(event) => updateWebSearchConfig({ apiKey: event.target.value })} placeholder={webSearch.provider === 'tavily' ? 'tvly-...' : '...'} disabled={!runtime.unlocked} /></SettingField>}
      <div className="flex items-center gap-2 py-1">
        <Button type="default" size="small" loading={searchTesting} onClick={() => void testSearch()}>测试连接</Button>
        {searchTestResult && <span className={searchTestResult.ok ? 'text-caption text-gm-success' : 'text-caption text-gm-error'}>{searchTestResult.ok ? '连接成功' : searchTestResult.message || '连接失败'}</span>}
      </div>
      <SectionTitle>搜索超时</SectionTitle>
      <SettingField label="请求超时" description="联网搜索请求最大等待时间">
        <Select options={[{ key: '15000', label: '15 秒' }, { key: '30000', label: '30 秒' }, { key: '60000', label: '60 秒' }]} value={String(webSearch.timeout || DEFAULT_REQUEST_TIMEOUT_MS)} onChange={(value) => updateWebSearchConfig({ timeout: Number(value) })} />
      </SettingField>
    </div>
  )
}

function WebEditorSettings() {
  const editor = useSettingsStore((state) => state.editor)
  const updateEditorSettings = useSettingsStore((state) => state.updateEditorSettings)
  return (
    <div className="w-full pb-6">
      <SectionTitle>外观</SectionTitle>
      <SettingField label="字号" description="编辑区与预览区文字大小"><SettingSlider label="字号" value={editor.fontSize} min={10} max={24} step={1} onChange={(value) => updateEditorSettings({ fontSize: Math.round(value) })} format={(value) => `${value}px`} debounceMs={150} /></SettingField>
      <SettingField label="行高" description="编辑区与预览区行间距倍数"><SettingSlider label="行高" value={editor.lineHeight} min={1.2} max={2} step={0.05} onChange={(value) => updateEditorSettings({ lineHeight: value })} format={(value) => value.toFixed(2)} debounceMs={150} /></SettingField>
      <SettingField label="Tab 大小" description="按 Tab 键插入的空格数"><Select options={[{ key: '2', label: '2 空格' }, { key: '4', label: '4 空格' }]} value={String(editor.tabSize)} onChange={(value) => updateEditorSettings({ tabSize: Number(value) })} /></SettingField>
      <Sep />
      <SectionTitle>行为</SectionTitle>
      <SettingField label="默认打开模式" description="打开 Markdown 时默认使用编辑或预览模式"><SegmentedTabs ariaLabel="默认打开模式" items={[{ value: 'edit', label: '编辑' }, { value: 'preview', label: '预览' }]} value={editor.defaultOpenMode} onChange={(value) => updateEditorSettings({ defaultOpenMode: value })} /></SettingField>
      <SettingField label="自动换行" description="长行自动折行显示"><Switch checked={editor.wordWrap} onChange={(value) => updateEditorSettings({ wordWrap: value })} /></SettingField>
      <SettingField label="行号" description="显示行号"><Switch checked={editor.lineNumbers} onChange={(value) => updateEditorSettings({ lineNumbers: value })} /></SettingField>
      <SettingField label="同步滚动" description="编辑与预览模式下同步滚动"><Switch checked={editor.syncScroll} onChange={(value) => updateEditorSettings({ syncScroll: value })} /></SettingField>
      <SettingField label="预览内源码编辑" description="按住 Alt 并点击 Markdown 块编辑"><Switch checked={editor.inlinePreviewEdit} onChange={(value) => updateEditorSettings({ inlinePreviewEdit: value })} /></SettingField>
      <SettingField label="快捷 AI 自动发送" description="快捷 AI 操作后立即发送"><Switch checked={editor.autoSendAiShortcut} onChange={(value) => updateEditorSettings({ autoSendAiShortcut: value })} /></SettingField>
    </div>
  )
}

function WebShortcutSettings() {
  const conflicts = findShortcutConflicts()
  const categories = Array.from(new Set(SHORTCUTS.map((item) => item.category)))
  return <div className="w-full pb-6"><SectionTitle>快捷键总览</SectionTitle><div className="mb-3 rounded-xl border border-gm-border bg-gm-surface-elevated px-3 py-2 text-caption text-gm-text-secondary">{conflicts.length > 0 ? `发现快捷键冲突：${conflicts.join('；')}` : '当前没有快捷键冲突。第一版仅支持查看，不支持自定义改键。'}</div>{categories.map((category) => <div key={category} className="mb-4"><h4 className="mb-2 text-caption font-semibold text-gm-text-tertiary">{category}</h4><div className="overflow-hidden rounded-xl border border-gm-border"><table className="w-full text-caption"><tbody>{SHORTCUTS.filter((item) => item.category === category).map((item) => <tr key={item.id} className="border-b border-gm-border-subtle last:border-b-0"><td className="px-3 py-2 text-gm-text">{item.label}</td><td className="px-3 py-2 text-right font-mono text-gm-text-secondary">{item.key}</td></tr>)}</tbody></table></div></div>)}</div>
}

function WebGeneralSettings() {
  const appearance = useSettingsStore((state) => state.appearance)
  const updateAppearanceSettings = useSettingsStore((state) => state.updateAppearanceSettings)
  const reset = useSettingsStore((state) => state.resetAiShortcutActions)
  const clearChat = useChatStore((state) => state.clearMessages)
  return <div className="w-full pb-6"><SectionTitle>外观</SectionTitle><div className="py-1.5"><span className="text-body text-gm-text">主题</span><p className="mt-0.5 text-caption text-gm-text-tertiary">选择后立即应用到编辑器、预览和应用界面</p><ThemePicker value={appearance.themeId} onChange={(value) => updateAppearanceSettings({ themeId: value })} /></div><SettingField label="定制光标" description="使用手作风光标"><Switch checked={appearance.customCursorEnabled} onChange={(value) => updateAppearanceSettings({ customCursorEnabled: value })} /></SettingField><Sep /><SectionTitle>数据边界</SectionTitle><div className="rounded-xl border border-gm-border bg-gm-surface-elevated p-3 text-caption text-gm-text-tertiary">网页端不初始化数据库；文件、标签页和聊天消息不会跨刷新保留。</div><div className="mt-3 flex flex-wrap gap-2"><Button type="default" size="small" onClick={requestProductTour}>产品导览</Button><Button type="text" size="small" onClick={() => { reset(); clearChat() }}>恢复快捷操作默认值并清空当前会话</Button></div><Sep /><Collapse question="隐私说明" answer={<p className="py-1 text-caption text-gm-text-secondary">API Key 只按上方选择的 Web 存储方式处理，网页端不启用 SQLite、RAG、Embedding 或持久聊天历史。</p>} /><Footer type="tree" className="mt-6 opacity-70" /></div>
}

export function WebSettingsPage() {
  const [active, setActive] = useState('ai')
  const tabs = useMemo(() => [
    { key: 'ai', label: <span className="text-body">AI 模型</span>, children: <WebAiSettings /> },
    { key: 'editor', label: <span className="text-body">编辑器</span>, children: <WebEditorSettings /> },
    { key: 'ai-shortcuts', label: <span className="text-body">快捷操作</span>, children: <AiShortcutSettings /> },
    { key: 'shortcuts', label: <span className="text-body">快捷键</span>, children: <WebShortcutSettings /> },
    { key: 'general', label: <span className="text-body">通用</span>, children: <WebGeneralSettings /> },
  ], [])
  return <div className="h-full flex flex-col"><div className="mb-4 flex-shrink-0"><h2 className="text-heading font-bold text-gm-text">设置</h2></div><div className="flex min-h-0 flex-1 flex-col"><Tabs items={tabs} activeKey={active} onChange={setActive} className="gm-settings-tabs gm-settings-tabs--web" leafAnimation={false} shadow={false} /></div></div>
}

export const SettingsPage = WebSettingsPage
export default WebSettingsPage
