import { loadDocumentContentHashByPath } from '@/services/database/persistence'
import {
  checkReadingArtifactSource,
  deleteReadingArtifact,
  loadReadingArtifactById,
  loadReadingArtifactsPage,
  persistReadingArtifact,
} from '@/services/database/readingArtifacts'
import type {
  ReadingArtifact,
  ReadingArtifactSourceAnchor,
  ReadingArtifactsPage,
  SourceAnchorCheck,
  PersistReadingArtifactInput,
  LoadReadingArtifactsPageOptions,
} from '@/services/database/readingArtifacts'

export type {
  ReadingArtifact,
  ReadingArtifactReference,
  ReadingArtifactSourceAnchor,
  ReadingArtifactType,
  SourceAnchorStatus,
  SourceAnchorCheck,
  AnnotationStructuredContent,
  PersistReadingArtifactInput,
  LoadReadingArtifactsPageOptions,
} from '@/services/database/readingArtifacts'

export {
  buildReadingArtifactReferences,
  getAnnotationStructuredContent,
  getReadingArtifactQuestion,
  getReadingArtifactReferences,
  mergeReadingArtifactQuestionMetadata,
  mergeReadingArtifactReferencesMetadata,
  resolveAnnotationPosition,
} from '@/services/database/readingArtifacts'

export async function persistReadingArtifactCommand(input: PersistReadingArtifactInput): Promise<void> {
  return persistReadingArtifact(input)
}

export async function loadReadingArtifactsPageCommand(
  options: LoadReadingArtifactsPageOptions,
): Promise<ReadingArtifactsPage> {
  return loadReadingArtifactsPage(options)
}

export async function loadReadingArtifactByIdCommand(id: string): Promise<ReadingArtifact | undefined> {
  return loadReadingArtifactById(id)
}

export async function deleteReadingArtifactCommand(id: string): Promise<void> {
  return deleteReadingArtifact(id)
}

export async function checkReadingArtifactSourceCommand(
  anchor: ReadingArtifactSourceAnchor,
): Promise<SourceAnchorCheck> {
  return checkReadingArtifactSource(anchor, loadDocumentContentHashByPath)
}

export function loadReadingArtifactSourceContentHash(filePath: string): Promise<string | undefined> {
  return loadDocumentContentHashByPath(filePath)
}
