import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReadingArtifact } from '@/services/database/readingArtifacts'
import type { ReadingMark } from '@/services/readingMarks'

const mocks = vi.hoisted(() => ({ page: vi.fn(), documents: vi.fn(), organization: vi.fn(), update: vi.fn(), markdown: vi.fn() }))
vi.mock('@/services/database/readingArtifactCenter', async (original) => ({
  ...(await original<typeof import('@/services/database/readingArtifactCenter')>()),
  loadReadingArtifactCenterItemsPage: mocks.page, loadReadingArtifactDocumentSummariesPage: mocks.documents,
}))
vi.mock('@/services/database/db', async (original) => ({ ...(await original<typeof import('@/services/database/db')>()), isDatabaseReady: () => true }))
vi.mock('@/services/database/artifactOrganization', async (original) => ({
  ...(await original<typeof import('@/services/database/artifactOrganization')>()),
  loadArtifactOrganization: mocks.organization, setArtifactOrganization: mocks.update,
}))
vi.mock('@/hooks/useTauri', async (original) => ({ ...(await original<typeof import('@/hooks/useTauri')>()), fileExists: async () => false }))
vi.mock('motion/react', async (original) => ({ ...(await original<typeof import('motion/react')>()), useReducedMotion: () => true }))
vi.mock('react-markdown', () => ({ default: ({ children }: { children: string }) => { mocks.markdown(); return <div>{children}</div> } }))

import { ReadingArtifactCenter } from '@/components/reading-artifacts/ReadingArtifactCenter'

const marks: ReadingMark[] = Array.from({ length: 60 }, (_, index) => ({
  id: `mark-${index}`, documentId: 'path:c:/fixture/test.md', documentPath: 'C:/fixture/test.md',
  type: 'annotation', color: 'yellow', note: `批注 ${index}`,
  anchor: { startOffset: 0, endOffset: 4, quote: Array.from({ length: 8 }, () => '匿名原文').join('\n'), contextBefore: '', contextAfter: '', range: { startBlockId: 'pb-0', startOffset: 0, endBlockId: 'pb-0', endOffset: 4 } },
  createdAt: 1000 - index, updatedAt: 1000 - index,
}))
const artifacts: ReadingArtifact[] = Array.from({ length: 60 }, (_, index) => ({
  id: `ai-${index}`, type: 'summary', title: `成果 ${index}`, content: `回复 ${index}`, structuredContent: { question: `问题 ${index}` },
  source: null, status: 'active', createdAt: 1000 - index, updatedAt: 1000 - index,
}))
const nextFrame = () => act(async () => { await new Promise<void>((resolve) => requestAnimationFrame(() => resolve())) })

