import { isSameFilePath } from '@/services/pathIdentity'
import { readRememberedMarkdownFileForOpen } from '@/services/markdownFileOpenPolicy'
import { describeFileOperationError } from '@/services/fileOperationErrors'
import { toast } from '@/services/toast'
import { useEditorStore } from '@/stores/editorStore'
import { createMarkdownPreviewModel } from '@/services/markdownPreviewModel'
import { getReadingMarkById, resolveReadingMarkAnchor } from '@/services/readingMarks'

function getLineForOffset(content: string, offset: number): number {
  const limit = Math.max(0, Math.min(offset, content.length))
  let line = 1
  for (let index = 0; index < limit; index += 1) {
    const code = content.charCodeAt(index)
    if (code === 10) line += 1
    else if (code === 13) {
      line += 1
      if (content.charCodeAt(index + 1) === 10) index += 1
    }
  }
  return line
}

/** 打开来源文档并把定位请求交给真实可见的预览实例。 */
export async function navigateToReadingMark(markId: string): Promise<boolean> {
  const mark = await getReadingMarkById(markId)
  if (!mark.documentPath) throw new Error('批注没有来源文件')
  const editor = useEditorStore.getState()
  const existing = editor.tabs.find((tab) => isSameFilePath(tab.filePath, mark.documentPath))
  let tabId = existing?.id
  let content = existing?.content ?? ''
  if (!tabId) {
    content = await readRememberedMarkdownFileForOpen(mark.documentPath)
    const name = mark.documentPath.split(/[/\\]/).pop() || mark.documentPath
    editor.addTab(mark.documentPath, name, content)
    tabId = useEditorStore.getState().activeTabId || undefined
  } else {
    editor.setActiveTab(tabId)
  }
  if (!tabId) return false
  const model = createMarkdownPreviewModel(content)
  const resolved = resolveReadingMarkAnchor(model, mark) ?? {
    from: mark.anchor.startOffset,
    to: mark.anchor.endOffset,
  }
  const startLine = getLineForOffset(content, resolved.from)
  const endLine = getLineForOffset(content, Math.max(resolved.from, resolved.to - 1))
  editor.setViewMode('preview')
  editor.requestReveal(tabId, startLine, endLine, 'preview')
  return true
}
export async function tryNavigateToReadingMark(markId: string): Promise<boolean> {
  try {
    return await navigateToReadingMark(markId)
  } catch (error) {
    toast.error(describeFileOperationError(error, '定位批注失败'))
    return false
  }
}
