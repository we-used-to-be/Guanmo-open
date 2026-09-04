import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useEditorStore } from '@/stores/editorStore'
import type { ReadingMark } from '@/services/readingMarks'

const mocks = vi.hoisted(() => ({
  getReadingMarkById: vi.fn(),
}))

vi.mock('@/services/readingMarks', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/readingMarks')>()),
  getReadingMarkById: mocks.getReadingMarkById,
}))

import { navigateToReadingMark } from '@/services/readingMarkNavigation'

const content = '# 标题\n\n第一行\n第二行批注目标\n第三行\n'
const startOffset = content.indexOf('第二行批注目标')
const mark: ReadingMark = {
  id: 'mark-navigation',
  documentId: 'path:c:/anonymous/source.md',
  documentPath: 'C:/anonymous/source.md',
  type: 'annotation',
  anchor: {
    range: {
      startBlockId: 'paragraph:1',
      startOffset: 0,
      endBlockId: 'paragraph:1',
      endOffset: '第二行批注目标'.length,
    },
    startOffset,
    endOffset: startOffset + '第二行批注目标'.length,
    quote: '第二行批注目标',
    contextBefore: '第一行\n',
    contextAfter: '\n第三行',
  },
  color: 'yellow',
  note: '批注',
  createdAt: 1,
  updatedAt: 1,
}

describe('navigateToReadingMark', () => {
  beforeEach(() => {
    mocks.getReadingMarkById.mockReset().mockResolvedValue(mark)
    useEditorStore.setState({
      tabs: [{
        id: 'tab-source',
        title: 'source.md',
        filePath: mark.documentPath,
        content,
        savedContent: content,
        originalContent: content,
        modified: false,
        pinned: false,
      }],
      activeTabId: 'tab-source',
      viewMode: 'edit',
      previewVisible: false,
      pendingReveal: null,
    })
  })

  it('将批注锚点换算为实际行号并复用 AI 来源的预览定位请求', async () => {
    await expect(navigateToReadingMark(mark.id)).resolves.toBe(true)

    expect(useEditorStore.getState().viewMode).toBe('preview')
    expect(useEditorStore.getState().pendingReveal).toEqual({
      tabId: 'tab-source',
      startLine: 4,
      endLine: 4,
      surface: 'preview',
    })
  })
})
