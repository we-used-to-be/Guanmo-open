import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { UsageActivity } from '@/features/settings/UsageActivity'

const mockState = vi.hoisted(() => ({
  enabled: true,
  snapshot: null as any,
  listeners: new Set<(snapshot: any) => void>(),
  order: [] as string[],
  checkpointUsageTracking: vi.fn(),
  clearUsageDataWithLifecycle: vi.fn(),
  loadUsageActivity: vi.fn(),
  queryUsageToday: vi.fn(),
  queryUsageTotal: vi.fn(),
  setUsageTrackingEnabled: vi.fn(),
}))

vi.mock('@/hooks/useTauri', () => ({
  isTauri: () => true,
}))

vi.mock('@/stores/settingsStore', () => ({
  useSettingsStore: (selector: (state: { usageTracking: { enabled: boolean } }) => unknown) =>
    selector({ usageTracking: { enabled: mockState.enabled } }),
}))

vi.mock('@/services/toast', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}))

vi.mock('animal-island-ui', () => ({
  Button: ({
    children,
    disabled,
    loading,
    onClick,
  }: {
    children: unknown
    disabled?: boolean
    loading?: boolean
    onClick?: () => void
  }) => (
    <button type="button" disabled={disabled || loading} onClick={onClick}>
      {children}
    </button>
  ),
  Switch: ({
    checked,
    onChange,
  }: {
    checked: boolean
    onChange: (checked: boolean) => void
  }) => (
    <input
      aria-label="记录"
      role="switch"
      type="checkbox"
      checked={checked}
      onChange={(event) => onChange(event.currentTarget.checked)}
    />
  ),
}))

vi.mock('@/services/usageTracking', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/usageTracking')>()
  return {
    ...actual,
    checkpointUsageTracking: mockState.checkpointUsageTracking,
    clearUsageDataWithLifecycle: mockState.clearUsageDataWithLifecycle,
    getPendingSnapshot: () => new Map<string, number>(),
    getUsageSnapshot: () => mockState.snapshot,
    loadUsageActivity: mockState.loadUsageActivity,
    queryUsageToday: mockState.queryUsageToday,
    queryUsageTotal: mockState.queryUsageTotal,
    setUsageTrackingEnabled: mockState.setUsageTrackingEnabled,
    subscribeUsageSnapshot: (listener: (snapshot: any) => void) => {
      mockState.listeners.add(listener)
      return () => mockState.listeners.delete(listener)
    },
  }
})

function emitSnapshot(snapshot: any): void {
  mockState.snapshot = snapshot
  for (const listener of mockState.listeners) listener(snapshot)
}

function activeSnapshot(overrides: Record<string, unknown> = {}): any {
  return {
    isActive: true,
    error: null,
    capturedMsByDate: new Map(),
    reset: false,
    ...overrides,
  }
}

describe('UsageActivity', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockState.enabled = true
    mockState.snapshot = activeSnapshot()
    mockState.listeners.clear()
    mockState.order.length = 0
    mockState.checkpointUsageTracking.mockImplementation(async () => {
      mockState.order.push('checkpoint')
    })
    mockState.clearUsageDataWithLifecycle.mockResolvedValue(undefined)
    mockState.loadUsageActivity.mockImplementation(async () => {
      mockState.order.push('activity')
      return new Map()
    })
    mockState.queryUsageToday.mockImplementation(async () => {
      mockState.order.push('today')
      return 30
    })
    mockState.queryUsageTotal.mockImplementation(async () => {
      mockState.order.push('total')
      return 30
    })
    mockState.setUsageTrackingEnabled.mockResolvedValue(undefined)
  })

  it('显示少于一分钟，并区分运行中、未激活和保存失败', async () => {
    render(<UsageActivity />)

    await waitFor(() => {
      expect(screen.getAllByText('少于 1 分钟')).toHaveLength(2)
    })
    expect(screen.getByRole('status')).toHaveTextContent('正在统计')

    act(() => {
      emitSnapshot(activeSnapshot({ isActive: false }))
    })
    expect(screen.getByRole('status')).toHaveTextContent('当前未激活')

    act(() => {
      emitSnapshot(activeSnapshot({ isActive: false, error: { kind: 'database_write' } }))
    })
    expect(screen.getByRole('status')).toHaveTextContent('保存失败')
  })

  it('刷新前先结算当前时段，再读取数据库和 pending', async () => {
    render(<UsageActivity />)
    await waitFor(() => expect(mockState.loadUsageActivity).toHaveBeenCalled())

    mockState.order.length = 0
    fireEvent.click(screen.getByLabelText('统计设置'))
    fireEvent.click(screen.getByRole('button', { name: '刷新统计' }))

    await waitFor(() => {
      expect(mockState.order).toEqual(['checkpoint', 'today', 'total', 'activity'])
    })
  })

  it('打印前结算并固定统计快照，后续计时不改变已生成的小票', async () => {
    mockState.loadUsageActivity.mockResolvedValue(new Map([['2026-09-28', 11880]]))
    mockState.queryUsageTotal.mockResolvedValue(244920)
    render(<UsageActivity />)
    await waitFor(() => expect(screen.getByText('68 小时 2 分钟')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: '生成回顾' }))
    await waitFor(() => expect(screen.getByRole('dialog', { name: '时光回顾' })).toBeInTheDocument())
    const paper = screen.getByRole('img', { name: '时光回顾统计卡片' })
    expect(paper).toHaveTextContent('68 小时 2 分钟')
    expect(paper).toHaveTextContent('3 小时 18 分钟')
    expect(paper).toHaveTextContent('2026.09.28')
    act(() => emitSnapshot(activeSnapshot({ capturedMsByDate: new Map([['2026-09-28', 60000]]) })))
    expect(paper).toHaveTextContent('68 小时 2 分钟')
    expect(mockState.checkpointUsageTracking).toHaveBeenCalledOnce()
  })

  it('读取统计失败时不打开含有错误数据的小票', async () => {
    render(<UsageActivity />)
    await waitFor(() => expect(mockState.loadUsageActivity).toHaveBeenCalled())
    mockState.queryUsageTotal.mockRejectedValueOnce(new Error('database unavailable'))
    fireEvent.click(screen.getByRole('button', { name: '生成回顾' }))
    await waitFor(() => expect(mockState.checkpointUsageTracking).toHaveBeenCalledOnce())
    await act(async () => {})
    expect(screen.queryByRole('dialog', { name: '时光回顾' })).not.toBeInTheDocument()
  })

  it('卸载时取消快照订阅，并忽略未完成刷新结果', async () => {
    let resolveToday: ((value: number) => void) | undefined
    const pendingToday = new Promise<number>((resolve) => {
      resolveToday = resolve
    })
    mockState.queryUsageToday.mockReturnValueOnce(pendingToday)

    const view = render(<UsageActivity />)
    await waitFor(() => expect(mockState.listeners.size).toBe(1))
    view.unmount()
    expect(mockState.listeners.size).toBe(0)

    resolveToday?.(999)
    await act(async () => {
      await pendingToday
    })
  })
})
