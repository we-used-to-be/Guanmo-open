// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))

vi.mock('@tauri-apps/api/core', () => ({ invoke }))
vi.mock('@/services/database/db', () => ({
  getDatabase: vi.fn(),
  isDatabaseReady: () => true,
}))

import {
  confirmMemoryCandidate,
  importBackupPayload,
  persistDocument,
  type BackupPayload,
} from '@/services/database/persistence'

beforeEach(() => {
  invoke.mockReset()
})

describe('SQLite 事务命令桥接', () => {
  it('文档索引使用单次事务命令并保留队列选项', async () => {
    invoke.mockResolvedValue(undefined)
    const document = {
      id: 'document-1',
      filePath: 'C:/anonymous/document.md',
      title: '匿名文档',
      content: '# 标题',
      contentHash: 'hash',
      lastModified: 1,
      chunks: [],
    }

    await persistDocument(document, { enqueueEmbeddingJob: true })

    expect(invoke).toHaveBeenCalledWith('persist_document_transaction', {
      request: { document, enqueueEmbeddingJob: true },
    })
  })

  it('候选记忆确认使用原子事务命令', async () => {
    invoke.mockResolvedValue(true)

    await expect(confirmMemoryCandidate('candidate-1')).resolves.toBe(true)
    expect(invoke).toHaveBeenCalledWith('confirm_memory_candidate_transaction', {
      id: 'candidate-1',
    })
  })

  it('备份版本兼容检查后整包交给事务命令', async () => {
    const payload: BackupPayload = {
      version: 1,
      exportedAt: 1,
      sessions: [],
      memories: [],
      note: '匿名备份',
    }
    invoke.mockResolvedValue({ sessions: 0, messages: 0, memories: 0 })

    await expect(importBackupPayload(payload)).resolves.toEqual({
      sessions: 0,
      messages: 0,
      memories: 0,
    })
    expect(invoke).toHaveBeenCalledWith('import_backup_transaction', { payload })
  })
})
