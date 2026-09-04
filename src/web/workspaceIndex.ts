import { UnsupportedCapabilityError } from './externalHttp'
import type { WorkspaceIndexResult } from './ragIndexer'

export interface WorkspaceCleanupResult {
  removed: number
  removedPaths: string[]
  errors: string[]
}

export interface WorkspaceRebuildResult extends WorkspaceIndexResult {
  removed: number
  removedPaths: string[]
}

export function isWorkspaceMarkdownPath(_filePath: string): boolean { return false }
export async function isWorkspaceKnowledgeDocumentIndexed(_filePath: string): Promise<boolean> { return false }
export async function addWorkspaceKnowledgeDocument(): Promise<never> {
  throw new UnsupportedCapabilityError('知识库索引')
}
export async function indexWorkspaceDocuments(): Promise<never> {
  throw new UnsupportedCapabilityError('知识库索引')
}
export async function cleanupMissingWorkspaceDocuments(): Promise<WorkspaceCleanupResult> {
  throw new UnsupportedCapabilityError('知识库索引')
}
export async function rebuildWorkspaceDocuments(): Promise<WorkspaceRebuildResult> {
  throw new UnsupportedCapabilityError('知识库索引')
}
