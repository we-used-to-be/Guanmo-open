import { useEffect, useRef } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { isTauri } from '@/hooks/useTauri'
import { isImagePath, isMarkdownPath, openExternalFilePaths, type ExternalFileOpenSource } from '@/services/externalFileOpen'
import { toast } from '@/services/toast'

const OPEN_FILES_EVENT = 'guanmo:open-files'
const DROP_IMAGES_EVENT = 'guanmo:drop-image-paths'

function getFileName(path: string): string {
  return path.split(/[/\\]/).pop() || path
}

export function useExternalFileOpen(appReady: boolean) {
  const drainingRef = useRef(false)
  const drainRequestedRef = useRef(false)

  useEffect(() => {
    if (!appReady || !isTauri()) return

    let disposed = false
    let unlistenOpenFiles: (() => void) | undefined
    let unlistenDragDrop: (() => void) | undefined

    const openPaths = async (paths: string[], source: ExternalFileOpenSource) => {
      const imagePaths = source === 'drag-drop' ? paths.filter(isImagePath) : []
      const openablePaths = source === 'drag-drop' ? paths.filter((path) => !isImagePath(path)) : paths

      if (imagePaths.length > 0) {
        window.dispatchEvent(new CustomEvent(DROP_IMAGES_EVENT, { detail: { paths: imagePaths } }))
      }

      const result = await openExternalFilePaths(openablePaths, source)
      if (result.ignored.some((path) => !isMarkdownPath(path))) {
        toast.warning('仅支持拖入 .md 文件')
      }
      for (const failure of result.failed) {
        toast.error(`打开「${getFileName(failure.path)}」失败: ${failure.reason}`)
      }
    }

    const drainPendingFiles = async () => {
      drainRequestedRef.current = true
      if (drainingRef.current) return
      drainingRef.current = true
      try {
        while (drainRequestedRef.current && !disposed) {
          drainRequestedRef.current = false
          const paths = await invoke<string[]>('take_pending_open_files')
          if (paths.length > 0) {
            await openPaths(paths, 'file-association')
          }
        }
      } catch (err) {
        console.error('[ExternalFileOpen] Failed to load pending files:', err)
      } finally {
        drainingRef.current = false
      }
    }

    const setup = async () => {
      unlistenOpenFiles = await listen(OPEN_FILES_EVENT, drainPendingFiles)
      if (disposed) {
        unlistenOpenFiles()
        return
      }
      unlistenDragDrop = await getCurrentWebviewWindow().onDragDropEvent((event) => {
        if (event.payload.type === 'drop') {
          void openPaths(event.payload.paths, 'drag-drop')
        }
      })
      if (disposed) {
        unlistenDragDrop()
        return
      }
      await drainPendingFiles()
    }

    void setup().catch((err) => {
      console.error('[ExternalFileOpen] Failed to initialize:', err)
    })

    return () => {
      disposed = true
      unlistenOpenFiles?.()
      unlistenDragDrop?.()
    }
  }, [appReady])
}
