import { remark } from 'remark'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import { normalizeLatexBlockDelimiters } from '@/services/markdownMath'

export const MAX_CHUNK_TOKENS = 400
export const MAX_SPECIAL_CHUNK_TOKENS = 300

export type SemanticBlockType = 'paragraph' | 'code' | 'math' | 'blockquote' | 'list' | 'table' | 'footnote' | 'html'

export interface SemanticChunk {
  start: number
  end: number
  startLine: number
  endLine: number
  content: string
  type: SemanticBlockType
  headingPath: string[]
  heading?: string
}

export interface SemanticHeading {
  start: number
  end: number
  startLine: number
  endLine: number
  depth: number
  text: string
  headingPath: string[]
}

export interface SemanticDocumentStructure {
  chunks: SemanticChunk[]
  headings: SemanticHeading[]
}

interface AstNode {
  type: string
  depth?: number
  position?: {
    start: { line: number; offset?: number }
    end: { line: number; offset?: number }
  }
}

const markdownParser = remark().use(remarkGfm).use(remarkMath)
const CONTINUATION_RE = /^(?:(?:因此|所以|由此|于是|同时|此外|进一步|具体而言|换言之|这意味着|其原因|为此|解决方案|处理方式|结果是)(?=\W|$)|(?:however|therefore|thus|because|consequently|furthermore|in other words)\b)/i
const STOP_WORDS = new Set(['this', 'that', 'with', 'from', 'have', 'will', 'into', 'then', 'when', 'where', 'what', '以及', '一个', '这个', '这些', '因此', '所以', '同时', '可以', '进行', '需要'])

export function estimateSemanticTokens(text: string): number {
  const cjkCount = (text.match(/[\u3400-\u9fff\uf900-\ufaff]/g) || []).length
  const remainingLength = text.replace(/[\u3400-\u9fff\uf900-\ufaff\s]/g, '').length
  return cjkCount + Math.ceil(remainingLength / 4)
}

function maxTokens(type: SemanticBlockType): number {
  return type === 'code' || type === 'math'
    ? MAX_SPECIAL_CHUNK_TOKENS
    : MAX_CHUNK_TOKENS
}

function blockType(type: string): SemanticBlockType | null {
  if (type === 'footnoteDefinition') return 'footnote'
  if (type === 'paragraph' || type === 'code' || type === 'math' || type === 'blockquote'
    || type === 'list' || type === 'table' || type === 'html') return type
  return null
}

function looksLikeStandaloneMath(text: string): boolean {
  const trimmed = text.trim()
  if (/^(?:\\\[[\s\S]*\\\]|\$\$[\s\S]*\$\$)$/.test(trimmed)) return true
  return /^\[[\s\S]*\]$/.test(trimmed)
    && /\\(?:text|frac|sqrt|sum|prod|int|lim|begin|left|right)\b|[=^_]/.test(trimmed)
}

function trimRange(content: string, start: number, end: number) {
  while (start < end && /\s/.test(content[start])) start++
  while (end > start && /\s/.test(content[end - 1])) end--
  return start < end ? { start, end } : null
}

