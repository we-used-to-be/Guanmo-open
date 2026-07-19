import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'
import ReactMarkdown from 'react-markdown'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import { normalizeLatexBlockDelimiters, remarkStandaloneDisplayMath } from '../src/services/markdownMath'

const cases = [
  '$$x^2 + y_1$$',
  '\\[\\text{中文公式} + \\frac{a_1}{b^2}\\]',
  String.raw`\[
\begin{aligned}
a &= b + c \\
d &= e - f
\end{aligned}
\]`,
]

for (const markdown of cases) {
  const html = renderToStaticMarkup(
    <ReactMarkdown remarkPlugins={[remarkMath, remarkStandaloneDisplayMath]} rehypePlugins={[rehypeKatex]}>
      {normalizeLatexBlockDelimiters(markdown)}
    </ReactMarkdown>,
  )
  assert.match(html, /class="katex-display"/)
  assert.doesNotMatch(html, /katex-error/)
}

const anchoredFormula = String.raw`\[
10011
\]`
const anchoredHtml = renderToStaticMarkup(
  <ReactMarkdown remarkPlugins={[remarkMath, remarkStandaloneDisplayMath]} rehypePlugins={[rehypeKatex]}>
    {normalizeLatexBlockDelimiters(anchoredFormula)}
  </ReactMarkdown>,
)
assert.match(anchoredHtml, /data-md-line="1"/)
assert.match(anchoredHtml, /data-md-end-line="3"/)
assert.match(anchoredHtml, /<annotation encoding="application\/x-tex">10011<\/annotation>/)

const fenced = ['```text', String.raw`\[`, 'x^2', String.raw`\]`, '```'].join('\n')
assert.equal(normalizeLatexBlockDelimiters(fenced), fenced)
assert.equal(normalizeLatexBlockDelimiters('before \\[x\\] after'), 'before \\[x\\] after')
assert.equal(normalizeLatexBlockDelimiters('  \\[x^2\\]  '), '  $$x^2$$  ')

console.log('Markdown 数学公式检查通过')
process.exit(0)
