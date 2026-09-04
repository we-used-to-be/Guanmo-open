import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { StrictMode, createRef, useRef, useState } from 'react'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { MarkdownPreview, type MarkdownBlockCommitRequest, type MarkdownPreviewHandle } from '@/components/editor/MarkdownPreview'
import { replaceMarkdownBlock } from '@/services/markdownBlocks'

const hoisted = vi.hoisted(() => {
  let renderCount = 0
  return {
    get renderCount() { return renderCount },
    inc() { renderCount += 1 },
    RealReactMarkdown: vi.fn(),
  }
})

vi.mock('react-markdown', async () => {
  const actual = await vi.importActual<typeof import('react-markdown')>('react-markdown')
  hoisted.RealReactMarkdown.mockImplementation(actual.default)
  return {
    default: (props: Record<string, unknown>) => {
      hoisted.inc()
      return hoisted.RealReactMarkdown(props)
    },
  }
})

beforeAll(() => {
  if (!Range.prototype.getClientRects) {
    Range.prototype.getClientRects = () => [] as unknown as DOMRectList
  }
  if (!Range.prototype.getBoundingClientRect) {
    Range.prototype.getBoundingClientRect = () => new DOMRect()
  }
})

function altClick(element: Element, x = 10, y = 10) {
  fireEvent.pointerDown(element, { altKey: true, pointerId: 1, clientX: x, clientY: y })
  fireEvent.pointerUp(element, { altKey: true, pointerId: 1, clientX: x, clientY: y })
  fireEvent.click(element, { altKey: true, clientX: x, clientY: y })
}

function renderPreview(overrides: Partial<React.ComponentProps<typeof MarkdownPreview>> = {}) {
  const onBlockCommit = vi.fn(async () => ({ status: 'applied' as const }))
  const onTaskToggle = vi.fn()
  const result = render(
    <>
      <MarkdownPreview
        content={'段落 [链接](https://example.com)\n\n![图片](image.png)\n\n- [ ] 任务'}
        documentKey="doc-1"
        documentVersion={1}
        inlineEditEnabled
        onBlockCommit={onBlockCommit}
        onTaskToggle={onTaskToggle}
        {...overrides}
      />
      <button type="button">外部按钮</button>
    </>
  )
  return { ...result, onBlockCommit, onTaskToggle }
}

const DELAYED_PREVIEW_CONTENT = '第一块\n\n第二块\n\n第三块'

function renderDelayedPreview() {
  let canonicalContent = DELAYED_PREVIEW_CONTENT
  const onContentChange = vi.fn()
  const onBlockCommit = vi.fn(async (request: MarkdownBlockCommitRequest) => {
    const result = replaceMarkdownBlock(canonicalContent, request.block, request.draft)
    if (result.status === 'applied') {
      canonicalContent = result.content
      onContentChange(result.content)
    }
    return result
  })
  const result = render(
    <MarkdownPreview
      content={DELAYED_PREVIEW_CONTENT}
      documentKey="doc-delayed"
      documentVersion={1}
      inlineEditEnabled
      onBlockCommit={onBlockCommit}
    />
  )
  return { ...result, onBlockCommit, onContentChange }
}

function StatefulDelayedPreview({ onCommit }: { onCommit: () => void }) {
  const canonicalContent = useRef('原文')
  const [documentVersion, setDocumentVersion] = useState(1)
  return (
    <MarkdownPreview
      content="原文"
      documentKey="doc-stateful-delayed"
      documentVersion={documentVersion}
      inlineEditEnabled
      onBlockCommit={(request) => {
        const result = replaceMarkdownBlock(canonicalContent.current, request.block, request.draft)
        if (result.status === 'applied') {
          canonicalContent.current = result.content
          setDocumentVersion((version) => version + 1)
          onCommit()
        }
        return result
      }}
    />
  )
}

function StatefulAnchoredPreview() {
  const [content, setContent] = useState(Array.from({ length: 8 }, (_, index) => `第${index + 1}块`).join('\n\n'))
  return (
    <MarkdownPreview
      content={content}
      documentKey="doc-anchored"
      documentVersion={content}
      inlineEditEnabled
      onBlockCommit={(request) => {
        const result = replaceMarkdownBlock(content, request.block, request.draft)
        if (result.status === 'applied') setContent(result.content)
        return result
      }}
    />
  )
}