function headingText(content: string, start: number, end: number): string {
  return content.slice(start, end)
    .replace(/^\s{0,3}#{1,6}[\t ]*/, '')
    .replace(/[\t ]+#+[\t ]*$/, '')
    .trim()
}

function keywords(text: string): Set<string> {
  const result = new Set<string>()
  const latinWords = text.toLowerCase().match(/[a-z][a-z0-9_-]{3,}/g) || []
  for (const word of latinWords) {
    if (!STOP_WORDS.has(word)) result.add(word)
  }
  for (const sequence of text.match(/[\u3400-\u9fff]{2,}/g) || []) {
    for (let index = 0; index < sequence.length - 1; index++) {
      result.add(sequence.slice(index, index + 2))
      if (index < sequence.length - 2) result.add(sequence.slice(index, index + 3))
    }
  }
  return result
}

function sameTopic(left: string, right: string): boolean {
  if (CONTINUATION_RE.test(right.trimStart())) return true
  if (/[：:]\s*$/.test(left)) return true
  const leftWords = keywords(left)
  const rightWords = keywords(right)
  let overlap = 0
  for (const word of leftWords) {
    if (rightWords.has(word)) overlap++
    if (overlap >= 2) return true
  }
  return false
}

export function scoreSemanticRelation(left: SemanticChunk, right: SemanticChunk, distance: number): number {
  let score = 0
  const sharesHeading = sameHeading(left, right)
  if (sharesHeading) score += 2
  else score -= 3
  if (sameTopic(left.content, right.content) || sameTopic(right.content, left.content)) score += 4
  if (sharesHeading && distance <= 2 && (left.type === 'math' || right.type === 'math')) score += 2
  if (distance === 1) score += 1
  return score - Math.max(0, distance - 2) * 0.5
}

function sameHeading(left: SemanticChunk, right: SemanticChunk): boolean {
  return left.headingPath.length === right.headingPath.length
    && left.headingPath.every((part, index) => part === right.headingPath[index])
}

function semanticBoundaryOffsets(text: string): number[] {
  const offsets: number[] = []
  const paragraphBreak = /\r?\n[\t ]*\r?\n/g
  let match: RegExpExecArray | null
  while ((match = paragraphBreak.exec(text))) offsets.push(match.index + match[0].length)

  if (offsets.length === 0) {
    const sentenceEnd = /[。！？.!?](?:[”’"']?)[\t ]*(?=(?:(?:因此|所以|由此|于是|同时|此外|进一步|然而|但是|不过|为此|最终|结果|解决方案|处理方式)(?=\W|$)|(?:Therefore|Thus|However|Consequently|Furthermore)\b))/gi
    while ((match = sentenceEnd.exec(text))) offsets.push(match.index + match[0].length)
  }
  return offsets
}

function splitAtSemanticBoundaries(chunk: SemanticChunk): SemanticChunk[] {
  const max = maxTokens(chunk.type)
  if (estimateSemanticTokens(chunk.content) <= max) return [chunk]

  const boundaries = semanticBoundaryOffsets(chunk.content)
  if (boundaries.length === 0) return [chunk]
  const parts: SemanticChunk[] = []
  let relativeStart = 0

  while (relativeStart < chunk.content.length) {
    const candidates = boundaries.filter((offset) => offset > relativeStart)
    let relativeEnd = chunk.content.length
    for (const boundary of candidates) {
      if (estimateSemanticTokens(chunk.content.slice(relativeStart, boundary)) > max) break
      relativeEnd = boundary
    }
    if (relativeEnd === chunk.content.length && estimateSemanticTokens(chunk.content.slice(relativeStart)) > max) {
      const first = candidates[0]
      if (!first) break
      relativeEnd = first
    }
    if (relativeEnd <= relativeStart) break

    const start = chunk.start + relativeStart
    const end = chunk.start + relativeEnd
    const range = trimRange(chunk.content, relativeStart, relativeEnd)
    if (range) {
      parts.push({
        ...chunk,
        start: chunk.start + range.start,
        end: chunk.start + range.end,
        content: chunk.content.slice(range.start, range.end),
        startLine: chunk.startLine + chunk.content.slice(0, range.start).split('\n').length - 1,
        endLine: chunk.startLine + chunk.content.slice(0, range.end).split('\n').length - 1,
      })
    }
    relativeStart = relativeEnd
  }
  return parts.length > 1 ? parts : [chunk]
}

function fallbackBlocks(content: string): SemanticChunk[] {
  const chunks: SemanticChunk[] = []
  const separator = /\r?\n[\t ]*\r?\n/g
  let start = 0
  let match: RegExpExecArray | null
  const push = (end: number) => {
    const range = trimRange(content, start, end)
    if (!range) return
    chunks.push({
      ...range,
      startLine: content.slice(0, range.start).split('\n').length,
      endLine: content.slice(0, range.end).split('\n').length,
      content: content.slice(range.start, range.end),
      type: 'paragraph',
      headingPath: [],
    })
  }
  while ((match = separator.exec(content))) {
    push(match.index)
    start = match.index + match[0].length
  }
  push(content.length)
  return chunks
}

export function buildSemanticDocumentStructure(content: string, isMarkdown = true): SemanticDocumentStructure {
  if (!content.trim()) return { chunks: [], headings: [] }
  if (!isMarkdown) {
    return { chunks: fallbackBlocks(content).flatMap(splitAtSemanticBoundaries), headings: [] }
  }

  try {
    const tree = markdownParser.parse(normalizeLatexBlockDelimiters(content))
    const headingPath: string[] = []
    const headings: SemanticHeading[] = []
    const chunks: SemanticChunk[] = []
    for (const rawNode of tree.children as AstNode[]) {
      const start = rawNode.position?.start.offset
      const end = rawNode.position?.end.offset
      if (typeof start !== 'number' || typeof end !== 'number' || start >= end) continue
      if (rawNode.type === 'heading' && rawNode.depth) {
        headingPath.splice(rawNode.depth - 1)
        const text = headingText(content, start, end)
        headingPath[rawNode.depth - 1] = text
        headings.push({
          start,
          end,
          startLine: rawNode.position!.start.line,
          endLine: rawNode.position!.end.line,
          depth: rawNode.depth,
          text,
          headingPath: headingPath.filter(Boolean),
        })
        continue
      }
      const parsedType = blockType(rawNode.type)
      const rawContent = content.slice(start, end)
      const type = parsedType === 'paragraph' && looksLikeStandaloneMath(rawContent) ? 'math' : parsedType
      if (!type) continue
      const range = trimRange(content, start, end)
      if (!range) continue
      chunks.push({
        ...range,
        startLine: rawNode.position!.start.line,
        endLine: rawNode.position!.end.line,
        content: content.slice(range.start, range.end),
        type,
        headingPath: headingPath.filter(Boolean),
        heading: headingPath[headingPath.length - 1],
      })
    }
    return { chunks: chunks.flatMap(splitAtSemanticBoundaries), headings }
  } catch {
    return { chunks: fallbackBlocks(content).flatMap(splitAtSemanticBoundaries), headings: [] }
  }
}

export function buildSemanticDocumentChunks(content: string, isMarkdown = true): SemanticChunk[] {
  return buildSemanticDocumentStructure(content, isMarkdown).chunks
}
