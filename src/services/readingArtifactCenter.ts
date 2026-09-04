import type { ReadingArtifact, ReadingArtifactReference } from '@/services/database/readingArtifacts'
import {
  getAnnotationStructuredContent,
  getReadingArtifactQuestion,
  getReadingArtifactReferences,
} from '@/services/database/readingArtifacts'
import { normalizeFilePath } from '@/services/pathIdentity'
import type { ReadingMark, ReadingMarkAnchor, ReadingMarkColor } from '@/services/readingMarks'
import { normalizeWorkspacePath, type WorkspaceRoot } from '@/services/workspaceIdentity'

export type ReadingArtifactItemType =
  | 'highlight'
  | 'annotation'
  | 'summary'
  | 'question_set'
  | 'reading_note'
  | 'ai_explanation'

export interface ReadingArtifactLocation {
  headingPath?: string[]
  startLine?: number
  endLine?: number
  startOffset?: number
  endOffset?: number
}

export interface ReadingArtifactDocumentRef {
  documentId: string
  filePath?: string
  fileName: string
  workspaceId?: string
  locations: ReadingArtifactLocation[]
}

export interface ReadingArtifactItem {
  key: `mark:${string}` | `ai:${string}`
  id: string
  backing: 'reading_mark' | 'reading_artifact'
  source: 'user' | 'ai'
  type: ReadingArtifactItemType
  title: string
  documentRefs: ReadingArtifactDocumentRef[]
  workspaceId?: string
  conversationId?: string
  anchor?: ReadingMarkAnchor
  quote?: string
  content?: string
  color?: ReadingMarkColor
  question?: string
  references?: ReadingArtifactReference[]
  createdAt: number
  updatedAt: number
}

export type ReadingArtifactTypeFilter = ReadingArtifactItemType

export interface ReadingArtifactDocumentSummary {
  documentRef: ReadingArtifactDocumentRef | null
  total: number
  highlights: number
  annotations: number
  aiArtifacts: number
  latestCreatedAt: number
}

const AI_TYPE_MAP: Record<ReadingArtifact['type'], ReadingArtifactItemType> = {
  summary: 'summary',
  question_set: 'question_set',
  annotation: 'ai_explanation',
  note: 'reading_note',
}

function isInsideWorkspace(filePath: string, workspacePath: string): boolean {
  const file = normalizeFilePath(filePath)
  const workspace = normalizeWorkspacePath(workspacePath)
  return Boolean(file && workspace && (file === workspace || file.startsWith(`${workspace}/`)))
}

function findWorkspaceId(filePath: string | undefined, workspaceRoots: readonly WorkspaceRoot[]): string | undefined {
  if (!filePath) return undefined
  return workspaceRoots
    .filter((root) => isInsideWorkspace(filePath, root.path))
    .sort((left, right) => normalizeWorkspacePath(right.path).length - normalizeWorkspacePath(left.path).length)[0]?.id
}

function fileNameFromPath(filePath: string): string {
  return filePath.split(/[/\\]/).filter(Boolean).pop() || filePath
}

function documentIdFor(filePath: string): string {
  return `path:${normalizeFilePath(filePath)}`
}

function appendLocation(ref: ReadingArtifactDocumentRef, location: ReadingArtifactLocation): void {
  const key = JSON.stringify(location)
  if (!ref.locations.some((item) => JSON.stringify(item) === key)) ref.locations.push(location)
}

function buildAiDocumentRefs(
  artifact: ReadingArtifact,
  references: readonly ReadingArtifactReference[],
  workspaceRoots: readonly WorkspaceRoot[],
): ReadingArtifactDocumentRef[] {
  const refs = new Map<string, ReadingArtifactDocumentRef>()
  const add = (filePath: string | undefined, fileName: string | undefined, location: ReadingArtifactLocation) => {
    const normalized = normalizeFilePath(filePath)
    const name = fileName?.trim() || (filePath ? fileNameFromPath(filePath) : '')
    if (!normalized && !name) return
    const documentId = normalized
      ? documentIdFor(filePath!)
      : `legacy-source:${artifact.id}:${name.toLocaleLowerCase()}`
    const current = refs.get(documentId) ?? {
      documentId,
      ...(filePath ? { filePath } : {}),
      fileName: name,
      workspaceId: findWorkspaceId(filePath, workspaceRoots),
      locations: [],
    }
    appendLocation(current, location)
    refs.set(documentId, current)
  }

  for (const reference of references) {
    if (reference.kind !== 'local') continue
    add(reference.filePath, reference.fileName, {
      headingPath: reference.titlePath,
      startLine: reference.startLine,
      endLine: reference.endLine,
    })
  }

  if (artifact.source?.filePath || artifact.source?.fileName) {
    const annotation = getAnnotationStructuredContent(artifact)
    add(artifact.source.filePath || undefined, artifact.source.fileName || undefined, {
      headingPath: artifact.source.headingPath || undefined,
      startLine: artifact.source.startLine || undefined,
      endLine: artifact.source.endLine || undefined,
      startOffset: annotation?.startOffset ?? undefined,
      endOffset: annotation?.endOffset ?? undefined,
    })
  }

  return [...refs.values()]
}

