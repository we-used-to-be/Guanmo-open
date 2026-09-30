import { useCallback, useEffect } from 'react'
import { useAppStore } from '@/stores/appStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { isTauri } from '@/hooks/useTauri'
import { fadeOutFullscreenBackground, restoreFullscreenBackground } from '@/services/fullscreenBackgroundLayer'

let shouldRestoreMaximizedAfterFullscreen = false
let fullscreenTransitionInFlight: Promise<void> | null = null
let fullscreenStateRevision = 0

type FullscreenTransitionPhase = 'idle' | 'blurring' | 'switching' | 'focusing'

const FULLSCREEN_BLUR_DURATION = 100
const FULLSCREEN_FOCUS_DURATION = 150
const FULLSCREEN_SETTLE_LIMIT = 1200

async function readFullscreenState(): Promise<boolean> {
  if (isTauri()) {
    const { getCurrentWindow } = await import('@tauri-apps/api/window')
    return getCurrentWindow().isFullscreen()
  }
  return Boolean(document.fullscreenElement)
}

async function setFullscreenState(next: boolean): Promise<void> {
  if (isTauri()) {
    const { getCurrentWindow } = await import('@tauri-apps/api/window')
    const win = getCurrentWindow()
    if (next) {
      const maximized = await win.isMaximized()
      shouldRestoreMaximizedAfterFullscreen = maximized
      if (maximized) {
        await win.unmaximize()
        await waitForAnimationFrames(2)
        await expandWindowToCurrentMonitor()
        await waitForAnimationFrames(2)
      }
      await win.setFullscreen(true)
    } else {
      await win.setFullscreen(false)
    }
    return
  }

  if (next && !document.fullscreenElement) {
    await document.documentElement.requestFullscreen()
  } else if (!next && document.fullscreenElement) {
    await document.exitFullscreen()
  }
}

async function restoreMaximizedAfterFullscreenIfNeeded(win: { maximize: () => Promise<void> }): Promise<void> {
  if (!shouldRestoreMaximizedAfterFullscreen) return
  shouldRestoreMaximizedAfterFullscreen = false
  await win.maximize()
  await waitForAnimationFrames(2)
}

function restoreMaximizedAfterExternalFullscreenExit(): void {
  if (!isTauri()) return
  import('@tauri-apps/api/window')
    .then(({ getCurrentWindow }) => restoreMaximizedAfterFullscreenIfNeeded(getCurrentWindow()))
    .catch((err) => console.error('Fullscreen: failed to restore maximized state:', err))
}

function restorePendingFullscreenBackground(): void {
  if (useSettingsStore.getState().appearance.fullscreenBackgroundEnabled) {
    restoreFullscreenBackground()
  }
}

async function beginDwmTransitionSuppression(): Promise<number | null> {
  if (!isTauri()) return null
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<number | null>('begin_fullscreen_dwm_transition')
}

async function endDwmTransitionSuppression(leaseId: number): Promise<void> {
  if (!isTauri()) return
  const { invoke } = await import('@tauri-apps/api/core')
  await invoke('end_fullscreen_dwm_transition', { leaseId })
}

async function expandWindowToCurrentMonitor(): Promise<void> {
  const { currentMonitor, getCurrentWindow } = await import('@tauri-apps/api/window')
  const monitor = await currentMonitor()
  if (!monitor) return
  const win = getCurrentWindow()
  await win.setPosition(monitor.position)
  await win.setSize(monitor.size)
}

function waitForAnimationFrame(): Promise<void> {
  if (typeof window === 'undefined') return Promise.resolve()
  if (typeof window.requestAnimationFrame === 'function') {
    return new Promise((resolve) => window.requestAnimationFrame(() => resolve()))
  }
  return new Promise((resolve) => window.setTimeout(resolve, 16))
}

async function waitForAnimationFrames(count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await waitForAnimationFrame()
  }
}

function setFullscreenTransitionPhase(phase: FullscreenTransitionPhase): void {
  if (typeof document === 'undefined') return
  if (phase === 'idle') {
    delete document.documentElement.dataset.fullscreenTransitionPhase
    return
  }
  document.documentElement.dataset.fullscreenTransitionPhase = phase
}

