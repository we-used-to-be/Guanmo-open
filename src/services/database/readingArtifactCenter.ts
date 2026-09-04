import { getDatabase, isDatabaseReady } from './db'
import {
  decodeReadingArtifact,
  type ReadingArtifact,
  type ReadingArtifactRow,
} from './readingArtifacts'
import {
  decodeReadingMarkRow,
  loadReadingMarksPage,
  type ReadingMark,
} from '@/services/readingMarks'
import { loadReadingArtifactsPageCommand } from '@/services/agent/artifactCommands'
import {
  buildReadingArtifactItems,
  filterReadingArtifactItems,
  listArtifactDocuments,
  type ReadingArtifactItemType,
} from '@/services/readingArtifactCenter'

export type ReadingArtifactCenterView = 'recent' | 'detail'
export type ReadingArtifactCenterSort = 'time' | 'source'

export interface ReadingArtifactCenterPageOptions {
  view: ReadingArtifactCenterView
  document?: { documentId: string; filePath?: string; fileName: string } | null
  documentId?: string | null
  documentPath?: string | null
  documentFileName?: string | null
  independent?: boolean
  query?: string
  types: readonly string[]
  sort?: ReadingArtifactCenterSort
  limit: number
  offset: number
}

function documentPathFor(options: ReadingArtifactCenterPageOptions): string | null | undefined {
  return options.documentPath ?? options.document?.filePath
}

function documentFileNameFor(options: ReadingArtifactCenterPageOptions): string | null | undefined {
  return options.documentFileName ?? options.document?.fileName
}

function independentFor(options: ReadingArtifactCenterPageOptions): boolean {
  return options.independent ?? (options.document === null)
}

export interface ReadingArtifactCenterPage {
  marks: ReadingMark[]
  artifacts: ReadingArtifact[]
  total: number
  hasMore: boolean
}

export interface ReadingArtifactDocumentSummaryRow {
  documentId: string
  filePath: string
  fileName: string
  total: number
  highlights: number
  annotations: number
  aiArtifacts: number
  latestCreatedAt: number
}

export interface ReadingArtifactDocumentPage {
  documents: ReadingArtifactDocumentSummaryRow[]
  total: number
  hasMore: boolean
}

const DEFAULT_LIMIT = 40
const MAX_LIMIT = 100
const AI_TYPE_MAP: Record<string, string> = {
  summary: 'summary',
  question_set: 'question_set',
  reading_note: 'note',
  ai_explanation: 'annotation',
}

function normalizeLimit(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.min(Math.floor(value), MAX_LIMIT) : DEFAULT_LIMIT
}

function normalizeOffset(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}

function placeholders(values: readonly unknown[], start = 1): string {
  return values.map((_, index) => `$${start + index}`).join(', ')
}

function normalizeQuery(value: string | undefined): string {
  return value?.trim() ?? ''
}

function likePattern(value: string): string {
  return `%${value.replace(/!/g, '!!').replace(/%/g, '!%').replace(/_/g, '!_')}%`
}

function markTypeClause(types: readonly string[]): string {
  const clauses: string[] = []
  if (types.includes('highlight')) clauses.push("(note IS NULL OR trim(note) = '')")
  if (types.includes('annotation')) clauses.push("(note IS NOT NULL AND trim(note) <> '')")
  if (!clauses.length) return '0 = 1'
  return `(${clauses.join(' OR ')})`
}

function artifactTypeClause(types: readonly string[], params: unknown[]): string {
  const values = types.map((type) => AI_TYPE_MAP[type]).filter(Boolean)
  if (!values.length) return '0 = 1'
  params.push(...values)
  return `reading_artifacts.type IN (${placeholders(values, params.length - values.length + 1)})`
}

function markSearchClause(query: string, params: unknown[]): string {
  if (!query) return ''
  params.push(likePattern(query))
  const p = `$${params.length}`
  return `(quote LIKE ${p} ESCAPE '!' OR COALESCE(note, '') LIKE ${p} ESCAPE '!' OR document_path LIKE ${p} ESCAPE '!')`
}

