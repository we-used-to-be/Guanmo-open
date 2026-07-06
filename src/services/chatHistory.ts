export interface ChatHistoryRow {
  id: string
  session_id: string
  parent_id?: string | null
  role: string
  created_at: number
  message_order?: number
}

/**
 * 将跨会话、倒序加载的历史消息整理为按时间正序排列的完整问答。
 * 配对始终限制在同一会话内，避免不同会话交错时问题与回答错配。
 */
export function buildLinkedQaRows<T extends ChatHistoryRow>(rows: T[]): T[] {
  const rowsById = new Map(rows.map((row) => [row.id, row]))
  return rows
    .filter((row) => row.role === 'assistant' && row.parent_id)
    .flatMap((assistant) => {
      const user = rowsById.get(assistant.parent_id!)
      if (!user || user.role !== 'user' || user.session_id !== assistant.session_id) return []
      return [{ user, assistant }]
    })
    .sort((a, b) => compareHistoryRows(a.assistant, b.assistant))
    .flatMap(({ user, assistant }) => [user, assistant])
}

function compareHistoryRows(a: ChatHistoryRow, b: ChatHistoryRow): number {
  if (a.created_at !== b.created_at) return a.created_at - b.created_at
  return (a.message_order ?? 0) - (b.message_order ?? 0)
}
