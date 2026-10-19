import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReadingArtifact } from '@/services/database/readingArtifacts'
import type { ReadingArtifactCenterPage } from '@/services/database/readingArtifactCenter'

const mocks = vi.hoisted(() => ({ page: vi.fn(), documents: vi.fn(), reducedMotion: false, databaseReady: false, organization: vi.fn() }))
vi.mock('@/services/database/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/database/db')>()),
  isDatabaseReady: () => mocks.databaseReady,
}))
vi.mock('@/services/database/artifactOrganization', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/database/artifactOrganization')>()),
  loadArtifactOrganization: mocks.organization,
}))
vi.mock('@/services/database/readingArtifactCenter', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/database/readingArtifactCenter')>()),
  loadReadingArtifactCenterItemsPage: mocks.page,
  loadReadingArtifactDocumentSummariesPage: mocks.documents,
}))
vi.mock('motion/react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('motion/react')>()),
  useReducedMotion: () => mocks.reducedMotion,
}))

import { ReadingArtifactCenter } from '@/components/reading-artifacts/ReadingArtifactCenter'

function page(start: number, count: number, hasMore: boolean): ReadingArtifactCenterPage {
  const artifacts: ReadingArtifact[] = Array.from({ length: count }, (_, index) => ({
    id: `paging-${start + index}`, type: 'summary', title: `成果 ${start + index}`,
    content: '匿名内容', structuredContent: {}, source: null, status: 'active',
    createdAt: 1000 - start - index, updatedAt: 1000 - start - index,
  }))
  return { marks: [], artifacts, total: 7, hasMore }
}

