import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { FileNode } from '@/services/fileTree'

vi.mock('@/services/fileSystem', () => ({ createFile: vi.fn(), createFolder: vi.fn(), openFile: vi.fn() }))
vi.mock('@/services/workspaceIndex', () => ({
  addWorkspaceKnowledgeDocument: vi.fn(),
  isWorkspaceKnowledgeDocumentIndexed: vi.fn(),
  isWorkspaceMarkdownPath: () => false,
}))
vi.mock('@/hooks/useTauri', () => ({ isTauri: () => false, revealFileInFolder: vi.fn() }))

import { FileTree } from '@/components/file-tree/FileTree'

const nodes: FileNode[] = [{
  name: 'Docs',
  path: 'D:/Notes/Docs',
  type: 'directory',
  children: [{
    name: 'Nested',
    path: 'D:/Notes/Docs/Nested',
    type: 'directory',
    children: [{ name: 'note.md', path: 'D:/Notes/Docs/Nested/note.md', type: 'file' }],
  }],
}]

describe('FileTree collapse', () => {
  it('keeps nested content inert during exit and reuses it on rapid reopen', () => {
    const onOpenFile = vi.fn()
    render(<FileTree nodes={nodes} onOpenFile={onOpenFile} />)

    const nested = screen.getByRole('button', { name: 'Nested' })
    expect(nested).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(nested)
    expect(nested).toHaveAttribute('aria-expanded', 'true')

    fireEvent.click(nested)
    expect(screen.getByText('note.md').closest('[aria-hidden="true"]')).toHaveProperty('inert', true)
    fireEvent.click(nested)

    expect(screen.getAllByText('note.md')).toHaveLength(1)
    expect(screen.getByText('note.md').closest('[aria-hidden="true"]')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'note.md' }))
    expect(onOpenFile).toHaveBeenCalledWith('D:/Notes/Docs/Nested/note.md')
  })
})
