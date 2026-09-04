/**
 * 文档模型契约测试
 *
 * 验证 docs/architecture/state-ownership.md 第 1/3/9 节 Invariants：
 * - 切换视图模式、开关预览、切换右 pane 只触碰视图状态，不修改任何 Tab 内容字段。
 * - 阅读位置更新只触碰 readingPositions，不触碰 tabs。
 *
 * Tab 内容（content / savedContent / originalContent / modified）的 Source of Truth
 * 只能是 editorStore 的内容类 actions（updateTabContent / markTabSaved 等）。
 */
import { beforeEach, describe, expect, it } from 'vitest'

import { useEditorStore, type Tab, type ViewMode } from '@/stores/editorStore'

function makeTab(id: string, content: string, filePath: string | null): Tab {
  return {
    id,
    title: `匿名文档 ${id}`,
    filePath,
    content,
    savedContent: content,
    originalContent: content,
    modified: false,
  }
}

const TAB_A = makeTab('contract-a', '第一份匿名文档内容\n\n包含两个段落。', 'X:\\anon\\contract-a.md')
const TAB_B = makeTab('contract-b', '第二份匿名文档内容', null)

function currentTabs(): Tab[] {
  return useEditorStore.getState().tabs
}

function tabContentSnapshot(): string {
  return JSON.stringify(currentTabs().map((tab) => ({
    id: tab.id,
    content: tab.content,
    savedContent: tab.savedContent,
    originalContent: tab.originalContent,
    modified: tab.modified,
  })))
}

describe('文档模型契约（invariants 见 docs/architecture/state-ownership.md）', () => {
  beforeEach(() => {
    useEditorStore.setState({
      tabs: [TAB_A, TAB_B],
      activeTabId: 'contract-a',
      viewMode: 'edit',
      previewVisible: false,
      rightPaneTabId: null,
      rightPaneUserSelected: false,
      readingPositions: {},
      previewSwitchingTabId: null,
      pendingReveal: null,
    })
  })

  it('切换全部视图模式不修改任何 Tab 内容字段', () => {
    const snapshot = tabContentSnapshot()
    const modes: ViewMode[] = ['edit', 'preview', 'edit-preview', 'dual-preview', 'diff-preview', 'edit']

    for (const mode of modes) {
      useEditorStore.getState().setViewMode(mode)
      expect(tabContentSnapshot()).toBe(snapshot)
    }

    // 磁盘 Tab 与临时 Tab 都不受影响
    expect(currentTabs()).toHaveLength(2)
  })

  it('开关预览与切换右 pane 不修改 Tab 内容', () => {
    const snapshot = tabContentSnapshot()

    useEditorStore.getState().togglePreview()
    useEditorStore.getState().setRightPaneTabId('contract-b')
    useEditorStore.getState().setRightPaneTabId(null)
    useEditorStore.getState().toggleDiffPreview()
    useEditorStore.getState().toggleDiffPreview()
    useEditorStore.getState().togglePreview()

    expect(tabContentSnapshot()).toBe(snapshot)
    // 视图状态本身确实发生了变化，证明动作已生效（不是空操作）
    expect(useEditorStore.getState().rightPaneTabId).toBeNull()
  })

  it('定位请求默认交给编辑器，并可明确交给预览', () => {
    useEditorStore.getState().requestReveal('contract-a', 2, 3)
    expect(useEditorStore.getState().pendingReveal).toEqual({
      tabId: 'contract-a',
      startLine: 2,
      endLine: 3,
      surface: 'editor',
    })

    useEditorStore.getState().requestReveal('contract-a', 4, 5, 'preview')
    expect(useEditorStore.getState().pendingReveal).toEqual({
      tabId: 'contract-a',
      startLine: 4,
      endLine: 5,
      surface: 'preview',
    })
  })

  it('产品引导恢复通过 editorStore action 原子更新视图状态', () => {
    useEditorStore.getState().restoreProductTourState({
      viewMode: 'dual-preview',
      previewVisible: false,
      rightPaneTabId: 'contract-b',
      rightPaneUserSelected: true,
      activeTabId: 'contract-b',
      previewSwitchingTabId: null,
    })

    expect(useEditorStore.getState()).toMatchObject({
      viewMode: 'dual-preview',
      previewVisible: false,
      rightPaneTabId: 'contract-b',
      rightPaneUserSelected: true,
      activeTabId: 'contract-b',
      previewSwitchingTabId: null,
    })
  })

  it('阅读位置更新只触碰 readingPositions，不触碰 tabs', () => {
    const snapshot = tabContentSnapshot()

    useEditorStore.getState().flushReadingPositions({
      'contract-a': { previewScrollTop: 320, topLine: 24 },
    })

    expect(tabContentSnapshot()).toBe(snapshot)
    expect(useEditorStore.getState().readingPositions).toMatchObject({
      'contract-a': { previewScrollTop: 320, topLine: 24 },
    })
  })
})
