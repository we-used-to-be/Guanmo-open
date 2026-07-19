import { dirnamePath, fileExists, joinPath, prepareMarkdownAssetsDir, readBinaryFile, writeBinaryFile } from '@/hooks/useTauri'

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'])

export function isImagePath(path: string): boolean {
  const ext = getExtension(path)
  return Boolean(ext && IMAGE_EXTENSIONS.has(ext))
}

export function isImageFile(file: File): boolean {
  return file.type.startsWith('image/') || isImagePath(file.name)
}

export async function saveExternalImageForMarkdown(markdownPath: string, imagePath: string): Promise<string> {
  const bytes = await readBinaryFile(imagePath)
  const ext = normalizeImageExtension(getExtension(imagePath) || 'png')
  return saveImageBytesForMarkdown(markdownPath, bytes, ext)
}

export async function saveImageFileForMarkdown(markdownPath: string, file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  const ext = normalizeImageExtension(getExtension(file.name) || extensionFromMime(file.type) || 'png')
  return saveImageBytesForMarkdown(markdownPath, bytes, ext)
}

async function saveImageBytesForMarkdown(markdownPath: string, bytes: Uint8Array, ext: string): Promise<string> {
  const markdownDir = await dirnamePath(markdownPath)
  const assetsDir = await joinPath(markdownDir, 'assets')
  await prepareMarkdownAssetsDir(markdownPath)

  const baseName = buildBaseName(markdownPath)
  const fileName = await nextAssetFileName(assetsDir, baseName, ext)
  const targetPath = await joinPath(assetsDir, fileName)
  await writeBinaryFile(targetPath, bytes)
  return `./assets/${fileName}`
}

async function nextAssetFileName(assetsDir: string, baseName: string, ext: string): Promise<string> {
  const stamp = new Date()
  const datePart = [
    stamp.getFullYear(),
    String(stamp.getMonth() + 1).padStart(2, '0'),
    String(stamp.getDate()).padStart(2, '0'),
  ].join('')
  const timePart = [
    String(stamp.getHours()).padStart(2, '0'),
    String(stamp.getMinutes()).padStart(2, '0'),
    String(stamp.getSeconds()).padStart(2, '0'),
  ].join('')

  for (let index = 1; index <= 999; index += 1) {
    const fileName = `${baseName}-${datePart}-${timePart}-${String(index).padStart(3, '0')}.${ext}`
    if (!(await fileExists(await joinPath(assetsDir, fileName)))) return fileName
  }

  return `${baseName}-${datePart}-${timePart}-${crypto.randomUUID().slice(0, 8)}.${ext}`
}

function buildBaseName(markdownPath: string): string {
  const name = markdownPath.split(/[/\\]/).pop() || 'image'
  const withoutExt = name.replace(/\.[^.]+$/, '')
  const safe = withoutExt
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-zA-Z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
  return safe || 'image'
}

function getExtension(path: string): string | null {
  const match = /\.([a-zA-Z0-9]+)$/.exec(path)
  return match ? normalizeImageExtension(match[1]) : null
}

function normalizeImageExtension(ext: string): string {
  const normalized = ext.toLowerCase()
  return normalized === 'jpeg' ? 'jpg' : normalized
}

function extensionFromMime(mime: string): string | null {
  if (mime === 'image/jpeg') return 'jpg'
  if (mime === 'image/png') return 'png'
  if (mime === 'image/gif') return 'gif'
  if (mime === 'image/webp') return 'webp'
  if (mime === 'image/bmp') return 'bmp'
  if (mime === 'image/svg+xml') return 'svg'
  return null
}
