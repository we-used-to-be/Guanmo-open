import { useSettingsStore } from '@/stores/settingsStore'
import { useEditorStore } from '@/stores/editorStore'
import { estimateRagWarmupMb, loadRagStatsAggregate } from '@/services/database/persistence'
import { getNativeRagIndexState, initializeNativeRagIndex } from './nativeIndex'
import { decideRagWarmup } from './warmupPolicy'
import { getSystemMemorySnapshot, scheduleMemoryAwareTask, subscribeMemoryPressure, type MemoryPressure } from '@/services/systemMemory'

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

/** Called only after the database and the first real surface are ready. */
export function scheduleNativeRagWarmup(): () => void {
  let disposed = false
  let started = false
  let documentCount = 0
  let quietTimer: number | undefined
  let idleId: number | undefined
  let cancelQueued: (() => void) | undefined
  let memoryPressure: MemoryPressure = 'unknown'
  let activeTabId = useEditorStore.getState().activeTabId

  const clearPending = () => {
    if (quietTimer !== undefined) window.clearTimeout(quietTimer)
    if (idleId !== undefined) window.cancelIdleCallback(idleId)
    quietTimer = undefined
    idleId = undefined
    cancelQueued?.()
    cancelQueued = undefined
  }
  const decision = () => {
    const snapshot = getSystemMemorySnapshot()
    return decideRagWarmup({
    policy: useSettingsStore.getState().editor.modePerformancePolicy,
    documentCount,
    availableMemoryMb: snapshot ? Math.min(snapshot.availablePhysicalMb, snapshot.availableCommitMb) : undefined,
    recentlyUsed: wasRagRecentlyUsed(),
    userActive: false,
    memoryPressure: memoryPressure === 'pressure',
  })
  }
  const start = () => {
    if (disposed || started || decision() !== 'idle-warmup') return
    cancelQueued = scheduleMemoryAwareTask(async () => {
      const state = await getNativeRagIndexState()
      if (disposed || started || decision() !== 'idle-warmup') return
      started = true
      stop()
      // Shared initialization is not cancelled by ordinary interaction or disposal.
      if (state.status !== 'ready') await initializeNativeRagIndex()
    }, estimateRagWarmupMb, () => !disposed && !started && decision() === 'idle-warmup', 6, '知识库索引预热')
  }
  const schedule = () => {
    if (disposed || started) return
    clearPending()
    if (decision() !== 'idle-warmup') return
    if (useSettingsStore.getState().editor.modePerformancePolicy === 'speed') {
      start()
      return
    }
    quietTimer = window.setTimeout(() => {
      quietTimer = undefined
      if (typeof window.requestIdleCallback === 'function') {
        idleId = window.requestIdleCallback(() => {
          idleId = undefined
          start()
        })
      } else {
        start()
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
    unsubscribeMemory()
  }

  const unsubscribeMemory = subscribeMemoryPressure((value) => {
    memoryPressure = value
    if (value !== 'normal') clearPending()
    else if (value === 'normal' && documentCount > 0) schedule()
  })

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
