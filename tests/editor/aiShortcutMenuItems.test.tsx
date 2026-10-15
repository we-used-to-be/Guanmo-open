import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { AiShortcutMenuItems } from '@/components/editor/AiShortcutMenuItems'
import { EditorContextMenu } from '@/components/editor/EditorContextMenu'
import { useSettingsStore } from '@/stores/settingsStore'
import type { EditorView } from '@codemirror/view'

describe('AI 快捷操作菜单', () => {
  beforeEach(() => {
    useSettingsStore.setState({
      aiShortcutActions: [
        { id: 'second', label: '第二项', prompt: '第二条命令', enabled: true },
        { id: 'hidden', label: '隐藏项', prompt: '隐藏命令', enabled: false },
        { id: 'first', label: '第一项', prompt: '第一条命令', enabled: true },
      ],
    })
  })

  it('只按配置顺序渲染启用项并传递对应命令', () => {
    const onAction = vi.fn()
    render(<AiShortcutMenuItems onAction={onAction} />)

    expect(screen.getAllByRole('menuitem').map((button) => button.textContent)).toEqual(['第二项', '第一项'])
    expect(screen.queryByText('隐藏项')).not.toBeInTheDocument()
    expect(screen.getByText('第二项')).not.toHaveAttribute('title')
    expect(screen.getByText('第一项')).not.toHaveAttribute('title')

    fireEvent.click(screen.getByRole('menuitem', { name: '第一项' }))
    expect(onAction).toHaveBeenCalledWith('第一条命令')
  })

  it('全部停用时源码右键菜单不显示空的 AI 命令组', () => {
    useSettingsStore.setState((state) => ({
      aiShortcutActions: state.aiShortcutActions.map((action) => ({ ...action, enabled: false })),
    }))
    const view = {
      state: {
        selection: { main: { empty: false, from: 0, to: 2 } },
      },
    } as unknown as EditorView
    const viewRef = { current: view }
    const { container } = render(
      <div>
        <EditorContextMenu viewRef={viewRef} />
      </div>,
    )

    fireEvent.contextMenu(container.firstElementChild!)
    expect(screen.queryByText('AI 助手')).not.toBeInTheDocument()
    expect(screen.getByText('Markdown 格式')).toBeInTheDocument()
  })
})
