import { useCallback, useEffect, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'
import type { Tab, ViewMode, ViewModeUsageStat } from '@/stores/editorStore'
import { eventMarker } from '@/services/eventMarker'
import {
  MODE_PREWARM_ACTIVITY_PAUSE,
  MODE_PREWARM_IDLE_DELAY,
  decideResource,
  getNextPrewarmTarget,
  scheduleIdlePrewarm,
  type InstanceType,
  type ModePerformancePolicy,
  type ModePrewarmLevel,
  type PrewarmTargetMode,
  type PrewarmedModeKeys,
  type ResourcePolicy,
} from '@/services/editorSession'

type ResourceKey = 'editor' | 'left-preview' | 'right-preview' | 'diff'
type MountedSetter = Dispatch<SetStateAction<boolean>>

interface UseEditorResourceLifecycleOptions {
  activeTab?: Tab
  activeTabId: string | null
  dualRightTab?: Tab | null
  rightTab?: Tab | null
  viewMode: ViewMode
  editorVisible: boolean
  leftPreviewVisible: boolean
  activeDocumentFirstScreenReady: boolean
  activeDocumentFirstScreenReadyRef: MutableRefObject<boolean>
  activePreviewPending: boolean
  rightPreviewPending: boolean
  activeDiffLineCount: number
  modePrewarm: ModePrewarmLevel
  modePerformancePolicy: ModePerformancePolicy
  modeResourcePolicy: ResourcePolicy
  viewModeUsage: Partial<Record<PrewarmTargetMode, ViewModeUsageStat>>
  getModeRenderKey: (mode: PrewarmTargetMode) => string | null
  warmScope: string | null
  leftPreviewMounted: boolean
  rightPreviewMounted: boolean
  editorMounted: boolean
  diffMounted: boolean
  draftDecisionVersion: number
  setLeftPreviewMounted: MountedSetter
  setRightPreviewMounted: MountedSetter
  setEditorMounted: MountedSetter
  setDiffMounted: MountedSetter
  retainedRightTabRef: MutableRefObject<Tab | null>
  leftPreviewDraftRef: MutableRefObject<boolean>
  rightPreviewDraftRef: MutableRefObject<boolean>
  leftPreviewRenderRef: MutableRefObject<{ content: string; filePath?: string | null }>
  restoredPreviewKeysRef: MutableRefObject<{ left: string | null; right: string | null }>
}

/**
 * Own the editor/preview/diff instance policy without owning document content.
 * The parent remains responsible for Pane composition and the document model.
 */
export function useEditorResourceLifecycle({
  activeTab,
  activeTabId,
  dualRightTab,
  rightTab,
  viewMode,
  editorVisible,
  leftPreviewVisible,
  activeDocumentFirstScreenReady,
  activeDocumentFirstScreenReadyRef,
  activePreviewPending,
  rightPreviewPending,
  activeDiffLineCount,
  modePrewarm,
  modePerformancePolicy,
  modeResourcePolicy,
  viewModeUsage,
  getModeRenderKey,
  warmScope,
  leftPreviewMounted,
  rightPreviewMounted,
  editorMounted,
  diffMounted,
  draftDecisionVersion,
  setLeftPreviewMounted,
  setRightPreviewMounted,
  setEditorMounted,
  setDiffMounted,
  retainedRightTabRef,
  leftPreviewDraftRef,
  rightPreviewDraftRef,
  leftPreviewRenderRef,
  restoredPreviewKeysRef,
}: UseEditorResourceLifecycleOptions) {
  const [prewarmedModeKeys, setPrewarmedModeKeys] = useState<PrewarmedModeKeys>({})
  const prewarmedModeKeysRef = useRef<PrewarmedModeKeys>({})
  prewarmedModeKeysRef.current = prewarmedModeKeys
  const warmedModeKeysRef = useRef<Set<string>>(new Set())
  const warmScopeRef = useRef<string | null>(null)
  const prewarmCancelRef = useRef(0)
  const idlePrewarmCancelRef = useRef<(() => void) | null>(null)
  const pendingPrewarmRef = useRef<{ scheduleId: string; target: PrewarmTargetMode } | null>(null)
  const prewarmScheduleSequenceRef = useRef(0)
  const requestedPrewarmScheduleIdsRef = useRef<Partial<Record<PrewarmTargetMode, string>>>({})
  const lastUserActivityAtRef = useRef(Date.now())

  const leftPreviewMountedRef = useRef(leftPreviewMounted)
  const rightPreviewMountedRef = useRef(rightPreviewMounted)
  const editorMountedRef = useRef(editorMounted)
  const diffMountedRef = useRef(diffMounted)
  leftPreviewMountedRef.current = leftPreviewMounted
  rightPreviewMountedRef.current = rightPreviewMounted
  editorMountedRef.current = editorMounted
  diffMountedRef.current = diffMounted

  const leftPreviewTtlRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const rightPreviewTtlRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const editorTtlRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const diffReleaseFrameRef = useRef<number | null>(null)
  const lastInstanceUseRef = useRef<Record<string, number>>({})
  const instanceDocumentRef = useRef<Record<string, string | null>>({})
  const forceDraftReleaseRef = useRef({ left: false, right: false })
  const resourcePolicyRef = useRef(modeResourcePolicy)
  resourcePolicyRef.current = modeResourcePolicy
  const viewModeRef = useRef(viewMode)
  viewModeRef.current = viewMode
  const previousVisibilityRef = useRef({
    editor: editorVisible,
    left: leftPreviewVisible,
    right: viewMode === 'dual-preview',
  })
  const previousActiveTabIdRef = useRef(activeTabId)

  const setResourceMounted = useCallback((
    resource: ResourceKey,
    mounted: boolean,
    documentKey: string | null = null,
  ) => {
    instanceDocumentRef.current[resource] = mounted ? documentKey : null
    if (resource === 'editor') {
      editorMountedRef.current = mounted
      setEditorMounted(mounted)
    } else if (resource === 'left-preview') {
      leftPreviewMountedRef.current = mounted
      setLeftPreviewMounted(mounted)
    } else if (resource === 'right-preview') {
      rightPreviewMountedRef.current = mounted
      setRightPreviewMounted(mounted)
    } else {
      diffMountedRef.current = mounted
      setDiffMounted(mounted)
    }
  }, [setDiffMounted, setEditorMounted, setLeftPreviewMounted, setRightPreviewMounted])

  const clearTtl = useCallback((ref: MutableRefObject<ReturnType<typeof setTimeout> | null>) => {
    if (ref.current !== null) {
      clearTimeout(ref.current)
      ref.current = null
    }
  }, [])

  const clearAllTtls = useCallback(() => {
    clearTtl(leftPreviewTtlRef)
    clearTtl(rightPreviewTtlRef)
    clearTtl(editorTtlRef)
  }, [clearTtl])

  const isInstanceVisible = useCallback((instanceKey: ResourceKey) => {
    const currentMode = viewModeRef.current
    if (instanceKey === 'editor') return currentMode === 'edit' || currentMode === 'edit-preview'
    if (instanceKey === 'left-preview') return currentMode === 'preview' || currentMode === 'edit-preview' || currentMode === 'dual-preview'
    if (instanceKey === 'right-preview') return currentMode === 'dual-preview'
    return currentMode === 'diff-preview'
  }, [])

  const decideHiddenResource = useCallback((
    instanceKey: ResourceKey,
    instanceType: InstanceType,
    candidateDocId: string | null,
    docCharCount: number,
    draftRef?: MutableRefObject<boolean>,
  ) => {
    const now = Date.now()
    return decideResource({
      policy: resourcePolicyRef.current,
      docId: candidateDocId,
      candidateDocId,
      docCharCount,
      instanceType,
      isCurrentlyVisible: false,
      lastUsedAt: lastInstanceUseRef.current[instanceKey] ?? now,
      now,
      hasUncommittedDraft: draftRef?.current ?? false,
    })
  }, [])

  const scheduleRelease = useCallback((
    ttlRef: MutableRefObject<ReturnType<typeof setTimeout> | null>,
    instanceKey: Exclude<ResourceKey, 'diff'>,
    instanceType: InstanceType,
    candidateDocId: string | null,
    docCharCount: number,
    releaseFn: () => void,
    draftRef?: MutableRefObject<boolean>,
  ) => {
    clearTtl(ttlRef)
    const now = Date.now()
    const hasDraft = draftRef?.current ?? false
    const decision = decideHiddenResource(instanceKey, instanceType, candidateDocId, docCharCount, draftRef)
    if (decision.action === 'release') {
      if (!hasDraft && !isInstanceVisible(instanceKey) && instanceDocumentRef.current[instanceKey] === candidateDocId) {
        if (import.meta.env.DEV) {
          eventMarker.mark('resource-release', { resource: instanceKey, reason: 'immediate', phase: 'requested' })
        }
        releaseFn()
      }
    } else if (decision.action === 'keepUntil') {
      const timer = setTimeout(() => {
        if (ttlRef.current !== timer) return
        ttlRef.current = null
        if (isInstanceVisible(instanceKey)) return
        if (instanceDocumentRef.current[instanceKey] !== candidateDocId) return
        const currentDecision = decideResource({
          policy: resourcePolicyRef.current,
          docId: candidateDocId,
          candidateDocId,
          docCharCount,
          instanceType,
          isCurrentlyVisible: false,
          lastUsedAt: lastInstanceUseRef.current[instanceKey] ?? now,
          now: Date.now(),
          hasUncommittedDraft: draftRef?.current ?? false,
        })
        if (currentDecision.action === 'release') {
          if (import.meta.env.DEV) {
            eventMarker.mark('resource-release', { resource: instanceKey, reason: 'ttl-expired', phase: 'requested' })
          }
          releaseFn()
        }
      }, Math.max(0, decision.deadline - now))
      ttlRef.current = timer
    }
  }, [clearTtl, decideHiddenResource, isInstanceVisible])

  const cancelPendingPrewarm = useCallback((reason: 'user-activity' | 'mode-change' | 'context-change' | 'policy-change' | 'schedule-replaced') => {
    const pending = pendingPrewarmRef.current
    if (pending) {
      if (import.meta.env.DEV) {
        eventMarker.mark('prewarm-cancel', {
          reason,
          scheduleId: pending.scheduleId,
          target: pending.target,
        })
      }
      pendingPrewarmRef.current = null
    }
    if (idlePrewarmCancelRef.current) {
      idlePrewarmCancelRef.current()
      idlePrewarmCancelRef.current = null
    }
  }, [])

  const cancelModePrewarm = useCallback((reason: 'user-activity' | 'mode-change' | 'context-change' | 'policy-change') => {
    prewarmCancelRef.current += 1
    lastUserActivityAtRef.current = Date.now()
    cancelPendingPrewarm(reason)
  }, [cancelPendingPrewarm])

  const previousModePrewarmRef = useRef(modePrewarm)
  const previousPerformancePolicyRef = useRef(modePerformancePolicy)

  useEffect(() => {
    const prev = previousPerformancePolicyRef.current
    previousPerformancePolicyRef.current = modePerformancePolicy
    if (import.meta.env.DEV && prev !== modePerformancePolicy) {
      eventMarker.mark('policy-change', { policy: modePerformancePolicy, prewarm: modePrewarm, resource: modeResourcePolicy })
    }
  }, [modePerformancePolicy, modePrewarm, modeResourcePolicy])

  useEffect(() => {
    const previous = previousModePrewarmRef.current
    previousModePrewarmRef.current = modePrewarm
    if (previous !== 'off' && modePrewarm === 'off') {
      cancelModePrewarm('policy-change')
      clearAllTtls()
      if (!editorVisible) setResourceMounted('editor', false)
      if (!leftPreviewVisible) {
        if (leftPreviewDraftRef.current) forceDraftReleaseRef.current.left = true
        else {
          leftPreviewRenderRef.current = { content: '', filePath: undefined }
          setResourceMounted('left-preview', false)
        }
      }
      if (viewMode !== 'dual-preview') {
        if (rightPreviewDraftRef.current) forceDraftReleaseRef.current.right = true
        else {
          retainedRightTabRef.current = null
          setResourceMounted('right-preview', false)
        }
      }
      if (diffReleaseFrameRef.current !== null) {
        window.cancelAnimationFrame(diffReleaseFrameRef.current)
        diffReleaseFrameRef.current = null
      }
      if (viewMode !== 'diff-preview') setResourceMounted('diff', false)
      setPrewarmedModeKeys({})
    }
  }, [cancelModePrewarm, clearAllTtls, editorVisible, leftPreviewVisible, modePrewarm, retainedRightTabRef, rightPreviewDraftRef, leftPreviewDraftRef, leftPreviewRenderRef, setResourceMounted, viewMode])

  useEffect(() => {
    const now = Date.now()
    const previousVisibility = previousVisibilityRef.current
    if (previousVisibility.left && !leftPreviewVisible) lastInstanceUseRef.current['left-preview'] = now
    if (previousVisibility.right && viewMode !== 'dual-preview') lastInstanceUseRef.current['right-preview'] = now
    if (previousVisibility.editor && !editorVisible) lastInstanceUseRef.current.editor = now
    previousVisibilityRef.current = {
      editor: editorVisible,
      left: leftPreviewVisible,
      right: viewMode === 'dual-preview',
    }
    if (leftPreviewVisible) {
      clearTtl(leftPreviewTtlRef)
      lastInstanceUseRef.current['left-preview'] = now
      setResourceMounted('left-preview', true, activeTab?.id ?? null)
      forceDraftReleaseRef.current.left = false
    } else if (leftPreviewMountedRef.current) {
      if (forceDraftReleaseRef.current.left && !leftPreviewDraftRef.current) {
        forceDraftReleaseRef.current.left = false
        leftPreviewRenderRef.current = { content: '', filePath: undefined }
        setResourceMounted('left-preview', false)
      } else {
        scheduleRelease(leftPreviewTtlRef, 'left-preview', 'preview', instanceDocumentRef.current['left-preview'] ?? activeTab?.id ?? null, activeTab?.content.length ?? 0, () => {
          leftPreviewRenderRef.current = { content: '', filePath: undefined }
          setResourceMounted('left-preview', false)
        }, leftPreviewDraftRef)
      }
    }

    if (viewMode === 'dual-preview') {
      clearTtl(rightPreviewTtlRef)
      lastInstanceUseRef.current['right-preview'] = now
      setResourceMounted('right-preview', true, rightTab?.id ?? null)
      forceDraftReleaseRef.current.right = false
    } else if (rightPreviewMountedRef.current) {
      const retained = retainedRightTabRef.current
      if (forceDraftReleaseRef.current.right && !rightPreviewDraftRef.current) {
        forceDraftReleaseRef.current.right = false
        retainedRightTabRef.current = null
        setResourceMounted('right-preview', false)
      } else {
        scheduleRelease(rightPreviewTtlRef, 'right-preview', 'preview', retained?.id ?? null, retained?.content.length ?? 0, () => {
          retainedRightTabRef.current = null
          setResourceMounted('right-preview', false)
        }, rightPreviewDraftRef)
      }
    }

    if (editorVisible) {
      clearTtl(editorTtlRef)
      lastInstanceUseRef.current.editor = now
      setResourceMounted('editor', true, activeTab?.id ?? null)
    } else if (editorMountedRef.current) {
      instanceDocumentRef.current.editor = activeTab?.id ?? null
      scheduleRelease(editorTtlRef, 'editor', 'editor', instanceDocumentRef.current.editor, activeTab?.content.length ?? 0, () => {
        setResourceMounted('editor', false)
      })
    }

    if (viewMode === 'diff-preview') {
      if (diffReleaseFrameRef.current !== null) window.cancelAnimationFrame(diffReleaseFrameRef.current)
      diffReleaseFrameRef.current = null
      lastInstanceUseRef.current.diff = now
      setResourceMounted('diff', true, activeTab?.id ?? null)
    } else if (diffMountedRef.current) {
      setResourceMounted('diff', false)
    }
  }, [activeTab?.content.length, activeTab?.id, clearTtl, draftDecisionVersion, editorMounted, editorVisible, leftPreviewDraftRef, leftPreviewMounted, leftPreviewRenderRef, leftPreviewVisible, retainedRightTabRef, rightPreviewDraftRef, rightPreviewMounted, scheduleRelease, setResourceMounted, viewMode, rightTab?.id])

  useEffect(() => {
    const prev = previousActiveTabIdRef.current
    previousActiveTabIdRef.current = activeTabId
    if (prev && activeTabId && prev !== activeTabId) {
      clearAllTtls()
      if (!rightPreviewDraftRef.current) retainedRightTabRef.current = null
      leftPreviewRenderRef.current = { content: '', filePath: undefined }
      restoredPreviewKeysRef.current = {
        left: leftPreviewVisible ? restoredPreviewKeysRef.current.left : null,
        right: viewMode === 'dual-preview' ? restoredPreviewKeysRef.current.right : null,
      }
      setPrewarmedModeKeys({})
      warmedModeKeysRef.current.clear()
      setResourceMounted('editor', editorVisible, activeTabId)
      setResourceMounted('left-preview', leftPreviewVisible, activeTabId)
      if (!rightPreviewDraftRef.current) setResourceMounted('right-preview', viewMode === 'dual-preview', rightTab?.id ?? null)
    }
  }, [activeTabId, clearAllTtls, editorVisible, leftPreviewVisible, retainedRightTabRef, restoredPreviewKeysRef, rightPreviewDraftRef, rightTab?.id, setResourceMounted, viewMode, leftPreviewRenderRef])

  if (warmScopeRef.current !== warmScope) {
    warmScopeRef.current = warmScope
    warmedModeKeysRef.current.clear()
  }
  const rememberWarmMode = (mode: PrewarmTargetMode) => {
    const key = getModeRenderKey(mode)
    if (key) warmedModeKeysRef.current.add(key)
  }
  if (leftPreviewVisible) {
    rememberWarmMode('preview')
    if (viewMode === 'edit-preview') rememberWarmMode('edit-preview')
    if (viewMode === 'dual-preview') rememberWarmMode('dual-preview')
  }
  if (viewMode === 'diff-preview') rememberWarmMode('diff-preview')

  useEffect(() => {
    const handleActivity = () => cancelModePrewarm('user-activity')
    window.addEventListener('keydown', handleActivity, true)
    window.addEventListener('pointerdown', handleActivity, true)
    window.addEventListener('wheel', handleActivity, { capture: true, passive: true })
    window.addEventListener('scroll', handleActivity, { capture: true, passive: true })
    return () => {
      window.removeEventListener('keydown', handleActivity, true)
      window.removeEventListener('pointerdown', handleActivity, true)
      window.removeEventListener('wheel', handleActivity, { capture: true })
      window.removeEventListener('scroll', handleActivity, { capture: true })
    }
  }, [cancelModePrewarm])

  useEffect(() => {
    cancelModePrewarm('mode-change')
  }, [cancelModePrewarm, viewMode])

  useEffect(() => {
    if (modePrewarm === 'off') setPrewarmedModeKeys({})
  }, [modePrewarm])

  useEffect(() => {
    cancelModePrewarm('context-change')
    setPrewarmedModeKeys({})
  }, [activeTab?.content, activeTab?.id, activeTab?.originalContent, cancelModePrewarm, viewMode])

  useEffect(() => {
    const canPrewarm = modePrewarm !== 'off' && modeResourcePolicy !== 'memory'
    if (!activeTab?.id || !canPrewarm) return
    if (!activeDocumentFirstScreenReadyRef.current || !activeDocumentFirstScreenReady) return
    if (activePreviewPending || rightPreviewPending) return

    const target = getNextPrewarmTarget({
      activeMode: viewMode,
      contentLength: activeTab.content.length,
      diffLineCount: activeDiffLineCount,
      level: modePrewarm,
      resolveKey: getModeRenderKey,
      warmedKeys: new Set([
        ...warmedModeKeysRef.current,
        ...Object.values(prewarmedModeKeysRef.current).filter((key): key is string => Boolean(key)),
      ]),
      usage: viewModeUsage,
    })
    if (!target) return

    cancelPendingPrewarm('schedule-replaced')
    const scheduleId = `prewarm-${++prewarmScheduleSequenceRef.current}`
    pendingPrewarmRef.current = { scheduleId, target }
    const token = prewarmCancelRef.current
    const timer = window.setTimeout(() => {
      const idleSince = Date.now() - lastUserActivityAtRef.current
      if (prewarmCancelRef.current !== token || idleSince < MODE_PREWARM_ACTIVITY_PAUSE) return
      if (idlePrewarmCancelRef.current) {
        idlePrewarmCancelRef.current()
        idlePrewarmCancelRef.current = null
      }
      idlePrewarmCancelRef.current = scheduleIdlePrewarm(() => {
        idlePrewarmCancelRef.current = null
        if (prewarmCancelRef.current !== token) return
        const key = getModeRenderKey(target)
        if (!key) return
        if (pendingPrewarmRef.current?.scheduleId === scheduleId) pendingPrewarmRef.current = null
        requestedPrewarmScheduleIdsRef.current[target] = scheduleId
        setPrewarmedModeKeys((current) => current[target] === key ? current : { ...current, [target]: key })
      })
    }, Math.max(MODE_PREWARM_IDLE_DELAY, MODE_PREWARM_ACTIVITY_PAUSE))

    if (import.meta.env.DEV) {
      eventMarker.mark('prewarm-schedule', {
        target,
        scheduleId,
        delayMs: Math.max(MODE_PREWARM_IDLE_DELAY, MODE_PREWARM_ACTIVITY_PAUSE),
      })
    }

    return () => window.clearTimeout(timer)
  }, [activeDiffLineCount, activeDocumentFirstScreenReady, activeDocumentFirstScreenReadyRef, activePreviewPending, activeTab?.content.length, activeTab?.id, cancelPendingPrewarm, getModeRenderKey, modePrewarm, modeResourcePolicy, prewarmedModeKeys, rightPreviewPending, viewMode, viewModeUsage])

  useEffect(() => {
    const canPrewarm = modePrewarm !== 'off' && modeResourcePolicy !== 'memory'
    if (!activeTab?.id || !canPrewarm) return
    if (!activeDocumentFirstScreenReadyRef.current || !activeDocumentFirstScreenReady) return
    const requestedModes = Object.keys(prewarmedModeKeys) as PrewarmTargetMode[]
    if (requestedModes.length === 0) return
    const now = Date.now()
    const wantsLeft = requestedModes.some((mode) => mode === 'preview' || mode === 'edit-preview' || mode === 'dual-preview')
    const wantsEditor = requestedModes.includes('edit-preview')
    const wantsRight = requestedModes.includes('dual-preview')
    const wantsDiff = requestedModes.includes('diff-preview')

    if (wantsLeft && !leftPreviewVisible && !leftPreviewMountedRef.current) {
      lastInstanceUseRef.current['left-preview'] = now
      setResourceMounted('left-preview', true, activeTab.id)
      const target = requestedModes.find((mode) => mode === 'preview' || mode === 'edit-preview' || mode === 'dual-preview')
      if (import.meta.env.DEV) {
        eventMarker.mark('prewarm-create', {
          resource: 'left-preview',
          target: target ?? null,
          scheduleId: target ? requestedPrewarmScheduleIdsRef.current[target] ?? null : null,
          phase: 'requested',
        })
      }
    }

    if (wantsEditor && !editorVisible && !editorMountedRef.current) {
      lastInstanceUseRef.current.editor = now
      setResourceMounted('editor', true, activeTab.id)
      if (import.meta.env.DEV) {
        eventMarker.mark('prewarm-create', {
          resource: 'editor',
          target: 'edit-preview',
          scheduleId: requestedPrewarmScheduleIdsRef.current['edit-preview'] ?? null,
          phase: 'requested',
        })
      }
    }

    if (wantsRight && viewMode !== 'dual-preview' && !rightPreviewMountedRef.current) {
      const candidate = dualRightTab ?? activeTab
      retainedRightTabRef.current = candidate
      lastInstanceUseRef.current['right-preview'] = now
      setResourceMounted('right-preview', true, candidate.id)
      if (import.meta.env.DEV) {
        eventMarker.mark('prewarm-create', {
          resource: 'right-preview',
          target: 'dual-preview',
          scheduleId: requestedPrewarmScheduleIdsRef.current['dual-preview'] ?? null,
          phase: 'requested',
        })
      }
    }

    if (wantsDiff && viewMode !== 'diff-preview' && !diffMountedRef.current) {
      lastInstanceUseRef.current.diff = now
      setResourceMounted('diff', true, activeTab.id)
      if (import.meta.env.DEV) {
        eventMarker.mark('prewarm-create', {
          resource: 'diff',
          target: 'diff-preview',
          scheduleId: requestedPrewarmScheduleIdsRef.current['diff-preview'] ?? null,
          phase: 'requested',
        })
      }
      const decision = decideHiddenResource('diff', 'diff', activeTab.id, activeTab.content.length)
      if (decision.action !== 'release') return
      if (diffReleaseFrameRef.current !== null) window.cancelAnimationFrame(diffReleaseFrameRef.current)
      diffReleaseFrameRef.current = window.requestAnimationFrame(() => {
        diffReleaseFrameRef.current = null
        if (viewModeRef.current === 'diff-preview' || instanceDocumentRef.current.diff !== activeTab.id) return
        setResourceMounted('diff', false)
      })
    }
  }, [activeDocumentFirstScreenReady, activeDocumentFirstScreenReadyRef, activeTab?.id, decideHiddenResource, editorVisible, leftPreviewVisible, modePrewarm, modeResourcePolicy, prewarmedModeKeys, retainedRightTabRef, setResourceMounted, viewMode]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => () => {
    clearAllTtls()
    if (idlePrewarmCancelRef.current) {
      idlePrewarmCancelRef.current()
      idlePrewarmCancelRef.current = null
    }
    if (diffReleaseFrameRef.current !== null) {
      window.cancelAnimationFrame(diffReleaseFrameRef.current)
      diffReleaseFrameRef.current = null
    }
    retainedRightTabRef.current = null
    leftPreviewRenderRef.current = { content: '', filePath: undefined }
    instanceDocumentRef.current = {}
    prewarmedModeKeysRef.current = {}
    warmedModeKeysRef.current.clear()
  }, [clearAllTtls, leftPreviewRenderRef, retainedRightTabRef])
}
