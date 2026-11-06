import type { ChatMessageSource } from './types'
import { normalizeFilePath } from '@/services/pathIdentity'
import type { LocalReadingArtifactReference, ReadingArtifactReference } from '@/services/database/readingArtifacts'
import type { OriginalSelectionSnapshot } from '@/services/originalSelections'

export type SourceReferenceId = `S${number}`

export interface SourceReferenceEntry {
  id: SourceReferenceId
  source: ChatMessageSource
}

export interface SourceReferenceRegistry {
  entries: readonly SourceReferenceEntry[]
}

export interface ParsedSourceReferences {
  content: string
  referencedIds: SourceReferenceId[]
  referencedSources: ChatMessageSource[]
  hasValidReferences: boolean
}

export interface StoredSourceReferenceSelection {
  sources: ChatMessageSource[]
  hasValidReferences: boolean
}

const SOURCE_REFERENCE_TOKEN_REGEX = /\[S([1-9]\d*)\]/g

function isValidLineRange(startLine: unknown, endLine: unknown): boolean {
  return typeof startLine === 'number'
    && Number.isInteger(startLine)
    && startLine > 0
    && typeof endLine === 'number'
    && Number.isInteger(endLine)
    && endLine >= startLine
}

/** 将聊天消息来源转换为稳定持久化快照，并按原顺序去重。 */
export function buildReadingArtifactReferences(
  sources: readonly ChatMessageSource[] | undefined,
  selections: readonly OriginalSelectionSnapshot[] = [],
): ReadingArtifactReference[] {
  const references: ReadingArtifactReference[] = []
  const seen = new Set<string>()
  const selectionSources: LocalReadingArtifactReference[] = selections.flatMap((selection) => {
    const filePath = selection.filePath?.trim()
    if (!filePath || !isValidLineRange(selection.startLine, selection.endLine)) return []
    return [{ kind: 'local', filePath, fileName: filePath.replace(/\\/g, '/').split('/').pop()!,
      startLine: selection.startLine!, endLine: selection.endLine! }]
  })
  for (const source of [...(sources ?? []), ...selectionSources]) {
    if (source.kind === 'memory') {
      const key = `memory:${source.memoryId}`
      if (!source.memoryId.trim() || !source.content.trim() || seen.has(key)) continue
      seen.add(key)
      references.push({ ...source })
      continue
    }
    if (source.kind === 'web') {
      const title = source.title.trim()
      const url = source.url.trim()
      if (!title || !url) continue
      const key = `web:${url}`
      if (seen.has(key)) continue
      seen.add(key)
      references.push({
        kind: 'web',
        title,
        url,
        ...(source.siteName?.trim() ? { siteName: source.siteName.trim() } : {}),
        ...(source.publishedAt?.trim() ? { publishedAt: source.publishedAt.trim() } : {}),
      })
      continue
    }

    const filePath = source.filePath.trim()
    const fileName = source.fileName.trim()
    if (!filePath || !fileName || !isValidLineRange(source.startLine, source.endLine)) continue
    const key = `local:${normalizeFilePath(filePath)}:${source.startLine}:${source.endLine}`
    if (seen.has(key)) continue
    seen.add(key)
    references.push({
      kind: 'local',
      filePath,
      fileName,
      ...(source.titlePath?.length ? { titlePath: [...source.titlePath] } : {}),
      ...(source.heading?.trim() ? { heading: source.heading.trim() } : {}),
      startLine: source.startLine,
      endLine: source.endLine,
    })
  }
  return references
}

export function normalizeSafeWebSourceUrl(url: string): string | null {
  const trimmed = url.trim()
  if (!trimmed) return null

  try {
    const parsed = new URL(trimmed)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    return parsed.toString()
  } catch {
    return null
  }
}

function getSourceIdentity(source: ChatMessageSource): string | null {
  if (source.kind === 'memory') {
    return source.memoryId.trim() && source.content.trim() ? `memory:${source.memoryId}` : null
  }
  if (source.kind === 'web') {
    const url = normalizeSafeWebSourceUrl(source.url)
    return url ? `web:${url}` : null
  }

  const filePath = normalizeFilePath(source.filePath)
  if (!filePath || !source.fileName.trim() || !isValidLineRange(source.startLine, source.endLine)) {
    return null
  }
  return `local:${filePath}:${source.startLine}:${source.endLine}`
}