function shouldAnimateFullscreenTransition(): boolean {
  if (!isTauri() || typeof window === 'undefined' || !document.getElementById('root')) return false
  if (!useSettingsStore.getState().appearance.fullscreenTransitionEnabled) return false
  return !window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

function waitForVisualTransition(surface: HTMLElement, duration: number): Promise<void> {
  return new Promise((resolve) => {
    let settled = false
    const timeoutRef = { id: 0 }
    const finish = () => {
      if (settled) return
      settled = true
      surface.removeEventListener('transitionend', handleTransitionEnd)
      window.clearTimeout(timeoutRef.id)
      resolve()
    }
    const handleTransitionEnd = (event: TransitionEvent) => {
      if (event.target !== surface) return
      if (event.propertyName === 'filter' || event.propertyName === 'transform' || event.propertyName === 'opacity') finish()
    }
    surface.addEventListener('transitionend', handleTransitionEnd)
    timeoutRef.id = window.setTimeout(finish, duration + 100)
    void surface.offsetWidth
  })
}

async function waitForFullscreenState(next: boolean): Promise<boolean> {
  const startedAt = performance.now()
  while (performance.now() - startedAt < FULLSCREEN_SETTLE_LIMIT) {
    if (await readFullscreenState() === next) {
      await waitForAnimationFrames(2)
      return true
    }
    await waitForAnimationFrame()
  }
  return await readFullscreenState()
}

async function runFullscreenChange(next: boolean, setFullscreen: (value: boolean) => void): Promise<void> {
  fullscreenStateRevision += 1
  let current: boolean
  try {
    current = await readFullscreenState()
  } catch (err) {
    console.error('Fullscreen: failed to read current state:', err)
    return
  }
  if (current === next) {
    if (!next && useAppStore.getState().isFullscreen) {
      try {
        await fadeOutFullscreenBackground()
      } catch (err) {
        console.warn('Fullscreen: background fade failed, continuing normally:', err)
      }
    }
    setFullscreen(current)
    return
  }

  let animated = false
  try {
    animated = shouldAnimateFullscreenTransition()
  } catch (err) {
    console.warn('Fullscreen: failed to evaluate transition preference, continuing without animation:', err)
  }
  const surface = animated ? document.getElementById('root') : null
  let backgroundFaded = false

  if (!next) {
    try {
      backgroundFaded = await fadeOutFullscreenBackground()
    } catch (err) {
      console.warn('Fullscreen: background fade failed, continuing normally:', err)
    }
  }

  if (surface) {
    try {
      setFullscreenTransitionPhase('blurring')
      await waitForVisualTransition(surface, FULLSCREEN_BLUR_DURATION)
    } catch (err) {
      console.warn('Fullscreen: blur transition failed, continuing without animation:', err)
    }
    setFullscreenTransitionPhase('switching')
  }

  let dwmTransitionLeaseId: number | null = null
  try {
    dwmTransitionLeaseId = await beginDwmTransitionSuppression()
  } catch (err) {
    console.warn('Fullscreen: failed to disable DWM transitions, continuing normally:', err)
  }

  try {
    await setFullscreenState(next)
    await waitForFullscreenState(next)
    const settledState = await readFullscreenState()
    setFullscreen(settledState)
    if (!next && backgroundFaded && settledState !== next) {
      restorePendingFullscreenBackground()
    }
    if (!next && settledState === next && isTauri()) {
      const { getCurrentWindow } = await import('@tauri-apps/api/window')
      await restoreMaximizedAfterFullscreenIfNeeded(getCurrentWindow())
    }
  } catch (err) {
    console.error('Fullscreen: change failed:', err)
    if (!next && backgroundFaded) restorePendingFullscreenBackground()
    try {
      setFullscreen(await readFullscreenState())
    } catch (readErr) {
      console.error('Fullscreen: failed to recover state:', readErr)
    }
  } finally {
    if (dwmTransitionLeaseId !== null) {
      try {
        await endDwmTransitionSuppression(dwmTransitionLeaseId)
      } catch (err) {
        console.warn('Fullscreen: failed to restore DWM transitions:', err)
      }
    }
  }

  if (surface) {
    try {
      await waitForAnimationFrames(2)
      setFullscreenTransitionPhase('focusing')
      await waitForVisualTransition(surface, FULLSCREEN_FOCUS_DURATION)
    } catch (err) {
      console.warn('Fullscreen: focus transition failed, cleaning up:', err)
    } finally {
      setFullscreenTransitionPhase('idle')
    }
  }
}

export function useFullscreen() {
  const isFullscreen = useAppStore((s) => s.isFullscreen)
  const setFullscreen = useAppStore((s) => s.setFullscreen)

  useEffect(() => {
    let disposed = false
    let cleanup: (() => void) | undefined
    let externalExitRequest = 0
    let externalExitPending = false
    let externalExitInFlight: Promise<void> | null = null

    const sync = () => {
      const stateRevision = ++fullscreenStateRevision
      readFullscreenState()
        .then((next) => {
          if (disposed || stateRevision !== fullscreenStateRevision || fullscreenTransitionInFlight) return

          const appIsFullscreen = useAppStore.getState().isFullscreen
          if (!next && appIsFullscreen) {
            if (externalExitInFlight) return
            externalExitPending = true
            const request = ++externalExitRequest
            const task = (async () => {
              try {
                const faded = await fadeOutFullscreenBackground()
                if (!faded || disposed || request !== externalExitRequest) return
                if (await readFullscreenState()) {
                  restorePendingFullscreenBackground()
                  return
                }
                setFullscreen(false)
                restoreMaximizedAfterExternalFullscreenExit()
              } catch (err) {
                if (request !== externalExitRequest) return
                restorePendingFullscreenBackground()
                console.warn('Fullscreen: external exit background fade failed:', err)
                if (!disposed) {
                  setFullscreen(false)
                  restoreMaximizedAfterExternalFullscreenExit()
                }
              } finally {
                if (request === externalExitRequest) externalExitPending = false
              }
            })()
            externalExitInFlight = task
            void task.finally(() => {
              if (externalExitInFlight === task) externalExitInFlight = null
            }).catch(() => undefined)
            return
          }

          if (next && externalExitPending) {
            externalExitRequest += 1
            externalExitPending = false
            restorePendingFullscreenBackground()
          }

          setFullscreen(next)
          if (!next && isTauri()) {
            import('@tauri-apps/api/window')
              .then(({ getCurrentWindow }) => restoreMaximizedAfterFullscreenIfNeeded(getCurrentWindow()))
              .catch((err) => console.error('Fullscreen: failed to restore maximized state:', err))
          }
        })
        .catch((err) => console.error('Fullscreen: failed to read state:', err))
    }

    sync()

    if (isTauri()) {
      import('@tauri-apps/api/window')
        .then(({ getCurrentWindow }) => {
          const win = getCurrentWindow()
          win.onResized(sync).then((unlisten) => {
            if (disposed) {
              unlisten()
            } else {
              cleanup = unlisten
            }
          })
        })
        .catch((err) => console.error('Fullscreen: failed to initialize listener:', err))
    } else {
      document.addEventListener('fullscreenchange', sync)
      cleanup = () => document.removeEventListener('fullscreenchange', sync)
    }

    return () => {
      disposed = true
      cleanup?.()
    }
  }, [setFullscreen])

  const changeFullscreen = useCallback(async (next: boolean) => {
    if (fullscreenTransitionInFlight) return fullscreenTransitionInFlight
    const task = runFullscreenChange(next, setFullscreen)
    fullscreenTransitionInFlight = task
    try {
      await task
    } finally {
      if (fullscreenTransitionInFlight === task) fullscreenTransitionInFlight = null
    }
  }, [setFullscreen])

  const toggleFullscreen = useCallback(async () => {
    try {
      const current = await readFullscreenState()
      await changeFullscreen(!current)
    } catch (err) {
      console.error('Fullscreen: toggle failed:', err)
    }
  }, [changeFullscreen])

  const enterFullscreen = useCallback(() => changeFullscreen(true), [changeFullscreen])
  const exitFullscreen = useCallback(() => changeFullscreen(false), [changeFullscreen])

  return { isFullscreen, toggleFullscreen, enterFullscreen, exitFullscreen }
}
