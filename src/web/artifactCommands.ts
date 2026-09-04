import { UnsupportedCapabilityError } from './externalHttp'

export type ReadingArtifactType = 'summary' | 'question_set' | 'annotation' | 'note'
export type SourceAnchorStatus = 'valid' | 'changed' | 'missing'

export interface ReadingArtifactSourceAnchor {
  filePath: string
  fileName: string
  contentHash?: string | null
  headingPath?: string[] | null
  startLine?: number | null
  endLine?: number | null
  quote?: string | null
  messageId?: string | null
  scope?: string | null
}

export interface ReadingArtifact {
  id: string
  type: ReadingArtifactType
  title: string
  content: string
  structuredContent?: unknown | null
  source?: ReadingArtifactSourceAnchor | null
  status: 'active' | 'archived'
  createdAt: number
  updatedAt: number
}

export interface ReadingArtifactReferenceLocal {
  kind: 'local'
  filePath: string
  fileName: string
  titlePath?: string[]
  heading?: string
  startLine: number
  endLine: number
}

export interface ReadingArtifactReferenceWeb {
  kind: 'web'
  title: string
  url: string
  siteName?: string
  publishedAt?: string
}

export type ReadingArtifactReference = ReadingArtifactReferenceLocal | ReadingArtifactReferenceWeb

export interface AnnotationStructuredContent {
  quote: string
  note: string
  question?: string
  contextFingerprint?: string | null
  startOffset?: number | null
  endOffset?: number | null
}

function unsupported(): never {
  throw new UnsupportedCapabilityError('阅读成果与批注')
}

export function getAnnotationStructuredContent(_artifact: ReadingArtifact): AnnotationStructuredContent | null { return unsupported() }
export function getReadingArtifactQuestion(_artifact: ReadingArtifact): string | null { return unsupported() }
export function getReadingArtifactReferences(_artifact: ReadingArtifact): ReadingArtifactReference[] { return unsupported() }
export function resolveAnnotationPosition(
  _content: string,
  _annotation: AnnotationStructuredContent,
  _source: ReadingArtifactSourceAnchor | null | undefined,
): { startLine: number; endLine: number } | null { return unsupported() }
