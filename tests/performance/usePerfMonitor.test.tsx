import { StrictMode } from 'react'
import { act, render } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PerfData } from '@/services/perfTypes'

const collectorState = vi.hoisted(() => ({ onData: null as ((data: PerfData) => void) | null }))
const perfCollectorMock = vi.hoisted(() => ({
  setSources: vi.fn(),
  setDocumentContextSources: vi.fn(),
  collect: vi.fn(),
  start: vi.fn((_interval: number, onData: (data: PerfData) => void) => { collectorState.onData = onData }),
  dispose: vi.fn(() => { collectorState.onData = null }),
}))
const eventMarkerMock = vi.hoisted(() => ({
  setSnapshotSource: vi.fn(), setFreshSnapshotSource: vi.fn(), start: vi.fn(),
  mark: vi.fn(), markPoint: vi.fn(), addListener: vi.fn(() => vi.fn()),
}))
vi.mock('@/services/perfCollector', () => ({ perfCollector: perfCollectorMock }))
vi.mock('@/services/eventMarker', () => ({ eventMarker: eventMarkerMock }))

import { usePerfMonitor } from '@/hooks/usePerfMonitor'
import { useEditorStore } from '@/stores/editorStore'
import { usePerfStore } from '@/stores/perfStore'

const SAMPLE = {
  timestamp: Date.now(), appWorkingSetKb: 1, appPrivateWorkingSetKb: 1,
  appPrivateBytesKb: 1, webviewWorkingSetKb: 1, webviewPrivateWorkingSetKb: 1,
  webviewPrivateBytesKb: 1, rustWorkingSetKb: 1, rustPrivateWorkingSetKb: 1,
  rustPrivateBytesKb: 1, webviewProcessCount: 1, rendererProcessCount: 1,
  gpuProcessCount: 0, utilityProcessCount: 0, cpuPercent: 1, cpuNormalizedPercent: 0.25, cpuCoreEquivalent: 0.01, systemCpuPercent: 10, processBreakdown: [],
  fps: 60, jsHeapUsedMb: 1, jsHeapTotalMb: 2, domNodeCount: 1, detachedDomNodes: 0,
  activeTimeoutCount: 0, activeIntervalCount: 0, activeRafCount: 0, eventListenerCount: 0,
  eventListenerWindowCount: 0, eventListenerDocumentCount: 0,
  eventListenerDomCount: 0, eventListenerUnknownCount: 0,
  mutationObserverCount: 0, resizeObserverCount: 0, intersectionObserverCount: 0,
  activeObjectUrlCount: 0, longTaskCount: 0, longTaskTotalDurationMs: 0,
  longTaskMaxDurationMs: 0, lastLongTaskAt: null, lastLongTaskMode: null,
  lastLongTaskUserAction: null, monacoModelCount: 0, monacoModelTotalChars: 0,
  monacoEditorInstanceCount: 0, monacoDiffEditorInstanceCount: 0,
  monacoDecorationCount: 0, monacoMarkerCount: 0, monacoModels: [], currentMode: 'edit',
  docCharCount: 0, activeDocumentCount: 0, activeDocumentCharCount: 0,
  totalOpenDocumentCharCount: 0, activeDocumentLineCount: 0,
  previewInstanceCount: 0, editorInstanceCount: 0, aiPanelOpen: false, isFullscreen: false,
  totalCollectDurationMs: 1, processQueryDurationMs: 1,
  jsMetricDurationMs: 0, storeUpdateDurationMs: 0, panelRenderDurationMs: 0,
} satisfies PerfData

function Harness() { usePerfMonitor(); return null }

describe('usePerfMonitor', () => {
  beforeEach(() => {
    collectorState.onData = null
    vi.clearAllMocks()
    perfCollectorMock.collect.mockResolvedValue(SAMPLE)
    usePerfStore.setState({ current: null, events: [], isPaused: false, enabled: true })
    useEditorStore.setState({ viewMode: 'edit' })
  })

  it('在 StrictMode 重挂载后仍保留单一采集回调', () => {
    render(<StrictMode><Harness /></StrictMode>)
    collectorState.onData?.(SAMPLE)
    expect(usePerfStore.getState().current).toEqual(SAMPLE)
  })

  it('采样 store 更新不会触发未订阅的业务组件重渲染', () => {
    let businessRenderCount = 0
    function BusinessArea() {
      businessRenderCount += 1
      return <div>business</div>
    }
    render(<><BusinessArea /><Harness /></>)
    act(() => collectorState.onData?.(SAMPLE))
    expect(businessRenderCount).toBe(1)
  })

  it('按实际挂载节点统计预览和编辑器实例', () => {
    render(<Harness />)
    document.body.insertAdjacentHTML('beforeend', '<div class="gm-markdown-preview"></div><div class="gm-markdown-preview"></div><div class="cm-editor"></div><div data-preview-switch-snapshot inert><div class="gm-markdown-preview"></div><div class="cm-editor"></div></div>')
    const sources = perfCollectorMock.setDocumentContextSources.mock.calls.at(-1)?.[0]
    expect(sources.getPreviewInstanceCount()).toBe(2)
    expect(sources.getEditorInstanceCount()).toBe(1)
  })

})
