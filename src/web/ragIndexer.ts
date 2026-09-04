import { UnsupportedCapabilityError } from './externalHttp'

export interface WorkspaceIndexResult {
  indexed: number
  skipped: number
  failed: number
  errors: string[]
}

export function isMarkdownPath(path: string): boolean {
  return /\.md$/i.test(path)
}

export function scheduleMarkdownDocumentIndex(_filePath: string, _content: string): void {
  // Web 会话不建立知识库索引。
}

export function cancelPendingIndexTimers(_filePaths: string | string[]): void {}
export function getPendingIndexTimerPaths(): string[] { return [] }

export function indexMarkdownDocument(): never {
  throw new UnsupportedCapabilityError('知识库索引')
}

export async function indexMarkdownDocumentAsync(): Promise<never> {
  throw new UnsupportedCapabilityError('知识库索引')
}

export async function indexWorkspaceMarkdown(): Promise<WorkspaceIndexResult> {
  throw new UnsupportedCapabilityError('知识库索引')
}
