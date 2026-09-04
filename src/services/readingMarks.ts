import { normalizeFilePath } from '@/services/pathIdentity'
import { searchVisibleText, type MarkdownPreviewModel } from '@/services/markdownPreviewModel'
import { getTextForSourceRange, buildDocumentRangeInfo, type DocumentRange } from '@/services/previewHighlight'
import type { PreviewSelectionSnapshot } from '@/components/editor/markdownPreviewTypes'
import { isWebRuntime } from '@/services/runtimeCapabilities'
import { UnsupportedCapabilityError } from '@/services/externalHttp'

export type ReadingMarkType = 'highlight' | 'annotation'
export type ReadingMarkColor = 'yellow' | 'green' | 'blue' | 'pink'

export interface ReadingMarkAnchor {
  range: DocumentRange
  startOffset: number
  endOffset: number
  quote: string
  contextBefore: string
  contextAfter: string
}

export interface ReadingMark {
  id: string
  documentId: string
  documentPath: string
  type: ReadingMarkType
  anchor: ReadingMarkAnchor
  color: ReadingMarkColor
  note?: string
  createdAt: number
  updatedAt: number
}

export interface CreateReadingMarkInput {
  documentPath: string
  type?: ReadingMarkType
  color?: ReadingMarkColor
  note?: string
  selection: PreviewSelectionSnapshot
  model?: MarkdownPreviewModel
}

export interface UpdateReadingMarkPatch {
  color?: ReadingMarkColor
  note?: string
  type?: ReadingMarkType
}

export type ReadingMarkConflictKind = 'exact' | 'overlap'

export interface ReadingMarkCreateConflict {
  mark: ReadingMark
  kind: ReadingMarkConflictKind
}

export type CreateReadingMarkResult =
  | { status: 'created'; mark: ReadingMark }
  | { status: 'conflict'; mark: ReadingMark; kind: ReadingMarkConflictKind }

export interface ResolvedReadingMark {
  mark: ReadingMark
  from: number
  to: number
}

export interface ReadingMarkRangeIndex {
  byId: Map<string, { from: number; to: number }>
  byBlockId: Map<string, ResolvedReadingMark[]>
  sorted: ResolvedReadingMark[]
}

async function invokeDatabase<T>(command: string, payload?: unknown): Promise<T> {
  if (isWebRuntime()) throw new UnsupportedCapabilityError('数据库相关能力')
  const [{ invoke }, { isDatabaseReady }] = await Promise.all([
    import('@tauri-apps/api/core'),
    import('@/services/database/db'),
  ])
  if (!isDatabaseReady()) throw new Error('数据库尚未就绪')
  return payload == null ? invoke<T>(command) : invoke<T>(command, payload as Record<string, unknown>)
}

export function readingDocumentId(documentPath: string): string {
  return `path:${normalizeFilePath(documentPath)}`
}

function clampContext(value: string, fromEnd: boolean): string {
  const chars = Array.from(value)
  return (fromEnd ? chars.slice(-64) : chars.slice(0, 64)).join('')
}

export function createReadingMarkAnchor(model: MarkdownPreviewModel, selection: PreviewSelectionSnapshot): ReadingMarkAnchor {
  const { from, to } = selection
  const rangeInfo = buildDocumentRangeInfo(model, from, to)
  if (!rangeInfo) throw new Error('无法为选区建立稳定的全文范围')
  const quote = getTextForSourceRange(model, from, to)
  if (!quote) throw new Error('选区没有可持久化的可见文本')
  return {
    range: rangeInfo.range,
    startOffset: from,
    endOffset: to,
    quote,
    contextBefore: clampContext(getTextForSourceRange(model, Math.max(0, from - 512), from), true),
    contextAfter: clampContext(getTextForSourceRange(model, to, Math.min(model.rawContent.length, to + 512)), false),
  }
}

interface ReadingMarkRow {
  id: string
  document_id: string
  document_path: string
  type: ReadingMarkType
  start_block_id: string
  start_block_offset: number
  end_block_id: string
  end_block_offset: number
  start_offset: number
  end_offset: number
  quote: string
  context_before: string
  context_after: string
  color: ReadingMarkColor
  note: string | null
  created_at: number
  updated_at: number
}

function timestamp(value: number): number {
  return value > 0 && value < 1_000_000_000_000 ? value * 1000 : value
}

