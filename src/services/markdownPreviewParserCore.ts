import type { Element, Nodes, Root, RootContent } from 'hast'
import { urlAttributes } from 'html-url-attributes'
import rehypeHighlight from 'rehype-highlight'
import rehypeKatex from 'rehype-katex'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import remarkParse from 'remark-parse'
import remarkRehype from 'remark-rehype'
import { unified } from 'unified'
import { normalizeLatexBlockDelimiters, remarkStandaloneDisplayMath } from './markdownMath'

export interface MarkdownPreviewBlock {
  key: string
  startLine: number
  endLine: number
  tree: Root
}

export interface MarkdownPreviewParseResult {
  blocks: MarkdownPreviewBlock[]
}

const SAFE_PROTOCOL = /^(https?|ircs?|mailto|xmpp)$/i

export async function parseMarkdownPreview(content: string): Promise<MarkdownPreviewParseResult> {
  const normalized = normalizeLatexBlockDelimiters(content)
  const processor = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkMath)
    .use(remarkStandaloneDisplayMath)
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(rehypeKatex)
    .use(rehypeHighlight)

  const tree = await processor.run(processor.parse(normalized)) as Root
  normalizeReactMarkdownOutput(tree)
  return { blocks: createBlocks(tree) }
}

function normalizeReactMarkdownOutput(parent: Root | Element) {
  for (let index = 0; index < parent.children.length; index += 1) {
    const node = parent.children[index]
    if (node.type === 'raw') {
      parent.children[index] = { type: 'text', value: node.value }
      continue
    }
    if (node.type !== 'element') continue

    sanitizeElementUrls(node)
    normalizeReactMarkdownOutput(node)
  }
}

function sanitizeElementUrls(node: Element) {
  for (const propertyName of Object.keys(urlAttributes)) {
    if (!Object.prototype.hasOwnProperty.call(node.properties, propertyName)) continue
    const tagNames = urlAttributes[propertyName]
    if (tagNames !== null && !tagNames.includes(node.tagName)) continue
    node.properties[propertyName] = sanitizeUrl(String(node.properties[propertyName] || ''))
  }
}

function sanitizeUrl(value: string): string {
  const colon = value.indexOf(':')
  const questionMark = value.indexOf('?')
  const numberSign = value.indexOf('#')
  const slash = value.indexOf('/')

  if (
    colon === -1
    || (slash !== -1 && colon > slash)
    || (questionMark !== -1 && colon > questionMark)
    || (numberSign !== -1 && colon > numberSign)
    || SAFE_PROTOCOL.test(value.slice(0, colon))
  ) {
    return value
  }
  return ''
}

function createBlocks(tree: Root): MarkdownPreviewBlock[] {
  const groups: RootContent[][] = []
  for (const child of tree.children) {
    if (isInterBlockWhitespace(child) && groups.length > 0) {
      groups[groups.length - 1].push(child)
    } else {
      groups.push([child])
    }
  }

  const occurrences = new Map<string, number>()
  return groups.map((children) => {
    const blockTree: Root = { type: 'root', children }
    const signature = hashString(JSON.stringify(blockTree, (key, value) => key === 'position' ? undefined : value))
    const occurrence = occurrences.get(signature) ?? 0
    occurrences.set(signature, occurrence + 1)
    const { startLine, endLine } = getLineRange(children)
    return {
      key: `${signature}:${occurrence}`,
      startLine,
      endLine,
      tree: blockTree,
    }
  })
}

function isInterBlockWhitespace(node: RootContent): boolean {
  return node.type === 'text' && /^\s*$/.test(node.value)
}

function getLineRange(nodes: Nodes[]): { startLine: number; endLine: number } {
  let startLine = Number.POSITIVE_INFINITY
  let endLine = 0

  const visit = (node: Nodes) => {
    const start = node.position?.start.line
    const end = node.position?.end.line
    if (typeof start === 'number') startLine = Math.min(startLine, start)
    if (typeof end === 'number') endLine = Math.max(endLine, end)
    if ('children' in node) node.children.forEach(visit)
  }
  nodes.forEach(visit)

  return {
    startLine: Number.isFinite(startLine) ? startLine : Math.max(1, endLine),
    endLine: Math.max(Number.isFinite(startLine) ? startLine : 1, endLine),
  }
}

function hashString(value: string): string {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}
