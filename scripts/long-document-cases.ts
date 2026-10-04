import { generateAnonymousMarkdown } from './markdown-preview-prototype/generateBenchmarkDoc'

export interface LongDocumentCase {
  name: string
  markdown: string
}

const fillTo = (target: number, unit: string) => unit.repeat(Math.ceil(target / unit.length)).slice(0, target)

export function createLongDocumentCases(): LongDocumentCase[] {
  const ordinary = [100_000, 300_000, 500_000, 1_000_000].map((size) => ({
    name: `ordinary-${size}`,
    markdown: generateAnonymousMarkdown(size, 7).markdown,
  }))
  const shortParagraphs = fillTo(300_000, '短段落用于测量滚动几何。\n\n')
  const list = fillTo(300_000, '- 列表项用于测量单块退化。\n')
  const table = (size: number) => `| 字段 | 内容 | 结果 |\n| --- | --- | --- |\n${fillTo(size, '| 数据 | 样本 | 结果 |\n')}`
  const code = fillTo(300_000, 'const sample = 1; // 匿名基准\n')
  const htmlBody = fillTo(100_000, '跨块 HTML 内的普通段落。\n\n')
  return [
    ...ordinary,
    { name: 'short-paragraphs-300000', markdown: shortParagraphs },
    { name: 'giant-list-300000', markdown: list },
    { name: 'giant-table-50000', markdown: table(50_000) },
    { name: 'giant-table-100000', markdown: table(100_000) },
    { name: 'giant-table-150000', markdown: table(150_000) },
    { name: 'giant-code-300000', markdown: `\`\`\`typescript\n${code}\n\`\`\`` },
    { name: 'cross-block-html-100000', markdown: `<div>\n\n${htmlBody}\n</div>` },
  ]
}
