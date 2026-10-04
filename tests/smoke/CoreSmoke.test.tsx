import { performance as nodePerformance } from 'node:perf_hooks'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearMocks, mockConvertFileSrc, mockIPC, mockWindows } from '@tauri-apps/api/mocks'
import { createRuntimeGuard } from './runtimeGuard'

const native = vi.hoisted(() => ({
  violations: [] as string[],
  files: {
    'C:\\smoke\\alpha.md': '# Smoke Alpha\n\n匿名文档 A。',
    'C:\\smoke\\beta.md': '# Smoke Beta\n\n匿名文档 B。',
  } as Record<string, string>,
  selectedPath: 'C:\\smoke\\alpha.md',
  fullscreen: false,
  block(operation: string): never {
    this.violations.push(operation)
    throw new Error(`Smoke 禁止外部访问 / 未声明 mock: ${operation}`)
  },
}))

// 只替换宿主边界；App、lazy 页面、Store、Hook 和业务 Service 使用真实实现。
vi.mock('@settings-entry', () => import('@/features/settings/SettingsPage'))
function invokeMock(command: string, args?: Record<string, unknown>) {
  switch (command) {
      case 'plugin:window|is_maximized': return false
      case 'plugin:window|is_minimized': return false
      case 'plugin:window|is_visible': return true
      case 'plugin:window|is_focused': return true
      case 'plugin:window|is_fullscreen': return native.fullscreen
      case 'plugin:window|set_fullscreen': native.fullscreen = Boolean(args?.value); return undefined
      case 'plugin:app|version': return '0.0.0-smoke'
      case 'plugin:path|join': return (args?.paths as string[]).join('\\')
      case 'plugin:dialog|open': return (args?.options as { directory?: boolean })?.directory ? 'C:\\smoke' : native.selectedPath
      case 'wait_for_file_access_restore': return { restoreSucceeded: true, legacyMigrationCompleted: true, workspaceCount: 0, selectedFileCount: 0, pendingCount: 0 }
      case 'has_pending_open_files': return false
      case 'begin_fullscreen_dwm_transition': return null
      case 'take_pending_open_files':
      case 'load_reading_marks':
      case 'list_authorized_api_origins':
      case 'load_reading_marks_page': return []
      case 'load_secret': return null
      case 'authorize_selected_path':
      case 'authorize_workspace_path':
      case 'record_diagnostic_event':
      case 'record_startup_metrics': return undefined
      case 'read_text_file_by_path': return native.files[String(args?.path)] ?? native.block(command)
      case 'path_exists': return Object.prototype.hasOwnProperty.call(native.files, String(args?.path))
      case 'read_dir_by_path': return [{ name: 'alpha.md', path: 'C:\\smoke\\alpha.md', isDirectory: false }, { name: 'beta.md', path: 'C:\\smoke\\beta.md', isDirectory: false }]
      case 'list_reading_backgrounds': return { version: 1, localBackgrounds: [], downloadedScenes: [] }
      case 'get_diagnostics_mode': return false
      default: return native.block(command)
  }
}
vi.mock('@tauri-apps/plugin-sql', () => ({
  default: { load: vi.fn(async () => ({
    execute: vi.fn(async () => ({ rowsAffected: 0, lastInsertId: 0 })),
    select: vi.fn(async (sql: string) => {
      if (sql === 'PRAGMA user_version') {
        const { CURRENT_DB_SCHEMA_VERSION } = await import('@/services/database/schema')
        return [{ user_version: CURRENT_DB_SCHEMA_VERSION }]
      }
      if (/^SELECT\s+COUNT\(/i.test(sql.trim())) return [{ count: 0, total: 0 }]
      return []
    }),
    close: vi.fn(async () => undefined),
  })) },
}))
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: async (options: { directory?: boolean }) => options.directory ? 'C:\\smoke' : native.selectedPath, save: async () => native.block('save dialog') }))
vi.mock('@tauri-apps/plugin-fs', () => ({ exists: async () => false, readDir: async () => [], readTextFile: async () => native.block('plugin-fs read'), writeTextFile: async () => native.block('plugin-fs write') }))
vi.mock('@tauri-apps/plugin-shell', () => ({ open: async () => native.block('shell open') }))

