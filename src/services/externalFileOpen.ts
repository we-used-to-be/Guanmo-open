import { readFile } from '@/hooks/useTauri'
import { describeFileOperationError } from '@/services/fileOperationErrors'
import { isSameFilePath } from '@/services/pathIdentity'
import { scheduleMarkdownDocumentIndex } from '@/services/rag/indexer'
import { useEditorStore } from '@/stores/editorStore'

export type ExternalFileOpenSource = 'startup' | 'file-association' | 'drag-drop'

export interface ExternalFileOpenResult {
  opened: string[]
  ignored: string[]
  failed: Array<{ path: string; reason: string }>
}

export function isMarkdownPath(path: string): boolean {
  return /\.(md|markdown|mdx)$/i.test(path)
}

export function isImagePath(path: string): boolean {
  return /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(path)
}

function getFileName(path: string): string {
  return path.split(/[/\\]/).pop() || 'untitled.md'
}

function logDuration(label: string, startedAt: number) {
  console.info(`[Perf] ${label}: ${Math.round(performance.now() - startedAt)}ms`)
}

export async function openExternalFilePaths(
  paths: string[],
  _source: ExternalFileOpenSource
): Promise<ExternalFileOpenResult> {
  const result: ExternalFileOpenResult = {
    opened: [],
    ignored: [],
    failed: [],
  }

  for (const path of paths) {
    if (!isMarkdownPath(path)) {
      result.ignored.push(path)
      continue
    }

    try {
      const startedAt = performance.now()
      const editorState = useEditorStore.getState()
      const existing = editorState.tabs.find((tab) => isSameFilePath(tab.filePath, path))
      if (existing) {
        editorState.setActiveTab(existing.id)
        result.opened.push(path)
        logDuration(`activate existing file ${getFileName(path)}`, startedAt)
        continue
      }

      const content = await readFile(path)
      const name = getFileName(path)
      useEditorStore.getState().addTab(path, name, content)
      scheduleMarkdownDocumentIndex(path, name, content)
      result.opened.push(path)
      logDuration(`read and open file ${name}`, startedAt)
    } catch (err) {
      result.failed.push({
        path,
        reason: describeFileOperationError(err, '打开文件失败'),
      })
    }
  }

  return result
}
