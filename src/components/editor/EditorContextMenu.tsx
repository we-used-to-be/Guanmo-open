import { useState, useEffect, useCallback, useRef } from 'react'
import type { EditorView } from '@codemirror/view'
import { useEditorStore } from '@/stores/editorStore'
import { addSelectionContextTag, setAiShortcutPrompt } from '@/services/aiContext'
import { ContextMenu, ContextMenuGroupTitle, ContextMenuItem, ContextMenuSeparator } from '@/components/common/ContextMenu'
import { toast } from '@/services/toast'

interface MenuState {
  x: number
  y: number
  hasSelection: boolean
}

interface EditorContextMenuProps {
  viewRef: React.MutableRefObject<EditorView | null>
}

export function EditorContextMenu({ viewRef }: EditorContextMenuProps) {
  const [menu, setMenu] = useState<MenuState | null>(null)
  const activeTab = useEditorStore((s) => s.tabs.find((t) => t.id === s.activeTabId))
  const wrapperRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const parent = wrapperRef.current?.parentElement
    if (!parent) return

    const handleContextMenu = (e: MouseEvent) => {
      e.preventDefault()
      const view = viewRef.current
      const hasSelection = view ? !view.state.selection.main.empty : false
      setMenu({ x: e.clientX, y: e.clientY, hasSelection })
    }

    parent.addEventListener('contextmenu', handleContextMenu)
    return () => parent.removeEventListener('contextmenu', handleContextMenu)
  }, [viewRef])

  const getSelection = useCallback(() => {
    const view = viewRef.current
    if (!view) return { from: 0, to: 0, text: '' }
    const sel = view.state.selection.main
    return { from: sel.from, to: sel.to, text: view.state.sliceDoc(sel.from, sel.to) }
  }, [viewRef])

  const replaceSelection = useCallback((insert: string, anchorOffset: number, headOffset = anchorOffset) => {
    const view = viewRef.current
    if (!view) return
    const { from, to, text } = getSelection()
    const nextText = insert.replace('$selection', text)
    view.dispatch({
      changes: { from, to, insert: nextText },
      selection: { anchor: from + anchorOffset, head: from + headOffset },
    })
    view.focus()
    setMenu(null)
  }, [viewRef, getSelection])

  const wrapSelection = useCallback((before: string, after: string, selectAfterOffset?: number, selectAfterLength?: number) => {
    const { text } = getSelection()
    const anchorOffset = typeof selectAfterOffset === 'number' ? before.length + text.length + selectAfterOffset : before.length
    const headOffset = typeof selectAfterLength === 'number' ? anchorOffset + selectAfterLength : before.length + text.length
    replaceSelection(`${before}$selection${after}`, anchorOffset, headOffset)
  }, [getSelection, replaceSelection])

  const insertAtCursor = useCallback((text: string, selectionStart?: number, selectionEnd?: number) => {
    const view = viewRef.current
    if (!view) return
    const { from } = view.state.selection.main
    const lineStart = view.state.doc.lineAt(from).from
    const needsNewline = lineStart < from && view.state.sliceDoc(lineStart, from).trim() !== ''
    const insert = needsNewline ? '\n' + text : text
    const prefixLength = needsNewline ? 1 : 0
    const anchor = from + (typeof selectionStart === 'number' ? prefixLength + selectionStart : insert.length)
    const head = from + (typeof selectionEnd === 'number' ? prefixLength + selectionEnd : anchor - from)
    view.dispatch({
      changes: { from, insert },
      selection: { anchor, head },
    })
    view.focus()
    setMenu(null)
  }, [viewRef])

  const handleCopy = useCallback(() => {
    const { text } = getSelection()
    if (text) navigator.clipboard.writeText(text)
    setMenu(null)
  }, [getSelection])

  const handlePaste = useCallback(async () => {
    const view = viewRef.current
    if (!view) return
    try {
      const text = await navigator.clipboard.readText()
      const { from, to } = getSelection()
      view.dispatch({ changes: { from, to, insert: text } })
      view.focus()
    } catch {
      toast.warning('粘贴失败，剪贴板权限被拒绝')
    }
    setMenu(null)
  }, [viewRef, getSelection])

  const handleSelectAll = useCallback(() => {
    const view = viewRef.current
    if (!view) return
    view.dispatch({
      selection: { anchor: 0, head: view.state.doc.length },
    })
    view.focus()
    setMenu(null)
  }, [viewRef])

  const handleAddSelectionToAi = useCallback(() => {
    const view = viewRef.current
    if (!view || !activeTab) return
    const sel = view.state.selection.main
    const text = view.state.sliceDoc(sel.from, sel.to)
    if (!text.trim()) return
    const startLine = view.state.doc.lineAt(sel.from).number
    const endLine = view.state.doc.lineAt(sel.to).number
    addSelectionContextTag({
      title: activeTab.title,
      filePath: activeTab.filePath,
      text,
      startLine,
      endLine,
      selectionFrom: sel.from,
      selectionTo: sel.to,
    })
    setMenu(null)
  }, [activeTab, viewRef])

  const handleAiAction = useCallback((prompt: string) => {
    const view = viewRef.current
    if (!view || !activeTab) return
    const sel = view.state.selection.main
    const text = view.state.sliceDoc(sel.from, sel.to)
    if (!text.trim()) return
    const startLine = view.state.doc.lineAt(sel.from).number
    const endLine = view.state.doc.lineAt(sel.to).number
    addSelectionContextTag({
      title: activeTab.title,
      filePath: activeTab.filePath,
      text,
      startLine,
      endLine,
      selectionFrom: sel.from,
      selectionTo: sel.to,
    })
    setAiShortcutPrompt(prompt)
    setMenu(null)
  }, [activeTab, viewRef])

  return (
    <div ref={wrapperRef}>
    {menu && (
    <ContextMenu position={menu} onClose={() => setMenu(null)} minWidth={176} maxWidth={176}>
      {menu.hasSelection ? (
        /* 选中文本右键菜单 */
        <>
          <ContextMenuGroupTitle>基础操作</ContextMenuGroupTitle>
          <ContextMenuItem onClick={handleCopy}>复制</ContextMenuItem>
          <ContextMenuItem onClick={handleAddSelectionToAi}>添加到 AI 上下文</ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuGroupTitle>AI 助手</ContextMenuGroupTitle>
          <ContextMenuItem onClick={() => handleAiAction('请解释这段内容')}>AI 解释这段</ContextMenuItem>
          <ContextMenuItem onClick={() => handleAiAction('请总结这段内容')}>AI 总结这段</ContextMenuItem>
          <ContextMenuItem onClick={() => handleAiAction('请改写这段内容，使其更清晰')}>AI 改写这段</ContextMenuItem>
          <ContextMenuItem onClick={() => handleAiAction('请只把选中文本整理为标准 Markdown 格式：可以调整标题、列表、引用、代码块、表格等 Markdown 标记；不得改变原文内容、语义和顺序，不得新增信息。')}>AI 优化格式</ContextMenuItem>
          <ContextMenuItem onClick={() => handleAiAction('请翻译这段内容')}>AI 翻译</ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuGroupTitle>Markdown 格式</ContextMenuGroupTitle>
          <ContextMenuItem onClick={() => wrapSelection('**', '**')}>加粗</ContextMenuItem>
          <ContextMenuItem onClick={() => wrapSelection('*', '*')}>斜体</ContextMenuItem>
          <ContextMenuItem onClick={() => wrapSelection('`', '`')}>行内代码</ContextMenuItem>
          <ContextMenuItem onClick={() => wrapSelection('\n```\n', '\n```\n')}>代码块</ContextMenuItem>
          <ContextMenuItem onClick={() => wrapSelection('> ', '')}>引用</ContextMenuItem>
          <ContextMenuItem onClick={() => wrapSelection('[', '](url)', 2, 3)}>链接</ContextMenuItem>
        </>
      ) : (
        /* 编辑器空白处右键菜单 */
        <>
          <ContextMenuGroupTitle>基础操作</ContextMenuGroupTitle>
          <ContextMenuItem onClick={handlePaste}>粘贴</ContextMenuItem>
          <ContextMenuItem onClick={handleSelectAll}>全选</ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuGroupTitle>插入 Markdown</ContextMenuGroupTitle>
          <ContextMenuItem onClick={() => insertAtCursor('# 标题\n', 2, 4)}>插入标题</ContextMenuItem>
          <ContextMenuItem onClick={() => insertAtCursor('> 引用\n', 2, 4)}>插入引用</ContextMenuItem>
          <ContextMenuItem onClick={() => insertAtCursor('\n```\n\n```\n', 5, 5)}>插入代码块</ContextMenuItem>
          <ContextMenuItem onClick={() => insertAtCursor('[链接文字](url)', 7, 10)}>插入链接</ContextMenuItem>
          <ContextMenuItem onClick={() => insertAtCursor('| 列1 | 列2 | 列3 |\n| --- | --- | --- |\n| | | |\n')}>插入表格</ContextMenuItem>
          <ContextMenuItem onClick={() => insertAtCursor('- [ ] 任务\n')}>插入任务列表</ContextMenuItem>
          <ContextMenuItem onClick={() => insertAtCursor('\n---\n')}>插入分割线</ContextMenuItem>
        </>
      )}
    </ContextMenu>
    )}
    </div>
  )
}