function artifactSearchClause(query: string, params: unknown[]): string {
  if (!query) return ''
  params.push(likePattern(query))
  const p = `$${params.length}`
  return `(reading_artifacts.title LIKE ${p} ESCAPE '!' OR reading_artifacts.content LIKE ${p} ESCAPE '!' OR COALESCE(reading_artifacts.source_file_name, '') LIKE ${p} ESCAPE '!' OR COALESCE(reading_artifacts.source_quote, '') LIKE ${p} ESCAPE '!' OR COALESCE(reading_artifacts.structured_content, '') LIKE ${p} ESCAPE '!')`
}

function documentClause(documentPath: string | null | undefined, field: string): { sql: string; params: unknown[] } {
  if (!documentPath) return { sql: '', params: [] }
  return {
    sql: `lower(replace(${field}, '\\\\', '/')) = lower(replace($DOCUMENT_PATH, '\\\\', '/'))`,
    params: [documentPath],
  }
}

function sourceOrderExpression(tableAlias: string): string {
  return `COALESCE(${tableAlias}.source_start_line, (SELECT MIN(CAST(json_extract(value, '$.startOffset') AS INTEGER)) FROM json_each(CASE WHEN json_valid(${tableAlias}.structured_content) THEN ${tableAlias}.structured_content ELSE '{}' END, '$.references') WHERE json_extract(value, '$.kind') = 'local'), 9223372036854775807)`
}

