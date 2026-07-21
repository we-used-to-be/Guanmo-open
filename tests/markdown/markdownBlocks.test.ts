import { describe, expect, it } from 'vitest'
import {
  parseMarkdownBlocks,
  replaceMarkdownBlock,
  type MarkdownBlock,
} from '@/services/markdownBlocks'

function blockBySource(content: string, needle: string): MarkdownBlock {
  const block = parseMarkdownBlocks(content).find((item) => item.rawSource.includes(needle))
  if (!block) throw new Error(`未找到 Markdown 块：${needle}`)
  return block
}

describe('parseMarkdownBlocks', () => {
  it('按完整 Markdown 块返回原始源码范围', () => {
    const content = [
      '---',
      'title: 示例',
      '---',
      '',
      '# 标题',
      '',
      '第一行',
      '第二行',
      '',
      '- 项目',
      '  - 嵌套项目',
      '',
      '> 引用',
      '> 第二行',
      '',
      '```ts',
      'const value = 1',
      '```',
      '',
      '```mermaid',
      'graph TD',
      'A-->B',
      '```',
      '',
      '$$',
      'x^2',
      '$$',
      '',
      '| A | B |',
      '| - | - |',
      '| 1 | 2 |',
      '',
      '<section>HTML</section>',
      '',
      '---',
    ].join('\n')

    const blocks = parseMarkdownBlocks(content)

    expect(blocks.map((block) => block.type)).toEqual([
      'frontmatter',
      'heading',
      'paragraph',
      'list',
      'blockquote',
      'code',
      'mermaid',
      'math',
      'table',
      'html',
      'thematicBreak',
    ])
    for (const block of blocks) {
      expect(content.slice(block.startOffset, block.endOffset)).toBe(block.rawSource)
      expect(block.startLine).toBeGreaterThan(0)
      expect(block.endLine).toBeGreaterThanOrEqual(block.startLine)
      expect(block.renderKey).toMatch(/^md-block-/)
    }
    expect(blockBySource(content, '第一行').rawSource).toBe('第一行\n第二行')
    expect(blockBySource(content, '- 项目').rawSource).toBe('- 项目\n  - 嵌套项目')
  })

  it('保留图片、任务列表、行内公式与无结尾换行的源码', () => {
    const content = '![图](assets/a.png)\n\n- [ ] 待办\n\n行内公式 $x+1$'

    const blocks = parseMarkdownBlocks(content)

    expect(blocks.map((block) => block.type)).toEqual(['image', 'list', 'paragraph'])
    expect(blocks.at(-1)?.rawSource).toBe('行内公式 $x+1$')
    expect(blocks.at(-1)?.endOffset).toBe(content.length)
  })

  it('使用原始 CRLF offset 且不吞掉连续空行', () => {
    const content = '# 标题\r\n\r\n\r\n多行\r\n段落\r\n\r\n尾部'
    const blocks = parseMarkdownBlocks(content)

    expect(blocks[1].rawSource).toBe('多行\r\n段落')
    expect(blocks[1].startOffset).toBe(content.indexOf('多行'))
    expect(content.slice(blocks[0].endOffset, blocks[1].startOffset)).toBe('\r\n\r\n\r\n')
  })

  it('可解析超长单段和十万字文档而不切成视觉行', () => {
    const longParagraph = '观墨'.repeat(20_000)
    const content = `${longParagraph}\n\n${'# 标题\n\n正文\n\n'.repeat(6_000)}`
    const blocks = parseMarkdownBlocks(content)

    expect(blocks[0].type).toBe('paragraph')
    expect(blocks[0].rawSource).toBe(longParagraph)
    expect(content.length).toBeGreaterThan(100_000)
    expect(blocks.length).toBe(12_001)
  })
})

describe('replaceMarkdownBlock', () => {
  it('只按 offset 替换目标块并完整保留 CRLF 和空行', () => {
    const content = '# 标题\r\n\r\n\r\n原段落\r\n第二行\r\n\r\n尾部'
    const block = blockBySource(content, '原段落')

    expect(replaceMarkdownBlock(content, block, '新段落')).toEqual({
      status: 'applied',
      content: '# 标题\r\n\r\n\r\n新段落\r\n\r\n尾部',
    })
  })

  it('目标切片变化时保留 draft 并报告冲突', () => {
    const original = '# 标题\n\n原段落'
    const block = blockBySource(original, '原段落')
    const externallyChanged = '# 标题\n\nAI 已修改'

    expect(replaceMarkdownBlock(externallyChanged, block, '我的草稿')).toEqual({
      status: 'conflict',
      draft: '我的草稿',
      currentSource: 'AI ',
    })
  })
})
