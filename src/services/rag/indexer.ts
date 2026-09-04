import { readFile, joinPath } from '@/hooks/useTauri'
import { listDirectory } from '@/services/fileSystem'
import { shouldSkipWorkspaceDirectory } from '@/services/fileTree'
import { ingestDocument, processEmbeddingQueue, runSerializedDocumentOperation } from './pipeline'
import { vectorStore } from './vectorStore'
import { isEmbeddingReady } from '@/services/ai/aiClient'
import { refreshNativeRagIndexDocument } from './nativeIndex'
import { useSettingsStore } from '@/stores/settingsStore'

const MARKDOWN_EXTENSIONS = new Set(['md', 'markdown', 'mdx'])
const DEFAULT_INDEX_DELAY = 1200
const AUTO_INDEX_MAX_CONTENT_LENGTH = 100_000
const pendingIndexTimers = new Map<string, ReturnType<typeof setTimeout>>()

export interface WorkspaceIndexResult {
  indexed: number
  skipped: number
  failed: number
  errors: string[]
}

function getName(path: string): string {
  return path.split(/[/\\]/).pop() || path
}

function getExtension(path: string): string {
  const name = getName(path)
  const idx = name.lastIndexOf('.')
  return idx > 0 ? name.slice(idx + 1).toLowerCase() : ''
}

export function isMarkdownPath(path: string): boolean {
  return MARKDOWN_EXTENSIONS.has(getExtension(path))
}

export function indexMarkdownDocument(
  filePath: string | null | undefined,
  title: string,
  content: string
): boolean {
  if (!filePath || !isMarkdownPath(filePath)) return false
  performMarkdownDocumentIndex(filePath, title, content).catch((err) => {
    console.warn('[RAG] document index failed, previous index preserved', {
      errorType: err instanceof Error ? err.name : typeof err,
    })
  })
  return true
}

/**
 * 显式等待索引完成，返回真实成功/失败结果。
 * 复用现有 performMarkdownDocumentIndex，不复制分块或持久化逻辑。
 * 失败时向调用方抛出，不只写 console.warn。
 */
export async function indexMarkdownDocumentAsync(
  filePath: string,
  title: string,
  content: string
): Promise<boolean> {
  if (!filePath || !isMarkdownPath(filePath)) return false
  return performMarkdownDocumentIndex(filePath, title, content)
}

async function performMarkdownDocumentIndex(
  filePath: string,
  title: string,
  content: string,
): Promise<boolean> {
  const indexed = await runSerializedDocumentOperation(filePath, async () => {
    const result = await ingestDocument(filePath, title || getName(filePath), content)
    if (!result) return false
    const { stats, unchanged } = result
    if (!unchanged) {
      const { document } = result
      const needsEmbedding = document.chunks.some((chunk) => !chunk.embedding)
      await vectorStore.replaceDocument(document, needsEmbedding)
      await refreshNativeRagIndexDocument(document.filePath)
    }
    console.info(
      `[RAG] index complete: total=${stats.total}, reused=${stats.reused}, added=${stats.added}, deleted=${stats.deleted}, reembedded=${stats.reembedded}`
    )
    return true
  })
  if (indexed && isEmbeddingReady()) {
    processEmbeddingQueue().catch((err) => console.warn('[RAG] background embedding failed:', err))
  }
  return indexed
}

export function scheduleMarkdownDocumentIndex(
  filePath: string | null | undefined,
  title: string,
  content: string,
  delay = DEFAULT_INDEX_DELAY
): boolean {
  if (!filePath || !isMarkdownPath(filePath)) return false

  // 自动索引仍在 WebView 主线程同步解析 Markdown。超长文档打开/保存后若继续调度，
  // 会在延迟到期时造成数秒无响应；显式知识库索引走 Async API，不受此保护影响。
  if (content.length >= AUTO_INDEX_MAX_CONTENT_LENGTH) {
    const existingTimer = pendingIndexTimers.get(filePath)
    if (existingTimer) {
      clearTimeout(existingTimer)
      pendingIndexTimers.delete(filePath)
    }
    return false
  }

  const settings = useSettingsStore.getState()
  if (!settings.knowledge.autoIndexEnabled) return false

  const existingTimer = pendingIndexTimers.get(filePath)
  if (existingTimer) {
    clearTimeout(existingTimer)
  }

  const timer = setTimeout(() => {
    pendingIndexTimers.delete(filePath)
    if (!useSettingsStore.getState().knowledge.autoIndexEnabled) return
    indexMarkdownDocument(filePath, title, content)
  }, Math.max(0, delay))

  pendingIndexTimers.set(filePath, timer)
  return true
}

/**
 * 取消指定路径的待执行索引定时器，支持单路径和多路径。
 * 清除 pendingIndexTimers 中对应 timer 并删除 Map 条目。
 */
export function cancelPendingIndexTimers(filePaths: string | string[]): void {
  const paths = Array.isArray(filePaths) ? filePaths : [filePaths]
  for (const filePath of paths) {
    const timer = pendingIndexTimers.get(filePath)
    if (timer) {
      clearTimeout(timer)
      pendingIndexTimers.delete(filePath)
    }
  }
}

/**
 * 获取所有待执行索引定时器的路径。
 */
export function getPendingIndexTimerPaths(): string[] {
  return [...pendingIndexTimers.keys()]
}

useSettingsStore.subscribe((state, previousState) => {
  if (previousState.knowledge.autoIndexEnabled && !state.knowledge.autoIndexEnabled) {
    cancelPendingIndexTimers(getPendingIndexTimerPaths())
  }
})

export async function indexWorkspaceMarkdown(
  rootPath: string,
  maxFiles = 200,
  maxScannedEntries = 2000
): Promise<WorkspaceIndexResult> {
  const result: WorkspaceIndexResult = {
    indexed: 0,
    skipped: 0,
    failed: 0,
    errors: [],
  }
  let scannedEntries = 0

  async function visit(dirPath: string): Promise<void> {
    if (result.indexed >= maxFiles || scannedEntries >= maxScannedEntries) return

    let entries
    try {
      entries = await listDirectory(dirPath)
    } catch (err) {
      result.failed++
      result.errors.push(`${dirPath}: ${err instanceof Error ? err.message : String(err)}`)
      return
    }

    for (const entry of entries) {
      if (result.indexed >= maxFiles || scannedEntries >= maxScannedEntries) return
      scannedEntries++
      const fullPath = await joinPath(dirPath, entry.name)

      if (entry.isDirectory) {
        if (shouldSkipWorkspaceDirectory(entry.name)) {
          result.skipped++
          continue
        }
        await visit(fullPath)
        continue
      }

      if (!entry.isFile || !isMarkdownPath(entry.name)) {
        result.skipped++
        continue
      }

      try {
        const content = await readFile(fullPath)
        if (await performMarkdownDocumentIndex(fullPath, entry.name, content)) {
          result.indexed++
        } else {
          result.skipped++
        }
      } catch (err) {
        result.failed++
        result.errors.push(`${fullPath}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }

  await visit(rootPath)
  await vectorStore.flushPersistence()
  return result
}