describe('ReadingArtifactCenter automatic paging', () => {
  let observers: { callback: IntersectionObserverCallback; target?: Element; root?: Element | Document | null; disconnected: boolean }[]
  beforeEach(() => {
    observers = []
    // These paging/entrance fixtures keep all twelve cards inside the viewport.
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(2400)
    mocks.reducedMotion = false
    mocks.databaseReady = false
    mocks.organization.mockReset().mockResolvedValue({ categories: [], entries: [] })
    mocks.page.mockReset().mockResolvedValueOnce(page(0, 5, true))
    mocks.documents.mockReset().mockResolvedValue({ documents: [], total: 0, hasMore: false })
    vi.stubGlobal('IntersectionObserver', class {
      entry: typeof observers[number]
      constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
        this.entry = { callback, root: options?.root, disconnected: false }
        observers.push(this.entry)
      }
      observe(target: Element) { this.entry.target = target }
      disconnect() { this.entry.disconnected = true }
    })
  })
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers() })

  async function open() {
    const result = render(<ReadingArtifactCenter onOpenAiSource={vi.fn()} />)
    await screen.findByText('成果 4')
    await waitFor(() => expect(observers.length).toBeGreaterThan(0))
    const observer = observers.find((entry) => !entry.disconnected && entry.target?.textContent?.includes('成果 3') && !entry.target.classList.contains('gm-artifact-card-pending'))!
    const scroller = screen.getByRole('region', { name: '阅读成果内容' })
    const initial = observers.filter((entry) => entry.target?.classList.contains('gm-artifact-card-pending'))
    if (initial.length) act(() => intersect(initial[initial.length - 1]))
    scroller.querySelectorAll('.gm-artifact-card-enter').forEach((card) => {
      fireEvent.animationEnd(card)
      fireEvent(card, new Event('webkitAnimationEnd', { bubbles: true }))
    })
    return { ...result, observer, scroller }
  }
  function intersect(observer: typeof observers[number]) {
    observer.callback([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver)
  }

  it('prefetches at the second last card once, preserves scroll and old cards, and staggers only appended cards', async () => {
    let resolve!: (value: ReadingArtifactCenterPage) => void
    mocks.page.mockImplementationOnce(() => new Promise<ReadingArtifactCenterPage>((done) => { resolve = done }))
    const { observer, scroller } = await open()
    expect(mocks.page).toHaveBeenNthCalledWith(1, expect.objectContaining({ limit: 5, offset: 0 }))
    expect(observer.root).toBe(scroller)
    expect(observer.target).toHaveTextContent('成果 3')
    const oldCard = screen.getByText('成果 0')
    scroller.scrollTop = 420
    act(() => { intersect(observer); intersect(observer) })
    expect(mocks.page).toHaveBeenCalledTimes(2)
    expect(mocks.page).toHaveBeenLastCalledWith(expect.objectContaining({ limit: 5, offset: 5 }))
    expect(screen.getByRole('status')).toHaveTextContent('正在加载更多阅读成果')
    expect(scroller.querySelectorAll('.gm-artifact-loading-dots > i')).toHaveLength(3)
    expect(scroller.scrollTop).toBe(420)
    await act(async () => resolve(page(5, 2, false)))
    expect(await screen.findByText('成果 6')).toBeInTheDocument()
    expect(screen.getByText('成果 0')).toBe(oldCard)
    expect(scroller.scrollTop).toBe(420)
    expect(scroller.querySelectorAll('.gm-artifact-card-pending')).toHaveLength(2)
    expect(scroller.querySelector('.gm-artifact-card-enter')).toBeNull()
    act(() => {
      const pending = observers.filter((entry) => entry.target?.classList.contains('gm-artifact-card-pending'))
      intersect(pending[pending.length - 1])
    })
    const entering = scroller.querySelectorAll<HTMLElement>('.gm-artifact-card-enter')
    expect(entering).toHaveLength(2)
    expect(Number.parseFloat(entering[1].style.getPropertyValue('--gm-artifact-enter-delay')) - Number.parseFloat(entering[0].style.getPropertyValue('--gm-artifact-enter-delay'))).toBe(50)
    fireEvent.animationEnd(entering[0])
    fireEvent(entering[0], new Event('webkitAnimationEnd', { bubbles: true }))
    await waitFor(() => expect(entering[0]).not.toHaveClass('gm-artifact-card-enter'))
    expect(screen.getByText('没有更多了')).toBeInTheDocument()
    act(() => intersect(observer))
    expect(mocks.page).toHaveBeenCalledTimes(2)
  })

  it('keeps loaded cards on failure and retries the same offset without automatic retry loops', async () => {
    mocks.page.mockRejectedValueOnce(new Error('临时查询失败')).mockResolvedValueOnce(page(5, 2, false))
    const { observer, scroller } = await open()
    scroller.scrollTop = 300
    act(() => intersect(observer))
    await screen.findByText('加载失败：临时查询失败')
    expect(screen.getByText('成果 0')).toBeInTheDocument()
    act(() => intersect(observer))
    expect(mocks.page).toHaveBeenCalledTimes(2)
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    await screen.findByText('成果 6')
    expect(mocks.page).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 5 }))
    expect(scroller.scrollTop).toBe(300)
  })

  it('ignores a late page after switching views and disconnects the observer', async () => {
    let resolve!: (value: ReadingArtifactCenterPage) => void
    mocks.page.mockImplementationOnce(() => new Promise<ReadingArtifactCenterPage>((done) => { resolve = done }))
    const { observer } = await open()
    act(() => intersect(observer))
    fireEvent.click(screen.getByRole('tab', { name: '按文档' }))
    await screen.findByText('当前条件下没有文档成果')
    await act(async () => resolve(page(5, 2, false)))
    expect(screen.queryByText('成果 6')).not.toBeInTheDocument()
    expect(observer.disconnected).toBe(true)
  })

  it('shows appended cards without entry motion when reduced motion is enabled', async () => {
    mocks.reducedMotion = true
    mocks.page.mockResolvedValueOnce(page(5, 2, false))
    const { observer, scroller } = await open()
    act(() => intersect(observer))
    await screen.findByText('成果 6')
    expect(scroller.querySelector('.gm-artifact-card-enter')).toBeNull()
  })

  it('stops prefetching when a page contains no new keys', async () => {
    const duplicatePage = page(0, 5, true)
    mocks.page.mockResolvedValueOnce({ ...duplicatePage, artifacts: Array.from({ length: 5 }, (_, index) => duplicatePage.artifacts[index % 5]) })
    const { observer } = await open()
    act(() => intersect(observer))
    await screen.findByText('没有更多了')
    expect(screen.getAllByText(/^成果 \d+$/)).toHaveLength(5)
    act(() => intersect(observer))
    expect(mocks.page).toHaveBeenCalledTimes(2)
  })

  it('keeps unfinished upper cards ahead of a later batch even when lower visibility callbacks arrive first', async () => {
    const clock = vi.spyOn(performance, 'now').mockReturnValue(1000)
    try {
      mocks.page.mockResolvedValueOnce(page(5, 5, true)).mockResolvedValueOnce(page(10, 2, false))
      const { observer, scroller } = await open()
      act(() => intersect(observer))
      await screen.findByText('成果 9')
      const upper = observers.find((entry) => entry.target?.classList.contains('gm-artifact-card-pending') && entry.target.textContent?.includes('成果 8'))!
      act(() => intersect(upper))
      expect(scroller.querySelectorAll('.gm-artifact-card-enter')).toHaveLength(4)
      expect(scroller.querySelectorAll('.gm-artifact-card-pending')).toHaveLength(1)
      const nextPrefetch = observers.find((entry) => !entry.disconnected && entry.target?.textContent?.includes('成果 8') && !entry.target.classList.contains('gm-artifact-card-enter'))!
      act(() => intersect(nextPrefetch))
      await screen.findByText('成果 11')
      const lower = observers.find((entry) => entry.target?.classList.contains('gm-artifact-card-pending') && entry.target.textContent?.includes('成果 11'))!
      act(() => intersect(lower))
      const entering = [...scroller.querySelectorAll<HTMLElement>('.gm-artifact-card-enter')]
      expect(entering).toHaveLength(7)
      expect(entering.map((element) => Number.parseFloat(element.style.getPropertyValue('--gm-artifact-enter-delay')))).toEqual([250, 300, 350, 400, 450, 500, 550])
      expect(scroller.querySelector('.gm-artifact-card-pending')).toBeNull()
    } finally {
      clock.mockRestore()
    }
  })

  it('defers initial queries, cancels a hidden opening and animates the first visible page', async () => {
    vi.useFakeTimers()
    const result = render(<ReadingArtifactCenter onOpenAiSource={vi.fn()} />)
    await act(async () => { vi.advanceTimersByTime(239) })
    expect(mocks.page).not.toHaveBeenCalled()
    expect(mocks.organization).not.toHaveBeenCalled()
    result.rerender(<ReadingArtifactCenter active={false} onOpenAiSource={vi.fn()} />)
    await act(async () => { vi.advanceTimersByTime(500) })
    expect(mocks.page).not.toHaveBeenCalled()
    result.rerender(<ReadingArtifactCenter active onOpenAiSource={vi.fn()} />)
    await act(async () => { vi.advanceTimersByTime(240) })
    expect(mocks.page).toHaveBeenCalledTimes(1)
    expect(mocks.organization).toHaveBeenCalledTimes(1)
    const scroller = screen.getByRole('region', { name: '阅读成果内容' })
    expect(scroller.querySelectorAll('.gm-artifact-card-pending')).toHaveLength(5)
    const pending = observers.filter((entry) => entry.target?.classList.contains('gm-artifact-card-pending'))
    act(() => intersect(pending[pending.length - 1]))
    expect(scroller.querySelectorAll('.gm-artifact-card-enter')).toHaveLength(5)
  })

  it('uses five-card automatic pages and the same entrances in document detail', async () => {
    mocks.databaseReady = true
    mocks.documents.mockResolvedValue({ documents: [{ documentId: '__independent__', filePath: '', fileName: '独立成果', total: 7, highlights: 0, annotations: 0, aiArtifacts: 7, latestCreatedAt: 1000 }], total: 1, hasMore: false })
    const { scroller } = await open()
    mocks.page.mockResolvedValueOnce(page(0, 5, true)).mockResolvedValueOnce(page(5, 2, false))
    fireEvent.click(screen.getByRole('tab', { name: '按文档' }))
    fireEvent.click(await screen.findByRole('button', { name: /独立成果/ }))
    await screen.findByText('成果 4')
    expect(mocks.page).toHaveBeenLastCalledWith(expect.objectContaining({ view: 'detail', limit: 5, offset: 0 }))
    expect(scroller.querySelectorAll('.gm-artifact-card-pending')).toHaveLength(5)
    const initial = observers.filter((entry) => !entry.disconnected && entry.target?.classList.contains('gm-artifact-card-pending'))
    act(() => intersect(initial[initial.length - 1]))
    scroller.querySelectorAll('.gm-artifact-card-enter').forEach((card) => {
      fireEvent.animationEnd(card)
      fireEvent(card, new Event('webkitAnimationEnd', { bubbles: true }))
    })
    const retained = screen.getByText('成果 0')
    scroller.scrollTop = 300
    const prefetch = observers.findLast((entry) => !entry.disconnected && entry.target?.textContent?.includes('成果 1') && !entry.target.classList.contains('gm-artifact-card-pending'))!
    act(() => { intersect(prefetch); intersect(prefetch) })
    await screen.findByText('成果 6')
    expect(mocks.page).toHaveBeenLastCalledWith(expect.objectContaining({ view: 'detail', limit: 5, offset: 5 }))
    expect(screen.getByText('成果 0')).toBe(retained)
    expect(scroller.scrollTop).toBe(300)
    expect(scroller.querySelectorAll('.gm-artifact-card-pending')).toHaveLength(2)
    expect(screen.queryByRole('button', { name: '加载更多' })).not.toBeInTheDocument()
  })

  it('loads only the latest view after the opening delay and cancels the timer on unmount', async () => {
    vi.useFakeTimers()
    const result = render(<ReadingArtifactCenter onOpenAiSource={vi.fn()} />)
    fireEvent.click(screen.getByRole('tab', { name: '按文档' }))
    await act(async () => { vi.advanceTimersByTime(240) })
    expect(mocks.page).not.toHaveBeenCalled()
    expect(mocks.documents).toHaveBeenCalledTimes(1)
    result.unmount()
    mocks.organization.mockClear()
    const reopened = render(<ReadingArtifactCenter onOpenAiSource={vi.fn()} />)
    reopened.unmount()
    await act(async () => { vi.advanceTimersByTime(500) })
    expect(mocks.page).not.toHaveBeenCalled()
    expect(mocks.organization).not.toHaveBeenCalled()
  })
})
