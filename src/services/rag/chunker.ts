import type { Chunk } from './types'
import { createContentHash } from './contentHash'

interface HeadingEntry {
  level: number
  title: string
}

interface MarkdownSection {
  lines: string[]
  startLine: number
  endLine: number
  titlePath: string[]
  heading?: string
}

interface TextBlock {
  text: string
  startLine: number
  endLine: number
  isCode: boolean
}

const MIN_MEANINGFUL_CHARS = 30

function cleanLine(line: string): string | null {
  const trimmed = line.trim()
  if (/^[-*_=\s]{3,}$/.test(trimmed)) return null
  if (/^(目录|导航|table of contents|toc)$/i.test(trimmed)) return null
  if (/^\s*[-*+]\s+\[[^\]]+\]\(#[^)]+\)\s*$/.test(line)) return null
  return line.replace(/[ \t]+$/g, '')
}

function normalizeChunkText(lines: string[]): string {
  const cleaned: string[] = []
  let previousBlank = false
  let previousHeading = ''

  for (const rawLine of lines) {
    const line = cleanLine(rawLine)
    if (line === null) continue

    const trimmed = line.trim()
    const headingText = trimmed.match(/^#{1,6}\s+(.+)$/)?.[1]?.trim() || ''
    if (headingText && headingText === previousHeading) continue
    if (headingText) previousHeading = headingText

    if (!trimmed) {
      if (!previousBlank) cleaned.push('')
      previousBlank = true
      continue
    }

    cleaned.push(line)
    previousBlank = false
  }

  return cleaned.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

function meaningfulLength(content: string): number {
  return content
    .replace(/```[\s\S]*?```/g, ' code ')
    .replace(/[#>*`_\-[\]()]/g, '')
    .replace(/\s+/g, '')
    .length
}

function isMeaningful(content: string): boolean {
  if (meaningfulLength(content) >= MIN_MEANINGFUL_CHARS) return true
  return /```|`[^`]+`|\b[A-Z][A-Z0-9_-]{2,}\b|\b[a-z]+[A-Z][A-Za-z0-9]*\b/.test(content)
}

function splitSections(lines: string[]): MarkdownSection[] {
  const sections: MarkdownSection[] = []
  const headingStack: HeadingEntry[] = []
  let currentLines: string[] = []
  let currentStartLine = 1
  let currentTitlePath: string[] = []
  let currentHeading: string | undefined
  let inFence = false

  const flush = (endLine: number) => {
    const text = normalizeChunkText(currentLines)
    if (text && isMeaningful(text)) {
      sections.push({
        lines: text.split('\n'),
        startLine: currentStartLine,
        endLine,
        titlePath: currentTitlePath,
        heading: currentHeading,
      })
    }
    currentLines = []
  }

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    const lineNumber = i + 1
    if (/^\s*```/.test(line)) inFence = !inFence

    const headingMatch = !inFence ? line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/) : null
    if (headingMatch) {
      if (currentLines.length > 0) flush(lineNumber - 1)

      const level = headingMatch[1].length
      const title = headingMatch[2].trim()
      while (headingStack.length > 0 && headingStack[headingStack.length - 1].level >= level) {
        headingStack.pop()
      }
      headingStack.push({ level, title })

      currentStartLine = lineNumber
      currentTitlePath = headingStack.map((item) => item.title)
      currentHeading = title
      currentLines = [line]
      continue
    }

    if (currentLines.length === 0) {
      currentStartLine = lineNumber
      currentTitlePath = headingStack.map((item) => item.title)
      currentHeading = headingStack[headingStack.length - 1]?.title
    }
    currentLines.push(line)
  }

  if (currentLines.length > 0) flush(lines.length)
  return sections
}

function splitBlocks(section: MarkdownSection): TextBlock[] {
  const blocks: TextBlock[] = []
  let current: string[] = []
  let currentStart = section.startLine
  let inFence = false

  const flush = (endLine: number) => {
    const text = normalizeChunkText(current)
    if (text) {
      blocks.push({
        text,
        startLine: currentStart,
        endLine,
        isCode: /^```/.test(text.trim()),
      })
    }
    current = []
  }

  for (let i = 0; i < section.lines.length; i += 1) {
    const line = section.lines[i]
    const lineNumber = section.startLine + i
    if (/^\s*```/.test(line)) inFence = !inFence

    if (!inFence && !line.trim()) {
      flush(lineNumber - 1)
      currentStart = lineNumber + 1
      continue
    }

    if (current.length === 0) currentStart = lineNumber
    current.push(line)
  }

  if (current.length > 0) flush(section.endLine)
  return blocks.filter((block) => isMeaningful(block.text))
}

function splitLongTextBlock(block: TextBlock, chunkSize: number, overlap: number): TextBlock[] {
  if (block.isCode || block.text.length <= chunkSize) return [block]

  const parts: TextBlock[] = []
  let start = 0
  while (start < block.text.length) {
    const hardEnd = Math.min(block.text.length, start + chunkSize)
    const softBreak = block.text.lastIndexOf('\n', hardEnd)
    const sentenceBreak = Math.max(
      block.text.lastIndexOf('。', hardEnd),
      block.text.lastIndexOf('！', hardEnd),
      block.text.lastIndexOf('？', hardEnd),
      block.text.lastIndexOf('.', hardEnd)
    )
    const end = Math.max(softBreak, sentenceBreak) > start + chunkSize * 0.5
      ? Math.max(softBreak, sentenceBreak) + 1
      : hardEnd
    const text = block.text.slice(start, end).trim()
    if (text) {
      parts.push({
        text,
        startLine: block.startLine,
        endLine: block.endLine,
        isCode: false,
      })
    }
    if (end >= block.text.length) break
    const nextStart = Math.max(0, end - overlap)
    start = nextStart > start ? nextStart : end
  }
  return parts
}

function getOverlapBlocks(blocks: TextBlock[], overlap: number): TextBlock[] {
  if (overlap <= 0) return []
  const selected: TextBlock[] = []
  let length = 0
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    const block = blocks[i]
    if (block.isCode) continue
    if (length + block.text.length > overlap && selected.length > 0) break
    selected.unshift(block)
    length += block.text.length
    if (length >= overlap) break
  }
  return selected
}

function pushChunk(
  chunks: Chunk[],
  seenHashes: Set<string>,
  documentId: string,
  section: MarkdownSection,
  blocks: TextBlock[],
  chunkIndex: number
): number {
  const content = normalizeChunkText(blocks.map((block) => block.text))
  if (!content || !isMeaningful(content)) return chunkIndex

  const contentHash = createContentHash(content)
  if (seenHashes.has(contentHash)) return chunkIndex
  seenHashes.add(contentHash)

  chunks.push({
    id: `${documentId}-chunk-${chunkIndex}`,
    documentId,
    content,
    contentHash,
    index: chunkIndex,
    startLine: Math.min(...blocks.map((block) => block.startLine)),
    endLine: Math.max(...blocks.map((block) => block.endLine)),
    titlePath: section.titlePath,
    heading: section.heading,
    sourceType: 'markdown',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })
  return chunkIndex + 1
}

/**
 * Split Markdown content into semantic chunks for RAG.
 * The splitter keeps heading metadata and avoids cutting fenced code blocks.
 */
export function chunkMarkdown(
  content: string,
  documentId: string,
  options: { chunkSize?: number; overlap?: number } = {}
): Chunk[] {
  const { chunkSize = 900, overlap = 150 } = options
  const sections = splitSections(content.split('\n'))
  const chunks: Chunk[] = []
  const seenHashes = new Set<string>()
  let chunkIndex = 0

  for (const section of sections) {
    const blocks = splitBlocks(section).flatMap((block) => splitLongTextBlock(block, chunkSize, overlap))
    let current: TextBlock[] = []
    let currentLength = 0

    for (const block of blocks) {
      const nextLength = currentLength + block.text.length
      if (current.length > 0 && nextLength > chunkSize) {
        chunkIndex = pushChunk(chunks, seenHashes, documentId, section, current, chunkIndex)
        const overlapBlocks = getOverlapBlocks(current, overlap)
        current = overlapBlocks
        currentLength = overlapBlocks.reduce((sum, item) => sum + item.text.length, 0)
      }

      current.push(block)
      currentLength += block.text.length
    }

    if (current.length > 0) {
      chunkIndex = pushChunk(chunks, seenHashes, documentId, section, current, chunkIndex)
    }
  }

  return chunks
}
