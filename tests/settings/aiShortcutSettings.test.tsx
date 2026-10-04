import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { AiShortcutSettings } from '@/features/settings/AiShortcutSettings'
import { createDefaultAiShortcutActions } from '@/services/aiShortcutActions'
import { useSettingsStore } from '@/stores/settingsStore'

vi.mock('@/services/toast', () => ({
  toast: {
    success: vi.fn(),
  },
}))

describe('快捷操作设置', () => {
  beforeEach(() => {
    useSettingsStore.setState({ aiShortcutActions: createDefaultAiShortcutActions() })
    vi.restoreAllMocks()
  })

  it('新增、校验并编辑快捷操作', async () => {
    render(<AiShortcutSettings />)
    fireEvent.click(screen.getByRole('button', { name: '新增操作' }))

    expect(await screen.findByRole('dialog', { name: '新增快捷操作' })).toBeInTheDocument()
    expect(screen.getByPlaceholderText('例如：提炼关键结论')).toHaveAttribute('maxlength', '12')
    fireEvent.click(await screen.findByRole('button', { name: '保存' }))
    expect(screen.getByText('请输入操作名称')).toBeInTheDocument()
    expect(screen.getByText('请输入 AI 命令')).toBeInTheDocument()

    fireEvent.change(screen.getByPlaceholderText('例如：提炼关键结论'), { target: { value: '  自定义操作  ' } })
    fireEvent.change(screen.getByPlaceholderText('描述 AI 应如何处理当前选区'), { target: { value: '  自定义命令  ' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    const created = useSettingsStore.getState().aiShortcutActions.at(-1)
    expect(created).toMatchObject({ label: '自定义操作', prompt: '自定义命令', enabled: true })
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: '新增快捷操作' })).not.toBeInTheDocument()
    })

    fireEvent.click(screen.getAllByRole('button', { name: '编辑' }).at(-1)!)
    fireEvent.change(await screen.findByDisplayValue('自定义操作'), { target: { value: '已编辑操作' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(useSettingsStore.getState().aiShortcutActions.at(-1)?.label).toBe('已编辑操作')
  })

  it('按 Escape 关闭快捷操作编辑弹窗', async () => {
    render(<AiShortcutSettings />)

    fireEvent.click(screen.getByRole('button', { name: '新增操作' }))
    expect(await screen.findByRole('dialog', { name: '新增快捷操作' })).toBeInTheDocument()

    fireEvent.keyDown(document, { key: 'Escape' })

    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: '新增快捷操作' })).not.toBeInTheDocument()
    })
    expect(screen.getByRole('button', { name: '新增操作' })).toBeInTheDocument()
  })

  it('支持按钮排序与启停', () => {
    render(<AiShortcutSettings />)

    fireEvent.click(screen.getByRole('button', { name: '下移“解释”' }))
    expect(useSettingsStore.getState().aiShortcutActions.slice(0, 2).map((item) => item.id)).toEqual([
      'explain-with-context',
      'explain',
    ])

    const translateRow = document.querySelector('[data-ai-shortcut-row="translate"]')!
    fireEvent.click(within(translateRow).getByRole('switch'))
    expect(useSettingsStore.getState().aiShortcutActions.find((action) => action.id === 'translate')?.enabled).toBe(false)
  })

  it('删除需要确认，恢复默认会覆盖当前列表', () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    render(<AiShortcutSettings />)

    fireEvent.click(screen.getAllByRole('button', { name: '删除' })[0])
    expect(useSettingsStore.getState().aiShortcutActions).toHaveLength(5)

    confirm.mockReturnValue(true)
    fireEvent.click(screen.getAllByRole('button', { name: '删除' })[0])
    expect(useSettingsStore.getState().aiShortcutActions).toHaveLength(4)

    fireEvent.click(screen.getByRole('button', { name: '恢复默认' }))
    expect(useSettingsStore.getState().aiShortcutActions).toHaveLength(5)
    expect(useSettingsStore.getState().aiShortcutActions[0].id).toBe('explain')
  })

  it('不显示拖拽入口、命令样例和完整内容悬浮提示', () => {
    render(<AiShortcutSettings />)
    expect(screen.queryByRole('button', { name: /拖动/ })).not.toBeInTheDocument()
    expect(screen.queryByText('命令样例')).not.toBeInTheDocument()
    expect(screen.getByText('解释')).not.toHaveAttribute('title')
    expect(screen.getByText('请解释这段内容')).not.toHaveAttribute('title')
  })

  it('调序控件位于内容左侧并使用紧凑原生按钮', () => {
    render(<AiShortcutSettings />)

    const row = document.querySelector('[data-ai-shortcut-row="explain"]')!
    const orderControls = within(row).getByLabelText('调整“解释”顺序')
    expect(row.firstElementChild).toBe(orderControls)
    expect(within(orderControls).getByRole('button', { name: '上移“解释”' })).toHaveClass('h-5', 'w-6')
    expect(within(orderControls).getByRole('button', { name: '下移“解释”' })).toHaveClass('h-5', 'w-6')
  })
})
