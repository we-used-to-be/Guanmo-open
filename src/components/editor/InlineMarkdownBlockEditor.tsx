import { useLayoutEffect, useRef } from 'react'
import { EditorState } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import type { MarkdownBlock } from '@/services/markdownBlocks'
import { buildMarkdownEditorTheme } from './CodeMirrorEditor'

interface InlineMarkdownBlockEditorProps {
  block: MarkdownBlock
  initialCursor: number
  fontSize: number
  lineHeight: number
  fontFamily: string
  wordWrap: boolean
  conflict: boolean
  previewHeight: number
  onDraftChange: (draft: string) => void
  onSubmit: (draft: string) => void
  onCopyDraft: (draft: string) => void
}

export function InlineMarkdownBlockEditor({
  block,
  initialCursor,
  fontSize,
  lineHeight,
  fontFamily,
  wordWrap,
  conflict,
  previewHeight,
  onDraftChange,
  onSubmit,
  onCopyDraft,
}: InlineMarkdownBlockEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const composingRef = useRef(false)
  const onDraftChangeRef = useRef(onDraftChange)
  const onSubmitRef = useRef(onSubmit)
  onDraftChangeRef.current = onDraftChange
  onSubmitRef.current = onSubmit

  // 计算编辑器高度：减去 border (2px) 后 clamp 到合理范围
  // 编辑器外壳有 border: 1px，所以实际内容高度 = previewHeight - 2
  const contentHeight = Math.max(0, previewHeight - 2)
  const editorHeight = Math.max(96, Math.min(contentHeight, Math.min(window.innerHeight * 0.7, 720)))

  useLayoutEffect(() => {
    if (!hostRef.current) return
    const submit = (view: EditorView) => {
      if (view.composing || composingRef.current) return false
      onSubmitRef.current(view.state.doc.toString())
      return true
    }
    const state = EditorState.create({
      doc: block.rawSource,
      selection: { anchor: Math.max(0, Math.min(initialCursor, block.rawSource.length)) },
      extensions: [
        history(),
        buildMarkdownEditorTheme(fontSize, lineHeight, fontFamily),
        EditorView.theme({
          '&': { height: `${editorHeight}px` },
          '.cm-scroller': { height: '100%', overflow: 'auto' },
          '.cm-content': { padding: '10px 12px', minHeight: '100%' },
          '.cm-gutters': { display: 'none' },
          '.cm-activeLine': { backgroundColor: 'transparent' },
        }),
        wordWrap ? EditorView.lineWrapping : [],
        EditorView.updateListener.of((update) => {
          if (update.docChanged) onDraftChangeRef.current(update.state.doc.toString())
        }),
        EditorView.domEventHandlers({
          compositionstart() {
            composingRef.current = true
            return false
          },
          compositionend() {
            composingRef.current = false
            return false
          },
          keydown(event) {
            return composingRef.current || event.isComposing || event.keyCode === 229
          },
        }),
        keymap.of([
          {
            key: 'Ctrl-s',
            run: (view) => {
              if (!submit(view)) return false
              queueMicrotask(() => window.dispatchEvent(new CustomEvent('cm-save')))
              return true
            },
          },
          indentWithTab,
          ...defaultKeymap,
          ...historyKeymap,
        ]),
      ],
    })
    const view = new EditorView({ state, parent: hostRef.current })
    viewRef.current = view
    queueMicrotask(() => view.focus())
    return () => {
      view.destroy()
      viewRef.current = null
    }
  // 编辑器在同一块内保持挂载，避免输入法组合期间因外部主题或字号变化重建。
  }, [block.renderKey]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className={`gm-inline-markdown-editor ${conflict ? 'gm-inline-markdown-editor--conflict' : ''}`}>
      <div className="gm-inline-markdown-editor__status">
        <span>Markdown</span>
        {conflict && (
          <>
            <span className="text-gm-error">内容已在其他位置发生变化，修改尚未覆盖原文</span>
            <button type="button" onClick={() => onCopyDraft(viewRef.current?.state.doc.toString() ?? block.rawSource)}>
              复制修改内容
            </button>
          </>
        )}
      </div>
      <div
        ref={hostRef}
        className="gm-inline-markdown-editor__host"
        style={{ height: `${editorHeight}px` }}
      />
    </div>
  )
}

function isLongBlock(block: MarkdownBlock): boolean {
  return block.type === 'code' || block.type === 'mermaid' || block.type === 'table'
}
