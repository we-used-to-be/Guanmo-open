import { isTauri, readBinaryFile } from '@/hooks/useTauri'
import { readReadingBackground } from '@/services/fullscreenBackgrounds'
import { toast } from '@/services/toast'

const BACKGROUND_FADE_MS = 380
type BackgroundLayer = { key: string | null; url: string | null }
type BackgroundSelection = {
  enabled: boolean
  path: string | null
  scene: string
  opacity: number
}

const layers: [BackgroundLayer, BackgroundLayer] = [{ key: null, url: null }, { key: null, url: null }]
let activeLayer = 0
let revision = 0
let fadeTimer: number | null = null
let fadeDone: Promise<void> | null = null
let finishFade: (() => void) | null = null
let fadeOnCancel: (() => void) | null = null

export function waitForFullscreenVisualIdle(): Promise<void> {
  const root = document.documentElement
  if (!root.dataset.fullscreenTransitionPhase) return Promise.resolve()
  return new Promise((resolve) => {
    const observer = new MutationObserver(() => {
      if (root.dataset.fullscreenTransitionPhase) return
      observer.disconnect()
      resolve()
    })
    observer.observe(root, { attributes: true, attributeFilter: ['data-fullscreen-transition-phase'] })
  })
}

function stopFade(): void {
  if (fadeTimer !== null) window.clearTimeout(fadeTimer)
  fadeTimer = null
  fadeOnCancel?.()
  fadeOnCancel = null
  finishFade?.()
  finishFade = null
  fadeDone = null
}

function pauseFade(): void {
  if (fadeTimer !== null) window.clearTimeout(fadeTimer)
  fadeTimer = null
  fadeOnCancel = null
  finishFade?.()
  finishFade = null
  fadeDone = null
}

function clearBackground(): void {
  stopFade()
  const root = document.documentElement
  delete root.dataset.fullscreenBackgroundReady
  for (const index of [0, 1]) {
    if (layers[index].url) URL.revokeObjectURL(layers[index].url)
    layers[index] = { key: null, url: null }
    root.style.removeProperty(`--gm-fullscreen-background-image-${index}`)
  }
  root.style.removeProperty('--gm-fullscreen-background-mix')
  root.style.removeProperty('--gm-fullscreen-background-visible')
  root.style.removeProperty('--gm-fullscreen-background-cover')
  root.style.removeProperty('--gm-fullscreen-glass-cover')
  activeLayer = 0
}

function startFade(onComplete: () => void, onCancel: (() => void) | null = null): Promise<void> {
  stopFade()
  const done = new Promise<void>((resolve) => {
    finishFade = resolve
    fadeOnCancel = onCancel
    fadeTimer = window.setTimeout(() => {
      fadeTimer = null
      finishFade = null
      fadeDone = null
      fadeOnCancel = null
      onComplete()
      resolve()
    }, window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : BACKGROUND_FADE_MS)
  })
  fadeDone = done
  return done
}

function hasDecodedBackground(): boolean {
  return layers.some((layer) => layer.url !== null)
}

/**
 * Hides the current background while retaining the decoded layers.
 * Callers can release the layers after the fullscreen transition succeeds,
 * or restore them when the native transition fails/cancels.
 */
export async function fadeOutFullscreenBackground(): Promise<boolean> {
  const request = revision
  await waitForFullscreenVisualIdle()
  if (request !== revision) return false

  if (!hasDecodedBackground()) return true
  const root = document.documentElement
  root.style.setProperty('--gm-fullscreen-background-visible', '0%')
  await startFade(() => undefined)
  return request === revision
}

/** Restore a background that was hidden for a pending fullscreen exit. */
export function restoreFullscreenBackground(): void {
  ++revision
  stopFade()
  if (!hasDecodedBackground()) return
  document.documentElement.style.setProperty('--gm-fullscreen-background-visible', '100%')
}

