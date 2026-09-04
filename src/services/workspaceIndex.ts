import { normalizeFilePath } from '@/services/pathIdentity'
import { normalizeWorkspacePath } from '@/services/workspaceIdentity'
import { workspaceIndexGateway } from '@/services/workspaceIndexGateway'
import type { WorkspaceIndexResult } from '@/services/rag/indexer'

export interface WorkspaceCleanupResult {
  removed: number
  removedPaths: string[]
  errors: string[]
}

export interface WorkspaceRebuildResult extends WorkspaceIndexResult {
  removed: number
  removedPaths: string[]
}

export async function indexWorkspaceDocuments(rootPath: string): Promise<WorkspaceIndexResult> {
  return workspaceIndexGateway.indexWorkspaceMarkdown(rootPath)
}

export function isWorkspaceMarkdownPath(filePath: string): boolean {
  return workspaceIndexGateway.isMarkdownPath(filePath)
}

export async function isWorkspaceKnowledgeDocumentIndexed(filePath: string): Promise<boolean> {
  return workspaceIndexGateway.isKnowledgeDocumentIndexed(filePath)
}

export async function addWorkspaceKnowledgeDocument(
  params: Parameters<typeof workspaceIndexGateway.addKnowledgeDocumentFromFile>[0],
) {
  return workspaceIndexGateway.addKnowledgeDocumentFromFile(params)
}

function isInsideWorkspace(filePath: string, workspacePath: string) {
  const file = normalizeFilePath(filePath)
  const workspace = normalizeWorkspacePath(workspacePath)
  return file === workspace || file.startsWith(`${workspace}/`)
}

function toWorkspacePaths(workspacePaths: string | string[]): string[] {
  const paths = Array.isArray(workspacePaths) ? workspacePaths : [workspacePaths]
  const seen = new Set<string>()
  return paths.filter((path) => {
    const identity = normalizeWorkspacePath(path)
    if (!identity || seen.has(identity)) return false
    seen.add(identity)
    return true
  })
}

export async function cleanupMissingWorkspaceDocuments(workspacePaths: string | string[]): Promise<WorkspaceCleanupResult> {
  const { readable, errors } = await workspaceIndexGateway.getReadableWorkspacePaths(toWorkspacePaths(workspacePaths))
  const paths = await workspaceIndexGateway.loadIndexedFilePaths()
  const removedPaths: string[] = []

  for (const filePath of paths) {
    if (!readable.some((workspacePath) => isInsideWorkspace(filePath, workspacePath))) continue
    try {
      if (await workspaceIndexGateway.fileExists(filePath)) continue
      await workspaceIndexGateway.removeDocumentIndex(filePath)
      removedPaths.push(filePath)
    } catch (error) {
      errors.push(`${filePath}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  return {
    removed: removedPaths.length,
    removedPaths,
    errors,
  }
}

export async function rebuildWorkspaceDocuments(workspacePaths: string | string[]): Promise<WorkspaceRebuildResult> {
  const { readable, errors } = await workspaceIndexGateway.getReadableWorkspacePaths(toWorkspacePaths(workspacePaths))
  const documentPaths = await workspaceIndexGateway.loadIndexedFilePaths()
  const removedPaths: string[] = []
  const result: WorkspaceIndexResult = { indexed: 0, skipped: 0, failed: errors.length, errors: [...errors] }

  for (const filePath of documentPaths) {
    if (!readable.some((workspacePath) => isInsideWorkspace(filePath, workspacePath))) continue
    try {
      await workspaceIndexGateway.removeDocumentIndex(filePath)
      removedPaths.push(filePath)
    } catch (error) {
      result.failed++
      result.errors.push(`${filePath}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  for (const workspacePath of readable) {
    const indexed = await workspaceIndexGateway.indexWorkspaceMarkdown(workspacePath)
    result.indexed += indexed.indexed
    result.skipped += indexed.skipped
    result.failed += indexed.failed
    result.errors.push(...indexed.errors)
  }
  return {
    ...result,
    removed: removedPaths.length,
    removedPaths,
  }
}
