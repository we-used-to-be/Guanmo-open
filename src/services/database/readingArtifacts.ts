/**
 * 结构化阅读成果（reading_artifacts）运行时解码、仓库与来源锚点校验。
 *
 * - 桌面端以 SQLite `reading_artifacts` 为唯一业务主存储。
 * - 表行必须经运行时 schema 解码；未知类型或损坏数据进入可见错误状态，不静默丢弃。
 * - 来源锚点保存内容哈希、heading/line 与引用快照；来源变化时标记“来源已变化”，
 *   不得自动贴到相似段落。
 * - 删除成果不会改动原文。
 */
import { getDatabase, isDatabaseReady } from './db'
import type { ChatMessageSource, ReadingScope } from '@/services/ai/types'
import { parseMarkdownBlocks, type MarkdownBlock } from '@/services/markdownBlocks'
import { decodeOriginalSelections, type OriginalSelectionSnapshot } from '@/services/originalSelections'
import { buildReadingArtifactReferences, type SourceReferenceId } from '@/services/ai/sourceReferences'

export { buildReadingArtifactReferences }

/** 阅读成果类型，与 schema CHECK 约束保持一致 */
export type ReadingArtifactType =
  | 'summary'
  | 'question_set'
  | 'annotation'
  | 'note'

export type ReadingArtifactStatus = 'active' | 'archived'

/** 来源锚点：用于把成果定位回来源文件和原文范围 */
export interface ReadingArtifactSourceAnchor {
  filePath: string
  fileName: string
  /** 来源内容哈希，用于检测原文是否变化 */
  contentHash?: string | null
  /** 标题路径（JSON 数组），基于 Markdown model/source offset */
  headingPath?: string[] | null
  startLine?: number | null
  endLine?: number | null
  /** 引用快照：定位失效时的恢复依据 */
  quote?: string | null
  /** 产生该成果的聊天消息 ID */
  messageId?: string | null
  /** 产生该成果时的阅读范围 */
  scope?: ReadingScope | null
}

/** 阅读成果运行时结构 */
export interface ReadingArtifact {
  id: string
  type: ReadingArtifactType
  title: string
  /** Markdown 正文 */
  content: string
  /** 结构化字段，经运行时解码 */
  structuredContent?: unknown | null
  source?: ReadingArtifactSourceAnchor | null
  status: ReadingArtifactStatus
  createdAt: number
  updatedAt: number
}

/** DB 行（snake_case），未经运行时解码 */
export interface ReadingArtifactRow {
  id: string
  type: string
  title: string
  content: string
  structured_content: string | null
  source_file_path: string | null
  source_file_name: string | null
  source_content_hash: string | null
  source_heading_path: string | null
  source_start_line: number | null
  source_end_line: number | null
  source_quote: string | null
  source_message_id: string | null
  source_scope: string | null
  status: string
  created_at: number
  updated_at: number
}

const ALLOWED_TYPES: readonly ReadingArtifactType[] = [
  'summary',
  'question_set',
  'annotation',
  'note',
]

const ALLOWED_STATUSES: readonly ReadingArtifactStatus[] = ['active', 'archived']

const ALLOWED_SCOPES: readonly ReadingScope[] = [
  'selection',
  'section',
  'document',
  'workspace',
]

function assertString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`reading_artifacts 字段 ${field} 缺失或非字符串`)
  }
  return value
}

function decodeStructuredContent(raw: string | null): unknown | null {
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    // 损坏的结构化数据进入可见错误状态，不静默丢弃
    throw new Error('reading_artifacts.structured_content 解析失败')
  }
}

function decodeHeadingPath(raw: string | null): string[] | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === 'string')) {
      throw new Error('headingPath 必须为字符串数组')
    }
    return parsed
  } catch {
    throw new Error('reading_artifacts.source_heading_path 解析失败')
  }
}

function decodeTimestamp(value: number): number {
  // 兼容秒与毫秒（与 memories 时间戳归一逻辑一致）
  return value > 0 && value < 1_000_000_000_000 ? value * 1000 : value
}

/**
 * 运行时解码单行 reading_artifacts。
 * 未知类型、未知状态或损坏结构化数据抛出可见错误，不静默丢弃。
 */
