import { render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const chartInstances = vi.hoisted(() => [] as Array<{ setOption: ReturnType<typeof vi.fn>; resize: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> }>)
const settingsState = vi.hoisted(() => ({ themeId: 'warm' }))

vi.mock('echarts/core', () => ({
  use: vi.fn(),
  init: vi.fn(() => {
    const chart = { setOption: vi.fn(), resize: vi.fn(), dispose: vi.fn() }
    chartInstances.push(chart)
    return chart
  }),
}))

vi.mock('echarts/charts', () => ({
  BarChart: {}, HeatmapChart: {}, LineChart: {}, PieChart: {}, RadarChart: {}, ScatterChart: {},
}))
vi.mock('echarts/components', () => ({
  AriaComponent: {}, DataZoomComponent: {}, DatasetComponent: {}, GridComponent: {}, LegendComponent: {},
  MarkLineComponent: {}, MarkPointComponent: {}, RadarComponent: {}, TitleComponent: {}, ToolboxComponent: {},
  TooltipComponent: {}, TransformComponent: {}, VisualMapComponent: {},
}))
vi.mock('echarts/features', () => ({ LabelLayout: {}, UniversalTransition: {} }))
vi.mock('echarts/renderers', () => ({ CanvasRenderer: {} }))
vi.mock('@/stores/settingsStore', () => ({
  useSettingsStore: (selector: (state: { appearance: { themeId: string } }) => unknown) => selector({ appearance: settingsState }),
}))

import { EChartsBlock } from '@/components/editor/EChartsBlock'

afterEach(() => {
  chartInstances.length = 0
  settingsState.themeId = 'warm'
})

describe('EChartsBlock', () => {
  it('初始化图表并在卸载时释放实例', async () => {
    const view = render(<EChartsBlock code={'{"series":[{"type":"bar","data":[1,2]}]}'} />)

    await waitFor(() => expect(chartInstances).toHaveLength(1))
    expect(chartInstances[0].setOption).toHaveBeenCalledWith(
      expect.objectContaining({ aria: { enabled: true }, backgroundColor: 'transparent' }),
      { notMerge: true },
    )

    view.unmount()
    expect(chartInstances[0].dispose).toHaveBeenCalledTimes(1)
  })

  it('配置无效时不初始化图表并保留源码', async () => {
    const view = render(<EChartsBlock code="{ invalid" />)

    expect(view.container).toHaveTextContent('ECharts 渲染失败')
    expect(view.container).toHaveTextContent('{ invalid')
    expect(chartInstances).toHaveLength(0)
  })

  it('配置变化时释放旧实例并初始化新实例', async () => {
    const view = render(<EChartsBlock code={'{"series":[{"type":"line","data":[1]}]}'} />)
    await waitFor(() => expect(chartInstances).toHaveLength(1))

    view.rerender(<EChartsBlock code={'{"series":[{"type":"line","data":[2]}]}'} />)
    await waitFor(() => expect(chartInstances).toHaveLength(2))
    expect(chartInstances[0].dispose).toHaveBeenCalledTimes(1)
  })

  it('主题变化时重建实例并响应容器尺寸变化', async () => {
    const originalResizeObserver = globalThis.ResizeObserver
    const observers: Array<{ trigger: () => void }> = []
    class TrackingResizeObserver {
      private readonly callback: ResizeObserverCallback
      constructor(callback: ResizeObserverCallback) {
        this.callback = callback
        observers.push({ trigger: () => this.callback([], this as unknown as ResizeObserver) })
      }
      observe() {}
      disconnect() {}
    }
    globalThis.ResizeObserver = TrackingResizeObserver as unknown as typeof ResizeObserver

    try {
      const view = render(<EChartsBlock code={'{"series":[{"type":"line","data":[1]}]}'} />)
      await waitFor(() => expect(chartInstances).toHaveLength(1))
      await waitFor(() => expect(observers).toHaveLength(1))
      observers[0].trigger()
      expect(chartInstances[0].resize).toHaveBeenCalledTimes(1)

      settingsState.themeId = 'dark'
      view.rerender(<EChartsBlock code={'{"series":[{"type":"line","data":[1]}]}'} />)
      await waitFor(() => expect(chartInstances).toHaveLength(2))
      expect(chartInstances[0].dispose).toHaveBeenCalledTimes(1)
      view.unmount()
    } finally {
      globalThis.ResizeObserver = originalResizeObserver
    }
  })
})
