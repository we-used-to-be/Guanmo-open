import assert from 'node:assert/strict'
import { shouldUseAgent } from '../src/services/agent/executor'
import { shouldIncludeFullDocumentContext } from '../src/services/agent/intentDetector'
import { prepareChatHistoryForModel } from '../src/services/aiChatMessages'
import { shouldTriggerScopedRag } from '../src/services/aiChatFlow'
import { registerTool } from '../src/services/agent/toolRegistry'
import { hideLikelyToolJsonPrefix, parseToolCall, stripToolCallJson } from '../src/services/agent/toolCallParser'
import { resolveAnchoredReplacementRange } from '../src/services/agent/editTarget'

registerTool({
  name: 'search_knowledge',
  description: 'test search tool',
  parameters: [],
  execute: async () => 'ok',
})

const pureJson = parseToolCall('{"tool":"search_knowledge","args":{"query":"RAG"}}')
assert.equal(pureJson?.name, 'search_knowledge')
assert.deepEqual(pureJson?.args, { query: 'RAG' })

const fencedJson = parseToolCall('```json\n{"tool":"search_knowledge","args":{"query":"notes"}}\n```')
assert.equal(fencedJson?.name, 'search_knowledge')
assert.deepEqual(fencedJson?.args, { query: 'notes' })

const embeddedJson = parseToolCall('先搜索：{"tool":"search_knowledge","args":{"query":"scope"}} 然后回答')
assert.equal(embeddedJson?.name, 'search_knowledge')
assert.deepEqual(embeddedJson?.args, { query: 'scope' })

const editConfirmation = parseToolCall('{"needsEditConfirmation":true,"path":"D:/notes/current.md","oldText":"旧","newText":"新"}')
assert.equal(editConfirmation?.name, 'replace_current_tab_text')
assert.deepEqual(editConfirmation?.args, { oldText: '旧', newText: '新', path: 'D:/notes/current.md' })

const fileEditConfirmation = parseToolCall('{"needsEditConfirmation":true,"path":"D:/notes/a.md","oldText":"旧","newText":"新"}')
assert.equal(fileEditConfirmation?.name, 'replace_current_tab_text')
assert.deepEqual(fileEditConfirmation?.args, { oldText: '旧', newText: '新', path: 'D:/notes/a.md' })

const wholeFileEditConfirmation = parseToolCall('{"needsEditConfirmation":true,"path":"D:/notes/a.md","replaceWholeDocument":true,"newText":"整篇新稿"}')
assert.equal(wholeFileEditConfirmation?.name, 'replace_current_tab_text')
assert.deepEqual(wholeFileEditConfirmation?.args, {
  newText: '整篇新稿',
  path: 'D:/notes/a.md',
  replaceWholeDocument: true,
})

assert.equal(parseToolCall('{"tool":'), null)
assert.equal(parseToolCall('普通回答'), null)

assert.equal(
  stripToolCallJson('说明\n```json\n{"tool":"search_knowledge","args":{"query":"RAG"}}\n```\n结束'),
  '说明\n\n结束'
)

assert.equal(hideLikelyToolJsonPrefix('{"tool":"search_knowledge","args":'), '')
assert.equal(hideLikelyToolJsonPrefix('普通流式回答'), '普通流式回答')

assert.equal(shouldUseAgent('你好', 0), false)
assert.equal(shouldUseAgent('总结这个文件', 1), true)
assert.equal(shouldUseAgent('总结这几个文件', 3), true)
assert.equal(shouldUseAgent('搜索本地文档里的 RAG 配置', 0), true)
assert.equal(shouldUseAgent('记住我喜欢简洁回答', 0), true)
assert.equal(shouldUseAgent('添加记忆 我偏好中文回答', 0), true)
assert.equal(shouldUseAgent('保存记忆 我喜欢先看结论', 0), true)
assert.equal(shouldUseAgent('我的地址是什么', 0), true)
assert.equal(shouldUseAgent('把这段话润色一下', 1), true)
assert.equal(shouldUseAgent('覆写整个文件为新的版本', 1), true)
assert.equal(shouldUseAgent('请调整这个文件的结构', 1), true)
assert.equal(shouldUseAgent('再简洁些', 0), false)
assert.equal(shouldUseAgent('再简洁些', 0, true), true)
assert.equal(shouldUseAgent('语气柔和一些', 0, true), true)
assert.equal(shouldUseAgent('更详细一点', 0, true), true)
assert.equal(shouldUseAgent('对比这两个文件的差异', 2), true)
assert.equal(shouldIncludeFullDocumentContext('把整篇文章重写一下'), true)
assert.equal(shouldIncludeFullDocumentContext('请对这篇文章整体润色'), true)
assert.equal(shouldIncludeFullDocumentContext('把这段话润色一下'), false)

const fileContextTag = {
  id: 'file-1',
  type: 'file' as const,
  title: 'notes.md',
  filePath: 'D:/notes/notes.md',
  content: null,
  preview: 'notes.md',
}
assert.equal(shouldTriggerScopedRag('总结这个文件', [fileContextTag]), true)
assert.equal(shouldTriggerScopedRag('你好', [fileContextTag]), false)
assert.equal(shouldTriggerScopedRag('总结这个文件', []), false)

const preparedHistory = prepareChatHistoryForModel([
  {
    role: 'user',
    content: '总结旧文件\n\n【当前文档上下文】\n\n[上下文1: old.md]\n---\n旧文件全文',
    displayContent: '总结旧文件',
  },
  {
    role: 'assistant',
    content: '旧文件摘要',
  },
  {
    role: 'user',
    content: '[系统] 用户确认并应用了文本修改。',
    hidden: true,
  },
])

assert.deepEqual(preparedHistory, [
  { role: 'user', content: '总结旧文件' },
  { role: 'assistant', content: '旧文件摘要' },
  { role: 'user', content: '[系统] 用户确认并应用了文本修改。' },
])

const duplicateText = '这是重点\n中间内容\n这是重点'
assert.deepEqual(resolveAnchoredReplacementRange(duplicateText, '这是重点', { from: 10, to: 14 }), {
  from: 10,
  to: 14,
})
assert.equal(resolveAnchoredReplacementRange(duplicateText, '不存在', { from: 10, to: 14 }), null)
assert.deepEqual(resolveAnchoredReplacementRange('这是重点\n中间内容\n新的更长重点', '新的更长重点', { from: 10, to: 14 }, { from: 10, to: 16 }), {
  from: 10,
  to: 16,
})

console.log('agent tool parser checks passed')