export function decodeReadingArtifact(row: ReadingArtifactRow): ReadingArtifact {
  const type = assertString(row.type, 'type') as ReadingArtifactType
  if (!ALLOWED_TYPES.includes(type)) {
    throw new Error(`未知的 reading_artifacts 类型：${type}`)
  }
  const status = (row.status || 'active') as ReadingArtifactStatus
  if (!ALLOWED_STATUSES.includes(status)) {
    throw new Error(`未知的 reading_artifacts 状态：${status}`)
  }

  const filePath = row.source_file_path
  const fileName = row.source_file_name
  const hasSource = Boolean(filePath || fileName || row.source_quote || row.source_message_id)
  const scope = row.source_scope
  if (scope && !ALLOWED_SCOPES.includes(scope as ReadingScope)) {
    throw new Error(`未知的 reading_artifacts.source_scope：${scope}`)
  }

  return {
    id: assertString(row.id, 'id'),
    type,
    title: assertString(row.title, 'title'),
    content: assertString(row.content, 'content'),
    structuredContent: decodeStructuredContent(row.structured_content),
    source: hasSource
      ? {
          filePath: filePath || '',
          fileName: fileName || '',
          contentHash: row.source_content_hash || null,
          headingPath: decodeHeadingPath(row.source_heading_path),
          startLine: row.source_start_line ?? null,
          endLine: row.source_end_line ?? null,
          quote: row.source_quote || null,
          messageId: row.source_message_id || null,
          scope: (scope as ReadingScope | null) ?? null,
        }
      : null,
    status,
    createdAt: decodeTimestamp(row.created_at),
    updatedAt: decodeTimestamp(row.updated_at),
  }
}

function serializeStructuredContent(value: unknown | null): string | null {
  if (value === null || value === undefined) return null
  return JSON.stringify(value)
}

function serializeHeadingPath(value: string[] | null | undefined): string | null {
  if (!value || value.length === 0) return null
  return JSON.stringify(value)
}

/** 写入参数 */
export interface PersistReadingArtifactInput {
  id: string
  type: ReadingArtifactType
  title: string
  content: string
  structuredContent?: unknown | null
  source?: ReadingArtifactSourceAnchor | null
}

export interface LocalReadingArtifactReference {
  kind: 'local'
  filePath: string
  fileName: string
  titlePath?: string[]
  heading?: string
  startLine: number
  endLine: number
}

export interface WebReadingArtifactReference {
  kind: 'web'
  title: string
  url: string
  siteName?: string
  publishedAt?: string
}

/** AI 回复的参考资料及本轮选区定位来源快照。 */
export type ReadingArtifactReference =
  | LocalReadingArtifactReference
  | WebReadingArtifactReference

/** 把对应用户提问合并进成果结构化元数据，不改动既有类型专属字段。 */
export function mergeReadingArtifactQuestionMetadata(
  structuredContent: unknown | null | undefined,
  question: string | undefined,
): unknown | null {
  const normalizedQuestion = question?.trim()
  if (!normalizedQuestion) return structuredContent ?? null
  if (isPlainObject(structuredContent)) {
    return { ...structuredContent, question: normalizedQuestion }
  }
  return structuredContent === null || structuredContent === undefined
    ? { question: normalizedQuestion }
    : { question: normalizedQuestion, content: structuredContent }
}

/** 把完整参考来源合并进成果结构化元数据。 */
export function mergeReadingArtifactReferencesMetadata(
  structuredContent: unknown | null | undefined,
  references: readonly ReadingArtifactReference[],
): Record<string, unknown> {
  if (isPlainObject(structuredContent)) {
    return { ...structuredContent, references: references.map(cloneReadingArtifactReference) }
  }
  return structuredContent === null || structuredContent === undefined
    ? { references: references.map(cloneReadingArtifactReference) }
    : { content: structuredContent, references: references.map(cloneReadingArtifactReference) }
}

/** 安全读取成果中保存的用户提问；旧成果或损坏字段返回 null。 */
export function getReadingArtifactQuestion(artifact: ReadingArtifact): string | null {
  if (!isPlainObject(artifact.structuredContent)) return null
  const question = artifact.structuredContent.question
  return typeof question === 'string' && question.trim() ? question : null
}

export function getReadingArtifactOriginalSelections(artifact: ReadingArtifact): OriginalSelectionSnapshot[] {
  return isPlainObject(artifact.structuredContent) ? decodeOriginalSelections(artifact.structuredContent.originalSelections) : []
}

