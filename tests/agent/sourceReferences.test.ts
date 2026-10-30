import { describe, expect, it } from 'vitest'
import {
  createSourceReferenceRegistry,
  normalizeSafeWebSourceUrl,
  parseSourceReferences,
  registerSourceReferences,
  resolveStoredSourceReferences,
} from '@/services/ai/sourceReferences'
import type { ChatMessageSource } from '@/services/ai/types'

const localSource: ChatMessageSource = {
  kind: 'local',
  filePath: 'C:\\anonymous\\note.md',
  fileName: 'note.md',
  titlePath: ['章节A'],
  startLine: 2,
  endLine: 4,
}

const webSource: ChatMessageSource = {
  kind: 'web',
  title: '匿名网页',
  url: 'https://example.com/anonymous',
}

describe('source reference registry', () => {
  it('deduplicates memory snapshots and keeps them visible alongside cited documents', () => {
    const memory = { kind: 'memory' as const, memoryId: 'anonymous-memory', content: '默认中文回答' }
    const registry = createSourceReferenceRegistry([localSource, memory, { ...memory }])
    expect(registry.entries.map(entry => entry.id)).toEqual(['S1', 'S2'])
    expect(resolveStoredSourceReferences(registry.entries.map(entry => entry.source), ['S1']).sources).toEqual([localSource, memory])
    expect(resolveStoredSourceReferences(registry.entries.map(entry => entry.source), ['S2']).sources).toEqual([memory])
  })
  it('assigns continuous IDs from included sources instead of original RAG numbers', () => {
    const registry = createSourceReferenceRegistry([
      { ...localSource, titlePath: ['来源 1'], startLine: 1, endLine: 2 },
      { ...localSource, titlePath: ['来源 3'], startLine: 8, endLine: 9 },
    ])

    expect(registry.entries.map((entry) => entry.id)).toEqual(['S1', 'S2'])
    expect(registry.entries.map((entry) => entry.source)).toEqual([
      expect.objectContaining({ startLine: 1, endLine: 2 }),
      expect.objectContaining({ startLine: 8, endLine: 9 }),
    ])
  })

  it('deduplicates local paths by normalized path and line range, and web URLs by normalized URL', () => {
    const registry = createSourceReferenceRegistry([
      localSource,
      { ...localSource, filePath: 'c:/ANONYMOUS/note.md' },
      { ...localSource, startLine: 8, endLine: 9 },
      webSource,
      { ...webSource, title: '重复标题', url: 'HTTPS://EXAMPLE.COM:443/anonymous' },
    ])

    expect(registry.entries.map((entry) => entry.id)).toEqual(['S1', 'S2', 'S3'])
    expect(registry.entries[0].source).toEqual(localSource)
    expect(registry.entries[2].source).toEqual(webSource)
  })

  it('只注册可安全打开的 HTTP(S) 网页来源', () => {
    expect(normalizeSafeWebSourceUrl(' HTTPS://EXAMPLE.COM:443/anonymous '))
      .toBe('https://example.com/anonymous')
    expect(normalizeSafeWebSourceUrl('javascript:alert(1)')).toBeNull()
    expect(normalizeSafeWebSourceUrl('file:///C:/anonymous.md')).toBeNull()
    expect(normalizeSafeWebSourceUrl('not a url')).toBeNull()

    const registry = createSourceReferenceRegistry([
      webSource,
      { ...webSource, url: 'javascript:alert(1)' },
    ])
    expect(registry.entries).toEqual([{ id: 'S1', source: webSource }])
  })

  it('reuses IDs when sources arrive from separate tool calls without mutating the prior registry', () => {
    const first = createSourceReferenceRegistry([localSource])
    const second = registerSourceReferences(first, [webSource, { ...localSource, filePath: 'c:/ANONYMOUS/note.md' }])

    expect(first.entries.map((entry) => entry.id)).toEqual(['S1'])
    expect(second.entries.map((entry) => entry.id)).toEqual(['S1', 'S2'])
    expect(second.entries[1].source).toEqual(webSource)
  })

  it('parses valid IDs in first-appearance order, de-duplicates repeats, and ignores unknown or malformed IDs', () => {
    const registry = createSourceReferenceRegistry([localSource, webSource])
    const content = '结论 [S2]，补充 [S1]，重复 [S2]，未知 [S9]，异常 [S01] [s1] [S-1]。'

    const parsed = parseSourceReferences(content, registry)

    expect(parsed).toEqual({
      content,
      referencedIds: ['S2', 'S1'],
      referencedSources: [webSource, localSource],
      hasValidReferences: true,
    })
  })

  it('returns an explicit safe empty result for empty or unreferenced content', () => {
    const registry = createSourceReferenceRegistry([localSource])

    expect(parseSourceReferences('', registry)).toEqual({
      content: '',
      referencedIds: [],
      referencedSources: [],
      hasValidReferences: false,
    })
    expect(parseSourceReferences('只有正文，没有引用。', registry)).toEqual({
      content: '只有正文，没有引用。',
      referencedIds: [],
      referencedSources: [],
      hasValidReferences: false,
    })
  })

  it('preserves the complete answer, including text after the legacy marker', () => {
    const registry = createSourceReferenceRegistry([localSource])
    const content = '正文开头\n\n[有效来源]\n[1]\n尾部仍是回答正文。'

    const parsed = parseSourceReferences(content, registry)

    expect(parsed.content).toBe(content)
    expect(parsed.referencedIds).toEqual([])
    expect(parsed.hasValidReferences).toBe(false)
  })

  it('accepts the legacy local source shape without newly optional metadata', () => {
    const legacyLocalSource: ChatMessageSource = {
      filePath: 'C:\\anonymous\\legacy.md',
      fileName: 'legacy.md',
      startLine: 1,
      endLine: 1,
    }
    const registry = createSourceReferenceRegistry([legacyLocalSource])

    expect(registry.entries).toEqual([{ id: 'S1', source: legacyLocalSource }])
    expect(parseSourceReferences('依据 [S1]。', registry).referencedSources).toEqual([legacyLocalSource])
  })

  it('从完整候选来源恢复合法引用子集，旧消息或全无效 ID 安全降级', () => {
    expect(resolveStoredSourceReferences([localSource, webSource], ['S2', 'S9', 'S2'])).toEqual({
      sources: [webSource],
      hasValidReferences: true,
    })
    expect(resolveStoredSourceReferences([localSource, webSource], undefined)).toEqual({
      sources: [localSource, webSource],
      hasValidReferences: false,
    })
    expect(resolveStoredSourceReferences([localSource, webSource], ['S9'])).toEqual({
      sources: [localSource, webSource],
      hasValidReferences: false,
    })
    expect(resolveStoredSourceReferences([
      { ...webSource, url: 'javascript:alert(1)' },
    ], undefined)).toEqual({
      sources: [],
      hasValidReferences: false,
    })
  })
})
