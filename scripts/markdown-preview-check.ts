import assert from 'node:assert/strict'
import { parseMarkdownPreviewInWorker } from '../src/services/markdownPreviewParser'
import { parseMarkdownPreview } from '../src/services/markdownPreviewParserCore'

const markdown = [
  '# 标题',
  '',
  '普通段落与 [安全链接](https://example.com)。',
  '',
  '- [ ] 任务一',
  '- [x] 任务二',
  '',
  '| 名称 | 值 |',
  '| --- | --- |',
  '| A | 1 |',
  '',
  '```ts',
  'const answer = 42',
  '```',
  '',
  String.raw`\[`,
  'x^2 + y_1',
  String.raw`\]`,
  '',
  '```mermaid',
  'graph TD',
  '  A --> B',
  '```',
  '',
  '脚注引用[^note]。',
  '',
  '[^note]: 脚注正文',
  '',
  '<script>alert(1)</script>',
  '',
  '[危险链接](javascript:alert(1))',
].join('\n')

const result = await parseMarkdownPreview(markdown)
assert.ok(result.blocks.length >= 9, '应按顶层 AST 语义节点拆分')
assert.equal(result.blocks[0].startLine, 1)
assert.ok(result.blocks.some((block) => block.startLine === 12 && block.endLine >= 14), '代码块应保留原文行号')
assert.ok(result.blocks.some((block) => block.startLine === 16 && block.endLine >= 18), '公式应保留原文行号')

const serialized = JSON.stringify(result.blocks)
assert.match(serialized, /language-ts/)
assert.match(serialized, /hljs/)
assert.match(serialized, /katex-display/)
assert.match(serialized, /language-mermaid/)
assert.match(serialized, /dataFootnoteRef/)
assert.match(serialized, /<script>alert\(1\)<\/script>/)
assert.doesNotMatch(serialized, /javascript:alert/)

const edited = await parseMarkdownPreview(markdown.replace('普通段落与', '修改后的普通段落与'))
assert.notEqual(edited.blocks[1].key, result.blocks[1].key, '变更块必须生成新键')
assert.equal(edited.blocks[0].key, result.blocks[0].key, '前置未变块必须复用稳定键')
assert.equal(edited.blocks[2].key, result.blocks[2].key, '后置未变块必须复用稳定键')

const shifted = await parseMarkdownPreview(markdown.replace('普通段落与', '新增一行\n普通段落与'))
const originalCode = result.blocks.find((block) => block.startLine === 12)
const shiftedCode = shifted.blocks.find((block) => JSON.stringify(block.tree).includes('language-ts'))
assert.equal(shiftedCode?.key, originalCode?.key, '行号变化不得破坏内容稳定键')
assert.equal(shiftedCode?.startLine, 13, '块行号必须随原文变化')

await assert.rejects(
  parseMarkdownPreviewInWorker('# 无 Worker 环境'),
  /不支持 Web Worker/,
  'Worker 不可用时必须返回可处理的 Promise rejection',
)

console.log('Markdown 预览解析检查通过')
