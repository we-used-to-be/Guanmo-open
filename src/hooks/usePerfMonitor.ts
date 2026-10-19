import { useEffect, useRef } from 'react'
import { perfCollector } from '@/services/perfCollector'
import { eventMarker } from '@/services/eventMarker'
import { recordPerfSample, usePerfStore } from '@/stores/perfStore'
import { useEditorStore } from '@/stores/editorStore'
import { useAppStore } from '@/stores/appStore'
import { runtimeResourceTracker } from '@/services/runtimeResourceTracker'

/** Cancelable delayed snapshot for mode-settled events. */
function useModeSettledTimer() {
  const timersRef = useRef<{ t2: number | null; t5: number | null }>({ t2: null, t5: null })

  const cancel = () => {
    const timers = timersRef.current
    if (timers.t2 !== null) { clearTimeout(timers.t2); timers.t2 = null }
    if (timers.t5 !== null) { clearTimeout(timers.t5); timers.t5 = null }
  }

  const schedule = (mode: string) => {
    cancel()
    for (const delayMs of [2000, 5000]) {
      const timerId = window.setTimeout(async () => {
        // Verify mode hasn't changed since scheduling
        if (useEditorStore.getState().viewMode !== mode) return
        const snapshot = await perfCollector.collect()
        if (useEditorStore.getState().viewMode !== mode) return
        eventMarker.markPoint('mode-settled', snapshot, {
          mode,
          delayMs,
          activeDocumentCharCount: snapshot.activeDocumentCharCount,
          previewInstanceCount: snapshot.previewInstanceCount,
          editorInstanceCount: snapshot.editorInstanceCount,
        })
        if (delayMs === 2000) timersRef.current.t2 = null
        if (delayMs === 5000) timersRef.current.t5 = null
      }, delayMs)
      if (delayMs === 2000) timersRef.current.t2 = timerId
      if (delayMs === 5000) timersRef.current.t5 = timerId
    }
  }

  return { cancel, schedule }
}

export function usePerfMonitor() {
  const modeSettled = useModeSettledTimer()
  const enabled = usePerfStore((state) => state.enabled)

  useEffect(() => {
    if (!import.meta.env.DEV || !enabled) return

    perfCollector.setSources({
      getCurrentMode: () => useEditorStore.getState().viewMode,
      getDocCharCount: () => {
        const state = useEditorStore.getState()
        return state.tabs.find((tab) => tab.id === state.activeTabId)?.content.length ?? 0
      },
    })

    // Document context sources for load context reporting
    perfCollector.setDocumentContextSources({
      getActiveDocumentCount: () => {
        const state = useEditorStore.getState()
        return state.tabs.length > 0 ? 1 : 0
      },
      getActiveDocumentCharCount: () => {
        const state = useEditorStore.getState()
        return state.tabs.find((tab) => tab.id === state.activeTabId)?.content.length ?? 0
      },
      getTotalOpenDocumentCharCount: () => {
        const state = useEditorStore.getState()
        return state.tabs.reduce((sum, tab) => sum + tab.content.length, 0)
      },
      getActiveDocumentLineCount: () => {
        const state = useEditorStore.getState()
        return state.tabs.find((tab) => tab.id === state.activeTabId)?.content.split('\n').length ?? 0
      },
      getPreviewInstanceCount: () => {
        return document.querySelectorAll('.gm-markdown-preview:not([data-preview-switch-snapshot] *)').length
      },
      getEditorInstanceCount: () => {
        return document.querySelectorAll('.cm-editor:not([data-preview-switch-snapshot] *)').length
      },
      getAiPanelOpen: () => useAppStore.getState().aiPanelOpen,
      getIsFullscreen: () => useAppStore.getState().isFullscreen,
    })

    eventMarker.setSnapshotSource(() => usePerfStore.getState().current)
    eventMarker.setFreshSnapshotSource(() => perfCollector.collect())
    eventMarker.mark('app-start')

    const startCollector = () => {
      const interval = usePerfStore.getState().settings.sampleIntervalMs
      perfCollector.start(interval, recordPerfSample, () => {
        usePerfStore.getState().setSampleInterval(5000)
      })
    }
    startCollector()

    const unsubscribeSettings = usePerfStore.subscribe((state, previous) => {
      if (state.settings.sampleIntervalMs !== previous.settings.sampleIntervalMs) startCollector()
    })
    const unsubscribeEvents = eventMarker.addListener(usePerfStore.getState().addEvent)
    const unsubscribeEditor = useEditorStore.subscribe((state, previous) => {
      if (state.activeTabId !== previous.activeTabId && state.activeTabId) {
        eventMarker.mark('switch-document', {
          previousTabId: previous.activeTabId ? 'doc' : null,
          currentTabId: state.activeTabId ? 'doc' : null,
        })
      }
      if (state.viewMode !== previous.viewMode) {
        // Schedule mode-settled after React renders + layout + paint
        modeSettled.schedule(state.viewMode)
      }
    })

    // Track mode-settled via requestAnimationFrame after mode change
    let pendingModeComplete: number | null = null
    const unsubscribeModeComplete = useEditorStore.subscribe((state, previous) => {
      if (state.viewMode !== previous.viewMode) {
        // Cancel any pending completion from a previous switch
        if (pendingModeComplete !== null) {
          cancelAnimationFrame(pendingModeComplete)
          pendingModeComplete = null
        }
        // Wait for React commit + layout + at least one paint frame
        pendingModeComplete = requestAnimationFrame(() => {
          pendingModeComplete = requestAnimationFrame(() => {
            pendingModeComplete = null
            eventMarker.mark('switch-mode-complete', {
              mode: state.viewMode,
            })
          })
        })
      }
    })

    const unsubscribeApp = useAppStore.subscribe((state, previous) => {
      if (state.aiPanelOpen !== previous.aiPanelOpen) {
        eventMarker.mark(state.aiPanelOpen ? 'ai-panel-open' : 'ai-panel-close')
      }
      if (state.isFullscreen !== previous.isFullscreen) {
        eventMarker.mark(state.isFullscreen ? 'enter-fullscreen' : 'exit-fullscreen')
      }
    })

    return () => {
      perfCollector.dispose()
      runtimeResourceTracker.uninstall()
      modeSettled.cancel()
      if (pendingModeComplete !== null) cancelAnimationFrame(pendingModeComplete)
      unsubscribeSettings()
      unsubscribeEvents()
      unsubscribeEditor()
      unsubscribeModeComplete()
      unsubscribeApp()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled])
}
