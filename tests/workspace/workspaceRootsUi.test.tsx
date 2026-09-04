import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  addWorkspaceRoot: vi.fn(),
  removeWorkspace: vi.fn(),
  refreshWorkspaceRoot: vi.fn(),
  pickDirectory: vi.fn(),
  indexWorkspaceDocuments: vi.fn(),
}))

vi.mock('@/hooks/useWorkspaceFileTree', () => ({
  useWorkspaceFileTree: () => ({
    workspaceRoots: [
      { id: 'root-a', path: 'D:/Notes', name: 'Notes' },
      { id: 'root-b', path: 'E:/Study', name: 'Study' },
      { id: 'root-c', path: 'F:/Personal', name: 'Personal' },
    ],
    workspaceTrees: {
      'root-a': { nodes: [{ name: 'a.md', path: 'D:/Notes/a.md', type: 'file' }], hiddenCount: 4, loading: false, error: null },
      'root-b': { nodes: [{ name: 'b.md', path: 'E:/Study/b.md', type: 'file' }], hiddenCount: 0, loading: false, error: null },
      'root-c': { nodes: [{ name: 'c.md', path: 'F:/Personal/c.md', type: 'file' }], hiddenCount: 0, loading: false, error: null },
    },
    addWorkspaceRoot: mocks.addWorkspaceRoot,
    removeWorkspace: mocks.removeWorkspace,
    refreshWorkspaceRoot: mocks.refreshWorkspaceRoot,
  }),
}))
vi.mock('@/hooks/useTauri', () => ({ isTauri: () => true }))
vi.mock('@/services/fileSystem', () => ({ pickDirectory: mocks.pickDirectory }))
vi.mock('@/services/workspaceIndex', () => ({ indexWorkspaceDocuments: mocks.indexWorkspaceDocuments }))
vi.mock('@/services/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('@/components/file-tree/FileTree', () => ({
  FileTree: ({ workspacePath }: { workspacePath: string }) => <div data-testid={`tree-${workspacePath}`} />,
}))

import { WorkspaceRoots } from '@/components/file-tree/WorkspaceRoots'

describe('WorkspaceRoots', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.addWorkspaceRoot.mockReturnValue(true)
    mocks.indexWorkspaceDocuments.mockResolvedValue({ indexed: 1, skipped: 0, failed: 0, errors: [] })
  })

  it('renders three roots and collapses them independently', () => {
    render(<WorkspaceRoots onOpenFile={vi.fn()} />)

    expect(screen.getByText('共打开 3 个文件夹')).toBeInTheDocument()
    expect(screen.getByTestId('tree-D:/Notes')).toBeInTheDocument()
    expect(screen.getByTestId('tree-E:/Study')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '折叠 Study' }))
    expect(screen.queryByTestId('tree-E:/Study')).not.toBeInTheDocument()
    expect(screen.getByTestId('tree-D:/Notes')).toBeInTheDocument()
    expect(screen.queryByText(/已隐藏/)).not.toBeInTheDocument()
  })

  it('removes only the selected root record', () => {
    render(<WorkspaceRoots onOpenFile={vi.fn()} />)

    fireEvent.click(screen.getAllByRole('button', { name: '移除' })[1])
    expect(mocks.removeWorkspace).toHaveBeenCalledWith('root-b')
    expect(mocks.removeWorkspace).toHaveBeenCalledTimes(1)
  })

  it('indexes the selected root and adds another folder', async () => {
    mocks.pickDirectory.mockResolvedValue('G:/Archive')
    render(<WorkspaceRoots onOpenFile={vi.fn()} />)

    fireEvent.click(screen.getAllByRole('button', { name: '索引' })[1])
    await waitFor(() => expect(mocks.indexWorkspaceDocuments).toHaveBeenCalledWith('E:/Study'))
    expect(screen.queryByRole('button', { name: '清理失效索引' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '重建索引' })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '添加文件夹' }))
    await waitFor(() => expect(mocks.addWorkspaceRoot).toHaveBeenCalledWith('G:/Archive'))
  })
})
