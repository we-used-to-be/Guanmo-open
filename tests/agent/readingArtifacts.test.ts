import { describe, expect, it, vi } from 'vitest'
import {
  decodeReadingArtifact,
  checkReadingArtifactSource,
  decodeAnnotationStructuredContent,
  buildReadingArtifactReferences,
  getAnnotationStructuredContent,
  getReadingArtifactQuestion,
  getReadingArtifactReferences,
  mergeReadingArtifactQuestionMetadata,
  mergeReadingArtifactReferencesMetadata,
  resolveAnnotationPosition,
  computeAnnotationFingerprint,
  findMarkdownBlockByOffset,
  findMarkdownBlockByQuote,
  type ReadingArtifactRow,
} from '@/services/database/readingArtifacts'
import type { ChatMessageSource } from '@/services/ai/types'
import { parseMarkdownBlocks } from '@/services/markdownBlocks'

function baseRow(overrides: Partial<ReadingArtifactRow> = {}): ReadingArtifactRow {
  return {
    id: 'artifact-1',
    type: 'summary',
    title: '匿名摘要',
    content: '这是匿名摘要正文',
    structured_content: null,
    source_file_path: 'C:/anonymous/note.md',
    source_file_name: 'note.md',
    source_content_hash: 'hash-1',
    source_heading_path: '["章节A"]',
    source_start_line: 2,
    source_end_line: 4,
    source_quote: '引用快照',
    source_message_id: 'message-1',
    source_scope: 'document',
    status: 'active',
    created_at: 1700000000,
    updated_at: 1700000001,
    ...overrides,
  }
}

describe('decodeReadingArtifact', () => {
  it('filters displayed saved sources by citations while preserving the complete snapshot', () => {
    const sources = [{ kind: 'memory', memoryId: 'first', content: '汉堡偏好' },
      { kind: 'memory', memoryId: 'second', content: '语言偏好' }]
    const artifact = decodeReadingArtifact(baseRow({ structured_content: JSON.stringify({
      references: sources, sourceCandidates: sources, referencedSourceIds: ['S1'],
    }) }))
    expect(getReadingArtifactReferences(artifact, true)).toEqual([sources[0]])
    expect(getReadingArtifactReferences(artifact)).toEqual(sources)
    const legacy = decodeReadingArtifact(baseRow({ structured_content: JSON.stringify({ references: sources }) }))
    expect(getReadingArtifactReferences(legacy, true)).toEqual(sources)
  })
  it('round-trips memory references as independent content snapshots without document anchors', () => {
    const memory = { kind: 'memory' as const, memoryId: 'anonymous-memory', content: '默认中文回答' }
    const references = buildReadingArtifactReferences([memory, { ...memory }])
    expect(references).toEqual([memory])
    const artifact = decodeReadingArtifact(baseRow({ structured_content: JSON.stringify(mergeReadingArtifactReferencesMetadata(null, references)) }))
    memory.content = '后续已修改'
    expect(getReadingArtifactReferences(artifact)).toEqual([{ kind: 'memory', memoryId: 'anonymous-memory', content: '默认中文回答' }])
  })
  it('解码有效行：含来源锚点、结构化字段与时间戳归一', () => {
    const artifact = decodeReadingArtifact(baseRow({
      structured_content: '{"points":["要点A"]}',
      created_at: 1700000000, // 秒级时间戳
    }))
    expect(artifact.id).toBe('artifact-1')
    expect(artifact.type).toBe('summary')
    expect(artifact.title).toBe('匿名摘要')
    expect(artifact.source?.filePath).toBe('C:/anonymous/note.md')
    expect(artifact.source?.headingPath).toEqual(['章节A'])
    expect(artifact.source?.startLine).toBe(2)
    expect(artifact.source?.endLine).toBe(4)
    expect(artifact.source?.quote).toBe('引用快照')
    expect(artifact.source?.contentHash).toBe('hash-1')
    expect(artifact.source?.scope).toBe('document')
    expect(artifact.structuredContent).toEqual({ points: ['要点A'] })
    // 秒级时间戳应归一为毫秒
    expect(artifact.createdAt).toBe(1700000000000)
  })

  it('毫秒级时间戳保持不变', () => {
    const artifact = decodeReadingArtifact(baseRow({ created_at: 1700000000000 }))
    expect(artifact.createdAt).toBe(1700000000000)
  })

  it('无来源字段时 source 为 null', () => {
    const artifact = decodeReadingArtifact(baseRow({
      source_file_path: null,
      source_file_name: null,
      source_quote: null,
      source_message_id: null,
      source_heading_path: null,
      source_start_line: null,
      source_end_line: null,
      source_content_hash: null,
      source_scope: null,
    }))
    expect(artifact.source).toBeNull()
  })

  it('未知类型抛出可见错误，不静默丢弃', () => {
    expect(() => decodeReadingArtifact(baseRow({ type: 'unknown_type' }))).toThrow(/未知.*类型/)
  })

  it('未知状态抛出可见错误', () => {
    expect(() => decodeReadingArtifact(baseRow({ status: 'deleted' }))).toThrow(/状态/)
  })

  it('未知阅读范围抛出可见错误', () => {
    expect(() => decodeReadingArtifact(baseRow({ source_scope: 'galaxy' }))).toThrow(/scope/)
  })

  it('损坏的 structured_content 抛出可见错误', () => {
    expect(() => decodeReadingArtifact(baseRow({ structured_content: '{not-json' }))).toThrow(/structured_content/)
  })

  it('损坏的 heading_path 抛出可见错误', () => {
    expect(() => decodeReadingArtifact(baseRow({ source_heading_path: '{not-json' }))).toThrow(/heading_path/)
  })

  it('heading_path 非字符串数组抛出错误', () => {
    expect(() => decodeReadingArtifact(baseRow({ source_heading_path: '[1,2]' }))).toThrow(/heading_path/)
  })

  it('所有合法类型均可解码', () => {
    for (const type of ['summary', 'question_set', 'annotation', 'note'] as const) {
      const artifact = decodeReadingArtifact(baseRow({ type }))
      expect(artifact.type).toBe(type)
    }
  })

  it('拒绝已移除的 flashcard_set 类型', () => {
    expect(() => decodeReadingArtifact(baseRow({ type: 'flashcard_set' }))).toThrow(/未知的 reading_artifacts 类型/)
  })
})

