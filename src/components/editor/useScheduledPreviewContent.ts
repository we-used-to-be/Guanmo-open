import { useLayoutEffect, useRef, useState } from 'react'

const PREVIEW_UPDATE_DELAY = 300
const LARGE_PREVIEW_UPDATE_DELAY = 650
const HUGE_PREVIEW_UPDATE_DELAY = 900

interface ScheduledPreviewContent {
  content: string
  version: number
  pending: boolean
}

function getPreviewUpdateDelay(content: string) {
  if (content.length >= 80000) return HUGE_PREVIEW_UPDATE_DELAY
  if (content.length >= 30000) return LARGE_PREVIEW_UPDATE_DELAY
  return PREVIEW_UPDATE_DELAY
}

/**
 * Keep the currently rendered preview stable while document edits settle.
 * A document switch or a newly enabled pane is visible immediately; only
 * content changes within the same document use the size-aware debounce.
 */
export function useScheduledPreviewContent(
  content: string,
  documentKey: string | null | undefined,
  enabled = true,
) {
  const [preview, setPreview] = useState<ScheduledPreviewContent>({
    content,
    version: 0,
    pending: false,
  })
  const previousKeyRef = useRef(documentKey)
  const previousEnabledRef = useRef(enabled)
  const versionRef = useRef(0)
  const switchedDocument = previousKeyRef.current !== documentKey
  const becameEnabled = enabled && !previousEnabledRef.current
  let visiblePreview = preview

  if (switchedDocument || becameEnabled) {
    previousKeyRef.current = documentKey
    previousEnabledRef.current = enabled
    versionRef.current += 1
    visiblePreview = { content, version: versionRef.current, pending: false }
  }

  useLayoutEffect(() => {
    previousEnabledRef.current = enabled
    if (!enabled) {
      if (preview.content) {
        versionRef.current += 1
        setPreview({ content: '', version: versionRef.current, pending: false })
      }
      return
    }
    if (switchedDocument || becameEnabled) {
      setPreview({ content, version: versionRef.current, pending: false })
      return
    }

    if (preview.content === content) {
      return
    }

    const version = versionRef.current + 1
    const timer = setTimeout(() => {
      versionRef.current = version
      setPreview({ content, version, pending: false })
    }, getPreviewUpdateDelay(content))

    return () => clearTimeout(timer)
  }, [becameEnabled, content, documentKey, enabled, preview.content, switchedDocument])

  return enabled
    ? { ...visiblePreview, pending: visiblePreview.content !== content }
    : visiblePreview
}
