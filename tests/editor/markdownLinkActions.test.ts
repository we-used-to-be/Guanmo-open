import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MarkdownPreview } from '@/components/editor/MarkdownPreview'
import { useEditorStore } from '@/stores/editorStore'
import { followMarkdownLink } from '@/services/markdownLinkActions'

const mocks = vi.hoisted(() => ({ read: vi.fn(), prepare: vi.fn(), grant: vi.fn(), shell: vi.fn(), index: vi.fn() }))
vi.mock('@/services/markdownFileOpenPolicy', () => ({ readRememberedMarkdownFileForOpen: mocks.read }))
vi.mock('@/hooks/useTauri', () => ({ isTauri: () => true, prepareMarkdownImage: mocks.prepare, requestSelectedPathAccess: mocks.grant }))
vi.mock('@tauri-apps/api/core', () => ({ convertFileSrc: (path: string) => `asset:${path}` }))
vi.mock('@tauri-apps/plugin-shell', () => ({ open: mocks.shell }))
vi.mock('@/services/rag/indexer', () => ({ scheduleMarkdownDocumentIndex: mocks.index }))

beforeEach(() => {
  useEditorStore.setState({ tabs: [], activeTabId: null, recentFiles: [], pendingReveal: null })
  mocks.read.mockReset().mockResolvedValue('# title\n\n## Results\n\ncontent')
  mocks.prepare.mockReset().mockImplementation(async (_source: string, image: string) => image)
  mocks.grant.mockReset().mockResolvedValue(false)
})
afterEach(cleanup)

describe('Markdown desktop link actions', () => {
  it('opens a real preview link all the way into the editor store', async () => {
    render(createElement(MarkdownPreview, { content: '[参数卡](E:/notes/PARAMETER_CARD_CN.md)', filePath: 'E:/notes/summary.md' }))
    fireEvent.click(screen.getByRole('link', { name: '参数卡' }))
    await waitFor(() => expect(useEditorStore.getState().tabs).toHaveLength(1))
    expect(useEditorStore.getState().tabs[0].filePath).toBe('E:/notes/PARAMETER_CARD_CN.md')
    expect(mocks.shell).not.toHaveBeenCalled()
  })
  it('opens Markdown in a tab instead of shell or browser', async () => {
    await followMarkdownLink('E%3A/notes/参数.md', 'E:/notes/source.md', '参数', vi.fn())
    expect(mocks.read).toHaveBeenCalledWith('E:/notes/参数.md')
    expect(useEditorStore.getState().tabs).toHaveLength(1)
    expect(useEditorStore.getState().tabs[0].title).toBe('参数.md')
    expect(mocks.shell).not.toHaveBeenCalled()
  })
  it('activates an existing dirty tab without reloading or overwriting it', async () => {
    useEditorStore.getState().addTab('E:/notes/参数.md', '参数.md', 'saved content')
    const original = useEditorStore.getState().tabs[0]
    useEditorStore.getState().updateTabContent(original.id, 'unsaved content')
    await followMarkdownLink('e:/NOTES/参数.md', 'E:/source.md', '参数', vi.fn())
    expect(mocks.read).not.toHaveBeenCalled()
    expect(useEditorStore.getState().tabs).toHaveLength(1)
    expect(useEditorStore.getState().tabs[0].content).toBe('unsaved content')
    expect(useEditorStore.getState().tabs[0].modified).toBe(true)
    expect(useEditorStore.getState().tabs[0].savedContent).toBe('saved content')
    expect(useEditorStore.getState().activeTabId).toBe(original.id)
  })
  it('deduplicates simultaneous reads and creates only one tab', async () => {
    let finish!: (content: string) => void
    mocks.read.mockReturnValue(new Promise((resolve) => { finish = resolve }))
    const first = followMarkdownLink('target.md', 'E:/notes/source.md', 'target', vi.fn())
    const second = followMarkdownLink('target.md', 'E:/notes/source.md', 'target', vi.fn())
    finish('content')
    await Promise.all([first, second])
    expect(mocks.read).toHaveBeenCalledTimes(1)
    expect(useEditorStore.getState().tabs).toHaveLength(1)
  })
  it('navigates to a heading in the target document', async () => {
    await followMarkdownLink('target.md#results', 'E:/notes/source.md', 'target', vi.fn())
    expect(useEditorStore.getState().pendingReveal).toMatchObject({ startLine: 3, surface: 'preview' })
  })
  it.each(['file not found', '重新授权已取消', 'FILE_TOO_LARGE|2000000|1048576'])('does not fall back to browser after %s', async (message) => {
    mocks.read.mockRejectedValue(new Error(message))
    await expect(followMarkdownLink('target.md', 'E:/notes/source.md', 'target', vi.fn())).rejects.toThrow(message)
    expect(useEditorStore.getState().tabs).toHaveLength(0)
    expect(mocks.shell).not.toHaveBeenCalled()
  })
  it('previews a local image inside the app', async () => {
    const show = vi.fn()
    await followMarkdownLink('figure.png', 'E:/notes/source.md', 'figure', show)
    expect(show).toHaveBeenCalledWith({ src: 'asset:E:/notes/figure.png', alt: 'figure' })
    expect(mocks.shell).not.toHaveBeenCalled()
  })
  it('requests explicit access to an unauthorized external image, then previews it', async () => {
    mocks.prepare.mockRejectedValueOnce('image is outside the Markdown directory and authorized locations')
    mocks.grant.mockResolvedValue(true)
    const show = vi.fn()
    await followMarkdownLink('E:/private/figure.png', 'E:/notes/source.md', 'figure', show)
    expect(mocks.grant).toHaveBeenCalledTimes(1)
    expect(mocks.prepare).toHaveBeenCalledTimes(2)
    expect(show).toHaveBeenCalledTimes(1)
  })
  it('cancels image authorization without opening anything externally', async () => {
    mocks.prepare.mockRejectedValue('image is outside the Markdown directory and authorized locations')
    const show = vi.fn()
    await followMarkdownLink('E:/private/figure.png', 'E:/notes/source.md', 'figure', show)
    expect(show).not.toHaveBeenCalled()
    expect(mocks.shell).not.toHaveBeenCalled()
  })
  it('routes a website to the default browser', async () => {
    await followMarkdownLink('https://example.com/page', null, 'web', vi.fn())
    expect(mocks.shell).toHaveBeenCalledWith('https://example.com/page')
    expect(mocks.read).not.toHaveBeenCalled()
  })
  it.each(['E:/script.exe', 'E:/shortcut.lnk', 'javascript:alert(1)', 'http://tauri.localhost/foo', ''])('does not launch unsupported or unsafe target %s', async (href) => {
    await expect(followMarkdownLink(href, 'E:/notes/source.md', 'bad', vi.fn())).rejects.toThrow()
    expect(mocks.shell).not.toHaveBeenCalled()
    expect(mocks.read).not.toHaveBeenCalled()
  })
})
