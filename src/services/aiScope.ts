import { vectorStore } from '@/services/rag/vectorStore'
import type { ContextTag } from '@/types/contextTag'
import { normalizeFilePath } from '@/services/pathIdentity'

export interface AgentEditTarget {
  id: string
  type: 'selection' | 'file'
  title: string
  filePath: string
  selectionFrom?: number
  selectionTo?: number
}

interface AgentScopeContext {
  contextTags: ContextTag[]
  editTargets?: AgentEditTarget[]
}

let activeAgentScopeContext: AgentScopeContext | null = null

function isInsideFolder(filePath: string, folderPath: string): boolean {
  const file = normalizeFilePath(filePath)
  const folder = normalizeFilePath(folderPath)
  return file === folder || file.startsWith(`${folder}/`)
}

export function resolveScopeFilePaths(contextTags: ContextTag[]): string[] {
  const directPaths = contextTags
    .map((tag) => tag.filePath)
    .filter((path): path is string => Boolean(path))

  const folderPaths = contextTags
    .map((tag) => tag.folderPath)
    .filter((path): path is string => Boolean(path))

  const folderMatchedPaths = folderPaths.flatMap((folderPath) =>
    vectorStore
      .getAllDocuments()
      .filter((doc) => isInsideFolder(doc.filePath, folderPath))
      .map((doc) => doc.filePath)
  )

  return Array.from(new Set([...directPaths, ...folderMatchedPaths]))
}

export function setAgentScopeContext(context: AgentScopeContext | null): void {
  activeAgentScopeContext = context
}

export function getAgentScopeContext(): AgentScopeContext | null {
  return activeAgentScopeContext
}
