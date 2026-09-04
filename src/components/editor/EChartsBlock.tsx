import { useEffect, useMemo, useRef, useState } from 'react'
import * as echarts from 'echarts/core'
import type { EChartsType } from 'echarts/core'
import {
  BarChart,
  HeatmapChart,
  LineChart,
  PieChart,
  RadarChart,
  ScatterChart,
} from 'echarts/charts'
import {
  AriaComponent,
  DataZoomComponent,
  DatasetComponent,
  GridComponent,
  LegendComponent,
  MarkLineComponent,
  MarkPointComponent,
  RadarComponent,
  TitleComponent,
  ToolboxComponent,
  TooltipComponent,
  TransformComponent,
  VisualMapComponent,
} from 'echarts/components'
import { LabelLayout, UniversalTransition } from 'echarts/features'
import { CanvasRenderer } from 'echarts/renderers'
import { parseEChartsOption } from '@/services/echartsOption'
import { useSettingsStore } from '@/stores/settingsStore'

echarts.use([
  BarChart,
  HeatmapChart,
  LineChart,
  PieChart,
  RadarChart,
  ScatterChart,
  AriaComponent,
  DataZoomComponent,
  DatasetComponent,
  GridComponent,
  LegendComponent,
  MarkLineComponent,
  MarkPointComponent,
  RadarComponent,
  TitleComponent,
  ToolboxComponent,
  TooltipComponent,
  TransformComponent,
  VisualMapComponent,
  LabelLayout,
  UniversalTransition,
  CanvasRenderer,
])

const ECHARTS_HEIGHT = 360

export function EChartsBlock({ code, startLine, endLine }: { code: string; startLine?: number; endLine?: number }) {
  const themeId = useSettingsStore((state) => state.appearance.themeId)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const chartRef = useRef<EChartsType | null>(null)
  const [error, setError] = useState<string | null>(null)
  const parsed = useMemo(() => parseEChartsOption(code), [code])

  useEffect(() => {
    const element = containerRef.current
    if (!element || !parsed.ok) return undefined

    let cancelled = false
    let chart: EChartsType

    try {
      const isDark = document.documentElement.dataset.theme === 'dark'
      chart = echarts.init(element, isDark ? 'dark' : undefined, { renderer: 'canvas' })
      chartRef.current = chart
    } catch (initError) {
      if (!cancelled) setError(initError instanceof Error ? initError.message : String(initError))
      return undefined
    }

    try {
      const option = {
        ...parsed.option,
        aria: parsed.option.aria ?? { enabled: true },
        backgroundColor: parsed.option.backgroundColor ?? 'transparent',
      }
      chart.setOption(option, { notMerge: true })
      setError(null)
    } catch (renderError) {
      if (chartRef.current === chart) chartRef.current = null
      chart.dispose()
      if (!cancelled) {
        setError(renderError instanceof Error ? renderError.message : String(renderError))
      }
      return undefined
    }

    const resizeObserver = new ResizeObserver(() => {
      if (chartRef.current === chart) chart.resize()
    })
    resizeObserver.observe(element)
    return () => {
      cancelled = true
      resizeObserver.disconnect()
      if (chartRef.current === chart) chartRef.current = null
      chart.dispose()
    }
  }, [parsed, themeId])

  if (!parsed.ok || error) {
    return (
      <div className="my-4 rounded-xl border border-gm-error/30 bg-gm-error/5 p-3" data-md-line={startLine} data-md-end-line={endLine}>
        <div className="mb-2 text-caption font-bold text-gm-error">ECharts 渲染失败</div>
        <div className="mb-2 text-caption text-gm-text-secondary">{parsed.ok ? error : parsed.message}</div>
        <pre className="overflow-x-auto whitespace-pre-wrap text-gm-text-secondary" style={{ fontSize: '0.85em' }}>{code}</pre>
      </div>
    )
  }

  return (
    <div className="my-4 overflow-hidden rounded-xl border border-gm-border bg-gm-surface-elevated" data-md-line={startLine} data-md-end-line={endLine} role="img" aria-label={typeof parsed.option.title === 'object' && parsed.option.title && 'text' in parsed.option.title ? String(parsed.option.title.text) : 'ECharts 图表'}>
      <div ref={containerRef} style={{ width: '100%', height: ECHARTS_HEIGHT }} />
    </div>
  )
}
