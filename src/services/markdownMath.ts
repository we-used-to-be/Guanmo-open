import type { Root } from 'mdast'
import type { Plugin } from 'unified'

export function normalizeLatexBlockDelimiters(markdown: string): string {
  const parts = markdown.split(/(\r?\n)/)
  const lines = parts.filter((_, index) => index % 2 === 0)
  const pairedDelimiterLines = new Set<number>()
  let fence: { marker: '`' | '~'; length: number } | null = null
  let openingLine: number | null = null

  lines.forEach((line, index) => {
    const fenceMatch = line.match(/^\s{0,3}(`{3,}|~{3,})/)
    if (fenceMatch) {
      const marker = fenceMatch[1][0] as '`' | '~'
      if (!fence) {
        fence = { marker, length: fenceMatch[1].length }
      } else if (marker === fence.marker && fenceMatch[1].length >= fence.length) {
        fence = null
      }
      return
    }
    if (fence) return

    const trimmed = line.trim()
    if (trimmed === '\\[' && openingLine === null) {
      openingLine = index
      return
    }
    if (trimmed === '\\]' && openingLine !== null) {
      pairedDelimiterLines.add(openingLine)
      pairedDelimiterLines.add(index)
      openingLine = null
    }
  })

  let lineIndex = 0
  return parts.map((part, index) => {
    if (index % 2 === 1) return part
    const currentLine = lineIndex++
    if (pairedDelimiterLines.has(currentLine)) {
      return part.replace(/\\([\[\]])/, () => '$$')
    }

    if (/^\s{0,3}\\\[.*\\\]\s*$/.test(part)) {
      return part.replace('\\[', () => '$$').replace(/\\\](\s*)$/, (_, trailing: string) => `$$${trailing}`)
    }
    return part
  }).join('')
}

export const remarkStandaloneDisplayMath: Plugin<[], Root> = () => (tree, file) => {
  const source = String(file.value ?? '')

  tree.children.forEach((node) => {
    if (node.type === 'math') {
      node.data = {
        hName: 'div',
        hProperties: {
          'data-md-line': node.position?.start.line,
          'data-md-end-line': node.position?.end.line,
        },
        hChildren: [{
          type: 'element',
          tagName: 'code',
          properties: { className: ['language-math', 'math-display'] },
          children: [{ type: 'text', value: node.value }],
        }],
      }
      return
    }

    if (node.type !== 'paragraph' || node.children.length !== 1 || node.children[0].type !== 'inlineMath') {
      return
    }
    const start = node.position?.start.offset
    const end = node.position?.end.offset
    if (typeof start !== 'number' || typeof end !== 'number') return

    const raw = source.slice(start, end).trim()
    if (!raw.startsWith('$$') || !raw.endsWith('$$')) return

    node.data = {
      hName: 'pre',
      hProperties: {
        'data-md-line': node.position?.start.line,
        'data-md-end-line': node.position?.end.line,
      },
      hChildren: [{
        type: 'element',
        tagName: 'code',
        properties: { className: ['language-math', 'math-display'] },
        children: [{ type: 'text', value: node.children[0].value }],
      }],
    }
  })
}
