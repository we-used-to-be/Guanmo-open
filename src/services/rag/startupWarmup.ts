import { isTauri } from '@/hooks/useTauri'
import { useEditorStore } from '@/stores/editorStore'
import { waitForStartupPoint } from '@/services/startupPerformance'

export function scheduleRagWarmupAfterFirstSurface(): () => void {
  if (!isTauri()) return () => undefined
  let cancelled = false
  let stopWarmup: (() => void) | undefined
  const surfaceReady = useEditorStore.getState().activeTabId
    ? Promise.race([waitForStartupPoint('editor-first-visible'), waitForStartupPoint('preview-first-visible')])
    : waitForStartupPoint('app-shell-first-visible')

  void surfaceReady.then(async () => {
    if (cancelled) return
    const { scheduleNativeRagWarmup } = await import('./warmupScheduler')
    if (!cancelled) stopWarmup = scheduleNativeRagWarmup()
  }).catch((error) => console.warn('[App] RAG index warmup failed:', error))

  return () => {
    cancelled = true
    stopWarmup?.()
  }
}
