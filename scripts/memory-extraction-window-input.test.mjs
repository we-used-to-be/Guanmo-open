import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildExperimentalWindow, validateExperimentalSources } from './memory-extraction-window-input.mjs'

const u = (id, sequence, visibleText, extra = {}) => ({ id, sequence, role: 'user', sessionId: 'S', scope: 'P', visibleText, ...extra })
const a = (id, sequence, parentId, visibleText, extra = {}) => ({ id, sequence, role: 'assistant', sessionId: 'S', scope: 'P', parentId, visibleText, ...extra })
const build = messages => buildExperimentalWindow(messages, { sessionId: 'S', scope: 'P' })

test('keeps continuous user options, assistant response and decision without value-keyword filtering', () => {
  const result = build([u('u1', 1, '项目数据库在SQLite和PostgreSQL里选。'), a('a2', 2, 'u1', '前者适合本地，后者适合服务端。'), u('u3', 3, '定第二个，后续项目都这样。')])
  assert.equal(result.status, 'ready')
  assert.deepEqual(result.window.map(item => item.id), ['u1', 'a2', 'u3'])
  assert.equal(result.window[1].parentId, 'u1')
})
test('replaces sensitive, refused, explicit and quoted inputs with gaps and never falls back to raw text', () => {
  const messages = [u('u1', 1, '我的密码是匿名口令'), a('a2', 2, 'u1', '我看到了'),
    u('u3', 3, '不要记住我的偏好'), u('u4', 4, '记住：以后先给结论'), u('u5', 5, '翻译：我喜欢早起')]
  const result = build(messages)
  const serialized = JSON.stringify(result)
  for (const text of messages.map(item => item.visibleText)) assert.equal(serialized.includes(text), false)
  assert.deepEqual(result.window.map(item => item.gap), ['sensitive', 'parent_gap', 'refusal', 'explicit', 'transformation'])
  assert.throws(() => build([{ id: 'x', sequence: 1, role: 'user', sessionId: 'S', scope: 'P', content: '原始附件正文' }]), /missing visible text/)
})
test('rejects scope or session mixing and orphan assistant messages', () => {
  assert.throws(() => build([u('x', 1, '普通对话', { scope: 'Q' })]), /boundary/)
  assert.throws(() => build([u('x', 1, '普通对话', { sessionId: 'T' })]), /boundary/)
  assert.throws(() => build([a('a', 1, 'missing', '建议')]), /parent/)
})
test('reports oversized turns without sending a truncated evidence window', () => {
  const result = build([u('u1', 1, '普通文字'.repeat(2000))])
  assert.deepEqual(result, { status: 'oversize', window: null })
  assert.deepEqual(buildExperimentalWindow([u('u1', 1, '普通对话')], { sessionId: 'S', scope: 'P', maxBytes: 5 }), { status: 'oversize', window: null })
})
test('requires real visible user primary and treats valid IDs as needing semantic review', () => {
  const window = build([u('u1', 1, '项目需要选择方案。'), a('a2', 2, 'u1', '我建议甲。'), u('u3', 3, '我还没决定。'),
    u('u4', 4, '我的密码是匿名口令')]).window
  const results = validateExperimentalSources(window, [
    { primarySourceId: 'a2', supportingSourceIds: [] },
    { primarySourceId: 'u3', supportingSourceIds: ['u4'] },
    { primarySourceId: 'u3', supportingSourceIds: ['a2'] },
    { primarySourceId: 'u1', supportingSourceIds: ['a2'] },
  ])
  assert.deepEqual(results, [{ valid: false, reason: 'invalid_primary' }, { valid: false, reason: 'invalid_support' },
    { valid: true, needsReview: true }, { valid: false, reason: 'invalid_support' }])
})
