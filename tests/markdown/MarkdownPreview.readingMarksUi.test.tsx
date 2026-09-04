import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MutableRefObject } from 'react'
import { MarkdownPreview } from '@/components/editor/MarkdownPreview'
import { AnnotationHoverOverlay, type AnnotationHoverOverlayHandle } from '@/components/editor/AnnotationHoverOverlay'
import { createMarkdownPreviewModel } from '@/services/markdownPreviewModel'
import { createReadingMarkAnchor, readingDocumentId, type ReadingMark, type UpdateReadingMarkPatch } from '@/services/readingMarks'
import { getTextForSourceRange, buildDocumentRangeInfo } from '@/services/previewHighlight'
import { getReadingMarkToolbarLayout, getReadingMarkToolbarPosition } from '@/components/editor/ReadingMarkToolbarContent'
import type { MarkdownPreviewHandle } from '@/components/editor/markdownPreviewTypes'

const content = '第一段批注目标。第二段批注目标。'
const documentPath = 'C:/temp/批注测试.md'
const emptyReadingMarks: ReadingMark[] = []

function makeRect(top: number, left = 0, width = 120, height = 20) {
  return { top, right: left + width, bottom: top + height, left, width, height, x: left, y: top, toJSON: () => ({}) } as DOMRect
}

function makeMark(id: string, quote: string, note: string, color: ReadingMark['color'] = 'yellow'): ReadingMark {
  const model = createMarkdownPreviewModel(content)
  const from = content.indexOf(quote)
  const to = from + quote.length
  const info = buildDocumentRangeInfo(model, from, to)
  if (!info) throw new Error('test range missing')
  const anchor = createReadingMarkAnchor(model, {
    range: info.range,
    from,
    to,
    text: getTextForSourceRange(model, from, to),
    startLine: 1,
    endLine: 1,
  })
  return {
    id,
    documentId: readingDocumentId(documentPath),
    documentPath,
    type: 'annotation',
    anchor,
    color,
    note,
    createdAt: 1,
    updatedAt: 1,
  }
}

let host: HTMLDivElement | null = null
let originalCaretRangeFromPoint: ((x: number, y: number) => Range | null) | undefined

beforeEach(() => {
  host = document.createElement('div')
  Object.defineProperties(host, {
    clientHeight: { configurable: true, value: 600 },
    clientWidth: { configurable: true, value: 700 },
  })
  document.body.appendChild(host)
  originalCaretRangeFromPoint = (document as Document & { caretRangeFromPoint?: (x: number, y: number) => Range | null }).caretRangeFromPoint
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const block = this.closest<HTMLElement>('[data-md-block-index]')
    if (block) return makeRect(Number.parseFloat(block.style.top) || 0, 40, 600, 80)
    if (this.classList.contains('gm-reading-mark-toolbar')) return makeRect(0, 0, this.classList.contains('is-expanded') ? 178 : 38, 38)
    if (this.classList.contains('gm-reading-mark-popover')) return makeRect(0, 0, 280, 140)
    return makeRect(0, 0, 700, 600)
  })
  const rangePrototype = Range.prototype as Range & { getClientRects?: () => DOMRectList; getBoundingClientRect?: () => DOMRect }
  if (!rangePrototype.getClientRects) Object.defineProperty(Range.prototype, 'getClientRects', { configurable: true, value: () => [] })
  if (!rangePrototype.getBoundingClientRect) Object.defineProperty(Range.prototype, 'getBoundingClientRect', { configurable: true, value: () => makeRect(100, 80, 180, 20) })
  vi.spyOn(Range.prototype, 'getClientRects').mockImplementation(() => [makeRect(100, 80, 180, 20)] as unknown as DOMRectList)
  vi.spyOn(Range.prototype, 'getBoundingClientRect').mockImplementation(() => makeRect(100, 80, 180, 20))
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  if (host) host.remove()
  ;(document as Document & { caretRangeFromPoint?: (x: number, y: number) => Range | null }).caretRangeFromPoint = originalCaretRangeFromPoint
  host = null
})

