import { useSettingsStore } from '@/stores/settingsStore'
import { useEditorStore } from '@/stores/editorStore'
import { loadRagStatsAggregate } from '@/services/database/persistence'
import { getNativeRagIndexState, initializeNativeRagIndex } from './nativeIndex'
import { decideRagWarmup } from './warmupPolicy'

const RECENT_RAG_USE_MS = 7 * 24 * 60 * 60 * 1000
const BALANCED_QUIET_MS = 2000

function wasRagRecentlyUsed(): boolean {
  try {
    const value = Number(localStorage.getItem('guanmo-rag-last-used-at'))
    return Number.isFinite(value) && Date.now() - value <= RECENT_RAG_USE_MS
  } catch {
    return false
  }
}

function availableMemoryMb(): number | undefined {
  const memory = performance as Performance & { memory?: { jsHeapSizeLimit: number; usedJSHeapSize: number } }
  if (!memory.memory) return undefined
  return Math.max(0, (memory.memory.jsHeapSizeLimit - memory.memory.usedJSHeapSize) / 1024 / 1024)
}

/** Called only after the database and the first real surface are ready. */
export function scheduleNativeRagWarmup(): () => void {
  let disposed = false
  let started = false
  let documentCount = 0
  let quietTimer: number | undefined
  let idleId: number | undefined
  let activeTabId = useEditorStore.getState().activeTabId

  const clearPending = () => {
    if (quietTimer !== undefined) window.clearTimeout(quietTimer)
    if (idleId !== undefined) window.cancelIdleCallback(idleId)
    quietTimer = undefined
    idleId = undefined
  }
  const decision = () => decideRagWarmup({
    policy: useSettingsStore.getState().editor.modePerformancePolicy,
    documentCount,
    availableMemoryMb: availableMemoryMb(),
    recentlyUsed: wasRagRecentlyUsed(),
    userActive: false,
    memoryPressure: false,
  })
  const start = async () => {
    if (disposed || started || decision() !== 'idle-warmup') return
    started = true
    clearPending()
    window.removeEventListener('pointerdown', onActivity, true)
    window.removeEventListener('keydown', onActivity, true)
    unsubscribeEditor()
    unsubscribeSettings()
    const state = await getNativeRagIndexState()
    if (state.status !== 'ready') await initializeNativeRagIndex()
  }
  const schedule = () => {
    if (disposed || started) return
    clearPending()
    if (decision() !== 'idle-warmup') return
    if (useSettingsStore.getState().editor.modePerformancePolicy === 'speed') {
      void start().catch((error) => console.warn('[RAG] Index warmup failed:', error))
      return
    }
    quietTimer = window.setTimeout(() => {
      quietTimer = undefined
      if (typeof window.requestIdleCallback === 'function') {
        idleId = window.requestIdleCallback(() => {
          idleId = undefined
          void start().catch((error) => console.warn('[RAG] Index warmup failed:', error))
        })
      } else {
        void start().catch((error) => console.warn('[RAG] Index warmup failed:', error))
      }
    }, BALANCED_QUIET_MS)
  }
  const onActivity = () => {
    if (useSettingsStore.getState().editor.modePerformancePolicy === 'balanced') schedule()
  }
  const unsubscribeEditor = useEditorStore.subscribe((state) => {
    if (state.activeTabId !== activeTabId) {
      activeTabId = state.activeTabId
      onActivity()
    }
  })
  const unsubscribeSettings = useSettingsStore.subscribe((state, previous) => {
    if (state.editor.modePerformancePolicy !== previous.editor.modePerformancePolicy) schedule()
  })
  window.addEventListener('pointerdown', onActivity, true)
  window.addEventListener('keydown', onActivity, true)

  const stop = () => {
    disposed = true
    clearPending()
    window.removeEventListener('pointerdown', onActivity, true)
    window.removeEventListener('keydown', onActivity, true)
    unsubscribeEditor()
    unsubscribeSettings()
  }

  void loadRagStatsAggregate().then((stats) => {
    if (disposed) return
    if (stats.documents === 0) {
      stop()
      return
    }
    documentCount = stats.documents
    schedule()
  }).catch((error) => {
    stop()
    console.warn('[RAG] Index warmup stats failed:', error)
  })

  return stop
}
