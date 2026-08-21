import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ReactMarkdown from 'react-markdown'
import { describe, expect, it } from 'vitest'
import { MARKDOWN_HTML_REHYPE_PLUGINS } from '@/services/markdownHtml'
import { sanitizeAndScopeSvgCss } from '@/services/svgStyle'

function renderMarkdown(markdown: string): string {
  return renderToStaticMarkup(
    <ReactMarkdown rehypePlugins={MARKDOWN_HTML_REHYPE_PLUGINS}>{markdown}</ReactMarkdown>,
  )
}

/** issue #22 真实回归样例：含标题、StripeDirect 标签、文字、框、连线、箭头。 */
const SAMPLE_SVG = `<svg viewBox="0 0 680 320" width="100%" role="img" xmlns="http://www.w3.org/2000/svg">
<title>payment-info 阶段两个支付插件的前端 JS 行为</title>
<desc>StripeDirect 和 PayPalStandardPro 在 payment-info 阶段都需要前端 JS 与支付网关交互，无法用单个 POST 完成下单加支付</desc>
<defs>
<marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
<path d="M2 1L8 5L2 9" fill="none" stroke="context-stroke" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
</marker>
<style>
.t{font:13px var(--font-sans);fill:var(--color-text-primary)}
.ts{font:12px var(--font-sans);fill:var(--color-text-secondary)}
.th{font:500 14px var(--font-sans);fill:var(--color-text-primary)}
.lane{font:500 12px var(--font-sans)}
</style>
</defs>
<text class="th" x="40" y="30">payment-info 阶段：两个支付插件都靠前端 JS 与网关交互</text>

<rect x="40" y="50" width="92" height="22" rx="11" fill="#E6F1FB" stroke="#185FA5" stroke-width="0.5"/>
<text class="lane" x="86" y="61" text-anchor="middle" dominant-baseline="central" fill="#0C447C">StripeDirect</text>
<line x1="86" y1="72" x2="86" y2="120" stroke="#185FA5" stroke-width="1.5" marker-end="url(#arrow)"/>
<rect x="20" y="120" width="132" height="60" rx="8" fill="url(#grad)" stroke="#185FA5"/>
<text x="86" y="150" text-anchor="middle" fill="#0C447C">payment-info</text>
</svg>`

