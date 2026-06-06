import type { ContextTag } from '@/types/contextTag'

export interface BuildContextOptions {
  tags: ContextTag[]
  readFile: (path: string) => Promise<string>
  maxChars?: number
}

export const CONTEXT_BLOCK_PREFIX = '以下是用户提供的上下文：'

const TAG_PRIORITY: Record<ContextTag['type'], number> = {
  selection: 0,
  file: 1,
  memory: 2,
  web: 3,
  folder: 4,
}

const MAX_CHARS_PER_TAG: Record<ContextTag['type'], number> = {
  selection: 4000,
  file: 3000,
  memory: 1200,
  web: 1200,
  folder: 240,
}

function getTagIdentity(tag: ContextTag): string {
  if (tag.type === 'selection') {
    return [
      tag.type,
      tag.filePath || '',
      tag.selectionFrom ?? '',
      tag.selectionTo ?? '',
      tag.content || '',
    ].join('|')
  }
  if (tag.type === 'file') {
    return [tag.type, tag.filePath || ''].join('|')
  }
  if (tag.type === 'folder') {
    return [tag.type, tag.folderPath || tag.filePath || ''].join('|')
  }
  return [tag.type, tag.title, tag.filePath || '', tag.folderPath || '', tag.content || ''].join('|')
}

function clipText(content: string, maxChars: number): string {
  if (content.length <= maxChars) return content
  return `${content.slice(0, maxChars)}\n...（内容已截断）`
}

function orderTags(tags: ContextTag[]): Array<{ tag: ContextTag; index: number }> {
  const seen = new Set<string>()
  return tags
    .map((tag, index) => ({ tag, index }))
    .filter(({ tag }) => {
      const identity = getTagIdentity(tag)
      if (seen.has(identity)) return false
      seen.add(identity)
      return true
    })
    .sort((a, b) => {
      const priorityDiff = TAG_PRIORITY[a.tag.type] - TAG_PRIORITY[b.tag.type]
      if (priorityDiff !== 0) return priorityDiff
      return a.index - b.index
    })
}

function buildTypeLabel(tag: ContextTag): string {
  switch (tag.type) {
    case 'selection':
      return '选中文本'
    case 'file':
      return '文件'
    case 'folder':
      return '文件夹'
    case 'memory':
      return '记忆'
    case 'web':
      return 'Web'
    default:
      return tag.type
  }
}

async function resolveTagContent(tag: ContextTag, readFile: (path: string) => Promise<string>): Promise<string> {
  if (tag.type === 'selection' || tag.type === 'memory' || tag.type === 'web') {
    return tag.content || ''
  }
  if (tag.type === 'folder') {
    return `[文件夹] ${tag.folderPath || tag.filePath || '未知路径'}`
  }
  if (!tag.filePath) return ''

  try {
    return await readFile(tag.filePath)
  } catch {
    return `[无法读取文件] ${tag.filePath}`
  }
}

export async function buildContextFromTags(options: BuildContextOptions): Promise<string> {
  const { tags, readFile, maxChars = 8000 } = options
  if (tags.length === 0) return ''

  const orderedTags = orderTags(tags)
  const parts: string[] = []
  let usedChars = 0

  for (const { tag } of orderedTags) {
    const resolvedContent = await resolveTagContent(tag, readFile)
    const rawContent = tag.type === 'selection' ? resolvedContent : resolvedContent.trim()
    if (!rawContent.trim()) continue

    const remaining = maxChars - usedChars
    if (remaining <= 180) break

    const locationInfo = tag.type === 'selection' && tag.startLine
      ? `\n行号: ${tag.startLine}${tag.endLine ? `-${tag.endLine}` : ''}`
      : ''
    const rangeInfo = tag.type === 'selection'
      && typeof tag.selectionFrom === 'number'
      && typeof tag.selectionTo === 'number'
      ? `\n字符范围: ${tag.selectionFrom}-${tag.selectionTo}`
      : ''

    const contentBudget = Math.max(
      120,
      Math.min(MAX_CHARS_PER_TAG[tag.type], remaining - 120)
    )
    const content = clipText(rawContent, contentBudget)
    const part = [
      `[上下文: ${tag.title}]（${buildTypeLabel(tag)}）`,
      `文件: ${tag.filePath || tag.folderPath || '未知'}`,
      `${locationInfo}${rangeInfo}`.trim(),
      '---',
      content,
    ].filter(Boolean).join('\n')

    if (part.length > remaining) {
      const clippedPart = clipText(part, remaining)
      if (clippedPart.trim()) {
        parts.push(clippedPart)
      }
      break
    }

    parts.push(part)
    usedChars += part.length
  }

  if (parts.length === 0) return ''
  return `${CONTEXT_BLOCK_PREFIX}\n\n${parts.join('\n\n')}`
}
