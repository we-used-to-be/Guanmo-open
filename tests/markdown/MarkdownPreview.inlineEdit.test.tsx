import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { StrictMode, useRef, useState } from 'react'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { MarkdownPreview, type MarkdownBlockCommitRequest } from '@/components/editor/MarkdownPreview'
import { replaceMarkdownBlock } from '@/services/markdownBlocks'

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

describe('MarkdownPreview 预览内源码编辑', () => {
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
    expect(screen.queryByText('Markdown')).not.toBeInTheDocument()

    altClick(link)
    expect(await screen.findByText('Markdown')).toBeInTheDocument()
    expect(document.querySelector('.cm-editor')).toBeInTheDocument()
  })

  it('Alt+拖动超过阈值时不进入编辑', () => {
    renderPreview()
    const paragraph = screen.getByText(/段落/).closest('[data-md-block-index]') as HTMLElement

    fireEvent.pointerDown(paragraph, { altKey: true, pointerId: 2, clientX: 10, clientY: 10 })
    fireEvent.pointerMove(paragraph, { altKey: true, pointerId: 2, clientX: 22, clientY: 10 })
    fireEvent.pointerUp(paragraph, { altKey: true, pointerId: 2, clientX: 22, clientY: 10 })

    expect(screen.queryByText('Markdown')).not.toBeInTheDocument()
  })

  it('普通点击图片放大和任务复选框仍执行原功能', () => {
    const { onTaskToggle } = renderPreview()
    fireEvent.click(screen.getByRole('checkbox'))
    expect(onTaskToggle).toHaveBeenCalledWith(5, true)

    fireEvent.click(screen.getByRole('button', { name: /图片/ }))
    expect(screen.getByRole('button', { name: '关闭' })).toBeInTheDocument()
  })

  it.each([
    ['图片', () => screen.getByRole('button', { name: /图片/ })],
    ['任务复选框', () => screen.getByRole('checkbox')],
  ])('Alt+点击%s优先进入块编辑', async (_label, getTarget) => {
    renderPreview()
    altClick(getTarget())
    expect(await screen.findByText('Markdown')).toBeInTheDocument()
  })

  it('Alt+点击代码块按钮进入完整代码块编辑并限制最大高度', async () => {
    renderPreview({ content: '```ts\nconst value = 1\n```' })
    altClick(screen.getByRole('button', { name: '复制 ts 代码' }))

    await screen.findByText('Markdown')
    expect(getComputedStyle(document.querySelector('.cm-scroller') as Element).maxHeight).toBe('480px')
  })

  it('外部 pointerdown 提交后恢复预览，Esc 不再提交', async () => {
    const { onBlockCommit } = renderPreview()
    altClick(screen.getByText(/段落/))
    await screen.findByText('Markdown')

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
    await screen.findByText('Markdown')
    altClick(screen.getByRole('button', { name: /图片/ }))

    await waitFor(() => expect(onBlockCommit).toHaveBeenCalledTimes(1))
    expect(order[0]).toContain('段落')
    expect(await screen.findByText('Markdown')).toBeInTheDocument()
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