import App from '@/App'
import { useAppStore } from '@/stores/appStore'
import { useEditorStore } from '@/stores/editorStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { useChatStore } from '@/stores/chatStore'
import { useToastStore } from '@/stores/toastStore'
import { closeDatabase, getDatabaseRuntimeState } from '@/services/database/db'

let guard: ReturnType<typeof createRuntimeGuard>
let root: HTMLDivElement

beforeEach(() => {
  native.violations.length = 0
  native.fullscreen = false
  native.selectedPath = 'C:\\smoke\\alpha.md'
  mockWindows('main')
  mockIPC((command, args) => invokeMock(command, args as Record<string, unknown> | undefined), { shouldMockEvents: true })
  mockConvertFileSrc('windows')
  vi.stubGlobal('performance', nodePerformance)
  vi.stubGlobal('fetch', () => native.block('fetch'))
  vi.stubGlobal('XMLHttpRequest', class { constructor() { native.block('XMLHttpRequest') } })
  vi.stubGlobal('WebSocket', class { constructor() { native.block('WebSocket') } })
  if (!HTMLElement.prototype.scrollTo) HTMLElement.prototype.scrollTo = () => undefined
  if (!Range.prototype.getClientRects) Range.prototype.getClientRects = () => [] as unknown as DOMRectList
  if (!Range.prototype.getBoundingClientRect) Range.prototype.getBoundingClientRect = () => new DOMRect()
  localStorage.clear()
  useAppStore.setState(useAppStore.getInitialState())
  useEditorStore.setState(useEditorStore.getInitialState())
  useChatStore.setState(useChatStore.getInitialState())
  useToastStore.setState(useToastStore.getInitialState())
  useAppStore.setState({ sidebarCollapsed: false, aiPanelOpen: false })
  useSettingsStore.setState((state) => ({
    editor: { ...state.editor, defaultOpenMode: 'edit', autoSave: false, modePerformancePolicy: 'memory' },
    appearance: { ...state.appearance, customCursorEnabled: false, fullscreenTransitionEnabled: false, fullscreenBackgroundEnabled: false },
    knowledge: { ...state.knowledge, autoIndexEnabled: false },
    ai: { ...state.ai, apiKey: '', baseUrl: '', chatModel: '', embedding: { ...state.ai.embedding, apiKey: '', baseUrl: '' } },
  }))
  // 避免首次邀请弹出；只跳过产品导览，不替换入口组件。
  localStorage.setItem('guanmo-product-tour-invite-v1', '1')
  // 更新检查走既有 24 小时缓存；Smoke 不验证联网更新。
  localStorage.setItem('guanmo:update:last-check', String(Date.now()))
  root = document.createElement('div')
  root.id = 'root'
  document.body.append(root)
  guard = createRuntimeGuard(root)
})

afterEach(async () => {
  try {
    guard.assertHealthy()
    expect(native.violations).toEqual([])
  } finally {
    // 主动卸载允许壳层消失，但卸载期间的 runtime error 仍须失败。
    guard.disarmShell()
    cleanup()
    root.remove()
    try {
      await vi.dynamicImportSettled()
      await new Promise((resolve) => setTimeout(resolve, 30))
      guard.assertHealthy()
      expect(native.violations).toEqual([])
    } finally {
      guard.stop()
      await closeDatabase()
      clearMocks()
      vi.unstubAllGlobals()
    }
  }
})

async function checkpoint(assertSurface: () => void) {
  await waitFor(() => { guard.assertHealthy(); assertSurface() }, { timeout: 8000 })
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)) })
  guard.assertHealthy()
  expect(native.violations).toEqual([])
}

async function boot() {
  render(<App />, { container: root })
  await checkpoint(() => {
    expect(getDatabaseRuntimeState().status).toBe('ready')
    expect(screen.getByTitle('设置')).toBeInTheDocument()
    expect(screen.getByText('未打开文件')).toBeInTheDocument()
  })
  const shell = root.querySelector<HTMLElement>('.bg-gm-canvas')
  expect(shell).not.toBeNull()
  guard.armShell(shell!)
}

