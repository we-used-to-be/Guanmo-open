import { render, act } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import React from 'react'

// Mock IntersectionObserver for jsdom
if (typeof IntersectionObserver === 'undefined') {
  globalThis.IntersectionObserver = class IntersectionObserver {
    constructor(_callback: IntersectionObserverCallback, _options?: IntersectionObserverInit) {}
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords(): IntersectionObserverEntry[] { return [] }
    root: Element | null = null
    rootMargin = ''
    thresholds: ReadonlyArray<number> = []
  } as unknown as typeof IntersectionObserver
}

// Mock Tauri hooks
vi.mock('@/hooks/useTauri', () => ({
  isTauri: false,
  openFileDialog: vi.fn(),
  openUrl: vi.fn(),
}))

// Mock file system
vi.mock('@/services/fileSystem', () => ({
  saveFile: vi.fn(),
  saveFileAs: vi.fn(),
  openFile: vi.fn(),
}))

// Mock RAG indexer
vi.mock('@/services/rag/indexer', () => ({
  scheduleMarkdownDocumentIndex: vi.fn(),
}))

// Mock toast
vi.mock('@/services/toast', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
  },
}))

// Mock event marker
vi.mock('@/services/eventMarker', () => ({
  eventMarker: {
    start: vi.fn(),
    mark: vi.fn(),
  },
}))

// Mock AI context
vi.mock('@/services/aiContext', () => ({
  addSelectionContextTag: vi.fn(),
  setAiShortcutPrompt: vi.fn(),
}))

// Mock editor view ref
vi.mock('@/services/editorViewRef', () => ({
  setActiveEditorView: vi.fn(),
  getActiveEditorView: vi.fn(() => null),
}))

// Mock markdown images
vi.mock('@/services/markdownImages', () => ({
  saveExternalImageForMarkdown: vi.fn(),
  saveImageFileForMarkdown: vi.fn(),
}))

// Mock useFileOperations
vi.mock('@/hooks/useFileOperations', () => ({
  useFileOperations: () => ({
    handleNewFile: vi.fn(),
    handleOpenFile: vi.fn(),
  }),
}))

// Mock file operation errors
vi.mock('@/services/fileOperationErrors', () => ({
  describeFileOperationError: vi.fn(() => 'mock error'),
}))

// Mock Tauri API core
vi.mock('@tauri-apps/api/core', () => ({
  convertFileSrc: vi.fn((src: string) => src),
}))

import { useEditorStore, type Tab } from '@/stores/editorStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { EditorArea } from '@/components/editor/EditorArea'
import { ReadingPositionSession } from '@/services/editorSession'

function createAnonymousTab(id: string, content: string): Tab {
  return {
    id,
    title: `匿名文档-${id}.md`,
    filePath: null,
    content,
    savedContent: content,
    originalContent: content,
    modified: false,
  }
}

function setupEditor(tabs: Tab[], activeTabId: string, viewMode: string = 'edit') {
  useEditorStore.setState({
    tabs,
    activeTabId,
    viewMode: viewMode as 'edit' | 'preview' | 'edit-preview' | 'dual-preview' | 'diff-preview',
    rightPaneTabId: null,
    rightPaneUserSelected: false,
    viewModeUsage: {},
    previewVisible: false,
    previewSwitchingTabId: null,
    pendingReveal: null,
  })
}

