import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FullscreenControlBar } from '@/components/editor/FullscreenControlBar'
import { useSettingsStore } from '@/stores/settingsStore'

const fileDialog = vi.hoisted(() => vi.fn())
const listBackgrounds = vi.hoisted(() => vi.fn())
const importBackground = vi.hoisted(() => vi.fn())
const deleteBackground = vi.hoisted(() => vi.fn())
const downloadBackground = vi.hoisted(() => vi.fn())
const readBackground = vi.hoisted(() => vi.fn())

vi.mock('@/hooks/useFullscreen', () => ({ useFullscreen: () => ({ exitFullscreen: vi.fn() }) }))
vi.mock('@/hooks/useTauri', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/hooks/useTauri')>(), isTauri: () => true,
  openFileDialog: fileDialog, readBinaryFile: vi.fn(),
}))
vi.mock('@/services/fullscreenBackgrounds', () => ({
  OFFICIAL_BACKGROUNDS: [
    { id: 'snow', label: '雪山', kind: 'official', thumbnail: '/snow.webp', downloaded: false, extension: 'png' },
    { id: 'sea', label: '海边', kind: 'official', thumbnail: '/sea.webp', downloaded: false, extension: 'png' },
    { id: 'stars', label: '星空', kind: 'official', thumbnail: '/stars.webp', downloaded: false, extension: 'png' },
  ],
  listReadingBackgrounds: listBackgrounds, importReadingBackground: importBackground,
  deleteReadingBackground: deleteBackground, downloadReadingBackground: downloadBackground,
  readReadingBackground: readBackground,
}))

const props = { productTourStep: null, fileDrawerOpen: false, onToggleFileDrawer: vi.fn(), onCloseFileDrawer: vi.fn(), onNewFile: vi.fn(), onOpenFile: vi.fn() }
const local = (count: number) => Array.from({ length: count }, (_, index) => ({ id: `00000000-0000-0000-0000-00000000000${index}`, label: `本地 ${index + 1}`, extension: 'png' }))

