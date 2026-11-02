import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render } from '@testing-library/react'
import { MarkdownPreview } from '@/components/editor/MarkdownPreview'
import { createMarkdownPreviewModel } from '@/services/markdownPreviewModel'

describe('Markdown reference virtualization', () => {
  it('resolves cross-block definitions without mounting the whole document', () => {
    const content = [
      '[首屏引用][guide]',
      ...Array.from({ length: 300 }, (_, index) => `\n\n段落 ${index} 的匿名填充内容。`),
      '',
      '[guide]: https://example.com/guide "Guide"',
    ].join('\n')
    const view = render(<MarkdownPreview content={content} />)
    const link = view.getByRole('link', { name: '首屏引用' })
    expect(link).toHaveAttribute('href', 'https://example.com/guide')
    expect(view.container.querySelectorAll('[data-md-block-index]').length).toBeLessThan(40)
  })

  it('renders cross-block footnotes and navigates in both directions', () => {
    const content = [
      '正文脚注[^note]。',
      '',
      '第二段也引用[^note]。',
      ...Array.from({ length: 300 }, (_, index) => `\n\n段落 ${index} 的匿名填充内容。`),
      '',
      '[^note]: 脚注定义内容。',
    ].join('\n')
    const view = render(<MarkdownPreview content={content} />)
    const footnoteSection = view.container.querySelector<HTMLElement>('section[data-footnotes]')
    expect(footnoteSection).not.toBeNull()
    expect(footnoteSection).toHaveTextContent('脚注定义内容。')
    expect(view.container.querySelectorAll('section[data-footnotes]')).toHaveLength(1)
    expect(view.container.querySelectorAll('a[data-footnote-backref]')).toHaveLength(2)
    expect(view.container.textContent).not.toContain('guanmo-footnote-context')
    const footnoteSectionLines = [...view.container.querySelectorAll<HTMLElement>('[data-md-footnote-section] [data-md-line]')]
      .map((element) => Number(element.dataset.mdLine))
    expect(footnoteSectionLines.every((line) => line < 1)).toBe(true)
    const referenceIds = [...view.container.querySelectorAll('sup a[data-footnote-ref]')].map((item) => item.id)
    expect(new Set(referenceIds).size).toBe(referenceIds.length)
    expect([...view.container.querySelectorAll('[data-md-block-index] sup a[data-footnote-ref]')].map((item) => item.textContent)).toEqual(['1', '1'])

    const reference = view.container.querySelector<HTMLAnchorElement>('[data-md-block-index] sup a[data-footnote-ref]')
    expect(reference).not.toBeNull()
    const preview = view.container.querySelector<HTMLElement>('.gm-markdown-preview')!
    const container = preview.parentElement!
    const target = view.container.querySelector<HTMLElement>(`[id="${reference!.hash.slice(1)}"]`)!
    const scrollTo = vi.fn()
    Object.defineProperty(container, 'scrollTo', { configurable: true, value: scrollTo })
    vi.spyOn(target, 'getBoundingClientRect').mockReturnValue({ top: 200 } as DOMRect)
    fireEvent.click(reference!)
    expect(scrollTo).toHaveBeenCalledWith({ top: 176, behavior: 'smooth' })

    view.container.querySelectorAll('[data-md-block-index] sup a[data-footnote-ref]').forEach((item) => item.remove())
    scrollTo.mockClear()
    const backref = view.container.querySelectorAll<HTMLAnchorElement>('a[data-footnote-backref]')[1]
    expect(backref).toHaveAttribute('href', `#${referenceIds[1]}`)
    container.scrollTop = 300
    fireEvent.click(backref!)
    expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({ behavior: 'smooth' }))
    expect(view.container.querySelectorAll('[data-md-block-index]').length).toBeLessThan(40)
  })

  it('uses the directory fade transition when returning to a distant body reference', () => {
    vi.useFakeTimers()
    const view = render(<MarkdownPreview content={'Text[^note].\n\n[^note]: Note.'} />)
    const preview = view.container.querySelector<HTMLElement>('.gm-markdown-preview')!
    const container = preview.parentElement!
    const bodyLine = preview.querySelector<HTMLElement>('[data-md-line="1"]')!
    const backref = view.container.querySelector<HTMLAnchorElement>('a[data-footnote-backref]')!
    Object.defineProperty(container, 'clientHeight', { configurable: true, value: 100 })
    Object.defineProperty(container, 'scrollHeight', { configurable: true, value: 5000 })
    Object.defineProperty(container, 'scrollTo', { configurable: true, value: vi.fn() })
    container.scrollTop = 3000
    vi.spyOn(bodyLine, 'getBoundingClientRect').mockImplementation(() => ({ top: -container.scrollTop } as DOMRect))
    fireEvent.click(backref)
    expect(preview.style.opacity).toBe('0')
    expect(container.scrollTo).not.toHaveBeenCalled()
    vi.advanceTimersByTime(100)
    expect(container.scrollTop).toBe(0)
    view.unmount()
    vi.useRealTimers()
  })

  it('uses the directory fade transition for distant footnote references', () => {
    vi.useFakeTimers()
    const view = render(<MarkdownPreview content={'Text[^note].\n\n[^note]: Note.'} />)
    const preview = view.container.querySelector<HTMLElement>('.gm-markdown-preview')!
    const container = preview.parentElement!
    const reference = view.container.querySelector<HTMLAnchorElement>('[data-md-block-index] a[data-footnote-ref]')!
    const target = view.container.querySelector<HTMLElement>(`[id="${reference.hash.slice(1)}"]`)!
    Object.defineProperty(container, 'clientHeight', { configurable: true, value: 100 })
    Object.defineProperty(container, 'scrollHeight', { configurable: true, value: 5000 })
    Object.defineProperty(container, 'scrollTo', { configurable: true, value: vi.fn() })
    vi.spyOn(target, 'getBoundingClientRect').mockImplementation(() => ({ top: 2000 - container.scrollTop } as DOMRect))
    fireEvent.click(reference)
    expect(preview.style.opacity).toBe('0')
    expect(container.scrollTo).not.toHaveBeenCalled()
    vi.advanceTimersByTime(100)
    expect(container.scrollTop).toBe(1976)
    view.unmount()
    vi.useRealTimers()
  })

  it('extracts source-positioned references and only attaches definitions to referencing blocks', () => {
    const content = [
      'First paragraph[^note-a].',
      '',
      'Second paragraph[^note-b] and [^NOTE-A].',
      '',
      'Inline code `[^code]` and escaped \\[^escaped] stay literal.',
      '',
      '```md',
      '[^fenced]: not a definition',
      '```',
      '',
      '[^missing] has no definition.',
      '',
      '[^note-a]: First definition references [^note-b].',
      '    Continued note text stays in the same multi-line definition.',
      '',
      '[^note-b]: Second definition references [^note-a].',
      '    The second note also has a continuation line.',
    ].join('\n')
    const model = createMarkdownPreviewModel(content)
    const references = model.footnoteReferences
    expect(references.map(({ identifier, number }) => [identifier, number])).toEqual([
      ['note-a', 1],
      ['note-b', 2],
      ['note-a', 1],
      ['note-b', 2],
      ['note-a', 1],
    ])
    expect(references.every((reference) => content.slice(reference.startOffset, reference.endOffset) === reference.source)).toBe(true)
    expect(model.footnoteDefinitions[0].endLine).toBeGreaterThan(model.footnoteDefinitions[0].startLine)
    expect(model.footnoteDefinitions[0].rawSource).toContain('Continued note text')

    const paragraphs = model.blocks.filter((block) => block.type === 'paragraph')
    expect(paragraphs[0].footnoteDefinitionIdentifiers).toEqual(['note-a', 'note-b'])
    expect(paragraphs[1].footnoteDefinitionIdentifiers).toEqual(['note-a', 'note-b'])
    expect(paragraphs[2].footnoteDefinitionIdentifiers).toEqual([])
    expect(paragraphs[3].footnoteDefinitionIdentifiers).toEqual([])
    expect(model.blocks.filter((block) => block.type === 'footnoteDefinition').every((block) => block.footnoteDefinitionIdentifiers.length === 0)).toBe(true)
  })

  it('does not mount footnote definition blocks into the virtual document body', () => {
    const content = [
      'Visible text[^note].',
      ...Array.from({ length: 30 }, (_, index) => `\n\nFiller ${index}.`),
      '',
      '[^note]: The definition appears only in the footnote section.',
    ].join('\n')
    const view = render(<MarkdownPreview content={content} />)
    expect(view.container.querySelector('[data-md-block-type="footnoteDefinition"]')).toBeNull()
    expect(view.container.querySelector('section[data-footnotes]')).toHaveTextContent('The definition appears only in the footnote section.')
  })

  it('ignores unresolved nested references when numbering later notes', () => {
    const content = 'First[^a].\n\n[^a]: Missing [^missing].\n\nLater[^b].\n\n[^b]: Note B.'
    const model = createMarkdownPreviewModel(content)
    expect(model.footnoteReferences.map(({ identifier, number }) => [identifier, number])).toEqual([['a', 1], ['b', 2]])
  })

  it('returns from a nested footnote to the reference in its parent note', () => {
    const content = 'Text[^a].\n\n[^a]: Parent refers to [^b].\n\n[^b]: Nested note.'
    const view = render(<MarkdownPreview content={content} />)
    const nestedReference = view.container.querySelector<HTMLAnchorElement>('section[data-footnotes] li[id$="fn-a"] sup a[data-footnote-ref]')
    const backref = view.container.querySelector<HTMLAnchorElement>('section[data-footnotes] li[id$="fn-b"] a[data-footnote-backref]')
    expect(nestedReference).not.toBeNull()
    expect(backref).toHaveAttribute('href', `#${nestedReference!.id}`)
    const scrollIntoView = vi.fn()
    Object.defineProperty(nestedReference!, 'scrollIntoView', { configurable: true, value: scrollIntoView })
    fireEvent.click(backref!)
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' })
  })

  it('keeps numbering global across different definitions and points backrefs to body references', () => {
    const content = [
      'First[^one].',
      '',
      'Second[^two] and repeat[^one].',
      '',
      '[^two]: Second note.',
      '',
      '[^one]: First note.',
    ].join('\n')
    const view = render(<MarkdownPreview content={content} />)
    const bodyReferences = [...view.container.querySelectorAll<HTMLAnchorElement>('[data-md-block-index] sup a[data-footnote-ref]')]
    expect(bodyReferences.map((reference) => reference.textContent)).toEqual(['1', '2', '1'])
    expect([...view.container.querySelectorAll<HTMLOListElement>('section[data-footnotes] ol > li')].map((item) => item.value)).toEqual([1, 2])

    const bodyReferenceIds = new Set(bodyReferences.map((reference) => reference.id))
    const backrefHrefs = [...view.container.querySelectorAll<HTMLAnchorElement>('section[data-footnotes] a[data-footnote-backref]')]
      .map((backref) => backref.getAttribute('href')?.slice(1))
    expect(backrefHrefs).toHaveLength(3)
    expect(backrefHrefs.every((href) => Boolean(href && bodyReferenceIds.has(href)))).toBe(true)
  })

  it('namespaces whole-document footnote anchors across preview instances', async () => {
    const content = [
      '开始 <span data-cross="true">',
      '',
      '跨块 HTML 内容',
      '',
      '结束</span>',
      '',
      '正文引用[^note]。',
      '',
      '重复引用[^note]。',
      '',
      '[^note]: 文末脚注。',
    ].join('\n')
    const view = render(<><MarkdownPreview content={content} /><MarkdownPreview content={content} /></>)
    await vi.waitFor(() => {
      expect(view.container.querySelectorAll('.gm-markdown-preview[data-md-render-mode="whole"]')).toHaveLength(2)
      expect(view.container.querySelectorAll('[data-md-block-index] sup a[data-footnote-ref]')).toHaveLength(4)
    })

    const references = [...view.container.querySelectorAll<HTMLAnchorElement>('[data-md-block-index] sup a[data-footnote-ref]')]
    expect(references.map((reference) => reference.textContent)).toEqual(['1', '1', '1', '1'])
    expect(new Set(references.map((reference) => reference.id)).size).toBe(4)
    const referenceIds = new Set(references.map((reference) => reference.id))
    const backrefTargets = [...view.container.querySelectorAll<HTMLAnchorElement>('a[data-footnote-backref]')]
      .map((backref) => backref.getAttribute('href')?.slice(1))
    expect(backrefTargets).toHaveLength(4)
    expect(backrefTargets.every((target) => Boolean(target && referenceIds.has(target)))).toBe(true)
  })

  it('rebuilds footnote mapping when the active document changes', () => {
    const firstDocument = 'First document[^first].\n\n[^first]: First note.'
    const secondDocument = 'Second document[^second] and again[^second].\n\n[^second]: Second note.'
    const view = render(<MarkdownPreview content={firstDocument} />)
    expect(view.container.querySelector('section[data-footnotes]')).toHaveTextContent('First note.')

    view.rerender(<MarkdownPreview content={secondDocument} />)
    expect(view.container.querySelector('section[data-footnotes]')).toHaveTextContent('Second note.')
    expect(view.container.querySelector('section[data-footnotes]')).not.toHaveTextContent('First note.')
    expect([...view.container.querySelectorAll('[data-md-block-index] sup a[data-footnote-ref]')].map((item) => item.textContent)).toEqual(['1', '1'])

    view.rerender(<MarkdownPreview content={firstDocument} />)
    expect(view.container.querySelector('section[data-footnotes]')).toHaveTextContent('First note.')
    expect(view.container.querySelector('section[data-footnotes]')).not.toHaveTextContent('Second note.')
  })

  it('does not treat generic syntax in code as cross-block HTML', () => {
    const content = [
      '```ts',
      'const request = (input: Request<TResponse, TPayload>) => input',
      'SingletonPromiseManager.init<T>()',
      '```',
      '',
      '行内代码 `request<T>()` 不应触发整篇渲染。',
      '',
      '    const result: Result<T> = createResult()',
      ...Array.from({ length: 300 }, (_, index) => `\n\n段落 ${index} 的匿名填充内容。`),
    ].join('\n')
    const view = render(<MarkdownPreview content={content} />)
    expect(view.container.querySelector('.gm-markdown-preview')).toHaveAttribute('data-md-render-mode', 'virtual')
    expect(view.container.querySelectorAll('[data-md-block-index]').length).toBeLessThan(40)
  })

  it('virtualizes self-contained HTML but keeps cross-block HTML compatible', async () => {
    const selfContained = ['<span data-safe="true">安全 HTML</span>', ...Array.from({ length: 300 }, (_, index) => `\n\n段落 ${index}。`)].join('\n')
    const virtualized = render(<MarkdownPreview content={selfContained} />)
    await vi.waitFor(() => expect(virtualized.container.querySelector('[data-md-block-index]')).not.toBeNull())
    expect(virtualized.container.querySelectorAll('[data-md-block-index]').length).toBeLessThan(40)
    virtualized.unmount()

    const crossBlock = ['开始 <span data-cross="true">', '', '跨块正文', '', '结束</span>'].join('\n')
    const compatible = render(<MarkdownPreview content={crossBlock} />)
    await vi.waitFor(() => expect(compatible.container.querySelector('.gm-markdown-preview')).toHaveAttribute('data-md-render-mode', 'whole'))
  })
})