describe('Markdown inline SVG sanitation', () => {
  it('保留单行 SVG 的内联元素', () => {
    const html = renderMarkdown('<svg viewBox="0 0 10 10"><text x="1" y="3">单行文字</text><line x1="0" y1="5" x2="9" y2="5" /></svg>')

    expect(html).toContain('<svg viewBox="0 0 10 10">')
    expect(html).toContain('<text x="1" y="3">单行文字</text>')
    expect(html).toContain('<line x1="0" y1="5" x2="9" y2="5"></line>')
  })

  it('保留空行分隔的 SVG 图形、连线和文字', () => {
    const html = renderMarkdown(`<svg width="360" height="180" viewBox="0 0 360 180" xmlns="http://www.w3.org/2000/svg">
<rect x="10" y="10" width="340" height="160" rx="12" fill="#F7F9FC" stroke="#3A6EA5" stroke-width="2"/>

<circle cx="70" cy="90" r="28" fill="#E6F1FB" stroke="#185FA5" stroke-width="2"/>

<line x1="100" y1="90" x2="230" y2="90" stroke="#185FA5" stroke-width="3"/>

<path d="M230 90 L215 82 M230 90 L215 98" fill="none" stroke="#185FA5" stroke-width="3"/>

<text x="70" y="96" text-anchor="middle" font-size="14" fill="#0C447C">开始</text>
</svg>`)

    expect(html).toContain('<rect')
    expect(html).toContain('<circle')
    expect(html).toContain('<line')
    expect(html).toContain('<path')
    expect(html).toContain('<text')
    expect(html).toContain('>开始</text>')
  })

  it('保留空行分隔 SVG 的文字定位与字号样式', () => {
    const html = renderMarkdown(`<svg width="360" height="180" viewBox="0 0 360 180" xmlns="http://www.w3.org/2000/svg">
  <rect x="10" y="10" width="340" height="160" rx="12"
        fill="#F7F9FC" stroke="#3A6EA5" stroke-width="2"/>

  <circle cx="70" cy="90" r="28"
          fill="#E6F1FB" stroke="#185FA5" stroke-width="2"/>

  <line x1="100" y1="90" x2="230" y2="90"
        stroke="#185FA5" stroke-width="3"/>

  <path d="M230 90 L215 82 M230 90 L215 98"
        fill="none" stroke="#185FA5" stroke-width="3"/>

  <text x="70" y="96"
        text-anchor="middle"
        font-size="14"
        fill="#0C447C">开始</text>

  <text x="285" y="96"
        text-anchor="middle"
        font-size="16"
        font-weight="600"
        fill="#26374A">SVG OK</text>
</svg>`)

    expect(html).toContain('stroke-width="2"')
    expect(html).toMatch(/<text[^>]*x="70"[^>]*y="96"[^>]*text-anchor="middle"[^>]*font-size="14"[^>]*>开始<\/text>/)
    expect(html).toMatch(/<text[^>]*x="285"[^>]*y="96"[^>]*text-anchor="middle"[^>]*font-size="16"[^>]*font-weight="600"[^>]*>SVG OK<\/text>/)
  })

  it('保留静态 SVG 图形和本地 marker 引用', () => {
    const html = renderMarkdown(`
<svg viewBox="0 0 100 40" width="100%" role="img" xmlns="http://www.w3.org/2000/svg">
  <title>匿名流程图</title>
  <defs>
    <marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
      <path d="M2 1L8 5L2 9" fill="none" stroke="context-stroke" stroke-width="1.5" stroke-linecap="round" />
    </marker>
  </defs>
  <rect x="1" y="1" width="20" height="12" rx="6" fill="#E6F1FB" />
  <circle cx="30" cy="7" r="5" fill="#E6F1FB" />
  <path d="M21 7H90" marker-end="url(#arrow)" />
  <text x="50" y="30" text-anchor="middle"><tspan>静态 SVG</tspan></text>
</svg>
`)

    expect(html).toContain('<svg viewBox="0 0 100 40"')
    expect(html).toContain('<marker id="user-content-arrow"')
    expect(html).toContain('marker-end="url(#user-content-arrow)"')
    expect(html).toContain('<rect')
    expect(html).toContain('<circle')
    expect(html).toContain('<tspan>静态 SVG</tspan>')
    expect(html).toContain('<text')
    expect(html).toContain('stroke="context-stroke"')
    expect(html).toContain('stroke-linecap="round"')
  })

  it('真实回归样例：标题、标签、文字、框、连线、箭头全部保留', () => {
    const html = renderMarkdown(SAMPLE_SVG)

    // 图形与文字不再丢失
    expect(html).toContain('<svg viewBox="0 0 680 320" width="100%"')
    expect(html).toContain('StripeDirect')
    expect(html).toContain('payment-info')
    expect(html).toContain('两个支付插件都靠前端 JS 与网关交互')
    expect(html).toContain('<rect')
    expect(html).toContain('<line')
    expect(html).toContain('<path')

    // defs + marker 箭头保留
    expect(html).toContain('<marker id="user-content-arrow"')
    expect(html).toContain('marker-end="url(#user-content-arrow)"')
    expect(html).toContain('stroke="context-stroke"')

    // 修复后的 stroke-linecap / stroke-linejoin 不再被白名单大小写错误删除
    expect(html).toContain('stroke-linecap="round"')
    expect(html).toContain('stroke-linejoin="round"')

    // <style> + class 样式生效且被作用域化，CSS 变量保留
    expect(html).toContain('<style>')
    expect(html).toMatch(/data-gm-svg-scope="[0-9a-f]{8}"/)
    expect(html).toContain('var(--color-text-primary, var(--gm-text))')
    expect(html).toContain('font: 500 14px var(--font-sans, var(--gm-font-family))')
  })

  it('过滤脚本、事件、外部资源和 foreignObject，同时保留安全 <style>', () => {
    const html = renderMarkdown(`
<svg viewBox="0 0 10 10" onload="alert(1)">
  <style>.ok { fill: var(--color-brand) }</style>
  <script>alert(1)</script>
  <foreignObject><div>不应渲染</div></foreignObject>
  <a href="javascript:alert(1)">危险链接</a>
  <a href="https://invalid.example/navigate">外部导航</a>
  <img src="https://invalid.example/image.png" alt="外部图片" />
  <use href="https://invalid.example/x.svg" />
  <rect width="10" height="10" fill="url(https://invalid.example/track.svg)" onclick="alert(2)" />
</svg>
`)

    expect(html).toContain('<svg viewBox="0 0 10 10"')
    // 脚本 / 事件 / 外部资源 / foreignObject 被阻止
    expect(html).not.toContain('<script')
    expect(html).not.toContain('alert(1)')
    expect(html).not.toContain('onload')
    expect(html).not.toContain('onclick')
    expect(html).not.toContain('javascript:')
    expect(html).not.toContain('invalid.example')
    expect(html).not.toContain('<img')
    expect(html).not.toContain('<a')
    expect(html).not.toContain('<foreignObject')
    expect(html).not.toContain('不应渲染')
    // 安全 <style> + CSS 变量仍保留（scoped）
    expect(html).toContain('<style>')
    expect(html).toContain('var(--color-brand, var(--gm-primary))')
  })

  it('顶层 <style>（非 SVG）整体丢弃，不污染外部 DOM', () => {
    const html = renderMarkdown('<style>body { display: none }</style>\n\n<p>正文</p>')
    expect(html).not.toContain('<style')
    expect(html).not.toContain('display: none')
    expect(html).toContain('正文')
  })

  it('SVG 内 <style> 被作用域化，body 选择器无法影响外部 DOM', () => {
    const html = renderMarkdown(`
<svg viewBox="0 0 10 10">
  <style>body { display: none }.node { fill: red }</style>
  <circle class="node" cx="5" cy="5" r="4" />
</svg>
`)
    const decodedStyleText = html.replaceAll('&quot;', '"')
    // body 与 .node 规则都被前缀作用域包裹，不再存在裸的 body 选择器
    expect(decodedStyleText).toMatch(/\[data-gm-svg-scope="[0-9a-f]{8}"\] body/)
    expect(decodedStyleText).toMatch(/\[data-gm-svg-scope="[0-9a-f]{8}"\] \.node/)
    expect(decodedStyleText).toContain('fill: red')
  })
})