describe('MarkdownPreview 批注浮层', () => {
  it('优先以触发鼠标点定位，并在视口边缘翻转或夹紧', () => {
    const originalWidth = window.innerWidth
    const originalHeight = window.innerHeight
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 400 })
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 300 })
    try {
      expect(getReadingMarkToolbarPosition(
        { top: 100, right: 260, bottom: 120, left: 80, triggerPoint: { x: 200, y: 210 } },
        { width: 30, height: 30, borderRadius: 10, padding: 0 },
      )).toEqual({ left: 200, top: 62 })
      expect(getReadingMarkToolbarPosition(
        { top: 10, right: 390, bottom: 30, left: 350, triggerPoint: { x: 390, y: 10 } },
        { width: 170, height: 32, borderRadius: 10, padding: 0 },
      )).toEqual({ left: 307, top: 38 })
      expect(getReadingMarkToolbarPosition(
        { top: 100, right: 260, bottom: 120, left: 80 },
        { width: 30, height: 30, borderRadius: 10, padding: 0 },
      )).toEqual({ left: 170, top: 62 })
    } finally {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalWidth })
      Object.defineProperty(window, 'innerHeight', { configurable: true, value: originalHeight })
    }
  })

  it('冲突展开胶囊为两段提示文案保留匹配宽度，折叠态仍为入口尺寸', () => {
    expect(getReadingMarkToolbarLayout('colors', false, false, 'create').width).toBe(30)
    expect(getReadingMarkToolbarLayout('colors', true, true, 'create').width).toBe(208)
  })

  it('默认没有常驻入口，Hover 后分别打开各自内容', async () => {
    const first = makeMark('mark-1', '第一段批注目标', '第一条批注')
    const second = makeMark('mark-2', '第二段批注目标', '第二条批注')
    const overlayRef = { current: null } as MutableRefObject<AnnotationHoverOverlayHandle | null>
    const onUpdate = vi.fn(async (mark: ReadingMark, patch: UpdateReadingMarkPatch) => ({ ...mark, ...patch, note: patch.note?.trim() || undefined }))
    const onDelete = vi.fn(async () => undefined)
    render(<>
      <MarkdownPreview content={content} documentKey="doc-ui" documentVersion={1} filePath={documentPath} readingMarks={[first, second]} annotationOverlayRef={overlayRef} />
      <AnnotationHoverOverlay ref={overlayRef} onUpdate={onUpdate} onDelete={onDelete} />
    </>, { container: host! })

    expect(screen.queryByRole('button', { name: /查看/ })).not.toBeInTheDocument()
    const entries = host!.querySelectorAll<HTMLElement>('[data-gm-reading-mark-id]')
    expect(entries).toHaveLength(2)
    fireEvent.pointerOver(entries[0], { clientX: 300, clientY: 220 })
    const firstTrigger = await waitFor(() => screen.getByRole('button', { name: '查看文字批注' }))
    const firstToolbar = firstTrigger.closest('.gm-reading-mark-toolbar') as HTMLElement
    expect(Number.parseFloat(firstToolbar.style.left)).toBe(300)
    fireEvent.pointerMove(document, { clientX: 600, clientY: 420 })
    expect(Number.parseFloat(firstToolbar.style.left)).toBe(300)
    expect(screen.queryByRole('textbox', { name: '批注内容' })).not.toBeInTheDocument()
    fireEvent.click(firstTrigger)
    expect(screen.getByRole('textbox', { name: '批注内容' })).toHaveValue('第一条批注')
    expect(screen.getByRole('button', { name: '保存批注' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '删除标记' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '返回颜色选择' })).not.toBeInTheDocument()
    expect(screen.queryByText('✎')).not.toBeInTheDocument()
    fireEvent.change(screen.getByRole('textbox', { name: '批注内容' }), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: '改为绿色高亮' }))
    await waitFor(() => expect(onUpdate).toHaveBeenCalledWith(first, { color: 'green' }))
    expect(screen.getByRole('button', { name: '改为绿色高亮' }).querySelector('.gm-reading-mark-dot')).toHaveClass('is-selected')
    fireEvent.change(screen.getByRole('textbox', { name: '批注内容' }), { target: { value: '编辑后的批注' } })
    fireEvent.click(screen.getByRole('button', { name: '保存批注' }))
    await waitFor(() => expect(onUpdate).toHaveBeenLastCalledWith(expect.objectContaining({ id: first.id, color: 'green', note: '第一条批注' }), { note: '编辑后的批注', color: 'green' }))
    await waitFor(() => expect(screen.queryByRole('textbox', { name: '批注内容' })).not.toBeInTheDocument())
    fireEvent.pointerOver(entries[0])
    const reopenedTrigger = await waitFor(() => screen.getByRole('button', { name: '查看文字批注' }))
    fireEvent.click(reopenedTrigger)
    fireEvent.click(screen.getByRole('button', { name: '删除标记' }))
    expect(screen.getByRole('button', { name: '确认删除批注' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '取消删除' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '取消删除' }))
    expect(onDelete).not.toHaveBeenCalled()
    fireEvent.keyDown(screen.getByRole('textbox', { name: '批注内容' }), { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('textbox', { name: '批注内容' })).not.toBeInTheDocument())
    fireEvent.pointerOver(entries[1])
    fireEvent.click(await waitFor(() => screen.getByRole('button', { name: '查看文字批注' })))
    expect(screen.getByRole('textbox', { name: '批注内容' })).toHaveValue('第二条批注')
  })

  it('无文字批注只显示笔入口，离开高亮延迟隐藏且进入浮层不会消失', async () => {
    vi.useFakeTimers()
    const mark = makeMark('mark-no-note', '第一段批注目标', '')
    const overlayRef = { current: null } as MutableRefObject<AnnotationHoverOverlayHandle | null>
    render(<>
      <MarkdownPreview content={content} documentKey="doc-no-note" documentVersion={1} filePath={documentPath} readingMarks={[mark]} annotationOverlayRef={overlayRef} />
      <AnnotationHoverOverlay ref={overlayRef} onUpdate={async (current, patch) => ({ ...current, ...patch })} onDelete={async () => undefined} />
    </>, { container: host! })

    const entry = host!.querySelector<HTMLElement>('[data-gm-reading-mark-id]')
    expect(entry).not.toBeNull()
    fireEvent.pointerOver(entry!)
    fireEvent.pointerOut(entry!, { relatedTarget: document.body })
    act(() => vi.advanceTimersByTime(599))
    expect(screen.getByRole('button', { name: '查看高亮批注' })).toBeInTheDocument()
    act(() => vi.advanceTimersByTime(1))
    expect(screen.queryByRole('button', { name: '查看高亮批注' })).not.toBeInTheDocument()

    fireEvent.pointerOver(entry!)
    const reopenedTrigger = screen.getByRole('button', { name: '查看高亮批注' })
    const reopenedOverlay = reopenedTrigger.closest('[data-annotation-hover-overlay="true"]') as HTMLElement
    fireEvent.pointerOver(reopenedOverlay)
    act(() => vi.advanceTimersByTime(200))
    expect(screen.getByRole('button', { name: '查看高亮批注' })).toBeInTheDocument()
    fireEvent.pointerOut(reopenedOverlay, { relatedTarget: document.body })
    act(() => vi.advanceTimersByTime(599))
    expect(screen.getByRole('button', { name: '查看高亮批注' })).toBeInTheDocument()
    act(() => vi.advanceTimersByTime(1))
    expect(screen.queryByRole('button', { name: '查看高亮批注' })).not.toBeInTheDocument()
    vi.useRealTimers()
  })

  it('已有纯高亮 Hover 展开操作并支持二次确认删除', async () => {
    const mark = makeMark('mark-delete', '第一段批注目标', '')
    const onUpdate = vi.fn(async (current: ReadingMark, patch: UpdateReadingMarkPatch) => ({ ...current, ...patch }))
    const onDelete = vi.fn(async () => undefined)
    const overlayRef = { current: null } as MutableRefObject<AnnotationHoverOverlayHandle | null>
    render(<>
      <MarkdownPreview content={content} documentKey="doc-delete" documentVersion={1} filePath={documentPath} readingMarks={[mark]} annotationOverlayRef={overlayRef} />
      <AnnotationHoverOverlay ref={overlayRef} onUpdate={onUpdate} onDelete={onDelete} />
    </>, { container: host! })

    const entry = host!.querySelector<HTMLElement>('[data-gm-reading-mark-id]')!
    fireEvent.pointerOver(entry)
    const trigger = await waitFor(() => screen.getByRole('button', { name: '查看高亮批注' }))
    const overlay = trigger.closest('[data-annotation-hover-overlay="true"]') as HTMLElement
    expect(screen.queryByRole('button', { name: '改为绿色高亮' })).not.toBeInTheDocument()
    fireEvent.mouseEnter(overlay)
    expect(screen.getByRole('button', { name: '改为绿色高亮' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '编辑文字批注' })).toBeInTheDocument()
    await waitFor(() => expect(Number.parseFloat(overlay.style.width)).toBeGreaterThanOrEqual(208))
    fireEvent.click(screen.getByRole('button', { name: '删除标记' }))
    expect(screen.getByRole('button', { name: '确认删除批注' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '取消删除' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '取消删除' }))
    expect(onDelete).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '删除标记' }))
    fireEvent.click(screen.getByRole('button', { name: '确认删除批注' }))
    await waitFor(() => expect(onDelete).toHaveBeenCalledWith(mark))
  })

  it('已有文字批注始终以选区上方为锚点并在保存后顺滑收起', async () => {
    const mark = makeMark('mark-text-position', '第一段批注目标', '原批注')
    const overlayRef = { current: null } as MutableRefObject<AnnotationHoverOverlayHandle | null>
    const onUpdate = vi.fn(async (current: ReadingMark, patch: UpdateReadingMarkPatch) => ({ ...current, ...patch }))
    render(<AnnotationHoverOverlay ref={overlayRef} onUpdate={onUpdate} onDelete={async () => undefined} />, { container: host! })

    act(() => overlayRef.current?.open(mark, { top: 320, right: 240, bottom: 340, left: 80 }))
    const textarea = await screen.findByRole('textbox', { name: '批注内容' })
    const toolbar = textarea.closest('.gm-reading-mark-toolbar') as HTMLElement
    expect(Number.parseFloat(toolbar.style.top)).toBeLessThan(320)
    fireEvent.change(textarea, { target: { value: '保存后的批注' } })
    fireEvent.click(screen.getByRole('button', { name: '保存批注' }))
    await waitFor(() => expect(onUpdate).toHaveBeenCalledWith(mark, { note: '保存后的批注', color: 'yellow' }))
    await waitFor(() => expect(screen.queryByRole('textbox', { name: '批注内容' })).not.toBeInTheDocument())
  })

  it('框选后的入口悬停展开并使用选区上方锚点', async () => {
    const caretRangeFromPoint = (document as Document & { caretRangeFromPoint?: (x: number, y: number) => Range | null })
    caretRangeFromPoint.caretRangeFromPoint = (x, _y) => {
      const textNode = host?.querySelector('[data-md-block-index]')?.querySelector('p span')?.firstChild
      if (!textNode) return null
      const range = document.createRange()
      const offset = x < 50 ? 0 : (textNode.textContent?.length ?? 0)
      range.setStart(textNode, offset)
      range.setEnd(textNode, offset)
      return range
    }
    render(<MarkdownPreview content={content} documentKey="doc-selection" documentVersion={1} filePath={documentPath} onCreateReadingMark={async () => ({ status: 'created' as const, mark: makeMark('created', '第一段批注目标', '新批注') })} />, { container: host! })
    const block = host!.querySelector<HTMLElement>('[data-md-block-index]')
    expect(block).not.toBeNull()
    fireEvent.mouseDown(block!, { button: 0, clientX: 4, clientY: 110 })
    fireEvent.mouseUp(document, { clientX: 120, clientY: 110 })

    const trigger = await waitFor(() => screen.getByRole('button', { name: '添加批注' }))
    const toolbar = trigger.closest('.gm-reading-mark-toolbar')
    expect(toolbar).not.toBeNull()
    expect(Number.parseFloat((toolbar as HTMLElement).style.left)).toBe(120)
    expect(Number.parseFloat((toolbar as HTMLElement).style.top)).toBe(62)
    fireEvent.mouseEnter(toolbar!)
    expect(toolbar!.querySelector('.gm-reading-mark-toolbar-actions')?.className).toContain('is-expanded')
    fireEvent.mouseLeave(toolbar!)
    expect(toolbar!.querySelector('.gm-reading-mark-toolbar-actions')?.className).not.toContain('is-expanded')
    trigger.focus()
    fireEvent.mouseEnter(toolbar!)
    fireEvent.mouseLeave(toolbar!)
    expect(toolbar!.querySelector('.gm-reading-mark-toolbar-actions')?.className).toContain('is-expanded')
    fireEvent.blur(trigger, { relatedTarget: document.body })
    expect(toolbar!.querySelector('.gm-reading-mark-toolbar-actions')?.className).not.toContain('is-expanded')
  })

  it('外部点击关闭批注入口时清除临时选区且不创建持久化标记', async () => {
    const caretRangeFromPoint = (document as Document & { caretRangeFromPoint?: (x: number, y: number) => Range | null })
    caretRangeFromPoint.caretRangeFromPoint = (x) => {
      const textNode = host?.querySelector('[data-md-block-index]')?.querySelector('p span')?.firstChild
      if (!textNode) return null
      const range = document.createRange()
      const offset = x < 50 ? 0 : (textNode.textContent?.length ?? 0)
      range.setStart(textNode, offset)
      range.setEnd(textNode, offset)
      return range
    }
    const previewRef = { current: null } as MutableRefObject<MarkdownPreviewHandle | null>
    const onCreateReadingMark = vi.fn(async () => ({ status: 'created' as const, mark: makeMark('created-outside-click', '第一段批注目标', '新批注') }))
    render(<MarkdownPreview ref={previewRef} content={content} documentKey="doc-outside-click" documentVersion={1} filePath={documentPath} readingMarks={emptyReadingMarks} onCreateReadingMark={onCreateReadingMark} />, { container: host! })
    const block = host!.querySelector<HTMLElement>('[data-md-block-index]')
    expect(block).not.toBeNull()
    fireEvent.mouseDown(block!, { button: 0, clientX: 4, clientY: 110 })
    fireEvent.mouseUp(document, { clientX: 120, clientY: 110 })

    await waitFor(() => expect(screen.getByRole('button', { name: '添加批注' })).toBeInTheDocument())
    expect(previewRef.current?.getSelection()).not.toBeNull()
    fireEvent.mouseDown(document.body, { button: 2 })
    expect(screen.getByRole('button', { name: '添加批注' })).toBeInTheDocument()
    expect(previewRef.current?.getSelection()).not.toBeNull()
    fireEvent.mouseDown(document.body)
    await waitFor(() => expect(screen.queryByRole('button', { name: '添加批注' })).not.toBeInTheDocument())
    expect(previewRef.current?.getSelection()).toBeNull()
    expect(onCreateReadingMark).not.toHaveBeenCalled()
  })

  it.each([
    ['先松右键', [
      { button: 2, buttons: 1 },
      { button: 0, buttons: 0 },
    ]],
    ['先松左键', [
      { button: 0, buttons: 2 },
      { button: 2, buttons: 0 },
    ]],
  ] as const)('左键拖选中按下右键时取消异常手势（%s）', async (_label, releases) => {
    const caretRangeFromPoint = (document as Document & { caretRangeFromPoint?: (x: number, y: number) => Range | null })
    caretRangeFromPoint.caretRangeFromPoint = (x) => {
      const textNode = host?.querySelector('[data-md-block-index]')?.querySelector('p span')?.firstChild
      if (!textNode) return null
      const range = document.createRange()
      const offset = x < 50 ? 0 : (textNode.textContent?.length ?? 0)
      range.setStart(textNode, offset)
      range.setEnd(textNode, offset)
      return range
    }
    const previewRef = { current: null } as MutableRefObject<MarkdownPreviewHandle | null>
    const onCreateReadingMark = vi.fn(async () => ({ status: 'created' as const, mark: makeMark('created-multi-button', '第一段批注目标', '') }))
    render(<MarkdownPreview ref={previewRef} content={content} documentKey="doc-multi-button-selection" documentVersion={1} filePath={documentPath} readingMarks={emptyReadingMarks} onCreateReadingMark={onCreateReadingMark} />, { container: host! })
    const block = host!.querySelector<HTMLElement>('[data-md-block-index]')
    expect(block).not.toBeNull()

    fireEvent.mouseDown(block!, { button: 0, buttons: 1, clientX: 4, clientY: 110 })
    const textNode = block!.querySelector('p span')?.firstChild
    expect(textNode).not.toBeNull()
    const nativeRange = document.createRange()
    nativeRange.selectNodeContents(textNode!)
    window.getSelection()?.addRange(nativeRange)
    fireEvent.mouseDown(block!, { button: 2, buttons: 3, clientX: 4, clientY: 110 })
    fireEvent.mouseMove(document, { buttons: 3, clientX: 120, clientY: 110 })
    for (const release of releases) {
      fireEvent.mouseUp(document, { ...release, clientX: 120, clientY: 110 })
    }

    await waitFor(() => expect(previewRef.current?.getSelection()).toBeNull())
    expect(window.getSelection()?.rangeCount).toBe(0)
    expect(screen.queryByRole('button', { name: '添加批注' })).not.toBeInTheDocument()
    expect(onCreateReadingMark).not.toHaveBeenCalled()
  })

  it('展开从中心向两侧延伸，选项首次点击即可生效', async () => {
    const caretRangeFromPoint = (document as Document & { caretRangeFromPoint?: (x: number, y: number) => Range | null })
    caretRangeFromPoint.caretRangeFromPoint = (x, _y) => {
      const textNode = host?.querySelector('[data-md-block-index]')?.querySelector('p span')?.firstChild
      if (!textNode) return null
      const range = document.createRange()
      range.setStart(textNode, x < 50 ? 0 : (textNode.textContent?.length ?? 0))
      range.setEnd(textNode, x < 50 ? 0 : (textNode.textContent?.length ?? 0))
      return range
    }
    const onCreateReadingMark = vi.fn(async () => ({ status: 'created' as const, mark: makeMark('created', '第一段批注目标', '新批注') }))
    render(<MarkdownPreview content={content} documentKey="doc-click" documentVersion={1} filePath={documentPath} onCreateReadingMark={onCreateReadingMark} />, { container: host! })
    const block = host!.querySelector<HTMLElement>('[data-md-block-index]')
    expect(block).not.toBeNull()
    fireEvent.mouseDown(block!, { button: 0, clientX: 4, clientY: 110 })
    fireEvent.mouseUp(document, { clientX: 120, clientY: 110 })

    const trigger = await waitFor(() => screen.getByRole('button', { name: '添加批注' }))
    const toolbar = trigger.closest('.gm-reading-mark-toolbar') as HTMLElement
    const collapsedLeft = toolbar.style.left
    fireEvent.mouseEnter(toolbar)
    expect(trigger).toHaveAttribute('aria-hidden', 'true')
    expect(toolbar.style.left).toBe(collapsedLeft)
    expect(screen.queryByRole('button', { name: '删除标记' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '创建黄色高亮' }))
    await waitFor(() => expect(onCreateReadingMark).toHaveBeenCalledTimes(1))
  })

  it('添加文字批注在同一胶囊内形变、聚焦并提交后关闭', async () => {
    const created = makeMark('created-text', '第一段批注目标', '')
    const onCreateReadingMark = vi.fn(async (_selection, _color, note) => ({ status: 'created' as const, mark: { ...created, note } }))
    const caretRangeFromPoint = (document as Document & { caretRangeFromPoint?: (x: number, y: number) => Range | null })
    caretRangeFromPoint.caretRangeFromPoint = (x) => {
      const textNode = host?.querySelector('[data-md-block-index]')?.querySelector('p span')?.firstChild
      if (!textNode) return null
      const range = document.createRange()
      range.setStart(textNode, x < 50 ? 0 : (textNode.textContent?.length ?? 0))
      range.setEnd(textNode, x < 50 ? 0 : (textNode.textContent?.length ?? 0))
      return range
    }
    render(<MarkdownPreview content={content} documentKey="doc-text" documentVersion={1} filePath={documentPath} onCreateReadingMark={onCreateReadingMark} />, { container: host! })
    const block = host!.querySelector<HTMLElement>('[data-md-block-index]')!
    fireEvent.mouseDown(block, { button: 0, clientX: 4, clientY: 110 })
    fireEvent.mouseUp(document, { clientX: 120, clientY: 110 })

    const trigger = await waitFor(() => screen.getByRole('button', { name: '添加批注' }))
    const toolbar = trigger.closest('.gm-reading-mark-toolbar') as HTMLElement
    fireEvent.mouseEnter(toolbar)
    const textButton = screen.getByRole('button', { name: '添加文字批注' })
    fireEvent.click(textButton)
    const textarea = await screen.findByRole('textbox', { name: '批注内容' })
    expect(textarea.closest('.gm-reading-mark-toolbar')).toBe(toolbar)
    expect(screen.queryByRole('button', { name: '删除标记' })).not.toBeInTheDocument()
    await waitFor(() => expect(textarea).toHaveFocus())
    expect(onCreateReadingMark).not.toHaveBeenCalled()

    fireEvent.change(textarea, { target: { value: '这是一条新批注' } })
    fireEvent.keyDown(textarea, { key: 'Enter' })
    await waitFor(() => expect(onCreateReadingMark).toHaveBeenCalledWith(expect.anything(), 'yellow', '这是一条新批注', expect.anything()))
    await waitFor(() => expect(host!.querySelector('.gm-reading-mark-toolbar')).toBeNull())
  })

  it('文字态 Esc 返回颜色胶囊，改色创建高亮且不会重复创建', async () => {
    const created = makeMark('created-return', '第一段批注目标', '')
    const onCreateReadingMark = vi.fn(async (_selection, color) => ({ status: 'created' as const, mark: { ...created, color } }))
    const caretRangeFromPoint = (document as Document & { caretRangeFromPoint?: (x: number, y: number) => Range | null })
    caretRangeFromPoint.caretRangeFromPoint = (x) => {
      const textNode = host?.querySelector('[data-md-block-index]')?.querySelector('p span')?.firstChild
      if (!textNode) return null
      const range = document.createRange()
      const offset = x < 50 ? 0 : (textNode.textContent?.length ?? 0)
      range.setStart(textNode, offset)
      range.setEnd(textNode, offset)
      return range
    }
    render(<MarkdownPreview content={content} documentKey="doc-return" documentVersion={1} filePath={documentPath} onCreateReadingMark={onCreateReadingMark} />, { container: host! })
    const block = host!.querySelector<HTMLElement>('[data-md-block-index]')!
    fireEvent.mouseDown(block, { button: 0, clientX: 4, clientY: 110 })
    fireEvent.mouseUp(document, { clientX: 120, clientY: 110 })
    const trigger = await waitFor(() => screen.getByRole('button', { name: '添加批注' }))
    const toolbar = trigger.closest('.gm-reading-mark-toolbar') as HTMLElement
    fireEvent.mouseEnter(toolbar)
    fireEvent.click(screen.getByRole('button', { name: '添加文字批注' }))
    const textarea = await screen.findByRole('textbox', { name: '批注内容' })
    fireEvent.keyDown(textarea, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('textbox', { name: '批注内容' })).not.toBeInTheDocument())
    await waitFor(() => expect(screen.getByRole('button', { name: '创建黄色高亮' })).toHaveFocus())
    const green = await screen.findByRole('button', { name: '创建绿色高亮' })
    fireEvent.click(green)
    await waitFor(() => expect(onCreateReadingMark).toHaveBeenCalledWith(expect.anything(), 'green', undefined, expect.anything()))
    expect(onCreateReadingMark).toHaveBeenCalledTimes(1)
  })

  it('文字态提交空内容时关闭且不创建高亮', async () => {
    const onCreateReadingMark = vi.fn()
    const caretRangeFromPoint = (document as Document & { caretRangeFromPoint?: (x: number, y: number) => Range | null })
    caretRangeFromPoint.caretRangeFromPoint = (x) => {
      const textNode = host?.querySelector('[data-md-block-index]')?.querySelector('p span')?.firstChild
      if (!textNode) return null
      const range = document.createRange()
      const offset = x < 50 ? 0 : (textNode.textContent?.length ?? 0)
      range.setStart(textNode, offset)
      range.setEnd(textNode, offset)
      return range
    }
    render(<MarkdownPreview content={content} documentKey="doc-empty-text" documentVersion={1} filePath={documentPath} onCreateReadingMark={onCreateReadingMark} />, { container: host! })
    const block = host!.querySelector<HTMLElement>('[data-md-block-index]')!
    fireEvent.mouseDown(block, { button: 0, clientX: 4, clientY: 110 })
    fireEvent.mouseUp(document, { clientX: 120, clientY: 110 })
    const trigger = await waitFor(() => screen.getByRole('button', { name: '添加批注' }))
    const toolbar = trigger.closest('.gm-reading-mark-toolbar') as HTMLElement
    fireEvent.mouseEnter(toolbar)
    fireEvent.click(screen.getByRole('button', { name: '添加文字批注' }))
    const textarea = await screen.findByRole('textbox', { name: '批注内容' })
    fireEvent.keyDown(textarea, { key: 'Enter' })
    await waitFor(() => expect(host!.querySelector('.gm-reading-mark-toolbar')).toBeNull())
    expect(onCreateReadingMark).not.toHaveBeenCalled()
  })

  it('文字批注创建失败时保留草稿并允许重试', async () => {
    const created = makeMark('created-retry', '第一段批注目标', '')
    const onCreateReadingMark = vi.fn()
      .mockRejectedValueOnce(new Error('暂时失败'))
      .mockResolvedValueOnce({ status: 'created', mark: { ...created, note: '可重试批注' } })
    const caretRangeFromPoint = (document as Document & { caretRangeFromPoint?: (x: number, y: number) => Range | null })
    caretRangeFromPoint.caretRangeFromPoint = (x) => {
      const textNode = host?.querySelector('[data-md-block-index]')?.querySelector('p span')?.firstChild
      if (!textNode) return null
      const range = document.createRange()
      const offset = x < 50 ? 0 : (textNode.textContent?.length ?? 0)
      range.setStart(textNode, offset)
      range.setEnd(textNode, offset)
      return range
    }
    render(<MarkdownPreview content={content} documentKey="doc-retry" documentVersion={1} filePath={documentPath} onCreateReadingMark={onCreateReadingMark} />, { container: host! })
    const block = host!.querySelector<HTMLElement>('[data-md-block-index]')!
    fireEvent.mouseDown(block, { button: 0, clientX: 4, clientY: 110 })
    fireEvent.mouseUp(document, { clientX: 120, clientY: 110 })
    const trigger = await waitFor(() => screen.getByRole('button', { name: '添加批注' }))
    const toolbar = trigger.closest('.gm-reading-mark-toolbar') as HTMLElement
    fireEvent.mouseEnter(toolbar)
    fireEvent.click(screen.getByRole('button', { name: '添加文字批注' }))
    const textarea = await screen.findByRole('textbox', { name: '批注内容' })
    fireEvent.change(textarea, { target: { value: '可重试批注' } })
    fireEvent.keyDown(textarea, { key: 'Enter' })
    await waitFor(() => expect(textarea).toBeEnabled())
    expect(onCreateReadingMark).toHaveBeenCalledTimes(1)
    fireEvent.keyDown(textarea, { key: 'Enter' })
    await waitFor(() => expect(onCreateReadingMark).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(host!.querySelector('.gm-reading-mark-toolbar')).toBeNull())
  })

  it('文字态外部点击关闭草稿且不创建高亮，重复点击不触发创建', async () => {
    const created = makeMark('created-outside', '第一段批注目标', '')
    const onCreateReadingMark = vi.fn(async () => ({ status: 'created' as const, mark: created }))
    const onUpdateReadingMark = vi.fn(async (id: string, patch: UpdateReadingMarkPatch) => ({ ...created, id, ...patch }))
    const caretRangeFromPoint = (document as Document & { caretRangeFromPoint?: (x: number, y: number) => Range | null })
    caretRangeFromPoint.caretRangeFromPoint = (x) => {
      const textNode = host?.querySelector('[data-md-block-index]')?.querySelector('p span')?.firstChild
      if (!textNode) return null
      const range = document.createRange()
      const offset = x < 50 ? 0 : (textNode.textContent?.length ?? 0)
      range.setStart(textNode, offset)
      range.setEnd(textNode, offset)
      return range
    }
    render(<MarkdownPreview content={content} documentKey="doc-outside" documentVersion={1} filePath={documentPath} onCreateReadingMark={onCreateReadingMark} onUpdateReadingMark={onUpdateReadingMark} />, { container: host! })
    const block = host!.querySelector<HTMLElement>('[data-md-block-index]')!
    fireEvent.mouseDown(block, { button: 0, clientX: 4, clientY: 110 })
    fireEvent.mouseUp(document, { clientX: 120, clientY: 110 })
    const trigger = await waitFor(() => screen.getByRole('button', { name: '添加批注' }))
    const toolbar = trigger.closest('.gm-reading-mark-toolbar') as HTMLElement
    fireEvent.mouseEnter(toolbar)
    const textButton = screen.getByRole('button', { name: '添加文字批注' })
    fireEvent.click(textButton)
    fireEvent.click(textButton)
    await screen.findByRole('textbox', { name: '批注内容' })
    fireEvent.mouseDown(document.body)
    await waitFor(() => expect(host!.querySelector('.gm-reading-mark-toolbar')).toBeNull())
    expect(onCreateReadingMark).not.toHaveBeenCalled()
    expect(onUpdateReadingMark).not.toHaveBeenCalled()
  })

  it('查看文字批注时离开浮层不会因鼠标移动收起文本框', async () => {
    const mark = makeMark('existing-pointer-leave', '第一段批注目标', '已有批注')
    const otherMark = makeMark('existing-pointer-leave-other', '第二段批注目标', '另一条批注')
    const overlayRef = { current: null } as MutableRefObject<AnnotationHoverOverlayHandle | null>
    render(<>
      <MarkdownPreview content={content} documentKey="doc-pointer-leave" documentVersion={1} filePath={documentPath} readingMarks={[mark, otherMark]} annotationOverlayRef={overlayRef} />
      <AnnotationHoverOverlay ref={overlayRef} onUpdate={async (current, patch) => ({ ...current, ...patch })} onDelete={async () => undefined} />
    </>, { container: host! })

    const entries = host!.querySelectorAll<HTMLElement>('[data-gm-reading-mark-id]')
    fireEvent.pointerOver(entries[0])
    const trigger = await screen.findByRole('button', { name: '查看文字批注' })
    fireEvent.click(trigger)
    const textarea = await screen.findByRole('textbox', { name: '批注内容' })
    const toolbar = textarea.closest('.gm-reading-mark-toolbar') as HTMLElement
    fireEvent.pointerOver(entries[1])
    fireEvent.pointerLeave(toolbar, { relatedTarget: document.body })
    fireEvent.mouseLeave(toolbar, { relatedTarget: document.body })

    expect(screen.getByRole('textbox', { name: '批注内容' })).toBeInTheDocument()
    fireEvent.keyDown(textarea, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('textbox', { name: '批注内容' })).not.toBeInTheDocument())
  })

  it('选区与已有标记重叠时沿用创建入口，悬停展开冲突提示与查看已有标记', async () => {
    const existing = makeMark('existing', '第一段批注目标', '已有批注')
    const caretRangeFromPoint = (document as Document & { caretRangeFromPoint?: (x: number, y: number) => Range | null })
    caretRangeFromPoint.caretRangeFromPoint = (x, _y) => {
      const textNode = host?.querySelector('[data-md-block-index]')?.querySelector('p span')?.firstChild
      if (!textNode) return null
      const range = document.createRange()
      range.setStart(textNode, x < 50 ? 0 : (textNode.textContent?.length ?? 0))
      range.setEnd(textNode, x < 50 ? 0 : (textNode.textContent?.length ?? 0))
      return range
    }
    const onCreateReadingMark = vi.fn()
    const overlayRef = { current: null } as MutableRefObject<AnnotationHoverOverlayHandle | null>
    render(<>
      <MarkdownPreview content={content} documentKey="doc-conflict" documentVersion={1} filePath={documentPath} readingMarks={[existing]} annotationOverlayRef={overlayRef} onCreateReadingMark={onCreateReadingMark} />
      <AnnotationHoverOverlay ref={overlayRef} onUpdate={async (mark, patch) => ({ ...mark, ...patch })} onDelete={async () => undefined} />
    </>, { container: host! })
    const block = host!.querySelector<HTMLElement>('[data-md-block-index]')
    fireEvent.mouseDown(block!, { button: 0, clientX: 4, clientY: 110 })
    fireEvent.mouseUp(document, { clientX: 120, clientY: 110 })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '查看已有标记' })).not.toBeInTheDocument()
    const conflictTrigger = screen.getByRole('button', { name: '添加批注' })
    const toolbar = conflictTrigger.closest('.gm-reading-mark-toolbar') as HTMLElement
    expect(conflictTrigger).toHaveAttribute('aria-expanded', 'false')
    fireEvent.mouseEnter(toolbar)
    expect(conflictTrigger).toHaveAttribute('aria-expanded', 'true')
    expect(await screen.findByRole('alert')).toHaveTextContent('与已有标记重叠')
    expect(screen.getByRole('button', { name: '查看已有标记' })).toBeInTheDocument()
    expect(toolbar.querySelector('.gm-reading-mark-toolbar-actions')?.className).toContain('is-conflict')
    expect(screen.queryByRole('button', { name: '创建黄色高亮' })).not.toBeInTheDocument()
    expect(onCreateReadingMark).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '查看已有标记' }))
    expect(await screen.findByRole('textbox', { name: '批注内容' })).toHaveValue('已有批注')
  })
})