describe('MarkdownPreview 预览内源码编辑', () => {
  it('有无语言标识的围栏代码块使用同款代码框', () => {
    const { container } = renderPreview({
      content: '```\nplain text\n```\n\n```txt\nlabeled text\n```',
    })
    const codeBlocks = container.querySelectorAll('.gm-code-block')

    expect(codeBlocks).toHaveLength(2)
    expect(codeBlocks[0]).toHaveTextContent('plain text')
    expect(codeBlocks[1]).toHaveTextContent('txt')
    expect(codeBlocks[1]).toHaveTextContent('labeled text')
  })

  it('Front Matter 的多个渲染节点仍归属同一个源码块', () => {
    const { container } = renderPreview({ content: '---\ntitle: 示例\n---\n\n正文' })
    const wrappers = container.querySelectorAll('[data-md-block-index]')

    expect(wrappers).toHaveLength(2)
    expect(wrappers[0]).toHaveAttribute('data-md-block-type', 'frontmatter')
    expect(wrappers[1]).toHaveAttribute('data-md-block-type', 'paragraph')
  })

  it('普通点击保持原交互，Alt+点击链接进入所属完整块编辑', async () => {
    renderPreview()
    const link = screen.getByRole('link', { name: '链接' })

    fireEvent.click(link)
    expect(document.querySelector('.cm-editor')).not.toBeInTheDocument()

    altClick(link)
    await waitFor(() => expect(document.querySelector('.cm-editor')).toBeInTheDocument())
  })

  it('Alt+拖动超过阈值时不进入编辑', () => {
    renderPreview()
    const paragraph = screen.getByText(/段落/).closest('[data-md-block-index]') as HTMLElement

    fireEvent.pointerDown(paragraph, { altKey: true, pointerId: 2, clientX: 10, clientY: 10 })
    fireEvent.pointerMove(paragraph, { altKey: true, pointerId: 2, clientX: 22, clientY: 10 })
    fireEvent.pointerUp(paragraph, { altKey: true, pointerId: 2, clientX: 22, clientY: 10 })

    expect(document.querySelector('.cm-editor')).not.toBeInTheDocument()
  })

  it('普通点击图片放大和任务复选框仍执行原功能', () => {
    const { onTaskToggle } = renderPreview()
    fireEvent.click(screen.getByRole('checkbox'))
    expect(onTaskToggle).toHaveBeenCalledWith(5, true)

    fireEvent.click(screen.getByRole('button', { name: /图片/ }))
    expect(screen.getByRole('button', { name: '关闭' })).toBeInTheDocument()
  })

  it('分块渲染保留跨块 reference link 与 footnote 定义', () => {
    renderPreview({
      content: [
        '正文包含 [参考链接][guide] 与脚注 [^note]。',
        '',
        '中间段落。',
        '',
        '[guide]: https://example.com/guide "指南"',
        '',
        '[^note]: 匿名脚注内容。',
      ].join('\n'),
    })

    expect(screen.getByRole('link', { name: '参考链接' })).toHaveAttribute('href', 'https://example.com/guide')
    expect(screen.getByText('匿名脚注内容。')).toBeInTheDocument()
  })

  it('大文档首屏只挂载有限数量的顶层块', () => {
    const content = Array.from({ length: 2000 }, (_, index) => `段落 ${index + 1}`).join('\n\n')
    const { container } = renderPreview({ content })

    expect(container.querySelectorAll('[data-md-block-index]').length).toBeLessThanOrEqual(12)
  })

  it('可按全文 offset 定位尚未挂载的预览块', () => {
    const previewRef = createRef<MarkdownPreviewHandle>()
    const scrollTo = vi.fn()
    const host = document.createElement('div')
    Object.defineProperties(host, {
      clientHeight: { configurable: true, value: 800 },
      clientWidth: { configurable: true, value: 1000 },
      scrollTo: { configurable: true, value: scrollTo },
    })
    const content = Array.from({ length: 200 }, (_, index) => `段落 ${index + 1}`).join('\n\n')

    render(<MarkdownPreview ref={previewRef} content={content} />, { container: host })
    act(() => previewRef.current?.scrollToOffset(content.lastIndexOf('段落 200')))

    expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({ top: expect.any(Number) }))
    expect(scrollTo.mock.calls[0][0].top).toBeGreaterThan(0)
    expect(previewRef.current?.getTopForLine(399)).toBeGreaterThan(0)
  })

  it('视口基准点落在块间距时使用下一个已挂载块的真实行号', () => {
    const previewRef = createRef<MarkdownPreviewHandle>()
    const host = document.createElement('div')
    Object.defineProperties(host, {
      clientHeight: { configurable: true, value: 800 },
      clientWidth: { configurable: true, value: 1000 },
      scrollTop: { configurable: true, value: 1_000, writable: true },
      getBoundingClientRect: {
        configurable: true,
        value: () => new DOMRect(0, 100, 1000, 800),
      },
    })

    render(<MarkdownPreview ref={previewRef} content={'第一块\n\n第二块\n\n第三块'} />, { container: host })
    const blocks = host.querySelectorAll<HTMLElement>('[data-md-block-index]')
    expect(blocks).toHaveLength(3)
    Object.defineProperty(blocks[0], 'getBoundingClientRect', {
      configurable: true,
      value: () => new DOMRect(0, -200, 1000, 100),
    })
    Object.defineProperty(blocks[1], 'getBoundingClientRect', {
      configurable: true,
      value: () => new DOMRect(0, 120, 1000, 100),
    })
    Object.defineProperty(blocks[2], 'getBoundingClientRect', {
      configurable: true,
      value: () => new DOMRect(0, 250, 1000, 100),
    })

    // 容器视口中的目标 y=110，位于第一块与第二块之间，应锚定第二块（源码第 3 行），
    // 而不是回退到已经可能发生累计漂移的全文高度估算。
    expect(previewRef.current?.getLineForTop(1_010)).toBe(3)
  })

  it.each([
    ['图片', () => screen.getByRole('button', { name: /图片/ })],
    ['任务复选框', () => screen.getByRole('checkbox')],
  ])('Alt+点击%s优先进入块编辑', async (_label, getTarget) => {
    renderPreview()
    altClick(getTarget())
    await waitFor(() => expect(document.querySelector('.cm-editor')).toBeInTheDocument())
  })

  it('Alt+点击代码块按钮进入完整代码块编辑', async () => {
    renderPreview({ content: '```ts\nconst value = 1\n```' })
    altClick(screen.getByRole('button', { name: '复制 ts 代码' }))

    await waitFor(() => expect(document.querySelector('.cm-editor')).toBeInTheDocument())
  })

  it.each([
    ['图片', '![示例图片](image.png)', 'image'],
    ['无序列表', '- 第一项\n- 第二项', 'list'],
    ['Mermaid', '```mermaid\ngraph TD\nA-->B\n```', 'mermaid'],
  ])('Alt+点击%s可进入编辑', { timeout: 10000 }, async (_label, content, blockType) => {
    const { container } = renderPreview({ content })
    const wrapper = container.querySelector<HTMLElement>(`[data-md-block-type="${blockType}"]`)
    expect(wrapper).not.toBeNull()

    altClick(wrapper as HTMLElement)

    await waitFor(() => expect(document.querySelector('.cm-editor')).toBeInTheDocument())
  })

  it('外部 pointerdown 提交后恢复预览，Esc 不再提交', async () => {
    const { onBlockCommit } = renderPreview()
    altClick(screen.getByText(/段落/))
    await waitFor(() => expect(document.querySelector('.cm-editor')).toBeInTheDocument())

    fireEvent.keyDown(document.querySelector('.cm-content') as HTMLElement, { key: 'Escape' })
    expect(onBlockCommit).not.toHaveBeenCalled()
    expect(document.querySelector('.cm-editor')).toBeInTheDocument()

    fireEvent.pointerDown(screen.getByRole('button', { name: '外部按钮' }))
    await waitFor(() => expect(onBlockCommit).toHaveBeenCalledTimes(1))
    expect(document.querySelector('.cm-editor')).not.toBeInTheDocument()
  })

  it('Ctrl+Enter 不再提交或退出块编辑', async () => {
    const { onBlockCommit } = renderPreview()
    altClick(screen.getByText(/段落/))
    const editor = await screen.findByRole('textbox')

    fireEvent.keyDown(editor, { key: 'Enter', ctrlKey: true })

    expect(onBlockCommit).not.toHaveBeenCalled()
    expect(document.querySelector('.cm-editor')).toBeInTheDocument()
  })

  it('提交同步更新文档版本且预览仍防抖时，外部点击仍退出编辑', async () => {
    const user = userEvent.setup()
    const onCommit = vi.fn()
    render(
      <StrictMode>
        <StatefulDelayedPreview onCommit={onCommit} />
      </StrictMode>
    )
    altClick(screen.getByText('原文'))
    const editor = await screen.findByRole('textbox')
    await user.click(editor)
    await user.keyboard('{Control>}a{/Control}修改后')

    fireEvent.pointerDown(document.body)

    await waitFor(() => expect(onCommit).toHaveBeenCalledOnce())
    await waitFor(() => expect(document.querySelector('.cm-editor')).not.toBeInTheDocument())
  })

  it('再次 Alt+点击其他块时先提交当前块再打开新块', async () => {
    const order: string[] = []
    const onBlockCommit = vi.fn(async (request: MarkdownBlockCommitRequest) => {
      order.push(`commit:${request.block.rawSource}`)
      return { status: 'applied' as const }
    })
    renderPreview({ onBlockCommit })

    altClick(screen.getByText(/段落/))
    await waitFor(() => expect(document.querySelector('.cm-editor')).toBeInTheDocument())
    altClick(screen.getByRole('button', { name: /图片/ }))

    await waitFor(() => expect(onBlockCommit).toHaveBeenCalledTimes(1))
    expect(order[0]).toContain('段落')
    await waitFor(() => expect(document.querySelector('.cm-editor')).toBeInTheDocument())
  })

  it('预览内容防抖期间连续切换块仍按最新 offset 保存，并可用 Esc 退出', async () => {
    const user = userEvent.setup()
    const { onBlockCommit, onContentChange } = renderDelayedPreview()

    altClick(screen.getByText('第一块'))
    let editor = await screen.findByRole('textbox')
    await user.click(editor)
    await user.keyboard('{Control>}a{/Control}第一块（已修改且更长）')

    altClick(screen.getByText('第二块'))
    await waitFor(() => expect(onBlockCommit).toHaveBeenCalledTimes(1))
    editor = await screen.findByRole('textbox')
    await waitFor(() => expect(editor).toHaveTextContent('第二块'))
    await user.click(editor)
    await user.keyboard('{Control>}a{/Control}第二块已修改')
    fireEvent.pointerDown(document.body)

    await waitFor(() => expect(onBlockCommit).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(document.querySelector('.cm-editor')).not.toBeInTheDocument())
    expect(onBlockCommit.mock.results.every((result) => result.type === 'return')).toBe(true)
    expect(onContentChange).toHaveBeenLastCalledWith('第一块（已修改且更长）\n\n第二块已修改\n\n第三块')
  })

  it('连续 Alt+点击第三个块时不误报冲突，并可用外部点击退出', async () => {
    const user = userEvent.setup()
    const { onBlockCommit, onContentChange } = renderDelayedPreview()

    altClick(screen.getByText('第一块'))
    let editor = await screen.findByRole('textbox')
    await user.click(editor)
    await user.keyboard('{Control>}a{/Control}第一块已扩展')

    altClick(screen.getByText('第二块'))
    await waitFor(() => expect(onBlockCommit).toHaveBeenCalledTimes(1))
    editor = await screen.findByRole('textbox')
    await user.click(editor)
    await user.keyboard('{Control>}a{/Control}第二块已扩展')

    altClick(screen.getByText('第三块'))
    await waitFor(() => expect(onBlockCommit).toHaveBeenCalledTimes(2))
    editor = await screen.findByRole('textbox')
    await waitFor(() => expect(editor).toHaveTextContent('第三块'))
    fireEvent.pointerDown(document.body)

    await waitFor(() => expect(onBlockCommit).toHaveBeenCalledTimes(3))
    await waitFor(() => expect(document.querySelector('.cm-editor')).not.toBeInTheDocument())
    expect(screen.queryByText(/内容已在其他位置发生变化/)).not.toBeInTheDocument()
    expect(onContentChange).toHaveBeenLastCalledWith('第一块已扩展\n\n第二块已扩展\n\n第三块')
  })

  it('冲突时保留编辑器和草稿并提供复制入口', async () => {
    const onBlockCommit = vi.fn(async () => ({ status: 'conflict' as const, currentSource: '外部修改' }))
    renderPreview({ onBlockCommit })
    altClick(screen.getByText(/段落/))

    fireEvent.pointerDown(document.body)

    expect(await screen.findByText(/内容已在其他位置发生变化/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '复制修改内容' })).toBeInTheDocument()
    expect(document.querySelector('.cm-editor')).toBeInTheDocument()
  })

  it('异步提交未完成时卸载不会重复提交同一草稿', async () => {
    let resolveCommit: ((result: { status: 'applied'; content: string }) => void) | undefined
    const pendingCommit = new Promise<{ status: 'applied'; content: string }>((resolve) => {
      resolveCommit = resolve
    })
    const onBlockCommit = vi.fn(() => pendingCommit)
    const { unmount } = renderPreview({ onBlockCommit })
    altClick(screen.getByText(/段落/))

    fireEvent.pointerDown(document.body)
    await waitFor(() => expect(onBlockCommit).toHaveBeenCalledOnce())
    unmount()
    expect(onBlockCommit).toHaveBeenCalledOnce()

    await act(async () => {
      resolveCommit?.({ status: 'applied', content: '匿名内容' })
      await pendingCommit
    })
    expect(onBlockCommit).toHaveBeenCalledOnce()
  })

  it('输入法组合期间忽略提交快捷键且不卸载编辑器', async () => {
    const { onBlockCommit, rerender } = renderPreview()
    altClick(screen.getByText(/段落/))
    const editor = document.querySelector('.cm-content') as HTMLElement

    fireEvent.compositionStart(editor)
    fireEvent.keyDown(editor, { key: 'Escape', isComposing: true })
    rerender(
      <>
        <MarkdownPreview
          content={'段落 [链接](https://example.com)\n\n![图片](image.png)\n\n- [ ] 任务'}
          documentKey="doc-1"
          documentVersion={1}
          inlineEditEnabled
          onBlockCommit={onBlockCommit}
          fontSize={15}
        />
        <button type="button">外部按钮</button>
      </>
    )

    expect(onBlockCommit).not.toHaveBeenCalled()
    expect(document.querySelector('.cm-editor')).toBeInTheDocument()
    fireEvent.compositionEnd(editor)
  })

  it('块内输入只更新局部 draft，撤销重做后一次性提交', async () => {
    const user = userEvent.setup()
    const { onBlockCommit } = renderPreview({ content: '原文' })
    altClick(screen.getByText('原文'))
    const editor = await screen.findByRole('textbox')

    await user.click(editor)
    await user.keyboard('{Control>}a{/Control}新内容{Control>}z{/Control}{Control>}y{/Control}')
    fireEvent.pointerDown(document.body)

    await waitFor(() => expect(onBlockCommit).toHaveBeenCalledTimes(1))
    expect(onBlockCommit.mock.calls[0][0].draft).toBe('新内容')
    expect(screen.getByText('新内容')).toBeInTheDocument()
  })

  it('保存后按源码锚点保持视口位置，而不是恢复旧 scrollTop', async () => {
    const user = userEvent.setup()
    const host = document.createElement('div')
    Object.defineProperties(host, {
      clientHeight: { configurable: true, value: 100 },
      clientWidth: { configurable: true, value: 600 },
      scrollTop: { configurable: true, value: 121, writable: true },
    })
    document.body.appendChild(host)
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this === host) return new DOMRect(0, 0, 600, 100)
      const index = this.dataset.mdBlockIndex
      if (index !== undefined) {
        const top = Number.parseFloat(this.style.top || '0') - host.scrollTop
        return new DOMRect(0, top, 600, 40)
      }
      return new DOMRect()
    })

    render(<StatefulAnchoredPreview />, { container: host })
    act(() => host.dispatchEvent(new Event('scroll')))
    const before = host.querySelectorAll<HTMLElement>('[data-md-block-index]')[3]
    const anchorViewportTopBefore = before.getBoundingClientRect().top - host.getBoundingClientRect().top

    const firstBlock = Array.from(host.querySelectorAll<HTMLElement>('[data-md-block-index]'))
      .find((element) => element.textContent?.includes('第1块'))
    expect(firstBlock).toBeDefined()
    altClick(firstBlock as HTMLElement)
    await waitFor(() => expect(host.querySelector('.cm-content')).toBeInTheDocument())
    const editor = host.querySelector('.cm-content') as HTMLElement
    await user.click(editor)
    await user.keyboard('{Control>}a{/Control}第一块\n\n新增块\n\n再新增块')
    fireEvent.pointerDown(document.body)

    await waitFor(() => expect(
      Array.from(host.querySelectorAll<HTMLElement>('[data-md-block-index]'))
        .some((element) => element.textContent?.includes('第4块')),
    ).toBe(true))
    const anchor = Array.from(host.querySelectorAll<HTMLElement>('[data-md-block-index]'))
      .find((element) => element.textContent?.includes('第4块'))
    expect(anchor).toBeDefined()
    expect(anchor!.getBoundingClientRect().top - host.getBoundingClientRect().top)
      .toBeCloseTo(anchorViewportTopBefore, 0)
  })

  it('修改视口下方区块时不刷新上方 DOM，也不改阅读位置', async () => {
    const user = userEvent.setup()
    const host = document.createElement('div')
    let currentScrollTop = 0
    let scrollTopWrites = 0
    Object.defineProperties(host, {
      clientHeight: { configurable: true, value: 100 },
      clientWidth: { configurable: true, value: 600 },
      scrollTop: {
        configurable: true,
        get: () => currentScrollTop,
        set: (value: number) => {
          currentScrollTop = value
          scrollTopWrites += 1
        },
      },
    })
    document.body.appendChild(host)

    render(<StatefulAnchoredPreview />, { container: host })
    act(() => host.dispatchEvent(new Event('scroll')))
    const upperBlock = host.querySelector<HTMLElement>('[data-md-block-index="0"]')
    const lowerBlock = Array.from(host.querySelectorAll<HTMLElement>('[data-md-block-index]'))
      .find((element) => element.textContent?.includes('第8块'))
    expect(upperBlock).toBeDefined()
    expect(lowerBlock).toBeDefined()

    altClick(lowerBlock as HTMLElement)
    const editor = await screen.findByRole('textbox')
    await user.click(editor)
    await user.keyboard('{Control>}a{/Control}第8块已修改')
    fireEvent.pointerDown(document.body)

    await waitFor(() => expect(host).toHaveTextContent('第8块已修改'))
    expect(currentScrollTop).toBe(0)
    expect(scrollTopWrites).toBe(0)
    expect(host.querySelector('[data-md-block-index="0"]')).toBe(upperBlock)
  })

  it('Ctrl+S 先提交块修改再触发文档保存事件', async () => {
    const user = userEvent.setup()
    const order: string[] = []
    const onBlockCommit = vi.fn(async () => {
      order.push('commit')
      return { status: 'applied' as const }
    })
    const handleSave = () => order.push('save')
    window.addEventListener('cm-save', handleSave)
    renderPreview({ content: '原文', onBlockCommit })
    altClick(screen.getByText('原文'))

    await user.keyboard('{Control>}s{/Control}')
    await waitFor(() => expect(order).toEqual(['commit', 'save']))
    window.removeEventListener('cm-save', handleSave)
  })

  it('Ctrl+S 等待异步块提交完成后才触发文档保存事件', async () => {
    const user = userEvent.setup()
    const order: string[] = []
    let resolveCommit!: (result: { status: 'applied' }) => void
    const onBlockCommit = vi.fn(() => {
      order.push('commit')
      return new Promise<{ status: 'applied' }>((resolve) => {
        resolveCommit = resolve
      })
    })
    const handleSave = () => order.push('save')
    window.addEventListener('cm-save', handleSave)
    renderPreview({ content: '原文', onBlockCommit })
    altClick(screen.getByText('原文'))

    await user.keyboard('{Control>}s{/Control}')
    await waitFor(() => expect(onBlockCommit).toHaveBeenCalledOnce())
    expect(order).toEqual(['commit'])

    await act(async () => {
      resolveCommit({ status: 'applied' })
    })
    await waitFor(() => expect(order).toEqual(['commit', 'save']))
    window.removeEventListener('cm-save', handleSave)
  })

  it('外部内容变化时冻结编辑器，提交后按原始范围报告冲突', async () => {
    const onBlockCommit = vi.fn(async () => ({ status: 'conflict' as const, currentSource: 'AI 修改' }))
    const { rerender } = renderPreview({ content: '原文', onBlockCommit })
    altClick(screen.getByText('原文'))

    rerender(
      <>
        <MarkdownPreview
          content="AI 修改"
          documentKey="doc-1"
          documentVersion={2}
          inlineEditEnabled
          onBlockCommit={onBlockCommit}
        />
        <button type="button">外部按钮</button>
      </>
    )
    expect(screen.getByRole('textbox')).toHaveTextContent('原文')

    fireEvent.pointerDown(document.body)
    expect(await screen.findByText(/内容已在其他位置发生变化/)).toBeInTheDocument()
    expect(onBlockCommit.mock.calls[0][0]).toMatchObject({ documentVersion: 1, draft: '原文' })
  })

  it('切换标签页和关闭预览时提交当前块', async () => {
    const onBlockCommit = vi.fn(async () => ({ status: 'applied' as const }))
    const { rerender, unmount } = renderPreview({ content: '文档一', onBlockCommit })
    altClick(screen.getByText('文档一'))

    rerender(
      <MarkdownPreview
        content="文档二"
        documentKey="doc-2"
        documentVersion={1}
        inlineEditEnabled
        onBlockCommit={onBlockCommit}
      />
    )
    await waitFor(() => expect(onBlockCommit).toHaveBeenCalledTimes(1))
    expect(onBlockCommit.mock.calls[0][0].documentKey).toBe('doc-1')

    altClick(await screen.findByText('文档二'))
    unmount()
    expect(onBlockCommit).toHaveBeenCalledTimes(2)
    expect(onBlockCommit.mock.calls[1][0].documentKey).toBe('doc-2')
  })
})

