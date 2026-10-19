import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const fileApi = vi.hoisted(() => ({
  saveFileDialog: vi.fn(),
  writeFile: vi.fn(),
}))

vi.mock('@/hooks/useTauri', () => ({ ...fileApi, isTauri: () => false }))
vi.mock('@/hooks/usePerfMonitor', () => ({ usePerfMonitor: vi.fn() }))

import { PerfMonitorPanel } from '@/components/devtools/PerfMonitorPanel'
import type { PerfData } from '@/services/perfTypes'
import { useAgentDiagnosticsStore } from '@/services/devAgentDiagnostics'
import { recordPerfSample, usePerfStore } from '@/stores/perfStore'
import { useSettingsStore } from '@/stores/settingsStore'

describe('PerfMonitorPanel export', () => {
  beforeEach(() => {
    fileApi.saveFileDialog.mockResolvedValue('C:\\Temp\\perf-report.json')
    fileApi.writeFile.mockResolvedValue(undefined)
    usePerfStore.getState().clearHistory()
    usePerfStore.setState({
      current: null,
      isCollapsed: false,
      baseline: null,
      testStartedAt: null,
      testPeaks: {},
      isPaused: false,
      enabled: true,
    })
    useAgentDiagnosticsStore.setState({ enabled: false, runs: [] })
  })

  it('收起态只展示已开启检测的关键数据', () => {
    usePerfStore.setState({
      isCollapsed: true,
      current: {
        timestamp: 1,
        appPrivateWorkingSetKb: 1024,
        cpuNormalizedPercent: 12.3,
      } as PerfData,
    })
    useAgentDiagnosticsStore.setState({
      enabled: true,
      runs: [{
        runId: 'run-1',
        startedAt: 0,
        durationMs: 42,
        status: 'completed',
        mode: 'agent',
        metadata: {},
        spans: [],
      }],
    })

    render(<PerfMonitorPanel />)

    expect(screen.getByText(/内存/)).toBeInTheDocument()
    expect(screen.getByText(/CPU 12\.3%/)).toBeInTheDocument()
    expect(screen.getByText('Agent')).toBeInTheDocument()
    expect(screen.getByText('42ms')).toBeInTheDocument()
  })

  it('两个检测都关闭时收起态只保留入口图标', () => {
    usePerfStore.setState({ isCollapsed: true, enabled: false })

    render(<PerfMonitorPanel />)

    expect(screen.getByRole('button', { name: '打开开发诊断' })).toBeInTheDocument()
    expect(screen.queryByText('Agent')).not.toBeInTheDocument()
    expect(screen.queryByText(/内存/)).not.toBeInTheDocument()
  })

  it('通过系统保存对话框导出 JSON 到授权路径', async () => {
    render(<PerfMonitorPanel />)

    fireEvent.click(screen.getByRole('button', { name: '性能检测' }))
    fireEvent.click(screen.getByRole('button', { name: '导出 JSON' }))

    await waitFor(() => expect(fileApi.saveFileDialog).toHaveBeenCalledTimes(1))
    expect(fileApi.writeFile).toHaveBeenCalledWith(
      'C:\\Temp\\perf-report.json',
      expect.stringContaining('"exportedAt"'),
    )
  })

  it('取消保存对话框时不写入文件', async () => {
    fileApi.saveFileDialog.mockResolvedValue(null)
    render(<PerfMonitorPanel />)

    fireEvent.click(screen.getByRole('button', { name: '性能检测' }))
    fireEvent.click(screen.getByRole('button', { name: '导出 JSON' }))

    await waitFor(() => expect(fileApi.saveFileDialog).toHaveBeenCalledTimes(1))
    expect(fileApi.writeFile).not.toHaveBeenCalled()
  })

  it('导出报告记录当前模式性能策略', async () => {
    useSettingsStore.setState((state) => ({
      editor: { ...state.editor, modePerformancePolicy: 'speed' },
    }))
    render(<PerfMonitorPanel />)

    fireEvent.click(screen.getByRole('button', { name: '性能检测' }))
    fireEvent.click(screen.getByRole('button', { name: '导出 JSON' }))
    await waitFor(() => expect(fileApi.writeFile).toHaveBeenCalledTimes(1))
    const report = JSON.parse(fileApi.writeFile.mock.calls[0][1] as string)

    expect(report.testContext.modePerformancePolicy).toBe('speed')
  })

  it('性能采样通过 perfStore action 发布当前值和峰值', () => {
    const sample = {
      timestamp: 1,
      appPrivateWorkingSetKb: 10,
      webviewPrivateWorkingSetKb: 20,
      rustPrivateWorkingSetKb: 30,
    } as PerfData
    usePerfStore.setState({ current: null, isPaused: false, testStartedAt: 1, testPeaks: {} })

    recordPerfSample(sample)

    expect(usePerfStore.getState().current).toBe(sample)
    expect(usePerfStore.getState().testPeaks).toMatchObject({
      appPrivateWorkingSetKb: 10,
      webviewPrivateWorkingSetKb: 20,
      rustPrivateWorkingSetKb: 30,
    })
  })

  it('重挂面板后仍导出基线并脱敏用户操作', async () => {
    const snapshot = {
      lastLongTaskUserAction: 'click:button[C:\\private\\note.md]',
      monacoModels: [{ uri: 'file:///C:/private/note.md' }],
    } as PerfData
    usePerfStore.setState({ baseline: { kind: 'document', setAt: 1, snapshot } })
    const first = render(<PerfMonitorPanel />)
    first.unmount()
    render(<PerfMonitorPanel />)

    fireEvent.click(screen.getByRole('button', { name: '性能检测' }))
    fireEvent.click(screen.getByRole('button', { name: '导出 JSON' }))
    await waitFor(() => expect(fileApi.writeFile).toHaveBeenCalledTimes(1))
    const report = JSON.parse(fileApi.writeFile.mock.calls[0][1] as string)

    expect(report.baseline).not.toBeNull()
    expect(report.baseline.snapshot.lastLongTaskUserAction).toBe('[redacted-action]')
    expect(report.baseline.snapshot.monacoModels[0].uri).toBe('[redacted-uri]')
    expect(report.experimentalMetrics).toEqual(['eventListenerCount', 'detachedDomNodes'])
    expect(fileApi.writeFile.mock.calls[0][1]).not.toContain('private\\note.md')
  })
})