async function loadPageFromDatabase(options: ReadingArtifactCenterPageOptions): Promise<ReadingArtifactCenterPage> {
  const db = getDatabase()
  const limit = normalizeLimit(options.limit)
  const offset = normalizeOffset(options.offset)
  const query = normalizeQuery(options.query)
  const markParams: unknown[] = []
  const artifactParams: unknown[] = []
  const markWhere = [markTypeClause(options.types)]
  const artifactWhere = [artifactTypeClause(options.types, artifactParams), "reading_artifacts.status = 'active'"]
  if (options.view === 'detail' && independentFor(options)) {
    markWhere.push('0 = 1')
    artifactWhere.push("source_file_path IS NULL AND source_file_name IS NULL AND NOT EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(reading_artifacts.structured_content) THEN reading_artifacts.structured_content ELSE '{}' END, '$.references') WHERE json_extract(value, '$.kind') = 'local')")
  }
  const documentPath = documentPathFor(options)
  const documentFileName = documentFileNameFor(options)
  const markDoc = documentClause(documentPath, 'reading_marks.document_path')
  const artifactDoc = documentClause(documentPath, 'reading_artifacts.source_file_path')
  if (markDoc.sql) {
    markWhere.push(markDoc.sql.replace('$DOCUMENT_PATH', `$${markParams.length + 1}`))
    markParams.push(...markDoc.params)
  }
  if (artifactDoc.sql) {
    const pathParam = artifactParams.length + 1
    let documentMatch = `(${artifactDoc.sql.replace('$DOCUMENT_PATH', `$${pathParam}`)} OR EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(reading_artifacts.structured_content) THEN reading_artifacts.structured_content ELSE '{}' END, '$.references') WHERE json_extract(value, '$.kind') = 'local' AND lower(replace(json_extract(value, '$.filePath'), '\\\\', '/')) = lower(replace($${pathParam}, '\\\\', '/'))))`
    artifactParams.push(...artifactDoc.params)
    if (documentFileName) {
      const fileNameParam = artifactParams.length + 1
      documentMatch = `(${documentMatch} OR (reading_artifacts.source_file_path IS NULL AND reading_artifacts.source_file_name = $${fileNameParam}) OR EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(reading_artifacts.structured_content) THEN reading_artifacts.structured_content ELSE '{}' END, '$.references') WHERE json_extract(value, '$.kind') = 'local' AND NULLIF(trim(json_extract(value, '$.filePath')), '') IS NULL AND json_extract(value, '$.fileName') = $${fileNameParam}))`
      artifactParams.push(documentFileName)
    }
    artifactWhere.push(documentMatch)
  }
  if (documentFileName && !documentPath) {
    const fileNameParam = artifactParams.length + 1
    artifactWhere.push(`((reading_artifacts.source_file_path IS NULL AND reading_artifacts.source_file_name = $${fileNameParam}) OR EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(reading_artifacts.structured_content) THEN reading_artifacts.structured_content ELSE '{}' END, '$.references') WHERE json_extract(value, '$.kind') = 'local' AND NULLIF(trim(json_extract(value, '$.filePath')), '') IS NULL AND json_extract(value, '$.fileName') = $${fileNameParam}))`)
    artifactParams.push(documentFileName)
  }
  const markSearch = markSearchClause(query, markParams)
  const artifactSearch = artifactSearchClause(query, artifactParams)
  if (markSearch) markWhere.push(markSearch)
  if (artifactSearch) artifactWhere.push(artifactSearch)
  const markWhereSql = markWhere.join(' AND ')
  const artifactWhereSql = artifactWhere.join(' AND ')
  const markCountRows = await db.select<{ total: number }>(`SELECT COUNT(*) AS total FROM reading_marks WHERE ${markWhereSql}`, markParams)
  const artifactCountRows = await db.select<{ total: number }>(`SELECT COUNT(*) AS total FROM reading_artifacts WHERE ${artifactWhereSql}`, artifactParams)
  const total = Number(markCountRows[0]?.total || 0) + Number(artifactCountRows[0]?.total || 0)
  const sourceLimit = offset + limit
  const marksQuery = `SELECT * FROM reading_marks WHERE ${markWhereSql} ORDER BY ${options.sort === 'source' ? 'start_offset ASC, created_at ASC, id ASC' : 'created_at DESC, id DESC'} LIMIT $${markParams.length + 1} OFFSET $${markParams.length + 2}`
  const artifactQuery = `SELECT * FROM reading_artifacts WHERE ${artifactWhereSql} ORDER BY ${options.sort === 'source' ? `${sourceOrderExpression('reading_artifacts')} ASC, created_at ASC, id ASC` : 'created_at DESC, id DESC'} LIMIT $${artifactParams.length + 1} OFFSET $${artifactParams.length + 2}`
  const [markRows, artifactRows] = await Promise.all([
    db.select<Record<string, unknown>>(marksQuery, [...markParams, sourceLimit, 0]),
    db.select<ReadingArtifactRow>(artifactQuery, [...artifactParams, sourceLimit, 0]),
  ])
  const mappedMarks = markRows.map(decodeReadingMarkRow)
  const mappedArtifacts = artifactRows.map(decodeReadingArtifact)
  const merged = [
    ...mappedMarks.map((mark) => ({ kind: 'mark' as const, value: mark, key: `mark:${mark.id}`, createdAt: mark.createdAt, source: mark.anchor.startOffset })),
    ...mappedArtifacts.map((artifact) => ({ kind: 'artifact' as const, value: artifact, key: `ai:${artifact.id}`, createdAt: artifact.createdAt, source: artifact.source?.startLine ?? Number.MAX_SAFE_INTEGER })),
  ].sort((left, right) => {
    if (options.sort === 'source') return left.source - right.source || left.createdAt - right.createdAt || left.key.localeCompare(right.key)
    return right.createdAt - left.createdAt || left.key.localeCompare(right.key)
  }).slice(offset, offset + limit)
  return {
    marks: merged.filter((entry) => entry.kind === 'mark').map((entry) => entry.value),
    artifacts: merged.filter((entry) => entry.kind === 'artifact').map((entry) => entry.value),
    total,
    hasMore: offset + limit < total,
  }
}

