import assert from 'node:assert/strict'
import { buildSelectionContextWindow } from '../src/services/agent/selectionContext'

function rangeOf(content: string, selected: string) {
  const from = content.indexOf(selected)
  assert.notEqual(from, -1, `未找到测试选区：${selected}`)
  return { from, to: from + selected.length }
}

function chunkContents(content: string, selected: string) {
  const result = buildSelectionContextWindow(content, rangeOf(content, selected), true, 1)
  assert.ok(result, '应当生成选区上下文')
  return result.chunks.map((chunk) => chunk.content)
}

function directionalChunks(
  content: string,
  selected: string,
  direction: 'before' | 'after' | 'both',
  level: 1 | 2 = 1,
) {
  const result = buildSelectionContextWindow(content, rangeOf(content, selected), true, level, direction)
  assert.ok(result, '应当生成定向选区上下文')
  return result.chunks.map((chunk) => ({ role: chunk.role, content: chunk.content }))
}

{
  const content = [
    '# 上一个标题',
    '',
    '上一个标题的正文。',
    '',
    '# 目标标题',
    '',
    '目标标题的第一段正文。',
    '',
    '目标标题的第二段正文。',
  ].join('\n')
  const chunks = chunkContents(content, '# 目标标题')
  assert.deepEqual(chunks, ['目标标题的第一段正文。', '目标标题的第二段正文。'])
}


{
  const content = [
    '# 上一个标题',
    '',
    '与选区高度相关的上文。',
    '',
    '当前选区讨论苹果。',
    '',
    '# 下一个标题',
    '',
    '答案位于语义无关的斑马段落。',
  ].join('\n')
  assert.deepEqual(directionalChunks(content, '当前选区讨论苹果。', 'after'), [
    { role: 'current', content: '当前选区讨论苹果。' },
    { role: 'after', content: '答案位于语义无关的斑马段落。' },
  ])
}

{
  const content = [
    '# 目标标题',
    '',
    '直属正文。',
    '',
    '## 子标题',
    '',
    '子标题正文。',
    '',
    '# 后续标题',
    '',
    '不属于目标标题的正文。',
  ].join('\n')
  assert.deepEqual(directionalChunks(content, '# 目标标题', 'after'), [
    { role: 'current', content: '直属正文。' },
    { role: 'after', content: '子标题正文。' },
  ])
}

{
  const content = ['前文。', '', '当前段落。', '', '后文。'].join('\n')
  assert.deepEqual(directionalChunks(content, '当前段落。', 'before'), [
    { role: 'before', content: '前文。' },
    { role: 'current', content: '当前段落。' },
  ])
}

{
  const first = `第一段${'甲'.repeat(350)}`
  const second = `第二段${'乙'.repeat(350)}`
  const third = `第三段${'丙'.repeat(350)}`
  const content = ['# 标题', '', '当前段落。', '', first, '', second, '', third].join('\n')
  assert.deepEqual(directionalChunks(content, '当前段落。', 'after', 1), [
    { role: 'current', content: '当前段落。' },
    { role: 'after', content: first },
  ])
  assert.deepEqual(directionalChunks(content, '当前段落。', 'after', 2), [
    { role: 'after', content: second },
    { role: 'after', content: third },
  ])
}

{
  const content = ['# 空标题', '', '# 后续标题', '', '后续正文。'].join('\n')
  const result = buildSelectionContextWindow(content, rangeOf(content, '# 空标题'), true, 1, 'after')
  assert.equal(result?.diagnostics.emptyReason, 'heading-without-content')
  assert.deepEqual(result?.chunks, [])
}

{
  const content = [
    '# 上一个标题',
    '',
    '上一个标题的正文。',
    '',
    '# 目标标题',
    '',
    '目标标题的正文。',
  ].join('\n')
  const chunks = chunkContents(content, '目标标题')
  assert.deepEqual(chunks, ['目标标题的正文。'])
}

console.log('selection context checks passed')
