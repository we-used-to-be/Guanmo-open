import { useEffect, useState } from 'react'
import { convertFileSrc } from '@tauri-apps/api/core'
import { isTauri, prepareMarkdownImage, requestSelectedPathAccess } from '@/hooks/useTauri'
import { decodePreviewImagePath } from '@/services/markdownImagePaths'

interface MarkdownImageProps {
  src?: string
  alt?: string
  title?: string
  width?: string | number
  height?: string | number
  filePath?: string | null
  line?: number
  onZoom: (image: { src: string; alt: string }) => void
}

function localImagePath(src: string, filePath?: string | null): string | null {
  if (!src || /^(https?:|data:|blob:|asset:|file:)/i.test(src) || src.startsWith('#')) return null
  if (!filePath || !isTauri()) return null
  const normalized = decodePreviewImagePath(src).replace(/\\/g, '/')
  if (/^[a-zA-Z]:\//.test(normalized) || normalized.startsWith('/')) return normalized
  const documentPath = filePath.replace(/\\/g, '/')
  const directory = documentPath.slice(0, documentPath.lastIndexOf('/'))
  return `${directory}/${normalized.replace(/^\.\//, '')}`
}

export function MarkdownImage({ src = '', alt = '', title, width, height, filePath, line, onZoom }: MarkdownImageProps) {
  const imagePath = localImagePath(src, filePath)
  const [prepared, setPrepared] = useState<{ filePath: string; imagePath: string; src?: string; error?: string } | null>(null)
  const [requesting, setRequesting] = useState<string | null>(null)

  useEffect(() => {
    if (!imagePath || !filePath) return
    let cancelled = false
    // Authorize this exact image before the browser starts an asset request. Opening
    // a standalone Markdown file does not authorize its sibling images by itself.
    void prepareMarkdownImage(filePath, imagePath).then((canonicalPath) => {
      if (!cancelled) setPrepared({ filePath, imagePath, src: convertFileSrc(canonicalPath) })
    }).catch(() => {
      if (!cancelled) setPrepared({ filePath, imagePath })
    })
    return () => { cancelled = true }
  }, [filePath, imagePath])

  const current = prepared && prepared.filePath === filePath && prepared.imagePath === imagePath ? prepared : null
  const resolvedSrc = imagePath ? current?.src : src
  const failed = Boolean(imagePath && current && !current.src)
  const requestKey = `${filePath}\0${imagePath}`
  const busy = requesting === requestKey

  async function authorizeImage() {
    if (!imagePath || !filePath || busy) return
    setRequesting(requestKey)
    try {
      // Native selection explicitly grants this file, without importing/copying
      // it into assets. The existing helper rejects selection of another file.
      const granted = await requestSelectedPathAccess(imagePath, [
        { name: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'] },
      ])
      if (!granted) return
      const canonicalPath = await prepareMarkdownImage(filePath, imagePath)
      const authorizedSrc = convertFileSrc(canonicalPath)
      setPrepared((previous) => previous?.filePath === filePath && previous.imagePath === imagePath
        ? { filePath, imagePath, src: authorizedSrc }
        : previous)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setPrepared((previous) => previous?.filePath === filePath && previous.imagePath === imagePath
        ? { ...previous, error: message }
        : previous)
    } finally {
      setRequesting((previous) => previous === requestKey ? null : previous)
    }
  }

  return (
    <button
      type="button"
      className="gm-markdown-image my-4 block max-w-full cursor-zoom-in rounded-xl border border-gm-border bg-transparent p-0 text-left"
      onClick={() => { if (failed) void authorizeImage(); else if (resolvedSrc) onZoom({ src: resolvedSrc, alt }) }}
      disabled={busy}
      title={failed ? (current?.error || '无法加载图片：请检查路径，点击选择原图片并授权') : '点击放大图片'}
      data-md-line={line}
    >
      <img
        src={resolvedSrc || undefined}
        alt={alt}
        title={title}
        width={width}
        height={height}
        referrerPolicy="no-referrer"
        loading="lazy"
        decoding="async"
        className="max-w-full rounded-xl"
      />
      {failed && (
        <span className="block px-3 py-2 text-sm text-gm-text-secondary">
          {busy ? '正在等待图片授权…' : '无法加载图片，点击选择原图片并授权'}
        </span>
      )}
    </button>
  )
}