/** 附加快照保留候选来源顺序及既有引用 ID，不把选区插入 sources。 */
export function mergeReadingArtifactSelectionMetadata(
  structuredContent: Record<string, unknown>,
  selections: readonly OriginalSelectionSnapshot[] | undefined,
  sources: readonly ChatMessageSource[] | undefined,
  referencedSourceIds: readonly SourceReferenceId[] | undefined,
): Record<string, unknown> {
  return {
    ...structuredContent,
    ...(selections?.length ? { originalSelections: decodeOriginalSelections(selections) } : {}),
    ...(sources?.length ? { sourceCandidates: sources.map((source) => source.kind === 'web' ? { ...source } : { ...source, ...(source.titlePath ? { titlePath: [...source.titlePath] } : {}) }) } : {}),
    ...(referencedSourceIds ? { referencedSourceIds: [...referencedSourceIds] } : {}),
  }
}

export function getReadingArtifactReferencedSourceIds(artifact: ReadingArtifact): SourceReferenceId[] | undefined {
  if (!isPlainObject(artifact.structuredContent) || !Array.isArray(artifact.structuredContent.referencedSourceIds)) return undefined
  return artifact.structuredContent.referencedSourceIds.filter((id): id is SourceReferenceId => typeof id === 'string' && /^S[1-9]\d*$/.test(id))
}

/** 安全读取成果来源；旧成果或损坏项降级为空数组。 */
export function getReadingArtifactReferences(artifact: ReadingArtifact): ReadingArtifactReference[] {
  if (!isPlainObject(artifact.structuredContent)) return []
  const value = artifact.structuredContent.references
  const references = Array.isArray(value) ? value.flatMap((item) => {
    const decoded = decodeReadingArtifactReference(item)
    return decoded ? [decoded] : []
  }) : []
  return buildReadingArtifactReferences(references, getReadingArtifactOriginalSelections(artifact))
}

function decodeReadingArtifactReference(value: unknown): ReadingArtifactReference | null {
  if (!isPlainObject(value)) return null
  if (value.kind === 'web') {
    if (!isNonEmptyString(value.title) || !isNonEmptyString(value.url)) return null
    return {
      kind: 'web',
      title: value.title,
      url: value.url,
      ...(isNonEmptyString(value.siteName) ? { siteName: value.siteName } : {}),
      ...(isNonEmptyString(value.publishedAt) ? { publishedAt: value.publishedAt } : {}),
    }
  }
  if (value.kind !== 'local') return null
  if (
    !isNonEmptyString(value.filePath)
    || !isNonEmptyString(value.fileName)
    || !isValidLineRange(value.startLine, value.endLine)
  ) return null
  const titlePath = Array.isArray(value.titlePath)
    && value.titlePath.every((item) => typeof item === 'string')
    ? [...value.titlePath]
    : undefined
  return {
    kind: 'local',
    filePath: value.filePath,
    fileName: value.fileName,
    ...(titlePath?.length ? { titlePath } : {}),
    ...(isNonEmptyString(value.heading) ? { heading: value.heading } : {}),
    startLine: value.startLine as number,
    endLine: value.endLine as number,
  }
}