async function loadPageFallback(options: ReadingArtifactCenterPageOptions): Promise<ReadingArtifactCenterPage> {
  const limit = normalizeLimit(options.limit)
  const offset = normalizeOffset(options.offset)
  const [marksResult, artifactPageResult] = await Promise.all([
    loadReadingMarksPage(offset + limit, 0),
    loadReadingArtifactsPageCommand({ status: 'active', query: normalizeQuery(options.query), limit: offset + limit, offset: 0 }),
  ])
  const marks = marksResult ?? []
  const artifactPage = artifactPageResult ?? { artifacts: [], total: 0 }
  const merged = [
    ...marks.map((mark) => ({ kind: 'mark' as const, value: mark, key: `mark:${mark.id}`, createdAt: mark.createdAt, source: mark.anchor.startOffset })),
    ...artifactPage.artifacts.map((artifact) => ({ kind: 'artifact' as const, value: artifact, key: `ai:${artifact.id}`, createdAt: artifact.createdAt, source: artifact.source?.startLine ?? Number.MAX_SAFE_INTEGER })),
  ].sort((left, right) => options.sort === 'source'
    ? left.source - right.source || left.createdAt - right.createdAt || left.key.localeCompare(right.key)
    : right.createdAt - left.createdAt || left.key.localeCompare(right.key))
    .slice(offset, offset + limit)
  return {
    marks: merged.filter((entry) => entry.kind === 'mark').map((entry) => entry.value),
    artifacts: merged.filter((entry) => entry.kind === 'artifact').map((entry) => entry.value),
    total: (marks.length >= offset + limit ? offset + limit + 1 : marks.length) + Number(artifactPage.total || 0),
    hasMore: marks.length >= offset + limit || offset + limit < Number(artifactPage.total || 0),
  }
}

export async function loadReadingArtifactCenterItemsPage(options: ReadingArtifactCenterPageOptions): Promise<ReadingArtifactCenterPage> {
  if (!options.types.length) return { marks: [], artifacts: [], total: 0, hasMore: false }
  return isDatabaseReady() ? loadPageFromDatabase(options) : loadPageFallback(options)
}

