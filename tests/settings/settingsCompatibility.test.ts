import { beforeEach, describe, expect, it, vi } from 'vitest'

async function loadSettingsStore(persisted?: unknown, raw?: string) {
  vi.resetModules()
  localStorage.clear()
  if (raw !== undefined) {
    localStorage.setItem('guanmo-settings', raw)
  } else if (persisted !== undefined) {
    localStorage.setItem('guanmo-settings', JSON.stringify({ state: persisted, version: 0 }))
  }
  return (await import('@/stores/settingsStore')).useSettingsStore
}

describe('设置兼容', () => {
  beforeEach(() => {
    localStorage.clear()
    delete document.documentElement.dataset.theme
    delete document.documentElement.dataset.themeId
    delete document.documentElement.dataset.lightPalette
    document.documentElement.style.colorScheme = ''
  })

  it('没有持久配置时使用完整默认值', async () => {
    const store = await loadSettingsStore()
    const state = store.getState()

    expect(state.editor).toMatchObject({ fontSize: 14, lineHeight: 1.65, autoSave: true, modePerformancePolicy: 'balanced', inlinePreviewEdit: true, autoSendAiShortcut: true, defaultOpenMode: 'preview' })
    expect(state.appearance).toMatchObject({
      version: 1,
      themeId: 'warm',
      lastLightThemeId: 'warm',
      assistantVisualId: 'sprite',
      motionPreference: 'system',
    })
    expect(state.webSearch).toMatchObject({ provider: 'duckduckgo', maxResults: 5, timeout: 60000 })
    expect(state.ai.timeout).toBe(60000)
    expect(state.ai.maxContextLength).toBe(8192)
    expect(state.ai.embedding.timeout).toBe(60000)
    expect(state.aiShortcutActions).toHaveLength(6)
    expect(state.aiShortcutActions.map((action) => action.label)).toEqual([
      'AI 解释这段',
      'AI 结合上下文解释',
      'AI 总结这段',
      'AI 改写这段',
      'AI 优化格式',
      'AI 翻译',
    ])
  })

  it('旧配置缺少字段时由当前默认值补齐', async () => {
    const store = await loadSettingsStore({
      editor: { fontSize: 18 },
      appearance: { theme: 'dark' },
    })
    const state = store.getState()

    expect(state.editor).toMatchObject({ fontSize: 18, lineHeight: 1.65, fullscreenContentPadding: 88, inlinePreviewEdit: true, autoSendAiShortcut: true, defaultOpenMode: 'preview' })
    expect(state.appearance).toMatchObject({ themeId: 'dark', lastLightThemeId: 'warm', aiAvatarStyle: 'sprite' })
  })

  it('保留用户显式关闭快捷 AI 自动发送的设置', async () => {
    const store = await loadSettingsStore({ editor: { autoSendAiShortcut: false } })
    expect(store.getState().editor.autoSendAiShortcut).toBe(false)
  })

  it('将旧主题组合迁移为统一主题 ID', async () => {
    const warmStore = await loadSettingsStore({ appearance: { theme: 'light', lightPalette: 'warm' } })
    expect(warmStore.getState().appearance).toMatchObject({ themeId: 'warm', lastLightThemeId: 'warm' })

    const lightStore = await loadSettingsStore({ appearance: { theme: 'light', lightPalette: 'plain' } })
    expect(lightStore.getState().appearance).toMatchObject({ themeId: 'light', lastLightThemeId: 'light' })

    const darkStore = await loadSettingsStore({ appearance: { theme: 'dark', lightPalette: 'plain' } })
    expect(darkStore.getState().appearance).toMatchObject({ themeId: 'dark', lastLightThemeId: 'light' })
  })

  it('保留合法新主题并回退非法主题', async () => {
    const paperStore = await loadSettingsStore({ appearance: { themeId: 'paper', lastLightThemeId: 'paper' } })
    expect(paperStore.getState().appearance).toMatchObject({ themeId: 'paper', lastLightThemeId: 'paper' })

    const fallbackStore = await loadSettingsStore({ appearance: { themeId: 'unknown' } })
    expect(fallbackStore.getState().appearance).toMatchObject({ themeId: 'warm', lastLightThemeId: 'warm' })
  })

  it('非法外观扩展字段回退为版本 1 默认值', async () => {
    const store = await loadSettingsStore({
      appearance: {
        version: 99,
        themeId: 'removed-theme',
        assistantVisualId: 'user-code',
        motionPreference: 'invalid',
      },
    })
    expect(store.getState().appearance).toMatchObject({
      version: 1,
      themeId: 'warm',
      assistantVisualId: 'sprite',
      motionPreference: 'system',
    })
  })

  it('切换主题时立即同步文档属性并记住非深色主题', async () => {
    const store = await loadSettingsStore()
    store.getState().updateAppearanceSettings({ themeId: 'github-light' })

    expect(store.getState().appearance.lastLightThemeId).toBe('github-light')
    expect(document.documentElement.dataset.themeId).toBe('github-light')
    expect(document.documentElement.dataset.theme).toBe('light')
    expect(document.documentElement.style.colorScheme).toBe('light')

    store.getState().updateAppearanceSettings({ themeId: 'dark' })
    expect(store.getState().appearance.lastLightThemeId).toBe('github-light')
    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(document.documentElement.style.colorScheme).toBe('dark')
  })

  it('旧模型和搜索配置缺少超时时补默认值，越界值会被限制', async () => {
    const defaultedStore = await loadSettingsStore({
      ai: { baseUrl: 'http://localhost:11434', embedding: { baseUrl: 'http://localhost:11434' } },
      webSearch: { provider: 'custom', customUrl: 'https://example.com/search' },
    })
    expect(defaultedStore.getState().ai.timeout).toBe(60000)
    expect(defaultedStore.getState().ai.embedding.timeout).toBe(60000)
    expect(defaultedStore.getState().webSearch.timeout).toBe(60000)

    const clampedStore = await loadSettingsStore({
      ai: { timeout: 1000, embedding: { timeout: 300000 } },
      webSearch: { timeout: 900000 },
    })
    expect(clampedStore.getState().ai.timeout).toBe(5000)
    expect(clampedStore.getState().ai.embedding.timeout).toBe(120000)
    expect(clampedStore.getState().webSearch.timeout).toBe(120000)
  })

  it('完整保留旧配置和自定义模型上下文窗口', async () => {
    const oldStore = await loadSettingsStore({ ai: { maxContextLength: 8192 } })
    expect(oldStore.getState().ai.maxContextLength).toBe(8192)

    const customStore = await loadSettingsStore({ ai: { maxContextLength: 24576 } })
    expect(customStore.getState().ai.maxContextLength).toBe(24576)
  })

  it('未知字段不影响已知配置和默认值加载', async () => {
    const store = await loadSettingsStore({
      unknownRoot: { anonymous: true },
      editor: { fontSize: 16, unknownEditor: 'ignored' },
    })
    const state = store.getState()

    expect(state.editor.fontSize).toBe(16)
    expect(state.editor.autoSave).toBe(true)
    expect(state.ai).toBeDefined()
  })

  it('旧配置缺少 modePerformancePolicy 时默认 balanced', async () => {
    const store = await loadSettingsStore({
      editor: { fontSize: 16 },
    })
    const state = store.getState()
    expect(state.editor.modePerformancePolicy).toBe('balanced')
  })

  it('损坏的持久配置不会阻止应用使用默认设置', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const store = await loadSettingsStore(undefined, '{not-valid-json')

    expect(store.getState().editor.fontSize).toBe(14)
    expect(store.getState().appearance.themeId).toBe('warm')
  })

  it('旧配置缺少 knowledge 字段时默认 autoIndexEnabled=true', async () => {
    const store = await loadSettingsStore({
      editor: { fontSize: 16 },
    })
    const state = store.getState()
    expect(state.knowledge).toBeDefined()
    expect(state.knowledge.autoIndexEnabled).toBe(true)
  })

  it('旧配置缺少快捷操作字段时补全默认列表', async () => {
    const store = await loadSettingsStore({
      editor: { fontSize: 18 },
    })

    expect(store.getState().aiShortcutActions).toHaveLength(6)
    expect(store.getState().editor.fontSize).toBe(18)
  })

  it('保留快捷操作的顺序、启用状态和合法空列表', async () => {
    const savedActions = [
      { id: 'second', label: '第二项', prompt: '第二条命令', enabled: false },
      { id: 'first', label: '第一项', prompt: '第一条命令', enabled: true },
    ]
    const populatedStore = await loadSettingsStore({ aiShortcutActions: savedActions })
    expect(populatedStore.getState().aiShortcutActions).toEqual(savedActions)

    const emptyStore = await loadSettingsStore({ aiShortcutActions: [] })
    expect(emptyStore.getState().aiShortcutActions).toEqual([])
  })

  it('过滤非法快捷操作，非空损坏列表回退默认值', async () => {
    const mixedStore = await loadSettingsStore({
      aiShortcutActions: [
        { id: 'valid', label: '保留项', prompt: '保留命令', enabled: true },
        { id: 'valid', label: '重复项', prompt: '重复 ID', enabled: true },
        { id: 'missing-prompt', label: '无命令', enabled: true },
      ],
    })
    expect(mixedStore.getState().aiShortcutActions).toEqual([
      { id: 'valid', label: '保留项', prompt: '保留命令', enabled: true },
    ])

    const brokenStore = await loadSettingsStore({
      aiShortcutActions: [{ id: '', label: '', prompt: '' }],
    })
    expect(brokenStore.getState().aiShortcutActions).toHaveLength(6)
  })
})