describe('阅读成果问题元数据', () => {
  it('为普通成果保存问题且不改动既有结构化字段', () => {
    expect(mergeReadingArtifactQuestionMetadata(
      { points: ['要点A'] },
      '  对应的匿名问题  ',
    )).toEqual({ points: ['要点A'], question: '对应的匿名问题' })
  })

  it('旧成果或空问题保持兼容', () => {
    expect(mergeReadingArtifactQuestionMetadata(null, undefined)).toBeNull()
    expect(mergeReadingArtifactQuestionMetadata({ points: ['要点A'] }, '  ')).toEqual({ points: ['要点A'] })
    expect(getReadingArtifactQuestion(decodeReadingArtifact(baseRow()))).toBeNull()
  })

  it('可从四类成果通用 structured_content 中安全读取问题', () => {
    for (const type of ['summary', 'question_set', 'annotation', 'note'] as const) {
      const artifact = decodeReadingArtifact(baseRow({
        type,
        structured_content: type === 'annotation'
          ? '{"quote":"原文","note":"批注","question":"匿名问题"}'
          : '{"question":"匿名问题"}',
      }))
      expect(getReadingArtifactQuestion(artifact)).toBe('匿名问题')
    }
  })
})

describe('阅读成果参考来源', () => {
  const localSource: ChatMessageSource = {
    kind: 'local',
    filePath: 'C:\\anonymous\\note.md',
    fileName: 'note.md',
    titlePath: ['章节A'],
    heading: '章节A',
    startLine: 2,
    endLine: 4,
  }
  const webSource: ChatMessageSource = {
    kind: 'web',
    title: '匿名网页',
    url: 'https://example.com/anonymous',
    siteName: 'Example',
    publishedAt: '2026-08-10',
  }

  it('按原顺序保存本地与 Web 来源，并按规范化路径/行号和 URL 去重', () => {
    const references = buildReadingArtifactReferences([
      localSource,
      { ...localSource, filePath: 'c:/ANONYMOUS/note.md' },
      { ...localSource, startLine: 8, endLine: 9 },
      webSource,
      { ...webSource, title: '重复标题' },
    ])

    expect(references).toEqual([
      {
        kind: 'local',
        filePath: 'C:\\anonymous\\note.md',
        fileName: 'note.md',
        titlePath: ['章节A'],
        heading: '章节A',
        startLine: 2,
        endLine: 4,
      },
      expect.objectContaining({ kind: 'local', startLine: 8, endLine: 9 }),
      {
        kind: 'web',
        title: '匿名网页',
        url: 'https://example.com/anonymous',
        siteName: 'Example',
        publishedAt: '2026-08-10',
      },
    ])
  })

  it('四类成果均可合并来源，且原问题与批注字段不丢失', () => {
    const references = buildReadingArtifactReferences([localSource, webSource])
    for (const type of ['summary', 'question_set', 'annotation', 'note'] as const) {
      const initial = type === 'annotation'
        ? { quote: '原文', note: '批注正文' }
        : { points: ['要点A'] }
      const structured = mergeReadingArtifactQuestionMetadata(
        mergeReadingArtifactReferencesMetadata(initial, references),
        '匿名问题',
      )
      const artifact = decodeReadingArtifact(baseRow({
        type,
        structured_content: JSON.stringify(structured),
      }))

      expect(getReadingArtifactQuestion(artifact)).toBe('匿名问题')
      expect(getReadingArtifactReferences(artifact)).toEqual(references)
      if (type === 'annotation') {
        expect(getAnnotationStructuredContent(artifact)).toMatchObject({ quote: '原文', note: '批注正文' })
      } else {
        expect(artifact.structuredContent).toMatchObject({ points: ['要点A'] })
      }
    }
  })

  it('无来源写入空数组，旧成果或损坏来源项安全降级', () => {
    expect(mergeReadingArtifactReferencesMetadata(null, [])).toEqual({ references: [] })
    expect(getReadingArtifactReferences(decodeReadingArtifact(baseRow()))).toEqual([])
    const artifact = decodeReadingArtifact(baseRow({
      structured_content: JSON.stringify({
        references: [
          null,
          { kind: 'local', filePath: '', fileName: 'bad.md', startLine: 0, endLine: 0 },
          { kind: 'web', title: '有效来源', url: 'https://example.com/valid' },
        ],
      }),
    }))
    expect(getReadingArtifactReferences(artifact)).toEqual([
      { kind: 'web', title: '有效来源', url: 'https://example.com/valid' },
    ])
  })
})