describe('成果卡片虚拟卸载与正文隔离', () => {
  beforeEach(() => {
    mocks.page.mockReset()
    mocks.documents.mockReset().mockResolvedValue({ documents: [{ documentId: '__independent__', filePath: '', fileName: '独立成果', total: 60, highlights: 0, annotations: 0, aiArtifacts: 60, latestCreatedAt: 1000 }], total: 1, hasMore: false })
    mocks.organization.mockReset().mockResolvedValue({ categories: [], entries: [] })
    mocks.update.mockReset().mockResolvedValue(undefined)
    mocks.markdown.mockClear()
    vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} })
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return this.getAttribute('aria-label') === '阅读成果内容' ? 300 : 0
    })
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(400)
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return this.dataset.artifactRow ? 220 : 0
    })
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const top = this.hasAttribute('data-artifact-virtual-list') ? -(screen.queryByRole('region', { name: '阅读成果内容' })?.scrollTop ?? 0) : 0
      return { x: 0, y: top, top, left: 0, bottom: top + 300, right: 400, width: 400, height: 300, toJSON() {} }
    })
  })
  afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

  it('折叠长文本首次挂载和回滚重挂时，首轮测量不会暴露全文高度', async () => {
    const samples: Array<{ key: string; visibility: string; maxHeight: string; height: string; expandButton: boolean }> = []
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
      if (!this.dataset.artifactRow) return 0
      const text = this.querySelector<HTMLElement>('.font-serif')
      if (text) {
        const clip = text.parentElement!
        samples.push({ key: this.dataset.artifactRow, visibility: clip.style.visibility, maxHeight: text.style.maxHeight, height: clip.style.height,
          expandButton: [...this.querySelectorAll('button')].some((button) => button.textContent === '展开全文') })
      }
      return 220
    })
    mocks.page.mockResolvedValue({ marks, artifacts: [], total: 60, hasMore: false })
    render(<ReadingArtifactCenter onOpenAiSource={vi.fn()} />)
    await screen.findByText('批注 0')
    const scroller = screen.getByRole('region', { name: '阅读成果内容' })
    scroller.scrollTop = 5000
    fireEvent.scroll(scroller)
    await nextFrame()
    expect(screen.queryByText('批注 0')).toBeNull()
    const sampleCount = samples.length
    scroller.scrollTop = 0
    fireEvent.scroll(scroller)
    await nextFrame()
    expect(screen.getByText('批注 0')).toBeInTheDocument()
    expect(samples.filter((sample) => sample.visibility === 'hidden').length).toBeGreaterThan(1)
    expect(samples.every((sample) => sample.visibility === 'hidden' ? sample.maxHeight === '3lh' : sample.height !== '')).toBe(true)
    expect(samples.slice(sampleCount).find((sample) => sample.key === 'mark:mark-0')?.expandButton).toBe(true)
  })

  it('人工成果的展开状态和未保存批注在卸载重挂后保留，入场不重播', async () => {
    mocks.page.mockResolvedValue({ marks, artifacts: [], total: 60, hasMore: false })
    render(<ReadingArtifactCenter onOpenAiSource={vi.fn()} />)
    const first = (await screen.findByText('批注 0')).closest('article')!
    fireEvent.click(within(first).getByRole('button', { name: '展开全文' }))
    fireEvent.click(within(first).getByRole('button', { name: '编辑批注' }))
    fireEvent.change(within(first).getByRole('textbox'), { target: { value: '未保存的匿名草稿' } })
    const second = screen.getByText('批注 1').closest('article')!
    act(() => within(second).getByRole('button', { name: '编辑批注' }).focus())
    const scroller = screen.getByRole('region', { name: '阅读成果内容' })
    scroller.scrollTop = 5000
    fireEvent.scroll(scroller)
    await nextFrame()
    expect(document.body.contains(first)).toBe(false)
    expect(document.querySelectorAll('article').length).toBeLessThan(10)
    scroller.scrollTop = 0
    fireEvent.scroll(scroller)
    await nextFrame()
    expect(screen.getByRole('textbox')).toHaveValue('未保存的匿名草稿')
    const restored = screen.getByRole('textbox').closest('article')!
    fireEvent.click(within(restored).getByRole('button', { name: '取消' }))
    expect(within(restored).getByRole('button', { name: '收起' })).toHaveAttribute('aria-expanded', 'true')
    expect(restored.closest('.gm-artifact-card-enter')).toBeNull()
  })

  it('收藏刷新保留相同卡片引用，已展开的 Markdown 正文不重渲染', async () => {
    mocks.page.mockResolvedValue({ marks: [], artifacts, total: 60, hasMore: false })
    render(<ReadingArtifactCenter onOpenAiSource={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'AI · 摘要 问题 0 展开' }))
    await screen.findByText('回复 0', { selector: '[aria-label="AI 回复正文"] div' })
    const renders = mocks.markdown.mock.calls.length
    mocks.organization.mockResolvedValue({ categories: [], entries: [{ artifactKey: 'ai:ai-0', favorite: true, categoryIds: [] }] })
    fireEvent.click(screen.getByRole('button', { name: '收藏 成果 0' }))
    await screen.findByRole('button', { name: '取消收藏 成果 0' })
    await waitFor(() => expect(mocks.page).toHaveBeenCalledTimes(2))
    expect(mocks.markdown).toHaveBeenCalledTimes(renders)
  })

  it('文档详情同样限制挂载数量，并保留时间顺序及尾部可达性', async () => {
    mocks.page.mockResolvedValue({ marks: [], artifacts, total: 60, hasMore: false })
    render(<ReadingArtifactCenter onOpenAiSource={vi.fn()} />)
    await screen.findByRole('button', { name: 'AI · 摘要 问题 0 展开' })
    fireEvent.click(screen.getByRole('tab', { name: '按文档' }))
    fireEvent.click(await screen.findByRole('button', { name: /独立成果/ }))
    await screen.findByRole('button', { name: 'AI · 摘要 问题 59 展开' })
    expect(mocks.page).toHaveBeenLastCalledWith(expect.objectContaining({ view: 'detail' }))
    expect(document.querySelectorAll('article').length).toBeLessThan(10)
    const scroller = screen.getByRole('region', { name: '阅读成果内容' })
    scroller.scrollTop = 100000
    fireEvent.scroll(scroller)
    await nextFrame()
    expect(screen.getByRole('button', { name: 'AI · 摘要 问题 0 展开' })).toBeInTheDocument()
    expect(document.querySelectorAll('article').length).toBeLessThan(10)
  })

  it('AI 卡片卸载后恢复展开、回复滚动和原始选区开关，主动收起则重置内层状态', async () => {
    const first = { ...artifacts[0], structuredContent: { question: '问题 0', originalSelections: [{ title: '匿名选区', text: '匿名文本', filePath: null, truncated: false, previewOnly: false }] } }
    mocks.page.mockResolvedValue({ marks: [], artifacts: [first, ...artifacts.slice(1)], total: 60, hasMore: false })
    render(<ReadingArtifactCenter onOpenAiSource={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'AI · 摘要 问题 0 展开' }))
    const reply = await screen.findByLabelText('AI 回复正文')
    reply.scrollTop = 84
    fireEvent.scroll(reply)
    const selections = screen.getByText('原始选区 · 1').closest('details')!
    selections.open = true
    fireEvent(selections, new Event('toggle'))
    act(() => screen.getByRole('button', { name: '收藏 成果 1' }).focus())
    const scroller = screen.getByRole('region', { name: '阅读成果内容' })
    scroller.scrollTop = 5000
    fireEvent.scroll(scroller)
    await nextFrame()
    expect(document.body.contains(reply)).toBe(false)
    scroller.scrollTop = 0
    fireEvent.scroll(scroller)
    await nextFrame()
    expect(screen.getByLabelText('AI 回复正文').scrollTop).toBe(84)
    expect(screen.getByText('原始选区 · 1').closest('details')).toHaveAttribute('open')
    fireEvent.click(screen.getByRole('button', { name: 'AI · 摘要 问题 0 收起' }))
    fireEvent.click(screen.getByRole('button', { name: 'AI · 摘要 问题 0 展开' }))
    expect(screen.getByLabelText('AI 回复正文').scrollTop).toBe(0)
    expect(screen.getByText('原始选区 · 1').closest('details')).not.toHaveAttribute('open')
  })
})
