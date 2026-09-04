import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  fileExists: vi.fn(),
  readFile: vi.fn(),
  listDirectory: vi.fn(),
  listEmbeddingJobs: vi.fn(),
  loadDocumentFilePaths: vi.fn(),
  removeEmbeddingJobByPath: vi.fn(),
  removePersistedDocumentByPathTransaction: vi.fn(),
  indexWorkspaceMarkdown: vi.fn(),
  isMarkdownPath: vi.fn(),
  isKnowledgeDocumentIndexed: vi.fn(),
  addKnowledgeDocument: vi.fn(),
  vectorRemove: vi.fn(),
  removeNative: vi.fn(),
}))

vi.mock('@/hooks/useTauri', () => ({ fileExists: mocks.fileExists, readFile: mocks.readFile }))
vi.mock('@/services/fileSystem', () => ({ listDirectory: mocks.listDirectory }))
vi.mock('@/services/database/persistence', () => ({
  listEmbeddingJobs: mocks.listEmbeddingJobs,
  loadDocumentFilePaths: mocks.loadDocumentFilePaths,
  removeEmbeddingJobByPath: mocks.removeEmbeddingJobByPath,
  removePersistedDocumentByPathTransaction: mocks.removePersistedDocumentByPathTransaction,
}))
vi.mock('@/services/rag/knowledgeBase', () => ({
  addKnowledgeDocument: mocks.addKnowledgeDocument,
  isKnowledgeDocumentIndexed: mocks.isKnowledgeDocumentIndexed,
}))
vi.mock('@/services/rag/indexer', () => ({
  indexWorkspaceMarkdown: mocks.indexWorkspaceMarkdown,
  isMarkdownPath: mocks.isMarkdownPath,
}))
vi.mock('@/services/rag/vectorStore', () => ({ vectorStore: { removeByFilePathFromMemory: mocks.vectorRemove } }))
vi.mock('@/services/rag/nativeIndex', () => ({ removeNativeRagIndexDocument: mocks.removeNative }))

import {
  addWorkspaceKnowledgeDocument,
  cleanupMissingWorkspaceDocuments,
  indexWorkspaceDocuments,
  isWorkspaceKnowledgeDocumentIndexed,
  isWorkspaceMarkdownPath,
  rebuildWorkspaceDocuments,
} from '@/services/workspaceIndex'