export async function updateFullscreenBackground(selection: BackgroundSelection): Promise<void> {
  const request = ++revision
  await waitForFullscreenVisualIdle()
  if (request !== revision) return

  const root = document.documentElement
  if (!isTauri()) {
    clearBackground()
    return
  }
  root.style.setProperty('--gm-fullscreen-background-cover', `${100 - selection.opacity * 0.75}%`)
  root.style.setProperty('--gm-fullscreen-glass-cover', `${100 - selection.opacity * 0.3}%`)
  const key = selection.scene === 'custom' ? selection.path : selection.scene
  if (!selection.enabled || !key) {
    if (layers.every((layer) => layer.url === null)) {
      clearBackground()
      return
    }
    root.style.setProperty('--gm-fullscreen-background-visible', '0%')
    startFade(clearBackground)
    return
  }
  if (layers[activeLayer].key === key) {
    stopFade()
    const inactive = 1 - activeLayer
    if (layers[inactive].url) URL.revokeObjectURL(layers[inactive].url)
    layers[inactive] = { key: null, url: null }
    root.style.removeProperty(`--gm-fullscreen-background-image-${inactive}`)
    root.style.setProperty('--gm-fullscreen-background-visible', '100%')
    return
  }

  try {
    await import('@/styles/fullscreenBackground.css')
    if (request !== revision) return
    const id = selection.scene.startsWith('local:') ? selection.scene.slice(6) : selection.scene
    const bytes = selection.scene === 'custom' && selection.path
      ? await readBinaryFile(selection.path, { maxBytes: 20 * 1024 * 1024 })
      : new Uint8Array(await readReadingBackground(id))
    if (request !== revision) return
    if (bytes.byteLength > 20 * 1024 * 1024) throw new Error('图片超过 20 MB')
    const extension = selection.scene === 'custom' ? selection.path?.split('.').pop()?.toLowerCase()
      : bytes[0] === 0xff ? 'jpg' : bytes[0] === 0x47 ? 'gif' : bytes[0] === 0x52 ? 'webp' : bytes[0] === 0x42 ? 'bmp' : 'png'
    const mime = extension === 'jpg' ? 'image/jpeg' : `image/${extension}`
    const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: mime }))
    try {
      const image = new Image()
      image.src = url
      if (image.decode) await image.decode()
      if (fadeDone) await fadeDone
      if (request !== revision) return
      const previous = activeLayer
      const next = 1 - previous
      const initial = layers[previous].url === null
      if (layers[next].url) URL.revokeObjectURL(layers[next].url)
      layers[next] = { key, url }
      root.style.setProperty(`--gm-fullscreen-background-image-${next}`, `url("${url}")`)
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()))
      if (request !== revision) {
        if (layers[next].url === url) {
          layers[next] = { key: null, url: null }
          root.style.removeProperty(`--gm-fullscreen-background-image-${next}`)
        }
        return
      }
      root.style.setProperty('--gm-fullscreen-background-mix', next === 1 ? '100%' : '0%')
      root.style.setProperty('--gm-fullscreen-background-visible', '100%')
      activeLayer = next
      if (initial) {
        root.dataset.fullscreenBackgroundReady = 'true'
      } else {
        const clearPrevious = () => {
          if (layers[previous].url) URL.revokeObjectURL(layers[previous].url)
          layers[previous] = { key: null, url: null }
          root.style.removeProperty(`--gm-fullscreen-background-image-${previous}`)
        }
        startFade(clearPrevious, clearPrevious)
      }
    } finally {
      if (layers.every((layer) => layer.url !== url)) URL.revokeObjectURL(url)
    }
  } catch {
    if (request === revision) toast.error('背景图片无法读取，请重新选择')
  }
}

export async function releaseFullscreenBackground(): Promise<void> {
  const request = ++revision
  pauseFade()
  await waitForFullscreenVisualIdle()
  if (request === revision) clearBackground()
}