function cloneSource(source: ChatMessageSource): ChatMessageSource {
  if (source.kind === 'web' || source.kind === 'memory') return { ...source }
  return {
    ...source,
    ...(source.titlePath ? { titlePath: [...source.titlePath] } : {}),
  }
}

export function createSourceReferenceRegistry(
  sources: readonly ChatMessageSource[] = [],
): SourceReferenceRegistry {
  return registerSourceReferences({ entries: [] }, sources)
}

export function registerSourceReferences(
  registry: SourceReferenceRegistry,
  sources: readonly ChatMessageSource[],
): SourceReferenceRegistry {
  const entries = [...registry.entries]
  const idsByIdentity = new Map<string, SourceReferenceId>()

  for (const entry of entries) {
    const identity = getSourceIdentity(entry.source)
    if (identity) idsByIdentity.set(identity, entry.id)
  }

  for (const source of sources) {
    const identity = getSourceIdentity(source)
    if (!identity || idsByIdentity.has(identity)) continue

    const id = `S${entries.length + 1}` as SourceReferenceId
    entries.push({ id, source: cloneSource(source) })
    idsByIdentity.set(identity, id)
  }

  return { entries }
}

export function findSourceReferenceId(
  registry: SourceReferenceRegistry,
  source: ChatMessageSource,
): SourceReferenceId | undefined {
  const identity = getSourceIdentity(source)
  if (!identity) return undefined
  return registry.entries.find((entry) => getSourceIdentity(entry.source) === identity)?.id
}

export function parseSourceReferences(
  content: string,
  registry: SourceReferenceRegistry,
): ParsedSourceReferences {
  const entriesById = new Map(registry.entries.map((entry) => [entry.id, entry]))
  const referencedIds: SourceReferenceId[] = []
  const referencedSources: ChatMessageSource[] = []
  const seenIds = new Set<SourceReferenceId>()

  for (const match of content.matchAll(SOURCE_REFERENCE_TOKEN_REGEX)) {
    const id = `S${match[1]}` as SourceReferenceId
    const entry = entriesById.get(id)
    if (!entry || seenIds.has(id)) continue
    seenIds.add(id)
    referencedIds.push(id)
    referencedSources.push(entry.source)
  }

  return {
    content,
    referencedIds,
    referencedSources,
    hasValidReferences: referencedIds.length > 0,
  }
}

/** Bind only generated memory headings to this request's shared source IDs. */
export function annotateMemoryContext(
  context: string,
  sources: readonly ChatMessageSource[],
  registry: SourceReferenceRegistry,
): string {
  return context.replace(/^\[记忆 (\d+)\](?=\n分类：)/gm, (heading, number: string) => {
    const source = sources[Number(number) - 1]
    const id = source?.kind === 'memory' ? findSourceReferenceId(registry, source) : undefined
    return id ? `[${id}]` : heading
  })
}

/**
 * 从持久化的完整候选来源中恢复正文实际引用的展示子集。
 * 旧消息没有 ID 时，以及所有 ID 都无效时，安全降级为完整候选来源。
 */
export function resolveStoredSourceReferences(
  sources: readonly ChatMessageSource[] | undefined,
  referencedIds: readonly SourceReferenceId[] | undefined,
): StoredSourceReferenceSelection {
  const candidates = (sources ?? []).filter((source) => (
    source.kind !== 'web' || normalizeSafeWebSourceUrl(source.url) !== null
  ))
  if (!referencedIds?.length) {
    return { sources: candidates, hasValidReferences: false }
  }

  const registry = createSourceReferenceRegistry(candidates)
  const entriesById = new Map(registry.entries.map((entry) => [entry.id, entry]))
  const selected: ChatMessageSource[] = []
  const seen = new Set<SourceReferenceId>()

  for (const id of referencedIds) {
    if (seen.has(id)) continue
    const entry = entriesById.get(id)
    if (!entry) continue
    seen.add(id)
    selected.push(entry.source)
  }

  return selected.length > 0
    ? { sources: selected, hasValidReferences: true }
    : { sources: candidates, hasValidReferences: false }
}
