import { createRef } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { SearchOverlay } from '@/components/editor/SearchOverlay'

describe('SearchOverlay 预览全文搜索', () => {
  it('使用 Ctrl+F 请求的初始选区文本并定位到该选区匹配', () => {
    const paneRef = createRef<HTMLDivElement>()
    const scrollToOffset = vi.fn()
    const previewRef = { current: { scrollToOffset } }
    const content = '目标一\n\n目标二'

    render(
      <SearchOverlay
        onClose={vi.fn()}
        searchRequest={{
          requestId: 1,
          target: 'preview',
          initialQuery: '目标二',
          anchor: { offset: content.lastIndexOf('目标二'), sourceIndex: 0 },
        }}
        previewSources={[{ content, paneRef, previewRef }]}
      />,
    )

    const searchInput = screen.getByPlaceholderText('搜索...')
    expect(searchInput).toHaveValue('目标二')
    expect(searchInput).toHaveFocus()
    expect(searchInput.closest('[data-editor-search-overlay]')).not.toHaveClass('animate-slideInUp')
    expect(screen.getByText('1/1')).toBeInTheDocument()
    expect(scrollToOffset).toHaveBeenLastCalledWith(content.lastIndexOf('目标二'))
  })

  it('父组件重渲染后不重复消费 Ctrl+F 初始锚点', () => {
    const paneRef = createRef<HTMLDivElement>()
    const scrollToOffset = vi.fn()
    const previewRef = { current: { scrollToOffset } }
    const content = '目标一\n\n目标二'
    const searchRequest = {
      requestId: 1,
      target: 'preview' as const,
      initialQuery: '目标',
      anchor: { offset: content.indexOf('目标一'), sourceIndex: 0 },
    }
    const { rerender } = render(
      <SearchOverlay
        onClose={vi.fn()}
        searchRequest={searchRequest}
        previewSources={[{ content, paneRef, previewRef }]}
      />,
    )

    fireEvent.click(screen.getByTitle('下一个 (Enter)'))
    expect(screen.getByText('2/2')).toBeInTheDocument()
    expect(scrollToOffset).toHaveBeenLastCalledWith(content.lastIndexOf('目标二'))

    rerender(
      <SearchOverlay
        onClose={vi.fn()}
        searchRequest={searchRequest}
        previewSources={[{ content, paneRef, previewRef }]}
      />,
    )

    expect(screen.getByText('2/2')).toBeInTheDocument()
    expect(scrollToOffset).toHaveBeenCalledTimes(2)
    expect(scrollToOffset).toHaveBeenLastCalledWith(content.lastIndexOf('目标二'))
  })

  it('统计未挂载内容并按匹配 offset 请求虚拟预览定位', () => {
    const paneRef = createRef<HTMLDivElement>()
    const scrollToOffset = vi.fn()
    const previewRef = { current: { scrollToOffset } }
    const content = '首屏内容\n\n隐藏目标\n\n再次出现隐藏目标'

    render(
      <>
        <div ref={paneRef}>首屏内容</div>
        <SearchOverlay
          onClose={vi.fn()}
          previewSources={[{ content, paneRef, previewRef }]}
        />
      </>,
    )

    fireEvent.change(screen.getByPlaceholderText('搜索...'), { target: { value: '隐藏目标' } })

    expect(screen.getByText('1/2')).toBeInTheDocument()
    expect(scrollToOffset).toHaveBeenLastCalledWith(content.indexOf('隐藏目标'))

    fireEvent.click(screen.getByTitle('下一个 (Enter)'))

    expect(screen.getByText('2/2')).toBeInTheDocument()
    expect(scrollToOffset).toHaveBeenLastCalledWith(content.lastIndexOf('隐藏目标'))
  })

  it('提供视口锚点时跳到离锚点最近的匹配（而不是文档首个匹配）', () => {
    const paneRef = createRef<HTMLDivElement>()
    const scrollToOffset = vi.fn()
    const previewRef = {
      current: {
        scrollToOffset,
        // 视口停在第二个匹配之后：首个匹配 offset 0，第二个在 offset 13
        getViewportOffset: () => 20,
      },
    }
    const content = '隐藏目标一\n\n隐藏目标二'

    render(
      <>
        <div ref={paneRef}>隐藏目标一</div>
        <SearchOverlay
          onClose={vi.fn()}
          previewSources={[{ content, paneRef, previewRef }]}
        />
      </>,
    )

    fireEvent.change(screen.getByPlaceholderText('搜索...'), { target: { value: '隐藏目标' } })

    // 初始即选中第二个匹配 → 计数显示 2/2
    expect(screen.getByText('2/2')).toBeInTheDocument()
    // 锚点 20 距首个匹配（offset 0）更远、距第二个匹配（offset 7）更近 → 初始即跳第二个
    expect(scrollToOffset).toHaveBeenLastCalledWith(content.lastIndexOf('隐藏目标'))
  })
})
