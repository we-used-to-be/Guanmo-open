import { expect, it, vi } from 'vitest'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@/hooks/useTauri', () => ({ isTauri: () => true }))
vi.mock('@tauri-apps/api/core', () => ({ invoke }))

import { recordDiagnostic, setDetailedDiagnostics } from '@/services/productionDiagnostics'

it('只发送固定事件字段，详细模式关闭时不发送慢路径', async () => {
  recordDiagnostic('ai.request_slow', 'slow', 1200)
  await Promise.resolve()
  expect(invoke).not.toHaveBeenCalled()

  recordDiagnostic('file.read_failed', 'error', 34)
  await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('record_diagnostic_event', {
    input: { event: 'file.read_failed', status: 'error', durationMs: 34, count: undefined, code: undefined },
  }))

  await setDetailedDiagnostics(true)
  invoke.mockClear()
  recordDiagnostic('agent.tool_slow', 'slow', 1200, undefined, 'search_knowledge')
  await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('record_diagnostic_event', {
    input: { event: 'agent.tool_slow', status: 'slow', durationMs: 1200, count: undefined, code: 'search_knowledge' },
  }))
})
