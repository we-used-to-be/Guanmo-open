import { describe, expect, it } from 'vitest'
import {
  buildDocumentRangeInfo,
  buildDomRangesForSourceRange,
  createSourceOffsetAnnotator,
  collectAnnotatedTextNodes,
  domPointToSourceOffset,
  findWordRangeAt,
  getTextForSourceRange,
} from '@/services/previewHighlight'
import { createMarkdownPreviewModel, searchVisibleText } from '@/services/markdownPreviewModel'

function renderAnnotated(container: HTMLElement, tree: unknown): void {
  // 最小 HAST → DOM 序列化：仅覆盖测试所需的 element/text 两类节点
  const build = (node: any, parent: Node) => {
    if (node.type === 'text') {
      parent.appendChild(document.createTextNode(node.value))
      return
    }
    const element = document.createElement(node.tagName ?? 'span')
    for (const [key, value] of Object.entries(node.properties ?? {})) {
      element.setAttribute(key.replace(/([A-Z])/g, (c) => `-${c.toLowerCase()}`), String(value))
    }
    for (const child of node.children ?? []) build(child, element)
    parent.appendChild(element)
  }
  build(tree, container)
}

describe('previewHighlight 统一 DocumentRange 基础设施', () => {
  it('buildDocumentRangeInfo：全局 offset → 块 ID + 局部 offset', () => {
    const model = createMarkdownPreviewModel('# 标题\n\n第一段文本\n\n第二段文本')
    const firstParagraph = model.blocks.find((b) => b.rawSource.includes('第一段'))
    const secondParagraph = model.blocks.find((b) => b.rawSource.includes('第二段'))
    if (!firstParagraph || !secondParagraph) throw new Error('fixture 解析失败')

    const info = buildDocumentRangeInfo(
      model,
      firstParagraph.startOffset + 3,
      secondParagraph.startOffset + 5,
    )
    if (!info) throw new Error('range 构建失败')
    expect(info.range.startBlockId).toBe(firstParagraph.blockId)
    expect(info.range.startOffset).toBe(3)
    expect(info.range.endBlockId).toBe(secondParagraph.blockId)
    expect(info.range.endOffset).toBe(5)
  })

  it('getTextForSourceRange：跨块提取渲染可见文本，不受 DOM 挂载影响', () => {
    const model = createMarkdownPreviewModel('# 标题\n\n**加粗**文本\n\n第二段内容')
    const first = model.blocks.find((b) => b.rawSource.includes('加粗'))
    const second = model.blocks.find((b) => b.rawSource.includes('第二段'))
    if (!first || !second) throw new Error('fixture 解析失败')

    // 选区覆盖"加粗文本"的后半 + 整个第二段
    const from = first.startOffset + first.rawSource.indexOf('文本')
    const to = second.endOffset
    const text = getTextForSourceRange(model, from, to)
    expect(text).toContain('文本')
    expect(text).toContain('第二段内容')
    expect(text).not.toContain('**')
  })

  it('findWordRangeAt：Unicode 词边界扩展', () => {
    const model = createMarkdownPreviewModel('Hello 观墨世界 Markdown')
    const offset = model.rawContent.indexOf('观墨')
    const word = findWordRangeAt(model, offset + 1)
    if (!word) throw new Error('选词失败')
    expect(model.rawContent.slice(word.from, word.to)).toBe('观墨世界')
  })

  it('annotator：仅标注携带精确 position 的 text，无 position 子树跳过', () => {
    const tree = {
      type: 'element',
      tagName: 'p',
      children: [
        { type: 'text', value: '精确文本', position: { start: { offset: 10 }, end: { offset: 14 } } },
        { type: 'text', value: '重建文本' },
      ],
    }
    const transform = (createSourceOffsetAnnotator(100) as any)()
    transform(tree)
    const first = tree.children[0]
    expect(first.tagName).toBe('span')
    expect(first.properties.dataGmSrcFrom).toBe(110)
    expect(first.properties.dataGmSrcTo).toBe(114)
    // 无 position 的 text（KaTeX/highlight 重建子树）保持原样
    expect(tree.children[1].type).toBe('text')
  })

  it('DOM ↔ 源码 offset：domPointToSourceOffset 与 buildDomRangesForSourceRange 一致', () => {
    const container = document.createElement('div')
    const tree = {
      type: 'element',
      tagName: 'p',
      children: [
        { type: 'text', value: '前文', position: { start: { offset: 0 }, end: { offset: 2 } } },
        { type: 'text', value: '目标文本', position: { start: { offset: 2 }, end: { offset: 6 } } },
        { type: 'text', value: '后文', position: { start: { offset: 6 }, end: { offset: 8 } } },
      ],
    }
    const transform = (createSourceOffsetAnnotator(0) as any)()
    transform(tree)
    renderAnnotated(container, tree)
    document.body.appendChild(container)

    const annotated = collectAnnotatedTextNodes(container)
    expect(annotated).toHaveLength(3)

    // caret → 源码 offset（等长映射）
    const targetNode = annotated[1].node
    expect(domPointToSourceOffset(targetNode, 0)).toBe(2)
    expect(domPointToSourceOffset(targetNode, 4)).toBe(6)
    expect(domPointToSourceOffset(container.firstElementChild!, 0)).toBe(0)

    // 源码区间 → DOM Range（目标区间命中第二段）
    const ranges = buildDomRangesForSourceRange(container, 3, 5)
    expect(ranges).toHaveLength(1)
    expect(ranges[0].startContainer).toBe(targetNode)
    expect(ranges[0].startOffset).toBe(1)
    expect(ranges[0].endOffset).toBe(3)
    document.body.removeChild(container)
  })

  it('inlineCode：DOM caret 使用去反引号后的源码 value 区间', () => {
    const source = '你好呀`openstore`好的'
    const tree = {
      type: 'element',
      tagName: 'p',
      children: [
        { type: 'text', value: '你好呀', position: { start: { offset: 0 }, end: { offset: 3 } } },
        {
          type: 'element',
          tagName: 'code',
          children: [{ type: 'text', value: 'openstore', position: { start: { offset: 3 }, end: { offset: 14 } } }],
        },
        { type: 'text', value: '好的', position: { start: { offset: 14 }, end: { offset: 16 } } },
      ],
    }
    const transform = (createSourceOffsetAnnotator(0, source) as any)()
    transform(tree)

    const container = document.createElement('div')
    renderAnnotated(container, tree)
    document.body.appendChild(container)
    const annotated = collectAnnotatedTextNodes(container)
    const codeNode = annotated[1].node

    expect(annotated[1].from).toBe(4)
    expect(annotated[1].to).toBe(13)
    expect(domPointToSourceOffset(codeNode, 4)).toBe(8)
    expect(domPointToSourceOffset(codeNode, 9)).toBe(13)

    const model = createMarkdownPreviewModel(source)
    expect(getTextForSourceRange(model, 8, 13)).toBe('store')
    expect(getTextForSourceRange(model, 2, 6)).toBe('呀op')
    expect(getTextForSourceRange(model, 11, 15)).toBe('re好')
    document.body.removeChild(container)
  })

  it('非等长文本：转义符与实体使用可见文本边界映射源码 offset', () => {
    const source = 'a\\*openstore\\*z'
    const tree = {
      type: 'element',
      tagName: 'p',
      children: [{ type: 'text', value: 'a*openstore*z', position: { start: { offset: 0 }, end: { offset: source.length } } }],
    }
    const transform = (createSourceOffsetAnnotator(0, source) as any)()
    transform(tree)

    const container = document.createElement('div')
    renderAnnotated(container, tree)
    document.body.appendChild(container)
    const escapedNode = collectAnnotatedTextNodes(container)[0].node
    expect(domPointToSourceOffset(escapedNode, 2)).toBe(3)
    expect(domPointToSourceOffset(escapedNode, 12)).toBe(14)
    document.body.removeChild(container)

    const entitySource = 'a &amp; openstore'
    const entityTree = {
      type: 'element',
      tagName: 'p',
      children: [{ type: 'text', value: 'a & openstore', position: { start: { offset: 0 }, end: { offset: entitySource.length } } }],
    }
    const entityTransform = (createSourceOffsetAnnotator(0, entitySource) as any)()
    entityTransform(entityTree)
    const entityContainer = document.createElement('div')
    renderAnnotated(entityContainer, entityTree)
    document.body.appendChild(entityContainer)
    const entityNode = collectAnnotatedTextNodes(entityContainer)[0].node
    expect(domPointToSourceOffset(entityNode, 3)).toBe(7)
    const entityRanges = buildDomRangesForSourceRange(entityContainer, 2, 7)
    expect(entityRanges).toHaveLength(1)
    expect(entityRanges[0].startOffset).toBe(2)
    expect(entityRanges[0].endOffset).toBe(3)
    document.body.removeChild(entityContainer)

    const model = createMarkdownPreviewModel(entitySource)
    expect(getTextForSourceRange(model, 2, 7)).toBe('&')
    expect(getTextForSourceRange(model, 7, entitySource.length)).toBe(' openstore')
    expect(searchVisibleText(model, '&')).toEqual([{ from: 2, to: 7, blockIndex: 0 }])

    const emojiSource = 'a &#x1F600; openstore'
    const emojiTree = {
      type: 'element',
      tagName: 'p',
      children: [{ type: 'text', value: 'a 😀 openstore', position: { start: { offset: 0 }, end: { offset: emojiSource.length } } }],
    }
    const emojiTransform = (createSourceOffsetAnnotator(0, emojiSource) as any)()
    emojiTransform(emojiTree)
    const emojiContainer = document.createElement('div')
    renderAnnotated(emojiContainer, emojiTree)
    document.body.appendChild(emojiContainer)
    const emojiNode = collectAnnotatedTextNodes(emojiContainer)[0].node
    expect(domPointToSourceOffset(emojiNode, 4)).toBe(11)
    const emojiRanges = buildDomRangesForSourceRange(emojiContainer, 2, 11)
    expect(emojiRanges).toHaveLength(1)
    expect(emojiRanges[0].startOffset).toBe(2)
    expect(emojiRanges[0].endOffset).toBe(4)
    document.body.removeChild(emojiContainer)

    const emojiModel = createMarkdownPreviewModel(emojiSource)
    expect(getTextForSourceRange(emojiModel, 2, 11)).toBe('😀')
    expect(searchVisibleText(emojiModel, '😀')).toEqual([{ from: 2, to: 11, blockIndex: 0 }])

    const htmlSource = 'a <span>&amp; openstore</span> z'
    const htmlModel = createMarkdownPreviewModel(htmlSource)
    const htmlBlock = htmlModel.blocks[0]
    expect(htmlBlock).toBeDefined()
    expect(getTextForSourceRange(htmlModel, htmlBlock.startOffset, htmlBlock.endOffset)).toBe('a & openstore z')
  })

  it('inlineCode：换行规范化后仍保持源码边界映射', () => {
    const source = '`open\nstore`'
    const tree = {
      type: 'element',
      tagName: 'p',
      children: [{
        type: 'element',
        tagName: 'code',
        children: [{ type: 'text', value: 'open store', position: { start: { offset: 0 }, end: { offset: source.length } } }],
      }],
    }
    const transform = (createSourceOffsetAnnotator(0, source) as any)()
    transform(tree)
    const container = document.createElement('div')
    renderAnnotated(container, tree)
    document.body.appendChild(container)
    const codeNode = collectAnnotatedTextNodes(container)[0].node
    expect(domPointToSourceOffset(codeNode, 4)).toBe(5)
    expect(domPointToSourceOffset(codeNode, 5)).toBe(6)
    expect(domPointToSourceOffset(codeNode, 10)).toBe(11)

    const model = createMarkdownPreviewModel(source)
    expect(getTextForSourceRange(model, 1, 11)).toBe('open\nstore')
    document.body.removeChild(container)
  })
})