function cloneReadingArtifactReference(reference: ReadingArtifactReference): ReadingArtifactReference {
  return reference.kind === 'local'
    ? { ...reference, ...(reference.titlePath ? { titlePath: [...reference.titlePath] } : {}) }
    : { ...reference }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function isValidLineRange(startLine: unknown, endLine: unknown): startLine is number {
  return typeof startLine === 'number'
    && Number.isInteger(startLine)
    && startLine > 0
    && typeof endLine === 'number'
    && Number.isInteger(endLine)
    && endLine >= startLine
}

export async function persistReadingArtifact(
  input: PersistReadingArtifactInput,
): Promise<void> {
  if (!isDatabaseReady()) return
  const db = getDatabase()
  const source = input.source ?? null
  await db.execute(
    `INSERT OR REPLACE INTO reading_artifacts (
       id, type, title, content, structured_content,
       source_file_path, source_file_name, source_content_hash,
       source_heading_path, source_start_line, source_end_line, source_quote,
       source_message_id, source_scope, status, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, 'active',
       COALESCE((SELECT created_at FROM reading_artifacts WHERE id = $1), $15), $16)`,
    [
      input.id,
      input.type,
      input.title,
      input.content,
      serializeStructuredContent(input.structuredContent ?? null),
      source?.filePath || null,
      source?.fileName || null,
      source?.contentHash || null,
      serializeHeadingPath(source?.headingPath ?? null),
      source?.startLine ?? null,
      source?.endLine ?? null,
      source?.quote || null,
      source?.messageId || null,
      source?.scope || null,
      Math.floor(Date.now() / 1000),
      Math.floor(Date.now() / 1000),
    ],
  )
}

export interface LoadReadingArtifactsOptions {
  type?: ReadingArtifactType
  status?: ReadingArtifactStatus
  limit?: number
  offset?: number
}

export interface LoadReadingArtifactsPageOptions {
  type?: ReadingArtifactType
  status?: ReadingArtifactStatus
  query?: string
  limit?: number
  offset?: number
}

export interface ReadingArtifactsPage {
  artifacts: ReadingArtifact[]
  total: number
}

const DEFAULT_READING_ARTIFACT_PAGE_SIZE = 20
const MAX_READING_ARTIFACT_PAGE_SIZE = 100

function buildReadingArtifactWhere(
  options: Pick<LoadReadingArtifactsPageOptions, 'type' | 'status' | 'query'>,
): { where: string; params: unknown[] } {
  const clauses: string[] = []
  const params: unknown[] = []
  if (options.type) {
    params.push(options.type)
    clauses.push(`type = $${params.length}`)
  }
  if (options.status) {
    params.push(options.status)
    clauses.push(`status = $${params.length}`)
  }
  const query = options.query?.trim()
  if (query) {
    const escapedQuery = query.replace(/!/g, '!!').replace(/%/g, '!%').replace(/_/g, '!_')
    params.push(`%${escapedQuery}%`)
    const queryParam = `$${params.length}`
    clauses.push(`(
      title LIKE ${queryParam} ESCAPE '!'
      OR content LIKE ${queryParam} ESCAPE '!'
      OR COALESCE(source_file_name, '') LIKE ${queryParam} ESCAPE '!'
      OR COALESCE(source_quote, '') LIKE ${queryParam} ESCAPE '!'
      OR COALESCE(structured_content, '') LIKE ${queryParam} ESCAPE '!'
    )`)
  }
  return {
    where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '',
    params,
  }
}

function normalizeReadingArtifactPageLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_READING_ARTIFACT_PAGE_SIZE
  }
  return Math.min(Math.floor(value), MAX_READING_ARTIFACT_PAGE_SIZE)
}

function normalizeReadingArtifactPageOffset(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return 0
  return Math.floor(value)
}