describe('Core Smoke（真实 Desktop React Tree，隔离原生 I/O）', () => {
  it('空会话启动并完成主界面首次渲染', async () => { await boot() })

  it('Markdown 编辑/预览/分屏/全屏、侧栏、AI/阅读成果、设置/知识库和 Tab 往返', async () => {
    const user = userEvent.setup()
    await boot()
    await user.click(screen.getByTitle('打开文件'))
    await checkpoint(() => expect(root.querySelector('.cm-content')?.textContent).toContain('Smoke Alpha'))
    expect(useEditorStore.getState().tabs[0]?.filePath).toBe('C:\\smoke\\alpha.md')

    await user.click(screen.getByTitle('预览模式'))
    await checkpoint(() => expect(screen.getByRole('heading', { name: 'Smoke Alpha' })).toBeInTheDocument())
    await user.click(screen.getByTitle('编辑+预览'))
    await checkpoint(() => {
      expect(root.querySelector('.cm-content')?.textContent).toContain('Smoke Alpha')
      expect(screen.getByRole('heading', { name: 'Smoke Alpha' })).toBeInTheDocument()
    })
    await user.click(screen.getByTitle('预览模式'))
    await user.click(screen.getByTitle('进入全屏 F11'))
    await checkpoint(() => {
      expect(useAppStore.getState().isFullscreen).toBe(true)
      expect(screen.getByTitle('退出全屏')).toBeInTheDocument()
      expect(screen.getByRole('heading', { name: 'Smoke Alpha' })).toBeInTheDocument()
    })
    await user.click(screen.getByTitle('退出全屏'))
    await checkpoint(() => expect(screen.getByTitle('设置')).toBeInTheDocument())

    await user.click(screen.getByRole('button', { name: /打开 AI 助手/ }))
    await checkpoint(() => {
      expect(screen.getByText('AI 助手')).toBeInTheDocument()
      expect(screen.getByPlaceholderText('输入消息... (Enter 发送)')).toBeInTheDocument()
    })
    await user.click(screen.getByRole('button', { name: '打开阅读成果' }))
    await checkpoint(() => expect(screen.getByPlaceholderText('搜索阅读成果')).toBeInTheDocument())
    await user.click(screen.getByRole('button', { name: /打开 AI 助手/ }))
    await checkpoint(() => expect(screen.getByPlaceholderText('输入消息... (Enter 发送)')).toBeInTheDocument())

    await user.click(screen.getByTitle('设置'))
    await checkpoint(() => expect(screen.getByText('AI 模型')).toBeInTheDocument())
    await user.click(screen.getByText('管理文档'))
    await checkpoint(() => {
      expect(screen.getByText('知识库文档管理')).toBeInTheDocument()
      expect(screen.getByText('暂无已入库文档')).toBeInTheDocument()
    })
    await user.click(screen.getByRole('button', { name: '关闭知识库管理' }))
    await checkpoint(() => expect(screen.queryByText('知识库文档管理')).not.toBeInTheDocument())
    fireEvent.keyDown(document, { key: 'Escape' })
    await checkpoint(() => expect(screen.queryByText('AI 模型')).not.toBeInTheDocument())

    await user.click(screen.getByTitle('打开文件夹'))
    await checkpoint(() => {
      expect(screen.getByText('smoke')).toBeInTheDocument()
      expect(screen.getAllByText('beta.md').length).toBeGreaterThan(0)
    })
    native.selectedPath = 'C:\\smoke\\beta.md'
    await user.click(screen.getByTitle('打开文件'))
    await checkpoint(() => expect(screen.getByRole('heading', { name: 'Smoke Beta' })).toBeInTheDocument())
    for (const name of ['alpha.md', 'beta.md', 'alpha.md']) {
      const tab = screen.getAllByText(name).find((element) => element.closest('[role="button"][draggable]'))
      expect(tab).toBeDefined()
      await user.click(tab!)
      await checkpoint(() => expect(screen.getByRole('heading', { name: name === 'alpha.md' ? 'Smoke Alpha' : 'Smoke Beta' })).toBeInTheDocument())
    }
    await user.click(screen.getByTitle('编辑模式'))
    await checkpoint(() => expect(root.querySelector('.cm-content')?.textContent).toContain('Smoke Alpha'))
  }, 30000)
})
