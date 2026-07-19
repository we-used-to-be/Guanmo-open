import { buildLinkedQaRows, type ChatHistoryRow } from '../src/services/chatHistory'

interface TestRow extends ChatHistoryRow {
  id: string
}

function row(
  id: string,
  session: string,
  role: 'user' | 'assistant',
  createdAt: number,
  parentId?: string,
  messageOrder?: number
): TestRow {
  return { id, session_id: session, role, created_at: createdAt, parent_id: parentId, message_order: messageOrder }
}

function assertIds(name: string, rows: TestRow[], expected: string[]) {
  const actual = buildLinkedQaRows(rows).map((item) => item.id)
  if (actual.join(',') !== expected.join(',')) {
    throw new Error(`${name}: expected ${expected.join(',')}, received ${actual.join(',')}`)
  }
}

assertIds('交错会话不能跨会话配对', [
  row('b-a', 'b', 'assistant', 4, 'b-u'),
  row('a-a', 'a', 'assistant', 3, 'a-u'),
  row('b-u', 'b', 'user', 2),
  row('a-u', 'a', 'user', 1),
], ['a-u', 'a-a', 'b-u', 'b-a'])

assertIds('同时间戳按数据库顺序配对', [
  row('a-a', 'a', 'assistant', 10, 'a-u', 4),
  row('b-a', 'b', 'assistant', 10, 'b-u', 3),
  row('b-u', 'b', 'user', 10, undefined, 2),
  row('a-u', 'a', 'user', 10, undefined, 1),
], ['b-u', 'b-a', 'a-u', 'a-a'])

assertIds('分页边界补齐后形成完整问答', [
  row('new-a', 'a', 'assistant', 4, 'new-u'),
  row('old-a', 'b', 'assistant', 3, 'old-u'),
  row('new-u', 'a', 'user', 2),
  row('old-u', 'b', 'user', 1),
], ['old-u', 'old-a', 'new-u', 'new-a'])

assertIds('不完整问答不进入历史', [
  row('orphan-a', 'a', 'assistant', 3),
  row('complete-a', 'b', 'assistant', 2, 'complete-u'),
  row('complete-u', 'b', 'user', 1),
], ['complete-u', 'complete-a'])

assertIds('相邻消息不能覆盖显式父子关系', [
  row('first-u', 'a', 'user', 1),
  row('second-u', 'a', 'user', 2),
  row('first-a', 'a', 'assistant', 3, 'first-u'),
  row('second-a', 'a', 'assistant', 4, 'second-u'),
], ['first-u', 'first-a', 'second-u', 'second-a'])

console.log('AI 历史问答配对检查通过')
