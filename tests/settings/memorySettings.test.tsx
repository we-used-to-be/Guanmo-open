import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MemorySettings } from '@/features/settings/SettingsPage'
import type { Memory } from '@/services/database/persistence'
import { contentHash } from '@/services/memory/memoryPolicy'

const mockLoadMemoryPage = vi.fn()
const mockLoadMemoryCount = vi.fn()
const mockRemoveMemory = vi.fn()
const mockConfirmMemoryCandidate = vi.fn()

vi.mock('@/hooks/useTauri', async (importOriginal) => ({
  ...(await importOriginal()),
  isTauri: () => true,
}))

vi.mock('@/stores/appStore', () => ({
  selectPrimaryWorkspacePath: (state: { workspaceRoots: Array<{ path: string }> }) => state.workspaceRoots[0]?.path ?? null,
  useAppStore: (selector: (state: { workspaceRoots: Array<{ path: string }> }) => unknown) => selector({
    workspaceRoots: [{ path: 'D:/Anonymous/Current' }],
  }),
}))

vi.mock('@/services/database/persistence', () => ({
  clearAllChatSessions: vi.fn(),
  clearMemoriesByStatus: vi.fn(),
  confirmMemoryCandidate: (id: string, coexist?: boolean) => coexist ? mockConfirmMemoryCandidate(id, true) : mockConfirmMemoryCandidate(id),
  loadMemoryCount: (options: unknown) => mockLoadMemoryCount(options),
  loadMemoryPage: (options: unknown) => mockLoadMemoryPage(options),
  persistMemory: vi.fn(),
  removeMemory: (id: string) => mockRemoveMemory(id),
  toggleMemoryLocked: vi.fn(),
  updateMemoryStatus: vi.fn(),
}))

vi.mock('@/services/toast', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}))

const activeMemory: Memory = {
  id: 'memory-active-1',
  content: '匿名分页记忆',
  category: 'project',
  source: 'manual_created',
  locked: false,
  status: 'active',
  scopeType: 'project',
  scopeKey: 'd:/anonymous/current',
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
}

const candidateMemory: Memory = {
  ...activeMemory,
  id: 'memory-candidate-1',
  content: '匿名候选记忆',
  status: 'candidate',
  source: 'auto_extracted',
}

