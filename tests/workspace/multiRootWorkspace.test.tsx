import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { listDirectory } = vi.hoisted(() => ({ listDirectory: vi.fn() }))

vi.mock('@/services/fileSystem', () => ({
  listDirectory,
}))

vi.mock('@/hooks/useTauri', () => ({
  isTauri: () => true,
  joinPath: async (...paths: string[]) => paths.join('/'),
}))

vi.mock('@/services/persistedFileAccess', () => ({
  recoverRememberedWorkspace: async <T,>(_path: string, operation: () => Promise<T>) => operation(),
}))

import {
  migratePersistedAppState,
  normalizeWorkspacePath,
  selectPrimaryWorkspacePath,
  useAppStore,
} from '@/stores/appStore'
import { useWorkspaceFileTree } from '@/hooks/useWorkspaceFileTree'
import { useEditorStore } from '@/stores/editorStore'

describe('multi-root workspace state', () => {
  beforeEach(() => {
    useAppStore.setState({ workspaceRoots: [] })
    useEditorStore.setState({ tabs: [], activeTabId: null, recentFiles: [], favorites: [] })
    listDirectory.mockReset()
  })

  it('normalizes Windows path case, separators and trailing separators', () => {
    expect(normalizeWorkspacePath('D:\\Notes')).toBe('d:/notes')
    expect(normalizeWorkspacePath('d:/Notes/')).toBe('d:/notes')
    expect(normalizeWorkspacePath('\\\\?\\D:\\Notes\\')).toBe('d:/notes')
  })

  it('migrates the legacy workspacePath into the first root', () => {
    const migrated = migratePersistedAppState({ workspacePath: 'D:\\Legacy Notes\\' })

    expect(migrated.workspaceRoots).toHaveLength(1)
    expect(migrated.workspaceRoots?.[0]).toMatchObject({
      path: 'D:\\Legacy Notes',
      name: 'Legacy Notes',
    })
    expect(selectPrimaryWorkspacePath(migrated as ReturnType<typeof useAppStore.getState>)).toBe('D:\\Legacy Notes')
    expect(migrated).not.toHaveProperty('workspacePath')
  })

  it('adds three roots, rejects duplicate identities and removes only the selected root', () => {
    const store = useAppStore.getState()

    expect(store.addWorkspaceRoot('D:\\Notes')).toBe(true)
    expect(store.addWorkspaceRoot('E:\\Study')).toBe(true)
    expect(store.addWorkspaceRoot('F:\\Personal')).toBe(true)
    expect(store.addWorkspaceRoot('d:/notes/')).toBe(false)

    const roots = useAppStore.getState().workspaceRoots
    expect(roots.map((root) => root.path)).toEqual(['D:\\Notes', 'E:\\Study', 'F:\\Personal'])
    expect(selectPrimaryWorkspacePath(useAppStore.getState())).toBe('D:\\Notes')

    useAppStore.getState().removeWorkspaceRoot(roots[1].id)
    expect(useAppStore.getState().workspaceRoots.map((root) => root.path)).toEqual(['D:\\Notes', 'F:\\Personal'])
    expect(selectPrimaryWorkspacePath(useAppStore.getState())).toBe('D:\\Notes')

    useAppStore.getState().removeWorkspaceRoot(roots[0].id)
    expect(selectPrimaryWorkspacePath(useAppStore.getState())).toBe('F:\\Personal')
  })

  it('persists and rehydrates workspace roots in desktop storage', async () => {
    localStorage.removeItem('guanmo-app')
    act(() => {
      expect(useAppStore.getState().addWorkspaceRoot('D:\\Notes')).toBe(true)
    })

    const saved = localStorage.getItem('guanmo-app')
    expect(saved).toBeTruthy()
    expect(JSON.parse(saved!).state.workspaceRoots).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: 'D:\\Notes' })])
    )

    act(() => {
      useAppStore.setState({ workspaceRoots: [] })
    })
    localStorage.setItem('guanmo-app', saved!)
    await act(async () => {
      await useAppStore.persist.rehydrate()
    })

    expect(useAppStore.getState().workspaceRoots.map((root) => root.path)).toEqual(['D:\\Notes'])
  })

  it('does not close tabs or clear global recent files and favorites when removing a root', () => {
    useAppStore.getState().addWorkspaceRoot('D:\\Notes')
    const [root] = useAppStore.getState().workspaceRoots
    const tab = {
      id: 'tab-a',
      title: 'a.md',
      filePath: 'D:\\Notes\\a.md',
      content: '# A',
      savedContent: '# A',
      originalContent: '# A',
      modified: false,
    }
    useEditorStore.setState({
      tabs: [tab],
      activeTabId: tab.id,
      recentFiles: [{ path: tab.filePath, name: tab.title, lastOpened: 1 }],
      favorites: [tab.filePath],
    })

    useAppStore.getState().removeWorkspaceRoot(root.id)

    expect(useEditorStore.getState().tabs).toEqual([tab])
    expect(useEditorStore.getState().recentFiles).toHaveLength(1)
    expect(useEditorStore.getState().favorites).toEqual([tab.filePath])
  })
})

describe('multi-root workspace loading', () => {
  beforeEach(() => {
    useAppStore.setState({ workspaceRoots: [] })
    listDirectory.mockReset()
  })

  it('keeps successful roots available when another root cannot be read', async () => {
    listDirectory.mockImplementation(async (path: string) => {
      if (path === 'D:\\Missing') throw new Error('目录不存在')
      if (path === 'E:\\Study') return [{ name: 'note.md', isDirectory: false, isFile: true }]
      return []
    })
    act(() => {
      useAppStore.getState().addWorkspaceRoot('D:\\Missing')
      useAppStore.getState().addWorkspaceRoot('E:\\Study')
    })

    const { result } = renderHook(() => useWorkspaceFileTree())

    await waitFor(() => {
      const missing = result.current.workspaceRoots.find((root) => root.path === 'D:\\Missing')
      const study = result.current.workspaceRoots.find((root) => root.path === 'E:\\Study')
      expect(result.current.workspaceTrees[missing!.id].error).toContain('目录不存在')
      expect(result.current.workspaceTrees[study!.id].nodes).toHaveLength(1)
    })
    expect(result.current.workspaceRoots).toHaveLength(2)
  })
})
