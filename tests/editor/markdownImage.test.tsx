import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MarkdownImage } from '@/components/editor/MarkdownImage'
import { MarkdownPreview } from '@/components/editor/MarkdownPreview'

const mocks = vi.hoisted(() => ({
  desktop: true,
  prepare: vi.fn<(markdown: string, image: string) => Promise<string>>(),
  requestAccess: vi.fn<(path: string, filters: unknown) => Promise<boolean>>(),
  convert: vi.fn((path: string) => `asset://localhost/${encodeURIComponent(path)}`),
}))
vi.mock('@/hooks/useTauri', () => ({
  isTauri: () => mocks.desktop,
  prepareMarkdownImage: mocks.prepare,
  requestSelectedPathAccess: mocks.requestAccess,
}))
vi.mock('@tauri-apps/api/core', () => ({ convertFileSrc: mocks.convert }))

beforeEach(() => {
  mocks.desktop = true
  mocks.prepare.mockReset().mockImplementation(async (_markdown, image) => image)
  mocks.requestAccess.mockReset().mockResolvedValue(false)
})
afterEach(cleanup)

describe('Markdown image preview authorization', () => {
  it('authorizes a typed Chinese sibling image before emitting an asset URL', async () => {
    let authorize!: (path: string) => void
    mocks.prepare.mockReturnValue(new Promise((resolve) => { authorize = resolve }))
    const onZoom = vi.fn()
    render(<MarkdownImage src="模型111极图_文献配色.png" filePath={'C:\\notes\\新建文本文档.md'} alt="Fig2test" onZoom={onZoom} />)
    expect(mocks.prepare).toHaveBeenCalledWith('C:\\notes\\新建文本文档.md', 'C:/notes/模型111极图_文献配色.png')
    expect(screen.getByAltText('Fig2test').getAttribute('src')).toBeNull()
    expect(mocks.convert).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button'))
    expect(onZoom).not.toHaveBeenCalled()
    await act(async () => authorize('C:/notes/模型111极图_文献配色.png'))
    const src = screen.getByAltText('Fig2test').getAttribute('src')
    expect(src).toContain('asset://localhost/')
    fireEvent.click(screen.getByRole('button'))
    expect(onZoom).toHaveBeenCalledWith({ src, alt: 'Fig2test' })
  })

  it('uses the authorization path in the real Markdown renderer without inserting an image', async () => {
    render(<MarkdownPreview content="![Fig2test](模型111极图_文献配色.png)" filePath="C:/notes/test.md" />)
    await waitFor(() => expect(screen.getByAltText('Fig2test').getAttribute('src')).toContain('asset://localhost/'))
    expect(mocks.prepare).toHaveBeenCalledWith('C:/notes/test.md', 'C:/notes/模型111极图_文献配色.png')
  })

  it.each([
    ['![absolute](E:/notes/图1.png)', 'E:/notes/图1.png'],
    ['- ![absolute](E:/notes/图1.png)', 'E:/notes/图1.png'],
    ['![absolute](e:/notes/figure.png)', 'e:/notes/figure.png'],
    ['![absolute](E:\\notes\\figure.png)', 'E:/notes/figure.png'],
    ['![absolute](<E:/notes/图 1.png>)', 'E:/notes/图 1.png'],
    ['![absolute](E:/notes/%E5%9B%BE%201.png)', 'E:/notes/图 1.png'],
    ['![absolute][fig]\n\n[fig]: E:/notes/图1.png', 'E:/notes/图1.png'],
    ['<div>\n\n![absolute](E:/notes/图1.png)\n\n</div>', 'E:/notes/图1.png'],
  ])('keeps a drive path through the full Markdown preview: %s', async (content, imagePath) => {
    render(<MarkdownPreview content={content} filePath="E:/notes/SUMMARY.md" />)
    await waitFor(() => expect(screen.getByAltText('absolute').getAttribute('src')).toContain('asset://localhost/'))
    expect(mocks.prepare).toHaveBeenCalledWith('E:/notes/SUMMARY.md', imagePath)
  })

  it('does not bypass backend permissions for a parsed absolute image', async () => {
    mocks.prepare.mockRejectedValue(new Error('outside the Markdown directory'))
    render(<MarkdownPreview content="![external](E:/private/figure.png)" filePath="E:/notes/test.md" />)
    await waitFor(() => expect(screen.getByAltText('external').closest('button')?.title).toContain('无法加载图片'))
    expect(mocks.prepare).toHaveBeenCalledWith('E:/notes/test.md', 'E:/private/figure.png')
    expect(screen.getByAltText('external').getAttribute('src')).toBeNull()
    expect(mocks.convert).not.toHaveBeenCalled()
  })

  it.each(['javascript:alert%281%29', 'vbscript:msgbox%281%29', 'E:relative.png'])('keeps the existing URL filter for %s', (path) => {
    render(<MarkdownPreview content={`![blocked](${path})\n\n[link](${path})`} filePath="E:/notes/test.md" />)
    expect(screen.getByAltText('blocked').getAttribute('src')).toBeNull()
    expect(screen.getByText('link').closest('a')?.getAttribute('href') || '').toBe('')
    expect(mocks.prepare).not.toHaveBeenCalled()
  })

  it('preserves Windows document links for internal navigation without turning them into images', () => {
    render(<MarkdownPreview content="[document](E:/notes/report.md)" filePath="E:/notes/test.md" />)
    expect(screen.getByText('document').closest('a')?.getAttribute('href')).toBe('E%3A/notes/report.md')
    expect(screen.getByText('document').closest('a')?.getAttribute('target')).toBeNull()
    expect(mocks.prepare).not.toHaveBeenCalled()
  })

  it('offers explicit access to an external image and retries only after user selection', async () => {
    mocks.prepare.mockRejectedValueOnce(new Error('outside the Markdown directory'))
    mocks.requestAccess.mockResolvedValue(true)
    render(<MarkdownPreview content="![external](E:/figures/图1.png)" filePath="E:/reports/test.md" />)
    const prompt = await screen.findByText('无法加载图片，点击选择原图片并授权')
    expect(mocks.requestAccess).not.toHaveBeenCalled()
    fireEvent.click(prompt)
    await waitFor(() => expect(screen.getByAltText('external').getAttribute('src')).toContain('asset://localhost/'))
    expect(mocks.requestAccess).toHaveBeenCalledWith('E:/figures/图1.png', [
      { name: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'] },
    ])
    expect(mocks.prepare).toHaveBeenCalledTimes(2)
    expect(screen.queryByText('无法加载图片，点击选择原图片并授权')).toBeNull()
  })

  it('does not load or grant an external image if selection is cancelled', async () => {
    mocks.prepare.mockRejectedValue(new Error('outside the Markdown directory'))
    render(<MarkdownImage src="E:/figures/figure.png" filePath="E:/reports/test.md" alt="external" onZoom={vi.fn()} />)
    fireEvent.click(await screen.findByText('无法加载图片，点击选择原图片并授权'))
    await waitFor(() => expect(screen.getByRole('button').hasAttribute('disabled')).toBe(false))
    expect(mocks.requestAccess).toHaveBeenCalledTimes(1)
    expect(mocks.prepare).toHaveBeenCalledTimes(1)
    expect(screen.getByAltText('external').getAttribute('src')).toBeNull()
  })

  it('shows a selection error without retrying an unapproved file', async () => {
    mocks.prepare.mockRejectedValue(new Error('outside the Markdown directory'))
    mocks.requestAccess.mockRejectedValue(new Error('请选择原文件以恢复访问权限'))
    render(<MarkdownImage src="E:/figures/figure.png" filePath="E:/reports/test.md" alt="external" onZoom={vi.fn()} />)
    fireEvent.click(await screen.findByText('无法加载图片，点击选择原图片并授权'))
    await waitFor(() => expect(screen.getByRole('button').title).toBe('请选择原文件以恢复访问权限'))
    expect(mocks.prepare).toHaveBeenCalledTimes(1)
    expect(mocks.convert).not.toHaveBeenCalled()
  })

  it('does not overwrite a new document image when an old native dialog completes', async () => {
    let grantOld!: (granted: boolean) => void
    mocks.prepare.mockRejectedValueOnce(new Error('outside the Markdown directory'))
    mocks.requestAccess.mockReturnValue(new Promise((resolve) => { grantOld = resolve }))
    const { rerender } = render(<MarkdownImage src="E:/figures/old.png" filePath="E:/reports/test.md" alt="figure" onZoom={vi.fn()} />)
    fireEvent.click(await screen.findByText('无法加载图片，点击选择原图片并授权'))
    rerender(<MarkdownImage src="new.png" filePath="E:/new/test.md" alt="figure" onZoom={vi.fn()} />)
    await waitFor(() => expect(screen.getByAltText('figure').getAttribute('src')).toContain(encodeURIComponent('E:/new/new.png')))
    await act(async () => grantOld(true))
    expect(screen.getByAltText('figure').getAttribute('src')).toContain(encodeURIComponent('E:/new/new.png'))
  })

  it.each([
    ['./assets/figure.png', 'C:/notes/assets/figure.png'],
    [encodeURI('模型 图.png'), 'C:/notes/模型 图.png'],
    ['C:\\notes\\figure.png', 'C:/notes/figure.png'],
    ['//server/share/figure.png', '//server/share/figure.png'],
    ['/notes/figure.png', '/notes/figure.png'],
    ['100%bad.png', 'C:/notes/100%bad.png'],
  ])('resolves %s before requesting authorization', async (src, path) => {
    render(<MarkdownImage src={src} filePath="C:/notes/test.md" alt="figure" onZoom={vi.fn()} />)
    await waitFor(() => expect(screen.getByAltText('figure').getAttribute('src')).toBeTruthy())
    expect(mocks.prepare).toHaveBeenCalledWith('C:/notes/test.md', path)
  })

  it.each(['https://example.com/a.png', 'data:image/png;base64,AAAA', 'blob:example', 'asset://localhost/a', 'file:///a.png', '#figure'])('leaves %s unchanged', (src) => {
    render(<MarkdownImage src={src} filePath="C:/notes/test.md" alt="figure" onZoom={vi.fn()} />)
    expect(screen.getByAltText('figure').getAttribute('src')).toBe(src)
    expect(mocks.prepare).not.toHaveBeenCalled()
  })

  it('preserves browser and unsaved-document behavior', () => {
    mocks.desktop = false
    const { rerender } = render(<MarkdownImage src="figure.png" filePath="C:/notes/test.md" alt="figure" onZoom={vi.fn()} />)
    expect(screen.getByAltText('figure').getAttribute('src')).toBe('figure.png')
    mocks.desktop = true
    rerender(<MarkdownImage src="figure.png" filePath={null} alt="figure" onZoom={vi.fn()} />)
    expect(screen.getByAltText('figure').getAttribute('src')).toBe('figure.png')
    expect(mocks.prepare).not.toHaveBeenCalled()
  })

  it('does not issue an asset request when authorization fails', async () => {
    mocks.prepare.mockRejectedValue(new Error('outside the Markdown directory'))
    render(<MarkdownImage src="C:/private/secret.png" filePath="C:/notes/test.md" alt="figure" onZoom={vi.fn()} />)
    await waitFor(() => expect(screen.getByRole('button').getAttribute('title')).toContain('无法加载图片'))
    expect(screen.getByAltText('figure').getAttribute('src')).toBeNull()
    expect(mocks.convert).not.toHaveBeenCalled()
  })

  it('ignores an old authorization result after switching documents', async () => {
    let resolveOld!: (path: string) => void
    mocks.prepare.mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve }))
    const { rerender } = render(<MarkdownImage src="figure.png" filePath="C:/old/test.md" alt="figure" onZoom={vi.fn()} />)
    rerender(<MarkdownImage src="figure.png" filePath="C:/new/test.md" alt="figure" onZoom={vi.fn()} />)
    await waitFor(() => expect(screen.getByAltText('figure').getAttribute('src')).toContain(encodeURIComponent('C:/new/figure.png')))
    await act(async () => resolveOld('C:/old/figure.png'))
    expect(screen.getByAltText('figure').getAttribute('src')).toContain(encodeURIComponent('C:/new/figure.png'))
  })

  it('does not keep a previous image visible while a new path is awaiting authorization', async () => {
    const { rerender } = render(<MarkdownImage src="first.png" filePath="C:/notes/test.md" alt="figure" onZoom={vi.fn()} />)
    await waitFor(() => expect(screen.getByAltText('figure').getAttribute('src')).toBeTruthy())
    mocks.prepare.mockReturnValue(new Promise(() => {}))
    rerender(<MarkdownImage src="second.png" filePath="C:/notes/test.md" alt="figure" onZoom={vi.fn()} />)
    expect(screen.getByAltText('figure').getAttribute('src')).toBeNull()
  })
})