describe('checkReadingArtifactSource', () => {
  const anchor = {
    filePath: 'C:/anonymous/note.md',
    fileName: 'note.md',
    contentHash: 'hash-1',
    headingPath: ['章节A'],
    startLine: 2,
    endLine: 4,
    quote: '引用快照',
    messageId: null,
    scope: 'document' as const,
  }

  it('哈希匹配时返回 valid', async () => {
    const provider = vi.fn().mockResolvedValue('hash-1')
    const result = await checkReadingArtifactSource(anchor, provider)
    expect(result.status).toBe('valid')
    expect(result.currentHash).toBe('hash-1')
  })

  it('哈希不匹配时返回 changed，不自动贴到相似段落', async () => {
    const provider = vi.fn().mockResolvedValue('hash-2')
    const result = await checkReadingArtifactSource(anchor, provider)
    expect(result.status).toBe('changed')
    expect(result.currentHash).toBe('hash-2')
  })

  it('文件不可读取时返回 missing', async () => {
    const provider = vi.fn().mockResolvedValue(undefined)
    const result = await checkReadingArtifactSource(anchor, provider)
    expect(result.status).toBe('missing')
  })

  it('filePath 缺失时返回 missing', async () => {
    const provider = vi.fn()
    const result = await checkReadingArtifactSource({ ...anchor, filePath: '' }, provider)
    expect(result.status).toBe('missing')
    expect(provider).not.toHaveBeenCalled()
  })

  it('锚点无 contentHash 时只要有文件即视为 valid', async () => {
    const provider = vi.fn().mockResolvedValue('any-hash')
    const result = await checkReadingArtifactSource({ ...anchor, contentHash: null }, provider)
    expect(result.status).toBe('valid')
  })
})

