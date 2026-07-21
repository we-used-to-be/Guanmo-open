import { remark } from 'remark'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'

export type MarkdownBlockType =
  | 'frontmatter'
  | 'heading'
  | 'thematicBreak'
  | 'paragraph'
  | 'image'
  | 'list'
  | 'blockquote'
  | 'code'
  | 'mermaid'
  | 'math'
  | 'table'
  | 'html'
  | 'definition'
  | 'footnoteDefinition'
  | 'unknown'

export interface MarkdownBlock {
  type: MarkdownBlockType
  startLine: number
  endLine: number
  startOffset: number
  endOffset: number
  rawSource: string
  renderKey: string
}

interface PositionedNode {
  type: string
  lang?: string | null
  children?: PositionedNode[]
  position?: {
    start?: { line?: number; offset?: number }
    end?: { line?: number; offset?: number }
  }
}

const markdownBlockProcessor = remark().use(remarkGfm).use(remarkMath)

export function parseMarkdownBlocks(content: string): MarkdownBlock[] {
  if (!content) return []

  const root = markdownBlockProcessor.parse(content) as PositionedNode
  const blocks: MarkdownBlock[] = []
  const frontmatter = getFrontmatterRange(content)

  if (frontmatter) {
    blocks.push(createBlock(content, 'frontmatter', 1, frontmatter.endLine, 0, frontmatter.endOffset))
  }

  for (const node of root.children ?? []) {
    const startOffset = node.position?.start?.offset
    const endOffset = node.position?.end?.offset
    const startLine = node.position?.start?.line
    const endLine = node.position?.end?.line
    if (
      typeof startOffset !== 'number'
      || typeof endOffset !== 'number'
      || typeof startLine !== 'number'
      || typeof endLine !== 'number'
    ) continue
    if (frontmatter && startOffset < frontmatter.endOffset) continue

    blocks.push(createBlock(
      content,
      classifyNode(node),
      startLine,
      endLine,
      startOffset,
      endOffset
    ))
  }

  const occurrences = new Map<string, number>()
  return blocks.map((block) => {
    const signature = `${block.type}-${hashSource(block.rawSource)}`
    const occurrence = occurrences.get(signature) ?? 0
    occurrences.set(signature, occurrence + 1)
    return { ...block, renderKey: `md-block-${signature}-${occurrence}` }
  })
}

export function replaceMarkdownBlock(
  content: string,
  block: Pick<MarkdownBlock, 'startOffset' | 'endOffset' | 'rawSource'>,
  draft: string
):
  | { status: 'applied'; content: string }
  | { status: 'conflict'; draft: string; currentSource: string } {
  const currentSource = content.slice(block.startOffset, block.endOffset)
  if (currentSource !== block.rawSource) {
    return { status: 'conflict', draft, currentSource }
  }
  return {
    status: 'applied',
    content: content.slice(0, block.startOffset) + draft + content.slice(block.endOffset),
  }
}

function createBlock(
  content: string,
  type: MarkdownBlockType,
  startLine: number,
  endLine: number,
  startOffset: number,
  endOffset: number
): MarkdownBlock {
  return {
    type,
    startLine,
    endLine,
    startOffset,
    endOffset,
    rawSource: content.slice(startOffset, endOffset),
    renderKey: '',
  }
}

function classifyNode(node: PositionedNode): MarkdownBlockType {
  if (node.type === 'paragraph' && node.children?.length === 1 && node.children[0].type === 'image') {
    return 'image'
  }
  if (node.type === 'code') return node.lang?.toLowerCase() === 'mermaid' ? 'mermaid' : 'code'
  switch (node.type) {
    case 'heading':
    case 'thematicBreak':
    case 'paragraph':
    case 'list':
    case 'blockquote':
    case 'math':
    case 'table':
    case 'html':
    case 'definition':
    case 'footnoteDefinition':
      return node.type
    default:
      return 'unknown'
  }
}

function getFrontmatterRange(content: string): { endOffset: number; endLine: number } | null {
  const match = /^(?:\uFEFF)?---[ \t]*\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)[ \t]*(?=\r?\n|$)/.exec(content)
  if (!match) return null
  return {
    endOffset: match[0].length,
    endLine: 1 + countLineBreaks(match[0]),
  }
}

function countLineBreaks(value: string): number {
  return (value.match(/\r\n|\r|\n/g) ?? []).length
}

function hashSource(value: string): string {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}
