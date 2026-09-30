import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MarkdownPreview } from '@/components/editor/MarkdownPreview'
import { resolveMarkdownLink } from '@/services/markdownLinks'

const mocks = vi.hoisted(() => ({ desktop: true, follow: vi.fn(), error: vi.fn() }))
vi.mock('@/hooks/useTauri', () => ({ isTauri: () => mocks.desktop }))
vi.mock('@/services/markdownLinkActions', () => ({ followMarkdownLink: mocks.follow }))
vi.mock('@/services/toast', () => ({ toast: { error: mocks.error } }))
beforeEach(() => { mocks.desktop = true; mocks.follow.mockReset().mockResolvedValue(undefined) })
afterEach(cleanup)

describe('local Markdown link resolution', () => {
  it.each([
    ['E:/notes/参数.md', 'E:/notes/参数.md'],
    ['E%3A/notes/%E5%8F%82%E6%95%B0.md', 'E:/notes/参数.md'],
    ['E:\\notes\\参数.md', 'E:/notes/参数.md'],
    ['file:///E:/notes/参数.md', 'E:/notes/参数.md'],
    ['file%3A///E:/notes/参数.md', 'E:/notes/参数.md'],
    ['./子目录/参数.md', 'E:/notes/子目录/参数.md'],
    ['../公共/参数.md', 'E:/公共/参数.md'],
    ['图%20表.md', 'E:/notes/图 表.md'],
    ['report%231.md', 'E:/notes/report#1.md'],
    ['/公共/test.md', 'E:/公共/test.md'],
  ])('resolves %s against the source document, not tauri.localhost', (href, path) => {
    expect(resolveMarkdownLink(href, 'E:/notes/SUMMARY.md')).toEqual({ kind: 'markdown', path, fragment: '' })
  })
  it('handles verbatim Windows source paths and literal percent characters', () => {
    expect(resolveMarkdownLink('next.md', '\\\\?\\E:\\100%\\SUMMARY.md')).toMatchObject({ path: 'E:/100%/next.md' })
  })
  it('keeps fragments separate from filesystem paths', () => {
    expect(resolveMarkdownLink('report.md#%E7%BB%93%E6%9E%9C', 'E:/notes/source.md')).toEqual({ kind: 'markdown', path: 'E:/notes/report.md', fragment: '结果' })
  })
  it('classifies images and unsupported files without executing them', () => {
    expect(resolveMarkdownLink('E:/figure.png').kind).toBe('image')
    expect(resolveMarkdownLink('E:/script.exe').kind).toBe('unsupported')
  })
  it.each(['https://example.com/report', 'http://localhost:8000/report', 'mailto:test@example.com'])('preserves external address %s', (href) => {
    expect(resolveMarkdownLink(href)).toEqual({ kind: 'web', url: href })
  })
  it.each(['', 'javascript:alert(1)', 'data:text/html,test', 'tauri://localhost', 'https://tauri.localhost/foo', 'http://asset.localhost/x', 'https://tauri.localhost./', 'E:relative.md', 'file:///E:/notes/test.md?query=1', 'E:/notes/%00.md'])('rejects invalid/internal/unsafe address %s', (href) => {
    expect(() => resolveMarkdownLink(href, 'E:/notes/source.md')).toThrow()
  })
  it('requires a saved base for relative links only', () => {
    expect(() => resolveMarkdownLink('next.md')).toThrow('请先保存')
    expect(resolveMarkdownLink('E:/next.md')).toMatchObject({ path: 'E:/next.md' })
    expect(resolveMarkdownLink('#section')).toEqual({ kind: 'anchor', fragment: 'section' })
  })
})

describe('real preview link clicks', () => {
  it.each([
    '[参数](E:/notes/参数.md)',
    '[参数](../参数.md)',
    '[参数](file:///E:/notes/参数.md)',
    '<div>\n\n[参数](E:/notes/参数.md)\n\n</div>',
  ])('intercepts local navigation in %s', async (content) => {
    render(<MarkdownPreview content={content} filePath="E:/notes/source.md" />)
    const link = await screen.findByRole('link', { name: '参数' })
    const click = new MouseEvent('click', { bubbles: true, cancelable: true })
    await act(async () => { link.dispatchEvent(click) })
    expect(click.defaultPrevented).toBe(true)
    expect(link.getAttribute('target')).toBeNull()
    await waitFor(() => expect(mocks.follow).toHaveBeenCalled())
    const [href, source, label] = mocks.follow.mock.calls[0]
    expect(resolveMarkdownLink(href, source).kind).toBe('markdown')
    expect(label).toBe('参数')
  })
  it('also intercepts middle clicks instead of opening the internal origin', async () => {
    render(<MarkdownPreview content="[参数](E:/notes/参数.md)" filePath="E:/notes/source.md" />)
    const event = new MouseEvent('auxclick', { button: 1, bubbles: true, cancelable: true })
    await act(async () => { screen.getByRole('link').dispatchEvent(event) })
    expect(event.defaultPrevented).toBe(true)
    expect(mocks.follow).toHaveBeenCalledTimes(1)
  })
  it('does not give a filtered empty href a browser target', async () => {
    mocks.follow.mockRejectedValue(new Error('链接地址为空'))
    render(<MarkdownPreview content="[bad](javascript:alert%281%29)" filePath="E:/notes/source.md" />)
    const link = screen.getByText('bad').closest('a')!
    expect(link.getAttribute('href')).toBeNull()
    expect(link.getAttribute('target')).toBeNull()
    fireEvent.click(link)
    await waitFor(() => expect(mocks.error).toHaveBeenCalled())
  })
  it('leaves same-document anchors on the existing handler', () => {
    render(<MarkdownPreview content="[jump](#missing)" filePath="E:/notes/source.md" />)
    fireEvent.click(screen.getByRole('link'))
    expect(mocks.follow).not.toHaveBeenCalled()
  })
  it('preserves normal browser mode web links', () => {
    mocks.desktop = false
    render(<MarkdownPreview content="[web](https://example.com)" />)
    expect(screen.getByRole('link').getAttribute('target')).toBe('_blank')
    expect(mocks.follow).not.toHaveBeenCalled()
  })
})