describe('模式资源泄漏回归', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Reset stores
    useEditorStore.setState({
      tabs: [],
      activeTabId: null,
      viewMode: 'edit',
      rightPaneTabId: null,
      rightPaneUserSelected: false,
      viewModeUsage: {},
      previewVisible: false,
      previewSwitchingTabId: null,
      pendingReveal: null,
      recentFiles: [],
      favorites: [],
    })
    useSettingsStore.setState({
      editor: {
        fontSize: 14,
        lineHeight: 1.65,
        fontFamily: 'monospace',
        tabSize: 2,
        wordWrap: true,
        lineNumbers: true,
        minimap: false,
        autoSave: false,
        autoSaveDelay: 1000,
        syncScroll: false,
        autoSendAiShortcut: true,
        inlinePreviewEdit: false,
        modePrewarm: 'off',
        fullscreenContentPadding: 88,
      },
      ai: {
        protocol: 'openai-chat' as const,
        provider: 'custom' as const,
        baseUrl: '',
        apiKey: '',
        chatModel: 'anonymous',
        streamEnabled: false,
        webSearchEnabled: false,
        customPreferencePrompt: '',
        timeout: 60000,
        maxContextLength: 8192,
        temperature: 0.7,
        topP: 1,
        embedding: {
          protocol: 'openai-embedding' as const,
          provider: 'custom' as const,
          baseUrl: '',
          apiKey: '',
          embeddingModel: '',
        },
      },
      appearance: {
        theme: 'light',
        lightPalette: 'warm',
        customCursorEnabled: false,
        aiMascotAvatarEnabled: false,
      },
      webSearch: {
        provider: 'duckduckgo',
        apiKey: '',
        maxResults: 5,
        customUrl: '',
      },
      customChatPresets: [],
      customEmbeddingPresets: [],
    })
  })

  function renderEditorArea() {
    return render(<EditorArea />)
  }

  describe('编辑 + 预览切回普通预览', () => {
    it('隐藏编辑器 .cm-editor 在 memory 策略下立即释放', async () => {
      const tab = createAnonymousTab('tab-1', '# 匿名标题\n\n正文内容')
      setupEditor([tab], 'tab-1', 'edit-preview')

      // 使用 memory 策略确保立即释放
      act(() => {
        useSettingsStore.getState().updateEditorSettings({ modeResourcePolicy: 'memory' })
      })

      const { container } = renderEditorArea()

      // 编辑 + 预览模式下，编辑器应该可见
      const cmEditors = container.querySelectorAll('.cm-editor')
      expect(cmEditors.length).toBeGreaterThanOrEqual(1)

      // 切换到纯预览模式
      act(() => {
        useEditorStore.getState().setViewMode('preview')
      })

      // memory 策略下编辑器应立即释放
      const hiddenCmEditors = container.querySelectorAll('.cm-editor')
      expect(hiddenCmEditors.length).toBe(0)
    })
  })

  describe('双预览切回普通预览', () => {
    it('右预览在离开双预览后仍存在于 DOM 中（memory 策略验证立即释放）', async () => {
      const tab1 = createAnonymousTab('tab-1', '# 文档一\n\n内容A')
      const tab2 = createAnonymousTab('tab-2', '# 文档二\n\n内容B')
      setupEditor([tab1, tab2], 'tab-1', 'dual-preview')

      // 使用 memory 策略确保立即释放
      act(() => {
        useSettingsStore.getState().updateEditorSettings({ modeResourcePolicy: 'memory' })
      })

      // 设置右栏为 tab-2
      act(() => {
        useEditorStore.getState().setRightPaneTabId('tab-2')
      })

      const { container } = renderEditorArea()

      // 双预览模式下，应该有两个 .gm-markdown-preview
      const dualPreviews = container.querySelectorAll('.gm-markdown-preview')
      expect(dualPreviews.length).toBeGreaterThanOrEqual(2)

      // 切换到普通预览模式
      act(() => {
        useEditorStore.getState().setViewMode('preview')
      })

      // memory 策略下右预览应立即释放
      const singlePreviews = container.querySelectorAll('.gm-markdown-preview')
      expect(singlePreviews.length).toBe(1)
    })
  })

  describe('关闭预热后非当前实例', () => {
    it('关闭预热后非当前模式实例仍存在', async () => {
      const tab = createAnonymousTab('tab-1', '# 匿名文档\n\n正文')

      // 先开启预热确保预热实例被创建
      useSettingsStore.setState((s) => ({
        editor: { ...s.editor, modePrewarm: 'smart' },
      }))

      setupEditor([tab], 'tab-1', 'edit')

      // 先切换到 edit-preview 触发预热
      act(() => {
        useEditorStore.getState().setViewMode('edit-preview')
      })

      const { container } = renderEditorArea()

      // 切回 edit 模式
      act(() => {
        useEditorStore.getState().setViewMode('edit')
      })

      // 关闭预热
      act(() => {
        useSettingsStore.getState().updateEditorSettings({ modePrewarm: 'off' })
      })

      // 缺陷：预热创建的预览实例仍保留
      const previewsAfterOff = container.querySelectorAll('.gm-markdown-preview')
      // 当前缺陷：预热实例仍在 DOM 中（>=1），正确行为应为 0
      expect(previewsAfterOff.length).toBe(0)
    })
  })

  describe('切换文档后旧实例', () => {
    it('切换文档后旧文档预览实例仍存在', async () => {
      const tab1 = createAnonymousTab('tab-1', '# 文档一\n\n旧内容')
      const tab2 = createAnonymousTab('tab-2', '# 文档二\n\n新内容')
      setupEditor([tab1, tab2], 'tab-1', 'preview')

      const { container } = renderEditorArea()

      // 切换到 tab-2
      act(() => {
        useEditorStore.getState().setActiveTab('tab-2')
      })

      // 缺陷：旧文档的预览实例可能仍在 DOM 中
      const previews = container.querySelectorAll('.gm-markdown-preview')
      // 当前缺陷：旧文档预览实例仍在 DOM 中（>=2），正确行为应为 1
      expect(previews.length).toBe(1)
    })
  })

  describe('左右预览独立阅读位置', () => {
    it('左右预览独立保存和恢复阅读位置', () => {
      const session = new ReadingPositionSession()

      // 保存左侧预览位置
      session.saveForPane('tab-1', 'left', { previewScrollTop: 100 })
      // 保存右侧预览位置
      session.saveForPane('tab-1', 'right', { previewScrollTop: 300 })

      // 左右预览独立键，互不覆盖
      expect(session.getForPane('tab-1', 'left')?.previewScrollTop).toBe(100)
      expect(session.getForPane('tab-1', 'right')?.previewScrollTop).toBe(300)
    })
  })
})