export async function loadReadingArtifacts(
  options: LoadReadingArtifactsOptions = {},
): Promise<ReadingArtifact[]> {
  if (!isDatabaseReady()) return []
  const db = getDatabase()
  const clauses: string[] = []
  const params: unknown[] = []
  if (options.type) {
    params.push(options.type)
    clauses.push(`type = $${params.length}`)
  }
  if (options.status) {
    params.push(options.status)
    clauses.push(`status = $${params.length}`)
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
  params.push(options.limit ?? 200)
  const limitParam = `$${params.length}`
  params.push(options.offset ?? 0)
  const offsetParam = `$${params.length}`
  const rows = await db.select<ReadingArtifactRow>(
    `SELECT * FROM reading_artifacts ${where} ORDER BY updated_at DESC, created_at DESC, id DESC LIMIT ${limitParam} OFFSET ${offsetParam}`,
    params,
  )
  return rows.map(decodeReadingArtifact)
}

export async function loadReadingArtifactsPage(
  options: LoadReadingArtifactsPageOptions = {},
): Promise<ReadingArtifactsPage> {
  if (!isDatabaseReady()) return { artifacts: [], total: 0 }
  const db = getDatabase()
  const { where, params } = buildReadingArtifactWhere(options)
  const countRows = await db.select<{ total: number }>(
    `SELECT COUNT(*) AS total FROM reading_artifacts ${where}`,
    params,
  )
  const pageParams = [...params]
  pageParams.push(normalizeReadingArtifactPageLimit(options.limit))
  const limitParam = `$${pageParams.length}`
  pageParams.push(normalizeReadingArtifactPageOffset(options.offset))
  const offsetParam = `$${pageParams.length}`
  const rows = await db.select<ReadingArtifactRow>(
    `SELECT * FROM reading_artifacts ${where} ORDER BY updated_at DESC, created_at DESC, id DESC LIMIT ${limitParam} OFFSET ${offsetParam}`,
    pageParams,
  )
  return {
    artifacts: rows.map(decodeReadingArtifact),
    total: Number(countRows[0]?.total) || 0,
  }
}

export async function loadReadingArtifactById(
  id: string,
): Promise<ReadingArtifact | undefined> {
  if (!isDatabaseReady()) return undefined
  const db = getDatabase()
  const rows = await db.select<ReadingArtifactRow>(
    'SELECT * FROM reading_artifacts WHERE id = $1',
    [id],
  )
  return rows[0] ? decodeReadingArtifact(rows[0]) : undefined
}

export async function deleteReadingArtifact(id: string): Promise<void> {
  if (!isDatabaseReady()) return
  const db = getDatabase()
  await db.execute('DELETE FROM reading_artifacts WHERE id = $1', [id])
}

export async function setReadingArtifactStatus(
  id: string,
  status: ReadingArtifactStatus,
): Promise<void> {
  if (!isDatabaseReady()) return
  const db = getDatabase()
  await db.execute(
    'UPDATE reading_artifacts SET status = $1, updated_at = $2 WHERE id = $3',
    [status, Math.floor(Date.now() / 1000), id],
  )
}

export async function countReadingArtifacts(
  options: { status?: ReadingArtifactStatus } = {},
): Promise<number> {
  if (!isDatabaseReady()) return 0
  const db = getDatabase()
  const params: unknown[] = []
  const clause = options.status
    ? (params.push(options.status), `WHERE status = $${params.length}`)
    : ''
  const rows = await db.select<{ total: number }>(
    `SELECT COUNT(*) AS total FROM reading_artifacts ${clause}`,
    params,
  )
  return Number(rows[0]?.total) || 0
}

export interface ReadingArtifactBackupEntry {
  id: string
  type: string
  title: string
  content: string
  structuredContent: string | null
  sourceFilePath: string | null
  sourceFileName: string | null
  sourceContentHash: string | null
  sourceHeadingPath: string | null
  sourceStartLine: number | null
  sourceEndLine: number | null
  sourceQuote: string | null
  sourceMessageId: string | null
  sourceScope: string | null
  status: string
  createdAt: number
  updatedAt: number
}

/**
 * 加载全部阅读成果并重新序列化为备份条目（camelCase，结构化字段以 JSON 字符串保留）。
 * 供 exportBackupPayload 使用；旧备份导入缺少 artifacts 字段时按空数组兼容。
 */
export async function loadReadingArtifactsForBackup(): Promise<ReadingArtifactBackupEntry[]> {
  if (!isDatabaseReady()) return []
  const artifacts = await loadReadingArtifacts({ limit: 10000 })
  return artifacts.map((artifact) => ({
    id: artifact.id,
    type: artifact.type,
    title: artifact.title,
    content: artifact.content,
    structuredContent:
      artifact.structuredContent === null || artifact.structuredContent === undefined
        ? null
        : JSON.stringify(artifact.structuredContent),
    sourceFilePath: artifact.source?.filePath || null,
    sourceFileName: artifact.source?.fileName || null,
    sourceContentHash: artifact.source?.contentHash || null,
    sourceHeadingPath:
      artifact.source?.headingPath && artifact.source.headingPath.length > 0
        ? JSON.stringify(artifact.source.headingPath)
        : null,
    sourceStartLine: artifact.source?.startLine ?? null,
    sourceEndLine: artifact.source?.endLine ?? null,
    sourceQuote: artifact.source?.quote || null,
    sourceMessageId: artifact.source?.messageId || null,
    sourceScope: artifact.source?.scope || null,
    status: artifact.status,
    createdAt: artifact.createdAt,
    updatedAt: artifact.updatedAt,
  }))
}

// --- 来源锚点校验 ---

export type SourceAnchorStatus = 'valid' | 'changed' | 'missing'

export interface SourceAnchorCheck {
  status: SourceAnchorStatus
  /** 当前文件内容哈希（若可读取） */
  currentHash?: string
}

/**
 * 校验来源锚点是否仍然有效。
 * - 文件路径缺失视为 missing
 * - 内容哈希不匹配视为 changed
 * - 哈希匹配视为 valid
 * 注意：不读取原文做模糊匹配，避免自动贴到相似段落。
 */
export async function checkReadingArtifactSource(
  anchor: ReadingArtifactSourceAnchor,
  currentContentHashProvider: (filePath: string) => Promise<string | undefined>,
): Promise<SourceAnchorCheck> {
  if (!anchor.filePath) return { status: 'missing' }
  const currentHash = await currentContentHashProvider(anchor.filePath)
  if (currentHash === undefined) return { status: 'missing' }
  if (!anchor.contentHash) return { status: 'valid', currentHash }
  if (anchor.contentHash !== currentHash) return { status: 'changed', currentHash }
  return { status: 'valid', currentHash }
}

// --- 批注结构化内容 ---

/**
 * 批注结构化内容。
 *
 * - 批注绑定到原文范围，不修改原文。
 * - `quote` 为被批注的原文引用快照；`note` 为批注正文（通常来自 AI 回答或用户笔记）。
 * - `contextFingerprint` 为目标块源码指纹，用于原文局部变化后判断块是否仍稳定。
 * - `startOffset`/`endOffset` 为原始 Markdown source offset，定位基于 Markdown model，
 *   不遍历或假设全文 DOM 已挂载。
 */
export interface AnnotationStructuredContent {
  quote: string
  note: string
  question?: string
  contextFingerprint?: string | null
  startOffset?: number | null
  endOffset?: number | null
}

function assertNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`批注字段 ${field} 缺失或不是非空字符串`)
  }
  return value
}