export function adaptReadingMark(
  mark: ReadingMark,
  workspaceRoots: readonly WorkspaceRoot[] = [],
): ReadingArtifactItem {
  const workspaceId = findWorkspaceId(mark.documentPath, workspaceRoots)
  const type = mark.note?.trim() ? 'annotation' : 'highlight'
  return {
    key: `mark:${mark.id}`,
    id: mark.id,
    backing: 'reading_mark',
    source: 'user',
    type,
    title: type === 'annotation' ? '批注' : '高亮',
    documentRefs: [{
      documentId: documentIdFor(mark.documentPath),
      filePath: mark.documentPath,
      fileName: fileNameFromPath(mark.documentPath),
      workspaceId,
      locations: [{ startOffset: mark.anchor.startOffset, endOffset: mark.anchor.endOffset }],
    }],
    workspaceId,
    anchor: mark.anchor,
    quote: mark.anchor.quote,
    content: mark.note,
    color: mark.color,
    createdAt: mark.createdAt,
    updatedAt: mark.updatedAt,
  }
}

export function adaptAiReadingArtifact(
  artifact: ReadingArtifact,
  workspaceRoots: readonly WorkspaceRoot[] = [],
): ReadingArtifactItem {
  const references = getReadingArtifactReferences(artifact)
  const documentRefs = buildAiDocumentRefs(artifact, references, workspaceRoots)
  const workspaceIds = [...new Set(documentRefs.map((ref) => ref.workspaceId).filter(Boolean))]
  return {
    key: `ai:${artifact.id}`,
    id: artifact.id,
    backing: 'reading_artifact',
    source: 'ai',
    type: AI_TYPE_MAP[artifact.type],
    title: artifact.title,
    documentRefs,
    workspaceId: workspaceIds.length === 1 ? workspaceIds[0] : undefined,
    quote: artifact.source?.quote || getAnnotationStructuredContent(artifact)?.quote || undefined,
    content: artifact.content,
    question: getReadingArtifactQuestion(artifact) || undefined,
    references,
    createdAt: artifact.createdAt,
    updatedAt: artifact.updatedAt,
  }
}

export function buildReadingArtifactItems(
  marks: readonly ReadingMark[],
  aiArtifacts: readonly ReadingArtifact[],
  workspaceRoots: readonly WorkspaceRoot[] = [],
): ReadingArtifactItem[] {
  return [
    ...marks.map((mark) => adaptReadingMark(mark, workspaceRoots)),
    ...aiArtifacts.map((artifact) => adaptAiReadingArtifact(artifact, workspaceRoots)),
  ]
}

export function listRecentArtifacts(items: readonly ReadingArtifactItem[]): ReadingArtifactItem[] {
  return [...items].sort((left, right) => right.createdAt - left.createdAt || left.key.localeCompare(right.key))
}

export function getArtifactDocumentRefs(item: ReadingArtifactItem): ReadingArtifactDocumentRef[] {
  return item.documentRefs
}

export function listArtifactsByDocument(
  items: readonly ReadingArtifactItem[],
  documentId: string | null,
): ReadingArtifactItem[] {
  return items.filter((item) => documentId === null
    ? item.documentRefs.length === 0
    : item.documentRefs.some((ref) => ref.documentId === documentId))
}

export function listArtifactDocuments(items: readonly ReadingArtifactItem[]): ReadingArtifactDocumentSummary[] {
  const summaries = new Map<string, ReadingArtifactDocumentSummary>()
  for (const item of items) {
    const refs = item.documentRefs.length > 0 ? item.documentRefs : [null]
    for (const documentRef of refs) {
      const key = documentRef?.documentId ?? '__independent__'
      const summary = summaries.get(key) ?? {
        documentRef,
        total: 0,
        highlights: 0,
        annotations: 0,
        aiArtifacts: 0,
        latestCreatedAt: 0,
      }
      summary.total += 1
      summary.latestCreatedAt = Math.max(summary.latestCreatedAt, item.createdAt)
      if (item.source === 'ai') summary.aiArtifacts += 1
      else if (item.type === 'highlight') summary.highlights += 1
      else summary.annotations += 1
      summaries.set(key, summary)
    }
  }
  return [...summaries.values()].sort((left, right) => {
    if (left.documentRef === null) return 1
    if (right.documentRef === null) return -1
    return right.latestCreatedAt - left.latestCreatedAt || left.documentRef.fileName.localeCompare(right.documentRef.fileName)
  })
}

export function filterReadingArtifactItems(
  items: readonly ReadingArtifactItem[],
  selectedTypes: ReadonlySet<ReadingArtifactItemType>,
  query: string,
): ReadingArtifactItem[] {
  const needle = query.trim().toLocaleLowerCase()
  return items.filter((item) => {
    if (!selectedTypes.has(item.type)) return false
    if (!needle) return true
    const haystack = [
      item.title,
      item.quote,
      item.content,
      ...item.documentRefs.flatMap((ref) => [ref.fileName, ref.filePath]),
    ].filter(Boolean).join('\n').toLocaleLowerCase()
    return haystack.includes(needle)
  })
}