describe('块 DOM 稳定性', () => {
  it('打开编辑后 CodeMirror 宿主元素引用不变', async () => {
    const { rerender } = render(
      <MarkdownPreview content="原文" documentKey="d1" documentVersion={1} inlineEditEnabled onBlockCommit={vi.fn()} />,
    )
    altClick(screen.getByText('原文'))
    const cmHostBefore = document.querySelector('.gm-inline-markdown-editor__host')

    rerender(
      <MarkdownPreview content="原文" documentKey="d1" documentVersion={1} inlineEditEnabled onBlockCommit={vi.fn()} fontSize={15} />,
    )
    const cmHostAfter = document.querySelector('.gm-inline-markdown-editor__host')

    expect(cmHostBefore).toBe(cmHostAfter)
    expect(cmHostAfter).toBeInTheDocument()
  })
})

describe('ReactMarkdown 重渲染保护', () => {
  it('正文未变化时打开编辑不应再次执行 ReactMarkdown', () => {
    render(
      <MarkdownPreview
        content="段落 A\n\n段落 B"
        documentKey="d2"
        documentVersion={1}
        inlineEditEnabled
        onBlockCommit={vi.fn(async () => ({ status: 'applied' as const }))}
      />,
    )
    const initialCount = hoisted.renderCount

    altClick(screen.getByText(/段落 A/))

    expect(document.querySelector('.cm-editor')).toBeInTheDocument()
    expect(hoisted.renderCount).toBe(initialCount)
  })

  it('大文档（2000 段落）打开编辑不触发额外 ReactMarkdown 执行', () => {
    const paragraphs = Array.from({ length: 2000 }, (_, i) => `段落${i + 1}：这是匿名测试内容`).join('\n\n')
    const { container } = render(
      <MarkdownPreview
        content={paragraphs}
        documentKey="d-large"
        documentVersion={1}
        inlineEditEnabled
        onBlockCommit={vi.fn(async () => ({ status: 'applied' as const }))}
      />,
    )
    const initialCount = hoisted.renderCount
    const firstBlock = container.querySelector('[data-md-block-index="0"]') as HTMLElement

    altClick(firstBlock)

    expect(document.querySelector('.cm-editor')).toBeInTheDocument()
    expect(hoisted.renderCount).toBe(initialCount)
  })
})
