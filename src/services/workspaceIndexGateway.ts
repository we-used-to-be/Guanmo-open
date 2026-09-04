import { fileExists, readFile } from '@/hooks/useTauri'
import { listDirectory } from '@/services/fileSystem'
import {
  listEmbeddingJobs,
  loadDocumentFilePaths,
  removeEmbeddingJobByPath,
  removePersistedDocumentByPathTransaction,
} from '@/services/database/persistence'
import { addKnowledgeDocument, isKnowledgeDocumentIndexed, type AddKnowledgeResult } from '@/services/rag/knowledgeBase'
import { indexWorkspaceMarkdown, isMarkdownPath, type WorkspaceIndexResult } from '@/services/rag/indexer'
import { removeNativeRagIndexDocument } from '@/services/rag/nativeIndex'
import { vectorStore } from '@/services/rag/vectorStore'

// SQLite 删除成功但 Native RAG 清理失败时，保留路径供后续 workspace 操作重试。
const pendingNativeCleanupPaths = new Set<string>()

export interface WorkspaceIndexGateway {
  getReadableWorkspacePaths(workspacePaths: string[]): Promise<{ readable: string[]; errors: string[] }>
  loadIndexedFilePaths(): Promise<string[]>
  fileExists(filePath: string): Promise<boolean>
  removeDocumentIndex(filePath: string): Promise<void>
  indexWorkspaceMarkdown(rootPath: string): Promise<WorkspaceIndexResult>
  isMarkdownPath(filePath: string): boolean
  isKnowledgeDocumentIndexed(filePath: string): Promise<boolean>
  addKnowledgeDocumentFromFile(params: { filePath: string; title: string }): Promise<AddKnowledgeResult>
}

async function getReadableWorkspacePaths(workspacePaths: string[]): Promise<{ readable: string[]; errors: string[] }> {
  const readable: string[] = []
  const errors: string[] = []
  for (const workspacePath of workspacePaths) {
    try {
      await listDirectory(workspacePath)
      readable.push(workspacePath)
    } catch (error) {
      errors.push(`${workspacePath}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return { readable, errors }
}

async function loadIndexedFilePaths(): Promise<string[]> {
  const [filePaths, jobs] = await Promise.all([
    loadDocumentFilePaths(),
    listEmbeddingJobs(),
  ])
  return Array.from(new Set([
    ...filePaths,
    ...jobs.map((job) => job.filePath),
    ...pendingNativeCleanupPaths,
  ]))
}

async function removeDocumentIndex(filePath: string): Promise<void> {
  if (pendingNativeCleanupPaths.has(filePath)) {
    await removeNativeRagIndexDocument(filePath)
    pendingNativeCleanupPaths.delete(filePath)
    return
  }

  const result = await removePersistedDocumentByPathTransaction(filePath)
  if (!result.deleted && result.embeddingJobsDeleted === 0) {
    // The Rust transaction only removes embedding_jobs when a document row exists.
    // Keep the legacy job-only cleanup path for interrupted indexing.
    await removeEmbeddingJobByPath(filePath)
  }
  vectorStore.removeByFilePathFromMemory(filePath)
  try {
    await removeNativeRagIndexDocument(filePath)
  } catch (error) {
    pendingNativeCleanupPaths.add(filePath)
    throw error
  }
}

async function addKnowledgeDocumentFromFile({ filePath, title }: { filePath: string; title: string }): Promise<AddKnowledgeResult> {
  const content = await readFile(filePath)
  return addKnowledgeDocument({ filePath, title, content })
}

export const workspaceIndexGateway: WorkspaceIndexGateway = {
  getReadableWorkspacePaths,
  loadIndexedFilePaths,
  fileExists,
  removeDocumentIndex,
  indexWorkspaceMarkdown,
  isMarkdownPath,
  isKnowledgeDocumentIndexed,
  addKnowledgeDocumentFromFile,
}
