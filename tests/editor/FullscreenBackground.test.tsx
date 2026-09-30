import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FullscreenControlBar } from '@/components/editor/FullscreenControlBar'
import { useSettingsStore } from '@/stores/settingsStore'

const fileDialog = vi.hoisted(() => vi.fn())
const readImage = vi.hoisted(() => vi.fn())

vi.mock('@/hooks/useFullscreen', () => ({
  useFullscreen: () => ({ exitFullscreen: vi.fn() }),
}))

vi.mock('@/hooks/useTauri', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/hooks/useTauri')>(),
  isTauri: () => true,
  openFileDialog: fileDialog,
  readBinaryFile: readImage,
}))

const props = {
  productTourStep: null,
  fileDrawerOpen: false,
  onToggleFileDrawer: vi.fn(),
  onCloseFileDrawer: vi.fn(),
  onNewFile: vi.fn(),
  onOpenFile: vi.fn(),
}

afterEach(() => {
  useSettingsStore.getState().updateAppearanceSettings({ fullscreenBackgroundPath: null, fullscreenBackgroundOpacity: 40, fullscreenBackgroundEnabled: false, fullscreenBackgroundScene: 'custom' })
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('Fullscreen background', () => {
  it('restores legacy zero brightness as a fully hidden image', () => {
    const merge = useSettingsStore.persist.getOptions().merge!
    const restored = merge({ appearance: { fullscreenBackgroundBrightness: 0, fullscreenBackgroundPath: 'C:\\Pictures\\reading.png' } }, useSettingsStore.getState())

    expect(restored.appearance.fullscreenBackgroundOpacity).toBe(0)
    expect(restored.appearance.fullscreenBackgroundPath).toBe('C:\\Pictures\\reading.png')
    expect(restored.appearance.fullscreenBackgroundEnabled).toBe(true)
    expect(restored.appearance.fullscreenBackgroundScene).toBe('custom')
  })

  it('keeps the uploaded image when the background is disabled and expands the hovered scene', async () => {
    const path = 'C:\\Pictures\\reading.png'
    fileDialog.mockResolvedValue(path)
    readImage.mockImplementation(() => new Promise(() => {}))
    const view = render(<FullscreenControlBar {...props} />)

    fireEvent.click(screen.getByTitle('设置阅读背景'))
    fireEvent.click(screen.getByRole('button', { name: '选择图片' }))
    await waitFor(() => expect(useSettingsStore.getState().appearance.fullscreenBackgroundPath).toBe(path))
    expect(readImage).toHaveBeenCalledWith(path)
    expect(useSettingsStore.getState().appearance.fullscreenBackgroundEnabled).toBe(true)
    expect(screen.getByText('图片可见度')).toBeTruthy()

    const snow = screen.getByRole('button', { name: /雪山/ })
    fireEvent.mouseEnter(snow)
    expect(snow.className).toContain('is-expanded')
    expect(useSettingsStore.getState().appearance.fullscreenBackgroundScene).toBe('custom')
    fireEvent.mouseLeave(snow.parentElement!)
    expect(screen.getByRole('button', { name: /自定义/ }).className).toContain('is-expanded')

    fireEvent.change(screen.getByRole('slider', { name: '图片可见度' }), { target: { value: '0' } })
    expect(useSettingsStore.getState().appearance.fullscreenBackgroundOpacity).toBe(0)
    expect(document.documentElement.style.getPropertyValue('--gm-fullscreen-background-cover')).toBe('100%')

    fireEvent.change(screen.getByRole('slider', { name: '图片可见度' }), { target: { value: '100' } })
    expect(useSettingsStore.getState().appearance.fullscreenBackgroundOpacity).toBe(100)
    expect(document.documentElement.style.getPropertyValue('--gm-fullscreen-background-cover')).toBe('25%')

    fireEvent.click(screen.getByRole('button', { name: '停用背景' }))
    expect(useSettingsStore.getState().appearance.fullscreenBackgroundEnabled).toBe(false)
    expect(useSettingsStore.getState().appearance.fullscreenBackgroundPath).toBe(path)

    fireEvent.click(snow)
    expect(useSettingsStore.getState().appearance.fullscreenBackgroundScene).toBe('snow')
    expect(useSettingsStore.getState().appearance.fullscreenBackgroundPath).toBe(path)
    expect(screen.getByText('预设图片即将提供')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /自定义/ }))
    expect(useSettingsStore.getState().appearance.fullscreenBackgroundScene).toBe('custom')
    expect(screen.getByText('更换图片')).toBeTruthy()
    view.unmount()
    expect(document.documentElement.style.getPropertyValue('--gm-fullscreen-background-cover')).toBe('')
  })

  it('releases the displayed image when fullscreen controls unmount', async () => {
    const revokeObjectURL = vi.fn()
    vi.stubGlobal('URL', class extends URL {
      static createObjectURL = vi.fn(() => 'blob:reading-background')
      static revokeObjectURL = revokeObjectURL
    })
    readImage.mockResolvedValue(new Uint8Array([1, 2, 3]))
    useSettingsStore.getState().updateAppearanceSettings({ fullscreenBackgroundPath: 'C:\\Pictures\\reading.png', fullscreenBackgroundEnabled: true })

    const view = render(<FullscreenControlBar {...props} />)
    await waitFor(() => expect(document.documentElement.style.getPropertyValue('--gm-fullscreen-background-image')).toContain('blob:reading-background'))
    view.unmount()

    expect(document.documentElement.style.getPropertyValue('--gm-fullscreen-background-image')).toBe('')
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:reading-background')
  })

  it('removes the displayed image while disabled and restores it when enabled', async () => {
    const revokeObjectURL = vi.fn()
    vi.stubGlobal('URL', class extends URL {
      static createObjectURL = vi.fn(() => 'blob:reading-background')
      static revokeObjectURL = revokeObjectURL
    })
    readImage.mockResolvedValue(new Uint8Array([1, 2, 3]))
    const path = 'C:\\Pictures\\reading.png'
    useSettingsStore.getState().updateAppearanceSettings({ fullscreenBackgroundPath: path, fullscreenBackgroundEnabled: true })

    const view = render(<FullscreenControlBar {...props} />)
    await waitFor(() => expect(document.documentElement.style.getPropertyValue('--gm-fullscreen-background-image')).toContain('blob:reading-background'))
    fireEvent.click(screen.getByTitle('设置阅读背景'))
    fireEvent.click(screen.getByRole('button', { name: '停用背景' }))
    expect(document.documentElement.style.getPropertyValue('--gm-fullscreen-background-image')).toBe('')
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:reading-background')
    expect(useSettingsStore.getState().appearance.fullscreenBackgroundPath).toBe(path)

    fireEvent.click(screen.getByRole('button', { name: '启用背景' }))
    await waitFor(() => expect(document.documentElement.style.getPropertyValue('--gm-fullscreen-background-image')).toContain('blob:reading-background'))
    fireEvent.click(screen.getByRole('button', { name: /海边/ }))
    expect(document.documentElement.style.getPropertyValue('--gm-fullscreen-background-image')).toBe('')
    expect(useSettingsStore.getState().appearance.fullscreenBackgroundPath).toBe(path)
    fireEvent.click(screen.getByRole('button', { name: /自定义/ }))
    await waitFor(() => expect(document.documentElement.style.getPropertyValue('--gm-fullscreen-background-image')).toContain('blob:reading-background'))
    view.unmount()
  })
})
