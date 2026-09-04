import { getDatabase, isDatabaseReady } from './db'
import type { ReadingMark } from '@/services/readingMarks'

export async function loadAllReadingMarksForBackup(): Promise<ReadingMark[]> {
  if (!isDatabaseReady()) return []
  const rows = await getDatabase().select<any>('SELECT * FROM reading_marks ORDER BY created_at ASC')
  return rows.map((row) => ({
    id: row.id,
    documentId: row.document_id,
    documentPath: row.document_path,
    type: row.type,
    anchor: {
      range: {
        startBlockId: row.start_block_id,
        startOffset: row.start_block_offset,
        endBlockId: row.end_block_id,
        endOffset: row.end_block_offset,
      },
      startOffset: row.start_offset,
      endOffset: row.end_offset,
      quote: row.quote,
      contextBefore: row.context_before || '',
      contextAfter: row.context_after || '',
    },
    color: row.color,
    note: row.note || undefined,
    createdAt: row.created_at > 0 && row.created_at < 1_000_000_000_000 ? row.created_at * 1000 : row.created_at,
    updatedAt: row.updated_at > 0 && row.updated_at < 1_000_000_000_000 ? row.updated_at * 1000 : row.updated_at,
  }))
}
