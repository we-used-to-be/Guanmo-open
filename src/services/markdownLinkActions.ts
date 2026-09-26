import { convertFileSrc } from '@tauri-apps/api/core'
import { prepareMarkdownImage, requestSelectedPathAccess } from '@/hooks/useTauri'
import { readRememberedMarkdownFileForOpen } from '@/services/markdownFileOpenPolicy'
import { createMarkdownPreviewModel, findAnchorTarget } from '@/services/markdownPreviewModel'
import { isSameFilePath, normalizeFilePath } from '@/services/pathIdentity'
import { resolveMarkdownLink } from '@/services/markdownLinks'
import { scheduleMarkdownDocumentIndex } from '@/services/rag/indexer'
import { useEditorStore } from '@/stores/editorStore'

const pendingReads = new Map<string, Promise<string>>()

async function openMarkdown(path: string, fragment: string): Promise<void> {
  let state = useEditorStore.getState()
  let tab = state.tabs.find((item) => isSameFilePath(item.filePath, path))
  if (!tab) {
    const key = normalizeFilePath(path)
    let read = pendingReads.get(key)
    if (!read) {
      read = readRememberedMarkdownFileForOpen(path).finally(() => { pendingReads.delete(key) })
      pendingReads.set(key, read)
    }
    const content = await read
    // Recheck after I/O: another click may have opened/edited the target already.
    state = useEditorStore.getState()
    tab = state.tabs.find((item) => isSameFilePath(item.filePath, path))
    if (!tab) {
      const name = path.split('/').pop() || 'untitled.md'
      state.addTab(path, name, content)
      scheduleMarkdownDocumentIndex(path, name, content)
      tab = useEditorStore.getState().tabs.find((item) => isSameFilePath(item.filePath, path))
    }
  }
  if (!tab) throw new Error('无法打开目标文档')
  state.setActiveTab(tab.id)
  if (fragment) {
    const target = findAnchorTarget(createMarkdownPreviewModel(tab.content), fragment)
    if (!target) throw new Error('文档已打开，但未找到链接指定的标题')
    state.requestReveal(tab.id, target.line, undefined, 'preview')
  }
}

export async function followMarkdownLink(
  href: string | undefined,
  sourcePath: string | null | undefined,
  label: string,
  showImage: (image: { src: string; alt: string }) => void,
): Promise<void> {
  const target = resolveMarkdownLink(href, sourcePath)
  if (target.kind === 'anchor') return // Existing in-document navigation handles this.
  if (target.kind === 'web') {
    const { open } = await import('@tauri-apps/plugin-shell')
    await open(target.url)
    return
  }
  if (target.kind === 'markdown') {
    await openMarkdown(target.path, target.fragment)
    return
  }
  if (target.kind === 'image') {
    if (!sourcePath) throw new Error('请先保存当前文档，再预览本地图片链接')
    let canonical: string
    try {
      canonical = await prepareMarkdownImage(sourcePath, target.path)
    } catch (error) {
      if (!String(error).includes('outside the Markdown directory')) throw error
      const granted = await requestSelectedPathAccess(target.path, [
        { name: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'] },
      ])
      if (!granted) return
      canonical = await prepareMarkdownImage(sourcePath, target.path)
    }
    showImage({ src: convertFileSrc(canonical), alt: label })
    return
  }
  throw new Error('暂不支持直接打开此文件类型，请通过文件管理器打开')
}
