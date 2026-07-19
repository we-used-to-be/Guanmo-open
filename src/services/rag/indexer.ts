import { readFile, joinPath } from '@/hooks/useTauri'
import { listDirectory } from '@/services/fileSystem'
import { shouldSkipWorkspaceDirectory } from '@/services/fileTree'
import { ingestDocument, processEmbeddingQueue, runSerializedDocumentOperation } from './pipeline'
import { vectorStore } from './vectorStore'
import { isEmbeddingReady } from '@/services/ai/aiClient'

const MARKDOWN_EXTENSIONS = new Set(['md', 'markdown', 'mdx'])
const DEFAULT_INDEX_DELAY = 1200
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
  performMarkdownDocumentIndex(filePath, title, content).catch((err) =>
    console.warn('[RAG] document index failed, previous index preserved:', err)
  )
  return true
}

async function performMarkdownDocumentIndex(
  filePath: string,
  title: string,
  content: string,
): Promise<boolean> {
  const indexed = await runSerializedDocumentOperation(filePath, async () => {
    const result = await ingestDocument(filePath, title || getName(filePath), content)
    if (!result) return false
    const { document, stats, unchanged } = result
    if (!unchanged) {
      const needsEmbedding = document.chunks.some((chunk) => !chunk.embedding)
      await vectorStore.replaceDocument(document, needsEmbedding)
    }
    console.info(
      `[RAG] index ${filePath}: total=${stats.total}, reused=${stats.reused}, added=${stats.added}, deleted=${stats.deleted}, reembedded=${stats.reembedded}`
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

  const existingTimer = pendingIndexTimers.get(filePath)
  if (existingTimer) {
    clearTimeout(existingTimer)
  }

  const timer = setTimeout(() => {
    pendingIndexTimers.delete(filePath)
    indexMarkdownDocument(filePath, title, content)
  }, Math.max(0, delay))

  pendingIndexTimers.set(filePath, timer)
  return true
}

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