export function decodeReadingMarkRow(row: ReadingMarkRow | Record<string, any>): ReadingMark {
  const raw = row as any
  const note = raw.note?.trim() || undefined
  const anchor = raw.anchor ?? {
    range: {
      startBlockId: raw.start_block_id ?? raw.startBlockId,
      startOffset: raw.start_block_offset ?? raw.startBlockOffset,
      endBlockId: raw.end_block_id ?? raw.endBlockId,
      endOffset: raw.end_block_offset ?? raw.endBlockOffset,
    },
    startOffset: raw.start_offset ?? raw.startOffset,
    endOffset: raw.end_offset ?? raw.endOffset,
    quote: raw.quote,
    contextBefore: raw.context_before ?? raw.contextBefore,
    contextAfter: raw.context_after ?? raw.contextAfter,
  }
  const rawRange = anchor.range ?? {}
  return {
    id: raw.id,
    documentId: raw.document_id ?? raw.documentId,
    documentPath: raw.document_path ?? raw.documentPath,
    // type 仅作为旧数据库字段保留；业务语义统一由 note 是否为空派生。
    type: note ? 'annotation' : 'highlight',
    anchor: {
      range: {
        startBlockId: rawRange.startBlockId ?? rawRange.start_block_id,
        startOffset: rawRange.startOffset ?? rawRange.start_offset,
        endBlockId: rawRange.endBlockId ?? rawRange.end_block_id,
        endOffset: rawRange.endOffset ?? rawRange.end_offset,
      },
      startOffset: anchor.startOffset ?? anchor.start_offset,
      endOffset: anchor.endOffset ?? anchor.end_offset,
      quote: anchor.quote,
      contextBefore: anchor.contextBefore ?? anchor.context_before ?? '',
      contextAfter: anchor.contextAfter ?? anchor.context_after ?? '',
    },
    color: raw.color,
    note,
    createdAt: timestamp(raw.created_at ?? raw.createdAt),
    updatedAt: timestamp(raw.updated_at ?? raw.updatedAt),
  }
}

function toRustMark(mark: ReadingMark) {
  return {
    id: mark.id,
    documentId: mark.documentId,
    documentPath: mark.documentPath,
    type: mark.type,
    anchor: {
      range: mark.anchor.range,
      startOffset: mark.anchor.startOffset,
      endOffset: mark.anchor.endOffset,
      quote: mark.anchor.quote,
      contextBefore: mark.anchor.contextBefore,
      contextAfter: mark.anchor.contextAfter,
    },
    color: mark.color,
    note: mark.note ?? null,
    createdAt: mark.createdAt,
    updatedAt: mark.updatedAt,
  }
}

export async function loadReadingMarks(documentPath: string): Promise<ReadingMark[]> {
  if (!documentPath || isWebRuntime()) return []
  const rows = await invokeDatabase<ReadingMarkRow[]>('load_reading_marks', { documentId: readingDocumentId(documentPath) })
  return rows.map(decodeReadingMarkRow)
}

export async function loadReadingMarksPage(limit = 200, offset = 0): Promise<ReadingMark[]> {
  if (isWebRuntime()) return []
  const rows = await invokeDatabase<ReadingMarkRow[]>('load_reading_marks_page', { limit, offset })
  return rows.map(decodeReadingMarkRow)
}

export async function getReadingMarkById(id: string): Promise<ReadingMark> {
  return decodeReadingMarkRow(await invokeDatabase<ReadingMarkRow>('get_reading_mark', { id }))
}

export async function createReadingMark(input: CreateReadingMarkInput, model?: MarkdownPreviewModel): Promise<ReadingMark> {
  const documentPath = input.documentPath.trim()
  if (!normalizeFilePath(documentPath)) throw new Error('批注仅支持已保存的 Markdown 文件')
  const now = Date.now()
  const anchor = model
    ? createReadingMarkAnchor(model, input.selection)
    : {
        range: input.selection.range,
        startOffset: input.selection.from,
        endOffset: input.selection.to,
        quote: input.selection.text,
        contextBefore: '',
        contextAfter: '',
      }
  const mark: ReadingMark = {
    id: globalThis.crypto?.randomUUID?.() ?? `mark-${now}-${Math.random().toString(36).slice(2)}`,
    documentId: readingDocumentId(documentPath),
    documentPath,
    type: input.note?.trim() ? 'annotation' : 'highlight',
    anchor,
    color: input.color ?? 'yellow',
    note: input.note?.trim() || undefined,
    createdAt: now,
    updatedAt: now,
  }
  return decodeReadingMarkRow(await invokeDatabase<ReadingMarkRow>('upsert_reading_mark', { mark: toRustMark(mark) }))
}

export async function updateReadingMark(id: string, patch: UpdateReadingMarkPatch): Promise<ReadingMark> {
  if (isWebRuntime()) throw new UnsupportedCapabilityError('数据库相关能力')
  const current = decodeReadingMarkRow(await invokeDatabase<ReadingMarkRow>('get_reading_mark', { id }))
  const next: ReadingMark = {
    ...current,
    ...patch,
    note: patch.note === undefined ? current.note : (patch.note.trim() || undefined),
    type: patch.note !== undefined ? (patch.note.trim() ? 'annotation' : 'highlight') : (current.note?.trim() ? 'annotation' : 'highlight'),
    updatedAt: Date.now(),
  }
  return decodeReadingMarkRow(await invokeDatabase<ReadingMarkRow>('upsert_reading_mark', { mark: toRustMark(next) }))
}

