import { render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { MarkdownPreview } from '@/components/editor/MarkdownPreview'

describe('MarkdownPreview 内嵌 HTML', () => {
  it('渲染 GitHub README 常见的 HTML 混排', async () => {
    const { container } = render(
      <MarkdownPreview
        content={[
          '<p align="center"><img src="logo.png" alt="项目 Logo" width="120"></p>',
          '',
          '<details open><summary>更多信息</summary><div>说明<br>第二行</div></details>',
          '',
          '<table><thead><tr><th>名称</th></tr></thead><tbody><tr><td>GuanMo</td></tr></tbody></table>',
          '',
          '<blockquote>引用 <span>内容</span></blockquote>',
          '',
          'H<sub>2</sub>O X<sup>2</sup> <kbd>Ctrl</kbd>',
          '',
          '现有公式 $x^2$',
        ].join('\n')}
      />,
    )

    await waitFor(() => expect(container.querySelector('details')).toBeInTheDocument())
    const centeredParagraph = container.querySelector('p[align="center"]')
    expect(centeredParagraph).not.toBeNull()
    expect(screen.getByRole('img', { name: '项目 Logo' })).toHaveAttribute('width', '120')
    expect(container.querySelector('details[open] summary')).toHaveTextContent('更多信息')
    expect(container.querySelector('details br')).toBeInTheDocument()
    expect(screen.getByRole('cell', { name: 'GuanMo' })).toBeInTheDocument()
    expect(screen.getByText('内容')).toBeInTheDocument()
    expect(container.querySelector('sub')).toHaveTextContent('2')
    expect(container.querySelector('sup')).toHaveTextContent('2')
    expect(container.querySelector('kbd')).toHaveTextContent('Ctrl')
    expect(container.querySelector('.katex')).toBeInTheDocument()
  })

  it('完整渲染带空行、defs、style、marker 和文字节点的内联 SVG', async () => {
    const { container } = render(
      <MarkdownPreview
        content={`<svg viewBox="0 0 680 320" width="100%" role="img" xmlns="http://www.w3.org/2000/svg">
<title>payment-info 阶段两个支付插件的前端 JS 行为</title>
<desc>StripeDirect 和 PayPalStandardPro 在 payment-info 阶段都需要前端 JS 与支付网关交互</desc>
<defs>
<marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
<path d="M2 1L8 5L2 9" fill="none" stroke="context-stroke" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
</marker>
<style>.lane{font:500 12px var(--font-sans);fill:var(--color-text-primary)}</style>
</defs>
<text class="lane" x="86" y="30">payment-info</text>

<rect x="40" y="50" width="92" height="22" rx="11" fill="#E6F1FB" stroke="#185FA5" stroke-width="0.5"/>
<text class="lane" x="86" y="61" text-anchor="middle" dominant-baseline="central">StripeDirect</text>
<line x1="86" y1="72" x2="86" y2="120" stroke="#185FA5" stroke-width="1.5" marker-end="url(#arrow)"/>
</svg>`}
      />,
    )

    await waitFor(() => expect(container.querySelector('svg')).toBeInTheDocument())
    expect(container.querySelector('svg')).toHaveAttribute('width', '100%')
    expect(container.querySelector('svg title')).toHaveTextContent('payment-info 阶段两个支付插件')
    expect(container.querySelector('svg desc')).toHaveTextContent('StripeDirect 和 PayPalStandardPro')
    expect(container.querySelector('svg style')).toBeInTheDocument()
    expect(container.querySelector('svg marker')).toBeInTheDocument()
    expect(container.querySelector('svg path')).toBeInTheDocument()
    expect(container.querySelector('svg rect')).toBeInTheDocument()
    expect(container.querySelector('svg text')).toHaveTextContent('payment-info')
    expect(container.querySelector('svg text > span')).toBeNull()
    expect(screen.getByText('StripeDirect')).toBeInTheDocument()
    expect(container.querySelector('svg line')).toHaveAttribute('marker-end', 'url(#user-content-arrow)')
  })

  it('完整渲染未换行的内联 SVG（虚拟块边界）', async () => {
    const { container } = render(
      <MarkdownPreview
        content={'<svg viewBox="0 0 100 40"><defs><marker id="arrow"><path d="M0 0L5 5L0 10" /></marker></defs><text x="1" y="3">单行文字</text><line x1="0" y1="5" x2="90" y2="5" marker-end="url(#arrow)" /></svg>'}
      />,
    )

    await waitFor(() => expect(container.querySelector('svg')).toBeInTheDocument())
    expect(container.querySelector('svg text')).toHaveTextContent('单行文字')
    expect(container.querySelector('svg line')).toHaveAttribute('marker-end', 'url(#user-content-arrow)')
  })

  it('保留空行分隔 SVG 的文字定位与字号样式', async () => {
    const { container } = render(
      <MarkdownPreview
        content={`<svg width="360" height="180" viewBox="0 0 360 180" xmlns="http://www.w3.org/2000/svg">
  <rect x="10" y="10" width="340" height="160" rx="12" fill="#F7F9FC" stroke="#3A6EA5" stroke-width="2"/>

  <circle cx="70" cy="90" r="28" fill="#E6F1FB" stroke="#185FA5" stroke-width="2"/>

  <line x1="100" y1="90" x2="230" y2="90" stroke="#185FA5" stroke-width="3"/>

  <path d="M230 90 L215 82 M230 90 L215 98" fill="none" stroke="#185FA5" stroke-width="3"/>

  <text x="70" y="96" text-anchor="middle" font-size="14" fill="#0C447C">开始</text>

  <text x="285" y="96" text-anchor="middle" font-size="16" font-weight="600" fill="#26374A">SVG OK</text>
</svg>`}
      />,
    )

    await waitFor(() => expect(container.querySelector('svg')).toBeInTheDocument())
    const texts = container.querySelectorAll('svg text')
    expect(texts).toHaveLength(2)
    expect(texts[0]).toHaveAttribute('text-anchor', 'middle')
    expect(texts[0]).toHaveAttribute('font-size', '14')
    expect(texts[1]).toHaveAttribute('text-anchor', 'middle')
    expect(texts[1]).toHaveAttribute('font-size', '16')
    expect(texts[1]).toHaveAttribute('font-weight', '600')
    expect(container.querySelector('svg line')).toHaveAttribute('stroke-width', '3')
  })

  it('以隐私友好的方式加载 HTTPS 图片', async () => {
    render(
      <MarkdownPreview
        content='<img src="https://example.com/image.png" alt="远程图片" width="90%">'
      />,
    )

    const image = await screen.findByRole('img', { name: '远程图片' })
    expect(image).toHaveAttribute('src', 'https://example.com/image.png')
    expect(image).toHaveAttribute('referrerpolicy', 'no-referrer')
    expect(image).toHaveAttribute('loading', 'lazy')
    expect(image).toHaveAttribute('decoding', 'async')
  })

  it('移除危险标签、事件属性、样式和危险 URL', async () => {
    const { container } = render(
      <MarkdownPreview
        content={[
          '<script>globalThis.__htmlAttack = true</script>',
          '<iframe src="https://example.com"></iframe>',
          '<object data="https://example.com"></object>',
          '<embed src="https://example.com">',
          '<img src="safe.png" alt="安全图片" onerror="globalThis.__htmlAttack = true" style="position:fixed">',
          '<span onclick="globalThis.__htmlAttack = true" class="hostile">安全文本</span>',
          '<a href="javascript:globalThis.__htmlAttack = true">危险链接</a>',
        ].join('\n')}
      />,
    )

    await screen.findByText('安全文本')
    expect(container.querySelector('script, iframe, object, embed')).toBeNull()
    expect(container.querySelector('[onerror], [onclick], .hostile')).toBeNull()
    const safeImage = screen.getByRole('img', { name: '安全图片' })
    expect(safeImage).toHaveAttribute('src', 'safe.png')
    expect(safeImage).not.toHaveAttribute('style')
    expect(screen.getByText('安全文本')).not.toHaveAttribute('style')
    expect(screen.getByText('危险链接').closest('a')).not.toHaveAttribute('href')
    expect((globalThis as typeof globalThis & { __htmlAttack?: boolean }).__htmlAttack).toBeUndefined()
  })

  it('skipHtml 仍可完全禁用内嵌 HTML', () => {
    const { container } = render(
      <MarkdownPreview content="<details><summary>隐藏内容</summary></details>" skipHtml />,
    )

    expect(container.querySelector('details')).toBeNull()
    expect(screen.queryByText('隐藏内容')).not.toBeInTheDocument()
  })
})