describe('旧字段迁移', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('新字段合法时以新字段为准', async () => {
    const store = await loadSettingsStore({
      editor: { modePerformancePolicy: 'speed', modePrewarm: 'off', modeResourcePolicy: 'memory' },
    })
    expect(store.getState().editor.modePerformancePolicy).toBe('speed')
  })

  it('新字段非法时回退迁移', async () => {
    const store = await loadSettingsStore({
      editor: { modePerformancePolicy: 'invalid', modePrewarm: 'smart' },
    } as unknown as Record<string, unknown>)
    expect(store.getState().editor.modePerformancePolicy).toBe('balanced')
  })

  it('只有旧 modePrewarm=off 时迁移为 memory', async () => {
    const store = await loadSettingsStore({
      editor: { modePrewarm: 'off' },
    } as unknown as Record<string, unknown>)
    expect(store.getState().editor.modePerformancePolicy).toBe('memory')
  })

  it('只有旧 modePrewarm=smart 时迁移为 balanced', async () => {
    const store = await loadSettingsStore({
      editor: { modePrewarm: 'smart' },
    } as unknown as Record<string, unknown>)
    expect(store.getState().editor.modePerformancePolicy).toBe('balanced')
  })

  it('只有旧 modePrewarm=turbo 时迁移为 speed', async () => {
    const store = await loadSettingsStore({
      editor: { modePrewarm: 'turbo' },
    } as unknown as Record<string, unknown>)
    expect(store.getState().editor.modePerformancePolicy).toBe('speed')
  })

  it('只有旧 modeResourcePolicy=memory 时迁移为 memory', async () => {
    const store = await loadSettingsStore({
      editor: { modeResourcePolicy: 'memory' },
    } as unknown as Record<string, unknown>)
    expect(store.getState().editor.modePerformancePolicy).toBe('memory')
  })

  it('只有旧 modeResourcePolicy=balanced 时迁移为 balanced', async () => {
    const store = await loadSettingsStore({
      editor: { modeResourcePolicy: 'balanced' },
    } as unknown as Record<string, unknown>)
    expect(store.getState().editor.modePerformancePolicy).toBe('balanced')
  })

  it('只有旧 modeResourcePolicy=speed 时迁移为 speed', async () => {
    const store = await loadSettingsStore({
      editor: { modeResourcePolicy: 'speed' },
    } as unknown as Record<string, unknown>)
    expect(store.getState().editor.modePerformancePolicy).toBe('speed')
  })

  describe('两个旧字段组合时选择较保守的较低档', () => {
    const prewarmValues = ['off', 'smart', 'turbo'] as const
    const resourceValues = ['memory', 'balanced', 'speed'] as const
    const expected: Record<string, Record<string, string>> = {
      off: { memory: 'memory', balanced: 'memory', speed: 'memory' },
      smart: { memory: 'memory', balanced: 'balanced', speed: 'balanced' },
      turbo: { memory: 'memory', balanced: 'balanced', speed: 'speed' },
    }
    for (const pw of prewarmValues) {
      for (const rp of resourceValues) {
        it(`modePrewarm=${pw} + modeResourcePolicy=${rp} → ${expected[pw][rp]}`, async () => {
          const store = await loadSettingsStore({
            editor: { modePrewarm: pw, modeResourcePolicy: rp },
          } as unknown as Record<string, unknown>)
          expect(store.getState().editor.modePerformancePolicy).toBe(expected[pw][rp])
        })
      }
    }
  })

  it('两个旧字段都非法时使用 balanced', async () => {
    const store = await loadSettingsStore({
      editor: { modePrewarm: 'bad', modeResourcePolicy: 'bad' },
    } as unknown as Record<string, unknown>)
    expect(store.getState().editor.modePerformancePolicy).toBe('balanced')
  })

  it('新 aiAvatarStyle 合法时以新字段为准', async () => {
    const store = await loadSettingsStore({
      appearance: { aiAvatarStyle: 'sprite', aiMascotAvatarEnabled: true },
    } as unknown as Record<string, unknown>)
    expect(store.getState().appearance.aiAvatarStyle).toBe('sprite')
  })

  it('只有旧 aiMascotAvatarEnabled=true 时迁移为 sprite', async () => {
    const store = await loadSettingsStore({
      appearance: { aiMascotAvatarEnabled: true },
    } as unknown as Record<string, unknown>)
    expect(store.getState().appearance.aiAvatarStyle).toBe('sprite')
  })

  it('只有旧 aiMascotAvatarEnabled=false 时迁移为 sprite', async () => {
    const store = await loadSettingsStore({
      appearance: { aiMascotAvatarEnabled: false },
    } as unknown as Record<string, unknown>)
    expect(store.getState().appearance.aiAvatarStyle).toBe('sprite')
  })

  it('aiAvatarStyle 非法或缺失时统一迁移为 sprite', async () => {
    const invalidStyleStore = await loadSettingsStore({
      appearance: { aiAvatarStyle: 'bogus', aiMascotAvatarEnabled: true },
    } as unknown as Record<string, unknown>)
    expect(invalidStyleStore.getState().appearance.aiAvatarStyle).toBe('sprite')

    const missingStore = await loadSettingsStore({
      appearance: {},
    })
    expect(missingStore.getState().appearance.aiAvatarStyle).toBe('sprite')
  })

  it('迁移后运行时对象不含旧 aiMascotAvatarEnabled 字段', async () => {
    const store = await loadSettingsStore({
      appearance: { aiMascotAvatarEnabled: true },
    } as unknown as Record<string, unknown>)
    expect(store.getState().appearance).toHaveProperty('aiAvatarStyle')
    expect(store.getState().appearance as unknown as Record<string, unknown>).not.toHaveProperty('aiMascotAvatarEnabled')
  })

  it('两个旧字段都缺失时使用 balanced', async () => {
    const store = await loadSettingsStore({
      editor: { fontSize: 16 },
    })
    expect(store.getState().editor.modePerformancePolicy).toBe('balanced')
  })

  it('迁移后运行时对象不含旧字段', async () => {
    localStorage.clear()
    const store = await loadSettingsStore({
      editor: { modePrewarm: 'off', modeResourcePolicy: 'memory' },
    } as unknown as Record<string, unknown>)
    const state = store.getState()
    expect(state.editor).toHaveProperty('modePerformancePolicy')
    expect(state.editor as Record<string, unknown>).not.toHaveProperty('modePrewarm')
    expect(state.editor as Record<string, unknown>).not.toHaveProperty('modeResourcePolicy')
  })

  it('迁移后重新写入的 localStorage 不含旧字段', async () => {
    localStorage.clear()
    const store = await loadSettingsStore({
      editor: { modePrewarm: 'turbo', modeResourcePolicy: 'speed' },
    } as unknown as Record<string, unknown>)
    // Trigger a state change to force persistence
    store.getState().updateEditorSettings({ fontSize: 16 })
    // Wait for persist middleware debounce
    await new Promise(r => setTimeout(r, 50))
    const raw = localStorage.getItem('guanmo-settings')
    expect(raw).toBeTruthy()
    // After migration, saved data should not contain old fields
    expect(raw).not.toContain('"modePrewarm"')
    expect(raw).not.toContain('"modeResourcePolicy"')
    expect(raw).toContain('"modePerformancePolicy"')
  })
})