afterEach(() => {
  useSettingsStore.getState().updateAppearanceSettings({ fullscreenBackgroundPath: null, fullscreenBackgroundOpacity: 40, fullscreenBackgroundEnabled: false, fullscreenBackgroundScene: 'custom' })
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('Fullscreen background', () => {
  it('keeps legacy zero brightness compatible', () => {
    const merge = useSettingsStore.persist.getOptions().merge!
    const restored = merge({ appearance: { fullscreenBackgroundBrightness: 0, fullscreenBackgroundPath: 'C:\\Pictures\\reading.png' } }, useSettingsStore.getState())
    expect(restored.appearance.fullscreenBackgroundOpacity).toBe(0)
    expect(restored.appearance.fullscreenBackgroundEnabled).toBe(true)
    expect(restored.appearance.fullscreenBackgroundScene).toBe('custom')
  })

  it.each([0, 1, 2, 3])('shows exactly %i imported cards', async (count) => {
    listBackgrounds.mockResolvedValue({ downloadedOfficialIds: [], localBackgrounds: local(count) })
    readBackground.mockResolvedValue([0xff, 0xd8, 0xff])
    vi.stubGlobal('URL', class extends URL {
      static createObjectURL = vi.fn(() => 'blob:thumbnail')
      static revokeObjectURL = vi.fn()
    })
    render(<FullscreenControlBar {...props} />)
    fireEvent.click(screen.getByTitle('设置阅读背景'))
    await waitFor(() => expect(screen.queryAllByRole('button', { name: /使用本地.*背景/ })).toHaveLength(count))
    expect(screen.getAllByRole('button', { name: /下载.*背景/ })).toHaveLength(3)
    if (count === 0) expect(screen.getByText('还没有导入背景')).toBeTruthy()
    expect(readBackground.mock.calls.every(([, thumbnail]) => thumbnail === true)).toBe(true)
    expect((screen.getByRole('button', { name: '导入' }) as HTMLButtonElement).disabled).toBe(count === 3)
  })

  it('recognizes an official preset already downloaded before opening the panel', async () => {
    listBackgrounds.mockResolvedValue({ downloadedOfficialIds: ['snow'], localBackgrounds: [] })
    render(<FullscreenControlBar {...props} />)
    fireEvent.click(screen.getByTitle('设置阅读背景'))
    expect(await screen.findByRole('button', { name: '使用雪山背景' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '使用雪山背景' }))
    expect(downloadBackground).not.toHaveBeenCalled()
  })

  it('restores the download icon after failure', async () => {
    listBackgrounds.mockResolvedValue({ downloadedOfficialIds: [], localBackgrounds: [] })
    downloadBackground.mockRejectedValue(new Error('offline'))
    render(<FullscreenControlBar {...props} />)
    fireEvent.click(screen.getByTitle('设置阅读背景'))
    fireEvent.click(screen.getByRole('button', { name: '下载海边背景' }))
    await waitFor(() => expect(screen.getByRole('button', { name: '下载海边背景' }).hasAttribute('disabled')).toBe(false))
  })

  it('imports to the owned library and falls back when deleting the selected image', async () => {
    let items = local(0)
    listBackgrounds.mockImplementation(async () => ({ downloadedOfficialIds: [], localBackgrounds: items }))
    readBackground.mockResolvedValue([0xff, 0xd8, 0xff])
    fileDialog.mockResolvedValue('C:\\Pictures\\reading.png')
    importBackground.mockImplementation(async () => { items = local(1); return items[0] })
    deleteBackground.mockImplementation(async () => { items = local(0) })
    vi.stubGlobal('URL', class extends URL {
      static createObjectURL = vi.fn(() => 'blob:reading-background')
      static revokeObjectURL = vi.fn()
    })
    render(<FullscreenControlBar {...props} />)
    fireEvent.click(screen.getByTitle('设置阅读背景'))
    await screen.findByText('还没有导入背景')
    fireEvent.click(screen.getByRole('button', { name: '导入' }))
    await waitFor(() => expect(importBackground).toHaveBeenCalledWith('C:\\Pictures\\reading.png'))
    await waitFor(() => expect(useSettingsStore.getState().appearance.fullscreenBackgroundScene).toBe(`local:${local(1)[0].id}`))
    expect(useSettingsStore.getState().appearance.fullscreenBackgroundPath).toBeNull()
    fireEvent.click(await screen.findByRole('button', { name: '删除本地 1背景' }))
    await waitFor(() => expect(deleteBackground).toHaveBeenCalledWith(local(1)[0].id))
    await waitFor(() => expect(screen.getByText('还没有导入背景')).toBeTruthy())
    expect(useSettingsStore.getState().appearance.fullscreenBackgroundEnabled).toBe(false)
  })

  it('shows download progress, enables the preset, and keeps visibility controls', async () => {
    listBackgrounds.mockResolvedValue({ downloadedOfficialIds: [], localBackgrounds: [] })
    let finish!: () => void
    downloadBackground.mockImplementation((_id: string, onProgress: (value: number) => void) => {
      onProgress(42)
      return new Promise<void>((resolve) => { finish = resolve })
    })
    readBackground.mockResolvedValue([137, 80, 78, 71])
    render(<FullscreenControlBar {...props} />)
    fireEvent.click(screen.getByTitle('设置阅读背景'))
    fireEvent.click(screen.getByRole('button', { name: '下载雪山背景' }))
    expect(await screen.findByLabelText('下载进度 42%')).toBeTruthy()
    finish()
    await waitFor(() => expect(useSettingsStore.getState().appearance.fullscreenBackgroundScene).toBe('snow'))
    fireEvent.change(screen.getByRole('slider', { name: '图片可见度' }), { target: { value: '0' } })
    expect(document.documentElement.style.getPropertyValue('--gm-fullscreen-background-cover')).toBe('100%')
    fireEvent.click(screen.getByRole('button', { name: '停用背景' }))
    expect(useSettingsStore.getState().appearance.fullscreenBackgroundEnabled).toBe(false)
  })

  it('keeps the old image during a scene fade and fades out when disabled', async () => {
    listBackgrounds.mockResolvedValue({ downloadedOfficialIds: ['snow', 'sea'], localBackgrounds: [] })
    readBackground.mockResolvedValue([137, 80, 78, 71])
    let imageNumber = 0
    vi.stubGlobal('URL', class extends URL {
      static createObjectURL = vi.fn(() => `blob:scene-${++imageNumber}`)
      static revokeObjectURL = vi.fn()
    })
    render(<FullscreenControlBar {...props} />)
    useSettingsStore.getState().updateAppearanceSettings({ fullscreenBackgroundScene: 'snow', fullscreenBackgroundEnabled: true })
    const root = document.documentElement
    await waitFor(() => expect(root.style.getPropertyValue('--gm-fullscreen-background-visible')).toBe('100%'))
    expect(root.style.getPropertyValue('--gm-fullscreen-background-mix')).toBe('100%')
    expect(root.style.getPropertyValue('--gm-fullscreen-background-image-1')).toContain('blob:scene-1')

    useSettingsStore.getState().updateAppearanceSettings({ fullscreenBackgroundScene: 'sea' })
    expect(root.style.getPropertyValue('--gm-fullscreen-background-image-1')).toContain('blob:scene-1')
    await waitFor(() => expect(root.style.getPropertyValue('--gm-fullscreen-background-mix')).toBe('0%'))
    expect(root.style.getPropertyValue('--gm-fullscreen-background-visible')).toBe('100%')
    expect(root.style.getPropertyValue('--gm-fullscreen-background-image-0')).toContain('blob:scene-2')

    useSettingsStore.getState().updateAppearanceSettings({ fullscreenBackgroundEnabled: false })
    await waitFor(() => expect(root.style.getPropertyValue('--gm-fullscreen-background-visible')).toBe('0%'))
    expect(root.style.getPropertyValue('--gm-fullscreen-background-image-0')).toContain('blob:scene-2')
    await waitFor(() => expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:scene-1'))
  })
})
