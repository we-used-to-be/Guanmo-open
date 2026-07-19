export interface TocItem {
  id: string
  text: string
  level: number
  line: number
}
function slugify(text: string): string {
  const slug = text
    .trim()
    .toLowerCase()
    .replace(/[`*_~[\]()#]/g, '')
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
  return slug || 'heading'
}

export function createHeadingId(text: string, usedIds: Map<string, number>): string {
  const base = slugify(text)
  const count = usedIds.get(base) ?? 0
  usedIds.set(base, count + 1)
  return count === 0 ? base : `${base}-${count + 1}`
}

export function extractToc(content: string): TocItem[] {
  const items: TocItem[] = []
  const usedIds = new Map<string, number>()
  let inFence = false

  content.split(/\r?\n/).forEach((line, index) => {
    if (/^\s*```/.test(line) || /^\s*~~~/.test(line)) {
      inFence = !inFence
      return
    }
    if (inFence) return

    const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line)
    if (!match) return

    const text = match[2].trim()
    if (!text) return

    const lineNumber = index + 1
    items.push({
      // 使用行号作为唯一标识，避免重复标题导致 id 不一致
      id: `heading-${lineNumber}`,
      text,
      level: match[1].length,
      line: lineNumber,
    })
  })

  return items
}
