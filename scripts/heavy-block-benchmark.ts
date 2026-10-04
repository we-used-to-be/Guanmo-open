import { performance } from 'node:perf_hooks'
import { remark } from 'remark'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import remarkRehype from 'remark-rehype'
import rehypeHighlight from 'rehype-highlight'
import { createMarkdownPreviewModel, MARKDOWN_GFM_OPTIONS } from '@/services/markdownPreviewModel'
import { createSourceOffsetAnnotator } from '@/services/previewHighlight'
import { createLongDocumentCases } from './long-document-cases'

const gfm = remark().use(remarkGfm, MARKDOWN_GFM_OPTIONS).use(remarkMath)
const plain = remark().use(remarkMath)
const originalCases = createLongDocumentCases().filter((item) => /giant-(table|list|code)/.test(item.name))
const byName = new Map(originalCases.map((item) => [item.name, item.markdown]))
const shorten = (type: string, size: number) => {
  const original = byName.get(`giant-${type}-${type === 'table' ? '50000' : '300000'}`)!
  const prefix = type === 'table' ? original.slice(0, original.indexOf('\n', original.indexOf('\n') + 1) + 1) : ''
  const body = type === 'code' ? original.slice(original.indexOf('\n') + 1, original.lastIndexOf('\n```')) : original.slice(prefix.length)
  const safeBody = body.slice(0, size - prefix.length).replace(/[^\n]*$/, '')
  return { name: `giant-${type}-${size}`, markdown: type === 'code' ? `\`\`\`typescript\n${safeBody}\n\`\`\`` : prefix + safeBody }
}
const cases = [
  ...[5_000, 10_000, 20_000, 30_000].map((size) => shorten('table', size)),
  ...[50_000, 100_000, 200_000].map((size) => shorten('list', size)),
  ...[50_000, 100_000, 200_000].map((size) => shorten('code', size)),
  ...(process.env.GM_HEAVY_SWEEP_ONLY ? [] : originalCases),
].filter((item) => !process.argv[2] || item.name === process.argv[2])
const median = (values: number[]) => values.sort((a, b) => a - b)[Math.floor(values.length / 2)]
const measure = (fn: () => unknown) => {
  const start = performance.now()
  fn()
  return performance.now() - start
}

// Deliberately cheap preparse scan. It identifies candidate line spans, not exact Markdown semantics.
function scan(markdown: string) {
  let lines = 0
  let pipes = 0
  let listLines = 0
  let codeLines = 0
  let fenceOpen = false
  for (let start = 0; start < markdown.length;) {
    let end = markdown.indexOf('\n', start)
    if (end < 0) end = markdown.length
    const line = markdown.slice(start, end)
    lines++
    if (/^\s*(```|~~~)/.test(line)) fenceOpen = !fenceOpen
    else if (fenceOpen) codeLines++
    else if (/^\s*[-*+]\s/.test(line)) listLines++
    else if (line.startsWith('|')) pipes++
    start = end + 1
  }
  return { lines, pipes, listLines, codeLines }
}

for (const sample of cases) {
  const x = sample.markdown
  const result = {
    name: sample.name,
    chars: x.length,
    bytes: Buffer.byteLength(x),
    gfmParseMs: median(Array.from({ length: 3 }, () => measure(() => gfm.parse(x)))),
    noGfmParseMs: median(Array.from({ length: 3 }, () => measure(() => plain.parse(x)))),
    modelMs: median(Array.from({ length: 3 }, () => measure(() => createMarkdownPreviewModel(x)))),
    scanMs: median(Array.from({ length: 10 }, () => measure(() => scan(x)))),
    scan: scan(x),
  }
  if (sample.name.startsWith('giant-code')) {
    const model = createMarkdownPreviewModel(x)
    const processor = remark().use(remarkGfm, MARKDOWN_GFM_OPTIONS).use(remarkMath).use(remarkRehype)
    const tree = processor.runSync(processor.parse(x))
    const highlight = rehypeHighlight()
    const annotate = createSourceOffsetAnnotator(0, x, model.blocks[0].textSegments)()
    const clone = () => structuredClone(tree)
    const highlighted = clone()
    const highlightMs = median(Array.from({ length: 3 }, () => measure(() => highlight(clone()))))
    highlight(highlighted)
    const annotateHighlightedMs = median(Array.from({ length: 3 }, () => measure(() => annotate(cloneAfterHighlight()))))
    const annotatePlainMs = median(Array.from({ length: 3 }, () => measure(() => annotate(clone()))))
    function cloneAfterHighlight() { return structuredClone(highlighted) }
    Object.assign(result, { highlightMs, annotateHighlightedMs, annotatePlainMs })
  }
  process.stdout.write(`${JSON.stringify(result)}\n`)
}