describe('MemorySettings', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockLoadMemoryCount.mockImplementation(async ({ statuses }: { statuses: string[] }) => {
      if (statuses.includes('archived')) return 2
      if (statuses.includes('candidate')) return 1
      return 21
    })
    mockLoadMemoryPage.mockImplementation(async ({ statuses, offset }: {
      statuses: string[]
      offset: number
    }) => {
      if (statuses.includes('candidate')) {
        return { memories: [candidateMemory], total: 1 }
      }
      if (offset === 20) {
        return { memories: [{ ...activeMemory, id: 'memory-active-21' }], total: 21 }
      }
      return { memories: [activeMemory], total: 21 }
    })
    mockRemoveMemory.mockResolvedValue(undefined)
    mockConfirmMemoryCandidate.mockResolvedValue(true)
  })

  it('shows the user quote when a paraphrased candidate needs review', async () => {
    const quote = '我的职业是独立开发者，我长期从事软件开发'
    const evidence = JSON.stringify({ version: 3, policyVersion: 3, sensitivity: 'normal', reviewReason: 'semantic',
      evidenceQuote: quote, kind: 'semantic', sourceId: 'u1', sessionId: 's', windowId: 'w:1', excerpt: quote,
      sources: [{ id: 'u1', sessionId: 's', role: 'user', parentId: null, sequence: 1, createdAt: 1700000000000, textHash: 'a'.repeat(64) }] })
    mockLoadMemoryPage.mockImplementation(async ({ statuses }: { statuses: string[] }) => statuses.includes('candidate')
      ? { memories: [{ ...candidateMemory, evidence }], total: 1 } : { memories: [activeMemory], total: 1 })
    render(<MemorySettings />)
    expect(await screen.findByText(`请核对原文：${quote}`)).toBeInTheDocument()
  })

  it('shows existing facts and requires explicit coexistence confirmation', async () => {
    const quote = '我的爱好是绘画。'
    const evidence = JSON.stringify({ version: 3, policyVersion: 3, sensitivity: 'normal', reviewReason: 'semantic',
      evidenceQuote: quote, kind: 'semantic', sourceId: 'u1', sessionId: 's', windowId: 'w:1', excerpt: quote,
      conflicts: [{ id: activeMemory.id, contentHash: contentHash(activeMemory.content), updatedAt: activeMemory.updatedAt }],
      sources: [{ id: 'u1', sessionId: 's', role: 'user', parentId: null, sequence: 1, createdAt: 1700000000000, textHash: 'a'.repeat(64) }] })
    mockLoadMemoryPage.mockImplementation(async ({ statuses, ids }: { statuses: string[]; ids?: string[] }) => ids
      ? { memories: [activeMemory], total: 1 } : statuses.includes('candidate')
        ? { memories: [{ ...candidateMemory, evidence }], total: 1 } : { memories: [activeMemory], total: 1 })
    render(<MemorySettings />)
    expect(await screen.findByText(/确认并存不会覆盖已有记忆/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '确认并存' }))
    await waitFor(() => expect(mockConfirmMemoryCandidate).toHaveBeenCalledWith(candidateMemory.id, true))
  })

  it('disables coexistence when an existing fact has changed', async () => {
    const quote = '我的爱好是绘画。'
    const evidence = JSON.stringify({ version: 3, policyVersion: 3, sensitivity: 'normal', reviewReason: 'semantic',
      evidenceQuote: quote, kind: 'semantic', sourceId: 'u1', sessionId: 's', windowId: 'w:1', excerpt: quote,
      conflicts: [{ id: activeMemory.id, contentHash: contentHash(activeMemory.content), updatedAt: activeMemory.updatedAt }],
      sources: [{ id: 'u1', sessionId: 's', role: 'user', parentId: null, sequence: 1, createdAt: 1700000000000, textHash: 'a'.repeat(64) }] })
    mockLoadMemoryPage.mockImplementation(async ({ statuses, ids }: { statuses: string[]; ids?: string[] }) => ids
      ? { memories: [{ ...activeMemory, content: '已发生变化' }], total: 1 } : statuses.includes('candidate')
        ? { memories: [{ ...candidateMemory, evidence }], total: 1 } : { memories: [activeMemory], total: 1 })
    render(<MemorySettings />)
    expect(await screen.findByText('已有记忆已变化，请刷新后重新核对')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '确认并存' })).toBeDisabled()
    expect(mockConfirmMemoryCandidate).not.toHaveBeenCalled()
  })

  it('loads only filtered lightweight pages and switches stable offsets', async () => {
    render(<MemorySettings />)

    await screen.findByText('匿名分页记忆')
    expect(mockLoadMemoryPage).toHaveBeenCalledWith(expect.objectContaining({
      statuses: ['active'],
      limit: 20,
      offset: 0,
    }))
    expect(mockLoadMemoryPage).toHaveBeenCalledWith(expect.objectContaining({
      statuses: ['candidate'],
      limit: 10,
      offset: 0,
    }))

    await userEvent.click(screen.getByRole('button', { name: '下一页' }))

    await waitFor(() => {
      expect(mockLoadMemoryPage).toHaveBeenCalledWith(expect.objectContaining({
        statuses: ['active'],
        limit: 20,
        offset: 20,
      }))
    })
    expect(await screen.findByText('第 2 / 2 页')).toBeInTheDocument()
  })

  it('pushes exact project scope into SQLite options and refreshes after deletion', async () => {
    render(<MemorySettings />)
    await screen.findByText('匿名分页记忆')

    await userEvent.click(screen.getByRole('button', { name: '当前项目' }))
    await waitFor(() => {
      expect(mockLoadMemoryPage).toHaveBeenCalledWith(expect.objectContaining({
        statuses: ['active'],
        scopeType: 'project',
        includeGlobalForProject: false,
        scopeKey: expect.any(String),
      }))
    })

    const callsBeforeDelete = mockLoadMemoryPage.mock.calls.length
    await userEvent.click(screen.getByRole('button', { name: '删除' }))
    await waitFor(() => expect(mockRemoveMemory).toHaveBeenCalledWith('memory-active-1'))
    await waitFor(() => expect(mockLoadMemoryPage.mock.calls.length).toBeGreaterThan(callsBeforeDelete))
  })

  it('falls back safely when the current page becomes empty', async () => {
    mockLoadMemoryPage.mockImplementation(async ({ statuses, offset }: {
      statuses: string[]
      offset: number
    }) => {
      if (statuses.includes('candidate')) return { memories: [], total: 0 }
      if (offset === 20) return { memories: [], total: 1 }
      return { memories: [activeMemory], total: 21 }
    })

    render(<MemorySettings />)
    await screen.findByText('匿名分页记忆')
    await userEvent.click(screen.getByRole('button', { name: '下一页' }))

    await waitFor(() => {
      const firstPageCalls = mockLoadMemoryPage.mock.calls.filter(([options]) =>
        options.statuses.includes('active') && options.offset === 0
      )
      expect(firstPageCalls.length).toBeGreaterThan(1)
    })
    expect(await screen.findByText('匿名分页记忆')).toBeInTheDocument()
  })
})