export async function loadReadingArtifactDocumentSummariesPage(options: {
  query?: string
  types: readonly string[]
  limit: number
  offset: number
}): Promise<ReadingArtifactDocumentPage> {
  // Document summaries are intentionally metadata-only. The same bounded item query
  // is used when SQLite is unavailable (tests/Web fallback), while desktop uses SQL
  // grouping to avoid loading result bodies into the renderer.
  if (!isDatabaseReady()) {
    const page = await loadPageFallback({ view: 'recent', types: options.types, query: options.query, limit: options.limit, offset: 0 })
    const items = filterReadingArtifactItems(
      buildReadingArtifactItems(page.marks, page.artifacts),
      new Set(options.types as ReadingArtifactItemType[]),
      normalizeQuery(options.query),
    )
    const summaries = listArtifactDocuments(items).map((summary) => ({
      documentId: summary.documentRef?.documentId ?? '__independent__',
      filePath: summary.documentRef?.filePath ?? '',
      fileName: summary.documentRef?.fileName ?? '独立成果',
      total: summary.total,
      highlights: summary.highlights,
      annotations: summary.annotations,
      aiArtifacts: summary.aiArtifacts,
      latestCreatedAt: summary.latestCreatedAt,
    }))
    const total = summaries.length
    return { documents: summaries.slice(normalizeOffset(options.offset), normalizeOffset(options.offset) + normalizeLimit(options.limit)), total, hasMore: normalizeOffset(options.offset) + normalizeLimit(options.limit) < total }
  }
  const db = getDatabase()
  const query = normalizeQuery(options.query)
  const limit = normalizeLimit(options.limit)
  const offset = normalizeOffset(options.offset)
  const params: unknown[] = []
  const markTypes = markTypeClause(options.types)
  const artifactTypes = artifactTypeClause(options.types, params)
  const searchParts: string[] = []
  const pattern = query ? likePattern(query) : ''
  if (pattern) {
    params.push(pattern)
    const p = `$${params.length}`
    searchParts.push(`(quote LIKE ${p} ESCAPE '!' OR COALESCE(note, '') LIKE ${p} ESCAPE '!' OR document_path LIKE ${p} ESCAPE '!')`)
    searchParts.push(`(title LIKE ${p} ESCAPE '!' OR content LIKE ${p} ESCAPE '!' OR COALESCE(source_file_name, '') LIKE ${p} ESCAPE '!' OR COALESCE(source_quote, '') LIKE ${p} ESCAPE '!' OR COALESCE(structured_content, '') LIKE ${p} ESCAPE '!')`)
  }
  const markFilter = [`${markTypes}`, ...(searchParts[0] ? [searchParts[0]] : [])].join(' AND ')
  const artifactFilter = [`${artifactTypes}`, "reading_artifacts.status = 'active'", ...(searchParts[1] ? [searchParts[1]] : [])].join(' AND ')
  const sql = `WITH docs AS (
    SELECT lower(replace(document_path, '\\\\', '/')) AS document_id, document_path AS file_path, document_path AS file_name, created_at, CASE WHEN note IS NULL OR trim(note) = '' THEN 1 ELSE 0 END AS highlights, CASE WHEN note IS NOT NULL AND trim(note) <> '' THEN 1 ELSE 0 END AS annotations, 0 AS ai_artifacts, id AS item_id FROM reading_marks WHERE ${markFilter}
    UNION ALL
    SELECT lower(replace(source_file_path, '\\\\', '/')), source_file_path, COALESCE(source_file_name, source_file_path), created_at, 0, 0, 1, id FROM reading_artifacts WHERE ${artifactFilter} AND NULLIF(trim(source_file_path), '') IS NOT NULL
    UNION ALL
    SELECT CASE WHEN NULLIF(trim(json_extract(value, '$.filePath')), '') IS NOT NULL THEN lower(replace(json_extract(value, '$.filePath'), '\\\\', '/')) ELSE 'legacy-source:' || reading_artifacts.id || ':' || lower(json_extract(value, '$.fileName')) END, json_extract(value, '$.filePath'), json_extract(value, '$.fileName'), reading_artifacts.created_at, 0, 0, 1, reading_artifacts.id FROM reading_artifacts, json_each(CASE WHEN json_valid(structured_content) THEN structured_content ELSE '{}' END, '$.references') WHERE ${artifactFilter} AND json_extract(value, '$.kind') = 'local'
    UNION ALL
    SELECT '__independent__', NULL, '独立成果', created_at, 0, 0, 1, id FROM reading_artifacts WHERE ${artifactFilter} AND NULLIF(trim(source_file_path), '') IS NULL AND NULLIF(trim(source_file_name), '') IS NULL AND NOT EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(reading_artifacts.structured_content) THEN reading_artifacts.structured_content ELSE '{}' END, '$.references') WHERE json_extract(value, '$.kind') = 'local')
  ), deduped AS (
    SELECT document_id, item_id, MAX(file_path) AS file_path, MAX(file_name) AS file_name, MAX(created_at) AS created_at, MAX(highlights) AS highlights, MAX(annotations) AS annotations, MAX(ai_artifacts) AS ai_artifacts FROM docs GROUP BY document_id, item_id
  ), grouped AS (
    SELECT document_id, MAX(file_path) AS file_path, MAX(file_name) AS file_name, COUNT(*) AS total, SUM(highlights) AS highlights, SUM(annotations) AS annotations, SUM(ai_artifacts) AS ai_artifacts, MAX(created_at) AS latest_created_at FROM deduped GROUP BY document_id
  ) SELECT document_id AS documentId, file_path AS filePath, file_name AS fileName, total, highlights, annotations, ai_artifacts AS aiArtifacts, latest_created_at AS latestCreatedAt FROM grouped ORDER BY latest_created_at DESC, document_id ASC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`
  const countSql = sql.replace(/SELECT document_id AS[\s\S]*$/, 'SELECT COUNT(*) AS total FROM grouped')
  const [rows, countRows] = await Promise.all([
    db.select<ReadingArtifactDocumentSummaryRow>(sql, [...params, limit, offset]),
    db.select<{ total: number }>(countSql, params),
  ])
  const total = Number(countRows[0]?.total || 0)
  return { documents: rows, total, hasMore: offset + limit < total }
}