export async function deleteReadingMark(id: string): Promise<void> {
  await invokeDatabase('delete_reading_mark', { id })
}

function resolveReadingMarkAnchorWithBlockMap(
  model: MarkdownPreviewModel,
  mark: ReadingMark,
  blockById: Map<string, MarkdownPreviewModel['blocks'][number]>,
  verifyQuote = true,
): { from: number; to: number } | null {
  const anchor = mark.anchor
  const range = anchor.range
  const startBlock = blockById.get(range.startBlockId)
  const endBlock = blockById.get(range.endBlockId)
  if (startBlock && endBlock) {
    const from = startBlock.startOffset + range.startOffset
    const to = endBlock.startOffset + range.endOffset
    const startLimit = startBlock.endOffset - startBlock.startOffset
    const endLimit = endBlock.endOffset - endBlock.startOffset
    if (Number.isInteger(range.startOffset) && Number.isInteger(range.endOffset)
      && range.startOffset >= 0 && range.startOffset <= startLimit
      && range.endOffset >= 0 && range.endOffset <= endLimit
      && to > from
      && (!verifyQuote || getTextForSourceRange(model, from, to) === anchor.quote)) return { from, to }
  }
  if (Number.isInteger(anchor.startOffset) && Number.isInteger(anchor.endOffset)
    && anchor.startOffset >= 0 && anchor.endOffset <= model.rawContent.length
    && anchor.endOffset > anchor.startOffset
    && (!verifyQuote || getTextForSourceRange(model, anchor.startOffset, anchor.endOffset) === anchor.quote)) {
    return { from: anchor.startOffset, to: anchor.endOffset }
  }
  if (!verifyQuote) return null
  const candidates = searchVisibleText(model, anchor.quote)
  const contextual = candidates.filter((candidate) => {
    const before = getTextForSourceRange(model, Math.max(0, candidate.from - 512), candidate.from)
    const after = getTextForSourceRange(model, candidate.to, Math.min(model.rawContent.length, candidate.to + 512))
    return before.endsWith(anchor.contextBefore) && after.startsWith(anchor.contextAfter)
  })
  if (contextual.length === 1) return { from: contextual[0].from, to: contextual[0].to }
  return candidates.length === 1 ? { from: candidates[0].from, to: candidates[0].to } : null
}

export function resolveReadingMarkAnchor(model: MarkdownPreviewModel, mark: ReadingMark): { from: number; to: number } | null {
  return resolveReadingMarkAnchorWithBlockMap(model, mark, new Map(model.blocks.map((block) => [block.blockId, block])))
}

/** 构建文档级 ReadingMark 索引；DOM 不是索引来源，虚拟块挂载状态不参与计算。 */
export function buildReadingMarkRangeIndex(model: MarkdownPreviewModel, marks: ReadingMark[]): ReadingMarkRangeIndex {
  const byId = new Map<string, { from: number; to: number }>()
  const byBlockId = new Map<string, ResolvedReadingMark[]>()
  const sorted: ResolvedReadingMark[] = []
  const blockCount = model.blocks.length
  const blockById = new Map(model.blocks.map((block) => [block.blockId, block]))

  for (const mark of marks) {
    // 冲突判断只依赖持久化的 DocumentRange/全文 offset；避免每条标记
    // 再遍历整篇模型核对 quote，保证大量标记下索引构建近似 O(n)。
    const range = resolveReadingMarkAnchorWithBlockMap(model, mark, blockById, false)
    if (!range || range.to <= range.from) continue
    const entry = { mark, from: range.from, to: range.to }
    byId.set(mark.id, range)
    sorted.push(entry)
    if (blockCount === 0) continue
    let first = 0
    let low = 0
    let high = blockCount
    while (low < high) {
      const middle = (low + high) >> 1
      if (model.blocks[middle].endOffset <= range.from) low = middle + 1
      else high = middle
    }
    first = low
    for (let index = first; index < blockCount; index += 1) {
      const block = model.blocks[index]
      if (block.startOffset >= range.to) break
      if (block.endOffset <= range.from) continue
      const list = byBlockId.get(block.blockId)
      if (list) list.push(entry)
      else byBlockId.set(block.blockId, [entry])
    }
  }

  sorted.sort((left, right) => left.from - right.from || left.to - right.to || left.mark.id.localeCompare(right.mark.id))
  return { byId, byBlockId, sorted }
}

/** 按半开区间判断冲突；首尾相邻不冲突。 */
export function findReadingMarkConflict(
  index: ReadingMarkRangeIndex,
  from: number,
  to: number,
): ReadingMarkCreateConflict | null {
  if (to <= from) return null
  for (const entry of index.sorted) {
    if (entry.from >= to) break
    if (entry.to <= from) continue
    const kind: ReadingMarkConflictKind = entry.from === from && entry.to === to ? 'exact' : 'overlap'
    return { mark: entry.mark, kind }
  }
  return null
}
