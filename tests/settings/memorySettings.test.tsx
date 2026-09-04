import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MemorySettings } from '@/features/settings/SettingsPage'
import type { Memory } from '@/services/database/persistence'

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
  confirmMemoryCandidate: (id: string) => mockConfirmMemoryCandidate(id),
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
