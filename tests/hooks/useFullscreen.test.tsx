import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useFullscreen } from '@/hooks/useFullscreen'
import { useAppStore } from '@/stores/appStore'
import { useSettingsStore } from '@/stores/settingsStore'

const backgroundApi = vi.hoisted(() => ({
  fadeOut: vi.fn(async () => true),
  restore: vi.fn(),
}))

vi.mock('@/services/fullscreenBackgroundLayer', () => ({
  fadeOutFullscreenBackground: backgroundApi.fadeOut,
  restoreFullscreenBackground: backgroundApi.restore,
}))

let fullscreen = true
const requestFullscreen = vi.fn(async () => { fullscreen = true })
const exitFullscreen = vi.fn(async () => { fullscreen = false })

afterEach(() => {
  useAppStore.getState().setFullscreen(false)
  useSettingsStore.getState().updateAppearanceSettings({ fullscreenBackgroundEnabled: false })
  fullscreen = true
  requestFullscreen.mockClear()
  exitFullscreen.mockClear()
  vi.clearAllMocks()
})

describe('useFullscreen background exit timing', () => {
  beforeEach(() => {
    Object.defineProperty(document, 'fullscreenElement', {
      configurable: true,
      get: () => fullscreen ? document.documentElement : null,
    })
    document.documentElement.requestFullscreen = requestFullscreen
    document.exitFullscreen = exitFullscreen
    useAppStore.getState().setFullscreen(true)
    useSettingsStore.getState().updateAppearanceSettings({ fullscreenBackgroundEnabled: true })
    backgroundApi.fadeOut.mockResolvedValue(true)
  })

  it('waits for the background fade before an application initiated exit', async () => {
    let finishFade!: () => void
    backgroundApi.fadeOut.mockImplementationOnce(() => new Promise<boolean>((resolve) => {
      finishFade = () => resolve(true)
    }))
    const { result, unmount } = renderHook(() => useFullscreen())

    let exit!: Promise<void>
    act(() => { exit = result.current.exitFullscreen() })
    await waitFor(() => expect(backgroundApi.fadeOut).toHaveBeenCalledTimes(1))
    expect(exitFullscreen).not.toHaveBeenCalled()

    finishFade()
    await act(async () => { await exit })
    expect(exitFullscreen).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(useAppStore.getState().isFullscreen).toBe(false))
    unmount()
  })

  it('restores the background when the native exit fails', async () => {
    exitFullscreen.mockRejectedValueOnce(new Error('native exit failed'))
    const { result, unmount } = renderHook(() => useFullscreen())

    await act(async () => { await result.current.exitFullscreen() })
    expect(backgroundApi.restore).toHaveBeenCalled()
    expect(useAppStore.getState().isFullscreen).toBe(true)
    unmount()
  })

  it('coalesces repeated exit requests while a fade is pending', async () => {
    let finishFade!: () => void
    backgroundApi.fadeOut.mockImplementationOnce(() => new Promise<boolean>((resolve) => {
      finishFade = () => resolve(true)
    }))
    const { result, unmount } = renderHook(() => useFullscreen())

    let first!: Promise<void>
    let second!: Promise<void>
    act(() => {
      first = result.current.exitFullscreen()
      second = result.current.exitFullscreen()
    })
    await waitFor(() => expect(backgroundApi.fadeOut).toHaveBeenCalledTimes(1))
    finishFade()
    await act(async () => { await Promise.all([first, second]) })
    expect(exitFullscreen).toHaveBeenCalledTimes(1)
    unmount()
  })

  it('delays state cleanup for a system initiated exit until the fade completes', async () => {
    let finishFade!: () => void
    backgroundApi.fadeOut.mockImplementationOnce(() => new Promise<boolean>((resolve) => {
      finishFade = () => resolve(true)
    }))
    const { unmount } = renderHook(() => useFullscreen())

    fullscreen = false
    act(() => { document.dispatchEvent(new Event('fullscreenchange')) })
    await waitFor(() => expect(backgroundApi.fadeOut).toHaveBeenCalledTimes(1))
    expect(useAppStore.getState().isFullscreen).toBe(true)

    finishFade()
    await waitFor(() => expect(useAppStore.getState().isFullscreen).toBe(false))
    unmount()
  })
})