describe('decodeAnnotationStructuredContent', () => {
  it('解码合法批注结构', () => {
    const decoded = decodeAnnotationStructuredContent({
      quote: '被批注的原文',
      note: '这是批注正文',
      question: '对应的匿名问题',
      contextFingerprint: 'fp-1',
      startOffset: 10,
      endOffset: 20,
    })
    expect(decoded.quote).toBe('被批注的原文')
    expect(decoded.note).toBe('这是批注正文')
    expect(decoded.question).toBe('对应的匿名问题')
    expect(decoded.contextFingerprint).toBe('fp-1')
    expect(decoded.startOffset).toBe(10)
    expect(decoded.endOffset).toBe(20)
  })

  it('quote 缺失抛出可见错误，不保存残缺批注', () => {
    expect(() => decodeAnnotationStructuredContent({ note: '正文' })).toThrow(/quote/)
  })

  it('note 缺失抛出可见错误', () => {
    expect(() => decodeAnnotationStructuredContent({ quote: '原文' })).toThrow(/note/)
  })

  it('非对象抛出可见错误', () => {
    expect(() => decodeAnnotationStructuredContent('not-object')).toThrow(/对象/)
    expect(() => decodeAnnotationStructuredContent(null)).toThrow(/对象/)
  })

  it('offset 非有限数时归一为 null', () => {
    const decoded = decodeAnnotationStructuredContent({
      quote: '原文',
      note: '正文',
      startOffset: 'bad',
      endOffset: NaN,
    })
    expect(decoded.startOffset).toBeNull()
    expect(decoded.endOffset).toBeNull()
  })

  it('annotation 行经 decodeReadingArtifact 后可由 getAnnotationStructuredContent 取出', () => {
    const artifact = decodeReadingArtifact(baseRow({
      type: 'annotation',
      structured_content: '{"quote":"原文","note":"批注正文","contextFingerprint":"fp"}',
    }))
    const annotation = getAnnotationStructuredContent(artifact)
    expect(annotation?.quote).toBe('原文')
    expect(annotation?.note).toBe('批注正文')
  })

  it('损坏的 annotation structured_content 经 getAnnotationStructuredContent 安全降级为 null', () => {
    const artifact = decodeReadingArtifact(baseRow({
      type: 'annotation',
      structured_content: '{"note":"缺 quote"}',
    }))
    expect(getAnnotationStructuredContent(artifact)).toBeNull()
  })

  it('非批注类型 getAnnotationStructuredContent 返回 null', () => {
    const artifact = decodeReadingArtifact(baseRow({ type: 'summary' }))
    expect(getAnnotationStructuredContent(artifact)).toBeNull()
  })
})

