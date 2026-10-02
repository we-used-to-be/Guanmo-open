import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { TabBar } from '@/components/editor/TabBar'
import { useEditorStore, type Tab } from '@/stores/editorStore'

const tab: Tab = {
  id: 'tab-existing',
  title: '已有文档.md',
  filePath: 'X:/anon/existing.md',
  content: '# 已有内容',
  savedContent: '# 已有内容',
  originalContent: '# 已有内容',
  modified: false,
}

describe('TabBar 新建文档按钮', () => {
  beforeEach(() => {
    useEditorStore.setState({
      tabs: [tab],
      activeTabId: tab.id,
      viewMode: 'preview',
      previewVisible: true,
      rightPaneTabId: null,
      rightPaneUserSelected: false,
      previewSwitchingTabId: null,
    })
  })

  it('在标签右侧显示按钮并复用统一新建文档 action', () => {
    render(<TabBar />)

    const button = screen.getByRole('button', { name: '新建文档 (Ctrl+N)' })
    const existingTab = screen.getByRole('button', { name: '已有文档.md' })
    expect(button).toHaveAttribute('title', '新建文档 (Ctrl+N)')
    expect(existingTab.querySelector('[data-tab-active-indicator]')).toHaveClass('opacity-100')
    expect(existingTab.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

    fireEvent.click(button)

    const state = useEditorStore.getState()
    expect(state.viewMode).toBe('edit')
    expect(state.previewVisible).toBe(false)
    expect(state.tabs).toHaveLength(2)
    expect(state.tabs.find((item) => item.id === state.activeTabId)).toMatchObject({
      title: '未命名.md',
      content: '',
    })
  })
})
