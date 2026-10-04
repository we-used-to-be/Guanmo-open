import { isTauri } from '@/hooks/useTauri'
import type { AgentToolName } from '@/services/agent/toolSelector'

export type DiagnosticEvent =
  | 'app.start' | 'app.js_error' | 'app.unhandled_rejection'
  | 'file.read_failed' | 'file.write_failed' | 'file.read_slow'
  | 'markdown.parse_failed' | 'markdown.render_failed' | 'markdown.parse_slow' | 'markdown.render_slow'
  | 'database.init_failed' | 'database.query_failed' | 'database.init_slow' | 'database.query_slow'
  | 'ai.request_failed' | 'ai.request_slow'
  | 'agent.tool_failed' | 'agent.tool_slow'
  | 'rag.index_failed' | 'rag.index_slow' | 'rag.search_failed' | 'rag.search_slow'

type DiagnosticStatus = 'ok' | 'error' | 'slow' | 'cancelled'
let detailedMode = false

export function recordDiagnostic(
  event: DiagnosticEvent,
  status: DiagnosticStatus,
  durationMs?: number,
  count?: number,
  code?: AgentToolName,
): void {
  if (!isTauri()) return
  if (event.endsWith('_slow') && !detailedMode) return
  // No error object, path, request, content or free-form metadata crosses this boundary.
  void import('@tauri-apps/api/core')
    .then(({ invoke }) => invoke('record_diagnostic_event', {
      input: { event, status, durationMs, count, code },
    }))
    .catch(() => undefined)
}

export function installGlobalDiagnosticHandlers(): void {
  if (!isTauri()) return
  recordDiagnostic('app.start', 'ok')
  void getDetailedDiagnostics().catch(() => undefined)
}

export async function getDetailedDiagnostics(): Promise<boolean> {
  const { invoke } = await import('@tauri-apps/api/core')
  detailedMode = await invoke<boolean>('get_diagnostics_mode')
  return detailedMode
}

export async function setDetailedDiagnostics(detailed: boolean): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core')
  await invoke('set_diagnostics_mode', { detailed })
  detailedMode = detailed
}

export async function exportDiagnostics(): Promise<boolean> {
  const { save } = await import('@tauri-apps/plugin-dialog')
  const { invoke } = await import('@tauri-apps/api/core')
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')
  const path = await save({
    defaultPath: `guanmo-diagnostics-${stamp}.zip`,
    filters: [{ name: 'ZIP', extensions: ['zip'] }],
  })
  if (!path) return false
  await invoke('export_diagnostics_zip', { path })
  return true
}

export async function openDiagnosticsDirectory(): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core')
  await invoke('open_diagnostics_dir')
}

export async function clearDiagnostics(): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core')
  await invoke('clear_diagnostics')
}