describe('Markdown 块定位（虚拟预览安全）', () => {
  const content = '# 标题\n\n第一段正文内容。\n\n## 子标题\n\n第二段内容。\n'

  it('findMarkdownBlockByOffset 按 offset 命中正确顶层块', () => {
    const blocks = parseMarkdownBlocks(content)
    // 标题块起始 offset = 0
    const heading = findMarkdownBlockByOffset(blocks, 0)
    expect(heading?.type).toBe('heading')
    // 第一段正文 offset 在标题之后
    const paraStart = content.indexOf('第一段')
    const paragraph = findMarkdownBlockByOffset(blocks, paraStart)
    expect(paragraph?.type).toBe('paragraph')
    expect(paragraph?.rawSource).toContain('第一段正文内容')
  })

  it('findMarkdownBlockByOffset 超出范围返回 null', () => {
    const blocks = parseMarkdownBlocks(content)
    expect(findMarkdownBlockByOffset(blocks, 9999)).toBeNull()
    expect(findMarkdownBlockByOffset(blocks, -1)).toBeNull()
  })

  it('findMarkdownBlockByQuote 按引用快照命中块', () => {
    const blocks = parseMarkdownBlocks(content)
    const block = findMarkdownBlockByQuote(blocks, '第一段正文内容。')
    expect(block?.type).toBe('paragraph')
    expect(block?.rawSource).toContain('第一段')
  })

  it('findMarkdownBlockByQuote 未命中返回 null', () => {
    const blocks = parseMarkdownBlocks(content)
    expect(findMarkdownBlockByQuote(blocks, '完全不存在的引用文本xyz')).toBeNull()
  })

  it('computeAnnotationFingerprint 对同一块返回稳定指纹', () => {
    const paraStart = content.indexOf('第一段')
    const fp1 = computeAnnotationFingerprint(content, paraStart)
    const fp2 = computeAnnotationFingerprint(content, paraStart + 2)
    expect(fp1).toBeTruthy()
    expect(fp1).toBe(fp2)
  })

  it('computeAnnotationFingerprint 越界返回 null', () => {
    expect(computeAnnotationFingerprint('', 0)).toBeNull()
    expect(computeAnnotationFingerprint(content, 9999)).toBeNull()
  })
})

describe('resolveAnnotationPosition', () => {
  const content = '# 概念\n\n批注目标段落原文。\n\n## 其他\n\n无关内容。\n'

  it('按原始 offset 命中块并返回行号与 renderKey', () => {
    const startOffset = content.indexOf('批注目标段落原文')
    const fingerprint = computeAnnotationFingerprint(content, startOffset)
    const annotation = {
      quote: '批注目标段落原文',
      note: '批注',
      contextFingerprint: fingerprint,
      startOffset,
      endOffset: startOffset + 8,
    }
    const position = resolveAnnotationPosition(content, annotation, null)
    expect(position).not.toBeNull()
    expect(position?.matchedBy).toBe('offset')
    expect(position?.renderKey).toBeTruthy()
    expect(position?.startLine).toBeGreaterThan(0)
  })

  it('块指纹不一致时回退到 quote 重新命中', () => {
    const startOffset = content.indexOf('批注目标段落原文')
    const annotation = {
      quote: '批注目标段落原文',
      note: '批注',
      contextFingerprint: 'stale-fingerprint',
      startOffset,
      endOffset: null,
    }
    const position = resolveAnnotationPosition(content, annotation, null)
    expect(position?.matchedBy).toBe('quote')
  })

  it('offset 与 quote 都失效时回退到锚点行号', () => {
    const annotation = {
      quote: '不存在的引用xyz',
      note: '批注',
      startOffset: 9999,
      endOffset: null,
    }
    const anchor = {
      filePath: 'C:/anonymous/note.md',
      fileName: 'note.md',
      startLine: 3,
      endLine: 3,
    }
    const position = resolveAnnotationPosition(content, annotation, anchor)
    expect(position?.matchedBy).toBe('fallback')
    expect(position?.startLine).toBe(3)
    expect(position?.renderKey).toBe('')
  })

  it('内容为空且无锚点行号时返回 null', () => {
    const annotation = { quote: '原文', note: '批注', startOffset: 5, endOffset: null }
    expect(resolveAnnotationPosition('', annotation, null)).toBeNull()
  })

  it('批注不修改源 Markdown：定位为纯函数，不写回 content', () => {
    const startOffset = content.indexOf('批注目标段落原文')
    const annotation = {
      quote: '批注目标段落原文',
      note: '批注',
      startOffset,
      endOffset: null,
    }
    const before = content
    resolveAnnotationPosition(content, annotation, null)
    expect(content).toBe(before)
  })
})