describe('sanitizeAndScopeSvgCss', () => {
  const scope = '[data-gm-svg-scope="00000000"]'

  it('保留 class 样式、CSS 变量与 context-stroke', () => {
    const out = sanitizeAndScopeSvgCss(
      '.th{fill:var(--color-text-primary);font:500 14px var(--font-sans)}.line{stroke:context-stroke}',
      scope,
    )
    expect(out).toContain('fill: var(--color-text-primary, var(--gm-text))')
    expect(out).toContain('font: 500 14px var(--font-sans, var(--gm-font-family))')
    expect(out).toContain('stroke: context-stroke')
    expect(out).toContain('[data-gm-svg-scope="00000000"] .th')
    expect(out).toContain('[data-gm-svg-scope="00000000"] .line')
  })

  it('丢弃 @import / @font-face / @media 等 at-rule', () => {
    const out = sanitizeAndScopeSvgCss(
      '@import url(https://x.css);@font-face{src:url(https://x.woff2)}.a{fill:red}',
      scope,
    )
    expect(out).not.toContain('@import')
    expect(out).not.toContain('@font-face')
    expect(out).not.toContain('https://x')
    expect(out).toContain('fill: red')
  })

  it('阻止外部 url / data: url，仅允许本地片段并重写 clobber 前缀', () => {
    const out = sanitizeAndScopeSvgCss(
      '.a{fill:url(https://x.svg)}.b{fill:url(data:image/svg+xml;base64,xx)}.c{fill:url(#grad)}',
      scope,
    )
    expect(out).not.toContain('https://x.svg')
    expect(out).not.toContain('data:image')
    expect(out).toContain('url(#user-content-grad)')
  })

  it('阻止 script 向量（expression / behavior / javascript:）', () => {
    const out = sanitizeAndScopeSvgCss(
      '.a{background:expression(alert(1))}.b{behavior:url(#x)}.c{background:url(javascript:alert(1))}.d{width:10px}',
      scope,
    )
    expect(out).not.toContain('expression')
    expect(out).not.toContain('behavior')
    expect(out).not.toContain('javascript:')
    expect(out).toContain('width: 10px')
  })

  it('阻止 CSS 转义和 image-set 形式的外部资源', () => {
    const out = sanitizeAndScopeSvgCss(
      '.escaped{background-image:u\\72 l(https://x.svg)}.set{background-image:image-set("https://x.png" 1x)}.c{fill:url(#grad)}',
      scope,
    )
    expect(out).not.toContain('https://x.svg')
    expect(out).not.toContain('https://x.png')
    expect(out).not.toContain('image-set')
    expect(out).toContain('url(#user-content-grad)')
  })

  it('作用域化多个逗号选择器', () => {
    const out = sanitizeAndScopeSvgCss('.a,.b g,.c > path{stroke:#333}', scope)
    expect(out).toContain('[data-gm-svg-scope="00000000"] .a, [data-gm-svg-scope="00000000"] .b g, [data-gm-svg-scope="00000000"] .c > path')
  })
})
