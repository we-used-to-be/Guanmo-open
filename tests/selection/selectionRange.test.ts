import { beforeEach, describe, expect, it } from 'vitest'
import { addSelectionContextTag } from '@/services/aiContext'
import { resolveAnchoredReplacementRange } from '@/services/agent/editTarget'
import { useChatStore } from '@/stores/chatStore'

describe('选区读取', () => {
  beforeEach(() => {
    useChatStore.getState().clearMessages()
  })

  it.each([
    ['中文', '甲乙丙丁', 1, 3, '乙丙'],
    ['Emoji', '甲😀乙🚀丙', 1, 4, '😀乙'],
    ['文档开头', '首行\n末行', 0, 2, '首行'],
    ['文档末尾', '首行\n末行', 3, 6, '末行'],
    ['跨换行', '甲行\n乙行', 1, 4, '行\n乙'],
  ])('%s 选区严格遵守 UTF-16 半开区间', (_label, content, from, to, expected) => {
    const selected = content.slice(from, to)
    expect(selected).toBe(expected)
    expect(resolveAnchoredReplacementRange(content, selected, { from, to })).toEqual({ from, to })

    addSelectionContextTag({
      title: '匿名文档.md',
      text: selected,
      selectionFrom: from,
      selectionTo: to,
    })

    const tag = useChatStore.getState().contextTags[0]
    expect(tag.content).toBe(expected)
    expect(tag.selectionFrom).toBe(from)
    expect(tag.selectionTo).toBe(to)
  })

  it('允许无精确字符范围的预览选区添加到 AI 上下文', () => {
    addSelectionContextTag({
      title: '匿名文档.md',
      text: '块内草稿选区',
    })

    const tag = useChatStore.getState().contextTags[0]
    expect(tag.content).toBe('块内草稿选区')
    expect(tag.selectionFrom).toBeUndefined()
    expect(tag.selectionTo).toBeUndefined()
  })
})
