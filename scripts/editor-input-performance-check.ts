import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { readFileSync } from 'node:fs'
import { DeferredContentEmitter } from '@/services/editorInputBuffer'

const codeMirrorSource = readFileSync('src/components/editor/CodeMirrorEditor.tsx', 'utf8')
const editorAreaSource = readFileSync('src/components/editor/EditorArea.tsx', 'utf8')
const updateListener = codeMirrorSource.match(/const updateListener[\s\S]*?const state = EditorState\.create/)?.[0] ?? ''

assert.ok(updateListener, '应能定位 CodeMirror update listener')
assert.doesNotMatch(updateListener, /doc\.toString\(\)/, '逐键 update listener 不得同步序列化全文')
assert.match(codeMirrorSource, /inputBuffer\.flush\(\)[\s\S]*view\.destroy\(\)/, '销毁编辑器前必须刷新草稿')
assert.match(editorAreaSource, /const handleSave[\s\S]*useEditorStore\.getState\(\)/, '保存必须读取刷新后的最新 store 内容')
assert.match(editorAreaSource, /const previewToc = useMemo\(\(\) => extractToc\(activePreview\.content\), \[activePreview\.content\]\)/, '预览 TOC 应基于延迟后的内容派生')
assert.match(editorAreaSource, /const editorToc = useMemo\(\(\) => extractToc\(activeTab\?\.content \|\| ''\), \[activeTab\?\.content\]\)/, '编辑 TOC 不得依赖未挂载的预览')
assert.match(editorAreaSource, /const toc = viewMode === 'edit' \? editorToc : previewToc/, '目录必须按当前模式选择内容来源')
assert.match(editorAreaSource, /const modeDerivationsEnabled = viewMode !== 'edit'/, '纯编辑模式不得计算预览签名和 diff 行数')

for (const size of [50_000, 200_000]) {
  let serialized = 0
  let emitted = ''
  const emitter = new DeferredContentEmitter<{ content: string }>(
    (value) => {
      serialized += 1
      return value.content
    },
    (content) => { emitted = content }
  )
  const base = '# heading\n'.padEnd(size, 'x')
  const startedAt = performance.now()
  for (let index = 0; index < 100; index += 1) {
    emitter.push({ content: `${base}${index}` }, size + String(index).length)
  }
  const schedulingMs = performance.now() - startedAt
  assert.equal(serialized, 0, `${size} 文档逐键阶段不得序列化全文`)
  emitter.flush()
  assert.equal(serialized, 1, `${size} 文档一批输入只允许一次全文序列化`)
  assert.ok(emitted.endsWith('99'))
  assert.ok(schedulingMs < 100, `${size} 文档 100 次输入调度耗时异常：${schedulingMs.toFixed(1)}ms`)
  emitter.dispose()
  console.log(`${size} chars: 100 updates scheduled in ${schedulingMs.toFixed(1)}ms, serializations=${serialized}`)
}

console.log('editor input performance checks passed')
