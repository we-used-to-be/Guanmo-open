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
  })

  it('没有持久配置时使用完整默认值', async () => {
    const store = await loadSettingsStore()
    const state = store.getState()

    expect(state.editor).toMatchObject({ fontSize: 14, lineHeight: 1.65, autoSave: true, modePrewarm: 'smart', inlinePreviewEdit: true })
    expect(state.appearance).toMatchObject({ theme: 'light', lightPalette: 'warm' })
    expect(state.webSearch).toMatchObject({ provider: 'duckduckgo', maxResults: 5 })
  })

  it('旧配置缺少字段时由当前默认值补齐', async () => {
    const store = await loadSettingsStore({
      editor: { fontSize: 18 },
      appearance: { theme: 'dark' },
    })
    const state = store.getState()

    expect(state.editor).toMatchObject({ fontSize: 18, lineHeight: 1.65, fullscreenContentPadding: 88, inlinePreviewEdit: true })
    expect(state.appearance).toMatchObject({ theme: 'dark', lightPalette: 'warm', aiMascotAvatarEnabled: false })
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

  it('旧配置缺少 modeResourcePolicy 时默认 balanced', async () => {
    const store = await loadSettingsStore({
      editor: { fontSize: 16 },
    })
    const state = store.getState()
    expect(state.editor.modeResourcePolicy).toBe('balanced')
  })

  it('损坏的持久配置不会阻止应用使用默认设置', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const store = await loadSettingsStore(undefined, '{not-valid-json')

    expect(store.getState().editor.fontSize).toBe(14)
    expect(store.getState().appearance.theme).toBe('light')
  })
})
