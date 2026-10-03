import { importReadingBackgroundFile, readBinaryFile, type BackgroundLibraryRecord, type LocalBackgroundRecord } from '@/hooks/useTauri'
export { deleteReadingBackground, downloadReadingBackground, listReadingBackgrounds, readReadingBackground } from '@/hooks/useTauri'
import snowThumbnail from '@/assets/reading-backgrounds/snow.webp'
import seaThumbnail from '@/assets/reading-backgrounds/sea.webp'
import starsThumbnail from '@/assets/reading-backgrounds/stars.webp'

export interface BackgroundItem {
  id: string
  label: string
  kind: 'official' | 'local'
  thumbnail: string
  downloaded: boolean
  extension: string
}

export type LocalBackground = LocalBackgroundRecord
export type BackgroundLibrary = BackgroundLibraryRecord

export const OFFICIAL_BACKGROUNDS: BackgroundItem[] = [
  { id: 'snow', label: '码间絮语', kind: 'official', thumbnail: snowThumbnail, downloaded: false, extension: 'png' },
  { id: 'sea', label: '晨雾花语', kind: 'official', thumbnail: seaThumbnail, downloaded: false, extension: 'png' },
  { id: 'stars', label: '静谧星河', kind: 'official', thumbnail: starsThumbnail, downloaded: false, extension: 'png' },
]

async function createThumbnail(bytes: Uint8Array, extension: string): Promise<number[]> {
  const mime = extension === 'jpg' ? 'image/jpeg' : `image/${extension}`
  const sourceUrl = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: mime }))
  try {
    const image = new Image()
    image.src = sourceUrl
    await image.decode()
    const canvas = document.createElement('canvas')
    canvas.width = 360
    canvas.height = 202
    const context = canvas.getContext('2d')
    if (!context) throw new Error('无法生成缩略图')
    const scale = Math.max(canvas.width / image.naturalWidth, canvas.height / image.naturalHeight)
    const width = image.naturalWidth * scale
    const height = image.naturalHeight * scale
    context.drawImage(image, (canvas.width - width) / 2, (canvas.height - height) / 2, width, height)
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.7))
    if (!blob) throw new Error('无法生成缩略图')
    return Array.from(new Uint8Array(await blob.arrayBuffer()))
  } finally {
    URL.revokeObjectURL(sourceUrl)
  }
}

export async function importReadingBackground(path: string): Promise<LocalBackground> {
  const extension = path.split('.').pop()?.toLowerCase() ?? ''
  const bytes = await readBinaryFile(path, { maxBytes: 20 * 1024 * 1024 })
  if (bytes.byteLength > 20 * 1024 * 1024) throw new Error('图片不能超过 20 MB')
  const thumbnail = await createThumbnail(bytes, extension)
  return importReadingBackgroundFile(path, crypto.randomUUID(), thumbnail)
}