describe('multi-root workspace index maintenance', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.listEmbeddingJobs.mockResolvedValue([])
    mocks.listDirectory.mockResolvedValue([])
    mocks.fileExists.mockResolvedValue(false)
    mocks.readFile.mockResolvedValue('# Anonymous note')
    mocks.isMarkdownPath.mockReturnValue(true)
    mocks.isKnowledgeDocumentIndexed.mockResolvedValue(false)
    mocks.addKnowledgeDocument.mockResolvedValue({ filePath: 'D:/Notes/a.md', success: true })
    mocks.removePersistedDocumentByPathTransaction.mockResolvedValue({
      deleted: true,
      documentId: 'doc-1',
      chunksDeleted: 1,
      embeddingJobsDeleted: 1,
    })
    mocks.removeNative.mockResolvedValue(undefined)
    mocks.indexWorkspaceMarkdown.mockResolvedValue({ indexed: 1, skipped: 0, failed: 0, errors: [] })
  })

  it('cleans only documents inside the selected root boundary', async () => {
    mocks.loadDocumentFilePaths.mockResolvedValue([
      'D:/Notes/a.md',
      'D:/Notes2/b.md',
      'E:/Study/c.md',
    ])

    const result = await cleanupMissingWorkspaceDocuments('d:\\notes\\')

    expect(result.removedPaths).toEqual(['D:/Notes/a.md'])
    expect(mocks.removePersistedDocumentByPathTransaction).toHaveBeenCalledTimes(1)
    expect(mocks.removeEmbeddingJobByPath).not.toHaveBeenCalled()
    expect(mocks.removePersistedDocumentByPathTransaction.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.vectorRemove.mock.invocationCallOrder[0])
    expect(mocks.vectorRemove.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.removeNative.mock.invocationCallOrder[0])
  })

  it('does not delete indexes when a configured root is unavailable', async () => {
    mocks.listDirectory.mockRejectedValue(new Error('目录不存在'))
    mocks.loadDocumentFilePaths.mockResolvedValue(['D:/Missing/a.md'])

    const result = await cleanupMissingWorkspaceDocuments('D:/Missing')

    expect(result.removed).toBe(0)
    expect(result.errors).toHaveLength(1)
    expect(mocks.removePersistedDocumentByPathTransaction).not.toHaveBeenCalled()
  })

  it('rebuilds readable roots while preserving indexes under failed roots', async () => {
    mocks.listDirectory.mockImplementation(async (path: string) => {
      if (path === 'D:/Missing') throw new Error('目录不存在')
      return []
    })
    mocks.loadDocumentFilePaths.mockResolvedValue(['D:/Missing/a.md', 'E:/Study/b.md'])

    const result = await rebuildWorkspaceDocuments(['D:/Missing', 'E:/Study'])

    expect(result.removedPaths).toEqual(['E:/Study/b.md'])
    expect(result.errors[0]).toContain('D:/Missing')
    expect(mocks.indexWorkspaceMarkdown).toHaveBeenCalledTimes(1)
    expect(mocks.indexWorkspaceMarkdown).toHaveBeenCalledWith('E:/Study')
  })

  it('reports one cleanup failure without blocking other files, then retries it', async () => {
    mocks.loadDocumentFilePaths.mockResolvedValue(['D:/Notes/a.md', 'D:/Notes/b.md'])
    mocks.removePersistedDocumentByPathTransaction
      .mockRejectedValueOnce(new Error('database busy'))
      .mockResolvedValue({
        deleted: true,
        documentId: 'doc-1',
        chunksDeleted: 1,
        embeddingJobsDeleted: 1,
      })

    const first = await cleanupMissingWorkspaceDocuments('D:/Notes')

    expect(first.removedPaths).toEqual(['D:/Notes/b.md'])
    expect(first.errors).toEqual(['D:/Notes/a.md: database busy'])

    mocks.loadDocumentFilePaths.mockResolvedValue(['D:/Notes/a.md'])
    const second = await cleanupMissingWorkspaceDocuments('D:/Notes')

    expect(second.removedPaths).toEqual(['D:/Notes/a.md'])
    expect(second.errors).toEqual([])
    expect(mocks.removePersistedDocumentByPathTransaction).toHaveBeenCalledTimes(3)
  })

  it('rediscovers a Native cleanup failure after SQLite deletion and retries only Native cleanup', async () => {
    mocks.loadDocumentFilePaths.mockResolvedValue(['D:/Notes/a.md', 'D:/Notes/b.md'])
    mocks.removeNative
      .mockRejectedValueOnce(new Error('native index busy'))
      .mockResolvedValue(undefined)

    const first = await cleanupMissingWorkspaceDocuments('D:/Notes')

    expect(first.removedPaths).toEqual(['D:/Notes/b.md'])
    expect(first.errors).toEqual(['D:/Notes/a.md: native index busy'])
    expect(mocks.removePersistedDocumentByPathTransaction).toHaveBeenCalledTimes(2)

    mocks.listDirectory.mockRejectedValueOnce(new Error('root unavailable'))
    const blocked = await cleanupMissingWorkspaceDocuments('D:/Notes')

    expect(blocked.removed).toBe(0)
    expect(blocked.errors).toEqual(['D:/Notes: root unavailable'])
    expect(mocks.removeNative).toHaveBeenCalledTimes(2)

    mocks.listDirectory.mockResolvedValue([])
    mocks.loadDocumentFilePaths.mockResolvedValue([])
    const second = await cleanupMissingWorkspaceDocuments('D:/Notes')

    expect(second.removedPaths).toEqual(['D:/Notes/a.md'])
    expect(second.errors).toEqual([])
    expect(mocks.removePersistedDocumentByPathTransaction).toHaveBeenCalledTimes(2)
    expect(mocks.removeNative).toHaveBeenCalledTimes(3)
  })

  it('keeps rebuilding readable roots when one old index removal fails', async () => {
    mocks.loadDocumentFilePaths.mockResolvedValue(['D:/Notes/a.md', 'D:/Notes/b.md'])
    mocks.removePersistedDocumentByPathTransaction.mockRejectedValueOnce(new Error('native index busy'))

    const result = await rebuildWorkspaceDocuments('D:/Notes')

    expect(result.removedPaths).toEqual(['D:/Notes/b.md'])
    expect(result.failed).toBe(1)
    expect(result.errors).toEqual(['D:/Notes/a.md: native index busy'])
    expect(mocks.indexWorkspaceMarkdown).toHaveBeenCalledWith('D:/Notes')
  })

  it('removes an embedding-only job through the compatibility path', async () => {
    mocks.loadDocumentFilePaths.mockResolvedValue([])
    mocks.listEmbeddingJobs.mockResolvedValue([{ filePath: 'D:/Notes/pending.md' }])
    mocks.removePersistedDocumentByPathTransaction.mockResolvedValue({
      deleted: false,
      chunksDeleted: 0,
      embeddingJobsDeleted: 0,
    })

    const result = await cleanupMissingWorkspaceDocuments('D:/Notes')

    expect(result.removedPaths).toEqual(['D:/Notes/pending.md'])
    expect(mocks.removeEmbeddingJobByPath).toHaveBeenCalledWith('D:/Notes/pending.md')
  })

  it('routes workspace indexing and knowledge actions through the facade', async () => {
    const indexResult = { indexed: 2, skipped: 1, failed: 0, errors: [] }
    mocks.indexWorkspaceMarkdown.mockResolvedValue(indexResult)
    mocks.isKnowledgeDocumentIndexed.mockResolvedValue(true)
    const knowledgeResult = { filePath: 'D:/Notes/a.md', success: true }
    mocks.addKnowledgeDocument.mockResolvedValue(knowledgeResult)

    expect(isWorkspaceMarkdownPath('D:/Notes/a.md')).toBe(true)
    expect(await isWorkspaceKnowledgeDocumentIndexed('D:/Notes/a.md')).toBe(true)
    expect(await addWorkspaceKnowledgeDocument({ filePath: 'D:/Notes/a.md', title: 'a.md' })).toEqual(knowledgeResult)
    expect(await indexWorkspaceDocuments('D:/Notes')).toEqual(indexResult)
    expect(mocks.readFile).toHaveBeenCalledWith('D:/Notes/a.md')
    expect(mocks.addKnowledgeDocument).toHaveBeenCalledWith({
      filePath: 'D:/Notes/a.md',
      title: 'a.md',
      content: '# Anonymous note',
    })
    expect(mocks.indexWorkspaceMarkdown).toHaveBeenCalledWith('D:/Notes')
  })
})