/**
 * 运行时解码批注 structured_content。
 * 未知或损坏数据抛出可见错误，不静默丢弃。
 */
export function decodeAnnotationStructuredContent(value: unknown): AnnotationStructuredContent {
  if (!isPlainObject(value)) {
    throw new Error('批注 structured_content 必须为对象')
  }
  const quote = assertNonEmptyString(value.quote, 'quote')
  const note = assertNonEmptyString(value.note, 'note')
  const question = typeof value.question === 'string' && value.question.trim()
    ? value.question
    : undefined
  const contextFingerprint =
    typeof value.contextFingerprint === 'string' ? value.contextFingerprint : null
  const startOffset =
    typeof value.startOffset === 'number' && Number.isFinite(value.startOffset)
      ? value.startOffset
      : null
  const endOffset =
    typeof value.endOffset === 'number' && Number.isFinite(value.endOffset)
      ? value.endOffset
      : null
  return { quote, note, ...(question ? { question } : {}), contextFingerprint, startOffset, endOffset }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 取批注结构化内容；类型不符或数据损坏返回 null（不抛出，用于 UI 安全降级）。
 */
export function getAnnotationStructuredContent(
  artifact: ReadingArtifact,
): AnnotationStructuredContent | null {
  if (artifact.type !== 'annotation') return null
  try {
    return decodeAnnotationStructuredContent(artifact.structuredContent)
  } catch {
    return null
  }
}

// --- 批注定位（基于 Markdown model/source offset，不遍历 DOM）---

/**
 * 按原始 Markdown source offset 命中所属顶层块。
 *
 * 虚拟预览只挂载可视区附近顶层块，不能假设全文 DOM 已挂载，
 * 因此定位必须基于 Markdown model/source offset，而不是遍历 DOM。
 *
 * - offset 命中块区间 [startOffset, endOffset) 时返回该块。
 * - offset 落在块间隙（例如两个块之间的空行）时返回紧随其后的块。
 * - 超出全文范围时返回 null。
 */
export function findMarkdownBlockByOffset(
  blocks: MarkdownBlock[],
  offset: number,
): MarkdownBlock | null {
  if (!Number.isFinite(offset) || offset < 0) return null
  for (const block of blocks) {
    if (offset < block.endOffset) {
      return block
    }
  }
  return null
}

/**
 * 按引用文本在已解析顶层块中重新定位。
 *
 * 原文内容变化后行号可能漂移；用引用快照在当前 Markdown model 的块源码中匹配，
 * 命中时返回该块。优先完整包含匹配，其次按归一化文本前缀匹配。
 * 不读取 DOM，不假设全文已挂载；仅依赖 parseMarkdownBlocks 产出的块结构。
 */
export function findMarkdownBlockByQuote(
  blocks: MarkdownBlock[],
  quote: string,
): MarkdownBlock | null {
  const needle = normalizeForMatch(quote)
  if (!needle) return null
  for (const block of blocks) {
    if (normalizeForMatch(block.rawSource).includes(needle)) {
      return block
    }
  }
  const prefix = needle.slice(0, Math.min(needle.length, 24))
  for (const block of blocks) {
    if (normalizeForMatch(block.rawSource).startsWith(prefix)) {
      return block
    }
  }
  return null
}

/**
 * 计算块源码的稳定指纹（FNV-1a），用于检测原文是否局部变化。
 * 与 parseMarkdownBlocks 内部 renderKey 哈希算法保持一致。
 */
export function computeMarkdownBlockFingerprint(rawSource: string): string {
  return fnv1aHash(rawSource)
}

function normalizeForMatch(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase()
}

function fnv1aHash(value: string): string {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}

export interface AnnotationPosition {
  /** 当前命中块的起始行（1-based） */
  startLine: number
  /** 当前命中块的结束行（1-based） */
  endLine: number
  /** 命中块的 renderKey，便于虚拟预览精确滚动 */
  renderKey: string
  /** 定位方式：offset=按原始偏移命中；quote=按引用快照重新命中；fallback=退回锚点行号 */
  matchedBy: 'offset' | 'quote' | 'fallback'
}

/**
 * 把批注定位到当前文档的顶层块。
 *
 * - 优先按原始 source offset 命中块（虚拟预览安全，基于 Markdown model）。
 * - offset 失效时按引用快照 quote 在块源码中重新命中。
 * - 两者都失败时退回锚点保存的 startLine/endLine（仍可用于打开来源）。
 *
 * 不读取 DOM，不假设全文已挂载；仅依赖 parseMarkdownBlocks 产出的块结构。
 */
export function resolveAnnotationPosition(
  content: string,
  annotation: AnnotationStructuredContent,
  anchor: ReadingArtifactSourceAnchor | null | undefined,
): AnnotationPosition | null {
  const fallbackLines = anchor && anchor.startLine && anchor.endLine
    ? { startLine: anchor.startLine, endLine: anchor.endLine }
    : null

  if (!content) {
    return fallbackLines
      ? { ...fallbackLines, renderKey: '', matchedBy: 'fallback' }
      : null
  }

  const blocks = parseMarkdownBlocks(content)

  // 1. 按原始 offset 命中
  if (annotation.startOffset !== null && annotation.startOffset !== undefined) {
    const block = findMarkdownBlockByOffset(blocks, annotation.startOffset)
    if (block) {
      // 若保存了块指纹，校验块是否仍稳定；不一致则继续尝试 quote
      if (!annotation.contextFingerprint
        || computeMarkdownBlockFingerprint(block.rawSource) === annotation.contextFingerprint) {
        return toPosition(block, 'offset')
      }
    }
  }

  // 2. 按引用快照重新命中
  if (annotation.quote) {
    const block = findMarkdownBlockByQuote(blocks, annotation.quote)
    if (block) {
      return toPosition(block, 'quote')
    }
  }

  // 3. 退回锚点行号
  return fallbackLines
    ? { ...fallbackLines, renderKey: '', matchedBy: 'fallback' }
    : null
}

function toPosition(block: MarkdownBlock, matchedBy: 'offset' | 'quote'): AnnotationPosition {
  return {
    startLine: block.startLine,
    endLine: block.endLine,
    renderKey: block.renderKey,
    matchedBy,
  }
}

/**
 * 为指定 offset 计算所在块的上下文指纹，供批注保存时记录。
 * 返回 null 表示无法计算（例如 offset 越界或内容为空）。
 */
export function computeAnnotationFingerprint(
  content: string,
  startOffset: number,
): string | null {
  if (!content || !Number.isFinite(startOffset) || startOffset < 0) return null
  const blocks = parseMarkdownBlocks(content)
  const block = findMarkdownBlockByOffset(blocks, startOffset)
  return block ? computeMarkdownBlockFingerprint(block.rawSource) : null
}
