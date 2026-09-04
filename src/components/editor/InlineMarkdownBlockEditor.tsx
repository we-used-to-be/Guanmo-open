import { useLayoutEffect, useRef } from 'react'
import { EditorState } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { bracketMatching, syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language'
import { editorCodeLanguages } from '@/services/editorCodeLanguages'
import type { PreviewBlock } from '@/services/markdownPreviewModel'
import { buildMarkdownEditorTheme, markdownHighlightStyle } from './CodeMirrorEditor'

interface InlineMarkdownBlockEditorProps {
  block: PreviewBlock
  initialCursor: number
  fontSize: number
  lineHeight: number
  fontFamily: string
  wordWrap: boolean
  conflict: boolean
  onDraftChange: (draft: string) => void
  onSubmit: (draft: string) => Promise<boolean> | boolean
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

  useLayoutEffect(() => {
    if (!hostRef.current) return
    const submit = (view: EditorView): Promise<boolean> | boolean => {
      if (view.composing || composingRef.current) return false
      return onSubmitRef.current(view.state.doc.toString())
    }
    const state = EditorState.create({
      doc: block.rawSource,
      selection: { anchor: Math.max(0, Math.min(initialCursor, block.rawSource.length)) },
      extensions: [
        history(),
        bracketMatching(),
        syntaxHighlighting(markdownHighlightStyle),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        markdown({ base: markdownLanguage, codeLanguages: editorCodeLanguages }),
        buildMarkdownEditorTheme(fontSize, lineHeight, fontFamily),
        EditorView.theme({
          '& .cm-content': { padding: '8px 12px' },
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
              const result = submit(view)
              if (result === false) return false
              void Promise.resolve(result).then((submitted) => {
                if (submitted) window.dispatchEvent(new CustomEvent('cm-save'))
              })
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
  }, [block.blockId]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className={`gm-inline-markdown-editor ${conflict ? 'gm-inline-markdown-editor--conflict' : ''}`}>
      {conflict && (
        <div className="gm-inline-markdown-editor__status">
          <span className="text-gm-error">内容已在其他位置发生变化，修改尚未覆盖原文</span>
          <button type="button" onClick={() => onCopyDraft(viewRef.current?.state.doc.toString() ?? block.rawSource)}>
            复制修改内容
          </button>
        </div>
      )}
      <div
        ref={hostRef}
        className="gm-inline-markdown-editor__host"
      />
    </div>
  )
}
