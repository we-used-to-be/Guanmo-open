import { useEffect, useRef, useMemo } from 'react'
import { EditorState } from '@codemirror/state'
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab, undoDepth, redoDepth } from '@codemirror/commands'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { languages } from '@codemirror/language-data'
import { highlightSelectionMatches } from '@codemirror/search'
import { syntaxHighlighting, defaultHighlightStyle, bracketMatching, indentUnit } from '@codemirror/language'
import { autocompletion, completionKeymap } from '@codemirror/autocomplete'
import { useEditorStore } from '@/stores/editorStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { setActiveEditorView } from '@/services/editorViewRef'
import { useEditorHistoryStore } from '@/stores/editorHistoryStore'

interface CodeMirrorEditorProps {
  content: string
  onChange: (content: string) => void
  onSave?: () => void
  onImageFiles?: (files: File[], insertAt?: number) => void
  viewRef?: React.MutableRefObject<EditorView | null>
  documentKey?: string | null
  tabId?: string | null
}

function buildTheme(fontSize: number, lineHeight: number, fontFamily: string) {
  return EditorView.theme({
    '&': {
      backgroundColor: 'var(--gm-editor-bg)',
      color: 'var(--gm-text)',
      fontSize: `${fontSize}px`,
      height: '100%',
    },
    '.cm-content': {
      fontFamily,
      lineHeight: String(lineHeight),
      padding: '12px 0',
      caretColor: 'var(--gm-primary)',
    },
    '.cm-cursor, .cm-dropCursor': {
      borderLeftColor: 'var(--gm-primary)',
      borderLeftWidth: '2px',
    },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': {
      backgroundColor: 'rgba(25, 200, 185, 0.15) !important',
    },
    '.cm-activeLine': {
      backgroundColor: 'rgba(25, 200, 185, 0.05)',
    },
    '.cm-gutters': {
      backgroundColor: 'var(--gm-canvas)',
      color: 'var(--gm-text-tertiary)',
      border: 'none',
      borderRight: '1px solid var(--gm-border)',
    },
    '.cm-activeLineGutter': {
      backgroundColor: 'transparent',
      color: 'var(--gm-text)',
    },
    '.cm-foldGutter': {
      color: 'var(--gm-text-tertiary)',
    },
    '.cm-header': {
      color: 'var(--gm-text)',
      fontWeight: '700',
    },
    '.cm-header-1': { fontSize: '1.4em' },
    '.cm-header-2': { fontSize: '1.25em' },
    '.cm-header-3': { fontSize: '1.15em' },
    '.cm-emphasis': { fontStyle: 'italic', color: 'var(--gm-text)' },
    '.cm-strong': { fontWeight: '700', color: 'var(--gm-text)' },
    '.cm-strikethrough': { textDecoration: 'line-through', color: 'var(--gm-text-secondary)' },
    '.cm-url': { color: 'var(--gm-primary)', textDecoration: 'underline' },
    '.cm-link': { color: 'var(--gm-primary)' },
    '.cm-quote': { color: 'var(--gm-text-secondary)', fontStyle: 'italic' },
    '.cm-list': { color: 'var(--gm-text)' },
    '.cm-hr': { color: 'var(--gm-border)' },
    '.cm-inline-code': {
      backgroundColor: 'var(--gm-surface-elevated)',
      color: 'var(--gm-text)',
      padding: '1px 6px',
      borderRadius: '12px',
      fontSize: '0.9em',
    },
    '.cm-codeblock': { backgroundColor: 'var(--gm-surface-elevated)', color: 'var(--gm-text)' },
    '.cm-tooltip': {
      backgroundColor: 'var(--gm-surface)',
      border: '1px solid var(--gm-border)',
      borderRadius: '16px',
      boxShadow: '0 4px 12px rgba(61, 52, 40, 0.1)',
    },
    '.cm-tooltip-autocomplete': {
      '& > ul > li': { padding: '4px 8px' },
      '& > ul > li[aria-selected]': { backgroundColor: 'var(--gm-primary-subtle)', color: 'var(--gm-text)' },
    },
    '.cm-panels': {
      backgroundColor: 'var(--gm-surface)',
      color: 'var(--gm-text)',
      borderTop: '1px solid var(--gm-border)',
    },
    '.cm-panel input': {
      backgroundColor: 'var(--gm-surface-elevated)',
      color: 'var(--gm-text)',
      border: '1px solid var(--gm-border)',
      borderRadius: '12px',
      padding: '4px 8px',
    },
    '.cm-searchMatch': { backgroundColor: 'rgba(251, 191, 36, 0.2)' },
    '.cm-searchMatch-selected': { backgroundColor: 'rgba(251, 191, 36, 0.4)' },
  })
}

const saveKeymap = keymap.of([
  {
    key: 'Ctrl-s',
    run: (view) => {
      const event = new CustomEvent('cm-save', { detail: { content: view.state.doc.toString() } })
      window.dispatchEvent(event)
      return true
    },
  },
])

export function CodeMirrorEditor({ content, onChange, onSave, onImageFiles, viewRef: externalViewRef, documentKey, tabId }: CodeMirrorEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const internalViewRef = useRef<EditorView | null>(null)
  const viewRef = externalViewRef || internalViewRef
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  const onSaveRef = useRef(onSave)
  onSaveRef.current = onSave
  const onImageFilesRef = useRef(onImageFiles)
  onImageFilesRef.current = onImageFiles

  // Read editor settings from store
  const editorSettings = useSettingsStore((s) => s.editor)
  const pendingReveal = useEditorStore((s) => s.pendingReveal)
  const clearPendingReveal = useEditorStore((s) => s.clearPendingReveal)
  const settingsKey = `${editorSettings.fontSize}-${editorSettings.lineHeight}-${editorSettings.fontFamily}-${editorSettings.wordWrap}-${editorSettings.lineNumbers}-${editorSettings.tabSize}`

  const guanmoTheme = useMemo(
    () => buildTheme(editorSettings.fontSize, editorSettings.lineHeight, editorSettings.fontFamily),
    [editorSettings.fontSize, editorSettings.lineHeight, editorSettings.fontFamily]
  )

  useEffect(() => {
    const handleSave = (e: Event) => {
      const customEvent = e as CustomEvent<{ content: string }>
      onChangeRef.current(customEvent.detail.content)
      onSaveRef.current?.()
    }
    window.addEventListener('cm-save', handleSave)
    return () => window.removeEventListener('cm-save', handleSave)
  }, [])

  // Recreate editor when settings change
  useEffect(() => {
    if (!containerRef.current) return

    // Save current doc content before recreating
    const currentDoc = viewRef.current?.state.doc.toString() ?? content

    // Destroy old editor
    if (viewRef.current) {
      viewRef.current.destroy()
      viewRef.current = null
    }

    const updateListener = EditorView.updateListener.of((update) => {
      if (update.docChanged) {
        onChangeRef.current(update.state.doc.toString())
      }
      // 更新 undo/redo 状态
      const { setCanUndo, setCanRedo } = useEditorHistoryStore.getState()
      setCanUndo(undoDepth(update.state) > 0)
      setCanRedo(redoDepth(update.state) > 0)
    })

    const state = EditorState.create({
      doc: currentDoc,
      extensions: [
        editorSettings.lineNumbers ? lineNumbers() : [],
        highlightActiveLine(),
        highlightActiveLineGutter(),
        history(),
        bracketMatching(),
        autocompletion(),
        highlightSelectionMatches(),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        markdown({ base: markdownLanguage, codeLanguages: languages }),
        indentUnit.of(' '.repeat(editorSettings.tabSize)),
        guanmoTheme,
        saveKeymap,
        updateListener,
        EditorView.domEventHandlers({
          drop(event, view) {
            const files = Array.from(event.dataTransfer?.files || []).filter(isImageLikeFile)
            if (files.length === 0) return false
            event.preventDefault()
            const pos = view.posAtCoords({ x: event.clientX, y: event.clientY }) ?? view.state.selection.main.from
            onImageFilesRef.current?.(files, pos)
            return true
          },
          paste(event, view) {
            const files = Array.from(event.clipboardData?.files || []).filter(isImageLikeFile)
            if (files.length === 0) return false
            event.preventDefault()
            onImageFilesRef.current?.(files, view.state.selection.main.from)
            return true
          },
        }),
        keymap.of([
          indentWithTab,
          ...defaultKeymap,
          ...historyKeymap,
          ...completionKeymap,
        ]),
        keymap.of([
          { key: 'Ctrl-f', run: () => true },
          { key: 'Ctrl-h', run: () => true },
          { key: 'Ctrl-g', run: () => true },
          { key: 'F3', run: () => true },
        ]),
        editorSettings.wordWrap ? EditorView.lineWrapping : [],
        EditorState.allowMultipleSelections.of(true),
      ],
    })

    const view = new EditorView({
      state,
      parent: containerRef.current,
    })

    viewRef.current = view
    setActiveEditorView(view)
    const { setCanUndo, setCanRedo } = useEditorHistoryStore.getState()
    setCanUndo(false)
    setCanRedo(false)

    return () => {
      view.destroy()
      viewRef.current = null
      setActiveEditorView(null)
      setCanUndo(false)
      setCanRedo(false)
    }
  }, [settingsKey, documentKey]) // eslint-disable-line react-hooks/exhaustive-deps

  // Sync content from prop when it changes externally
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const currentContent = view.state.doc.toString()
    if (content !== currentContent) {
      view.dispatch({
        changes: { from: 0, to: currentContent.length, insert: content },
      })
    }
  }, [content])

  useEffect(() => {
    const view = viewRef.current
    if (!view || !pendingReveal || !tabId || pendingReveal.tabId !== tabId) return
    const startLine = Math.max(1, Math.min(pendingReveal.startLine, view.state.doc.lines))
    const endLine = Math.max(startLine, Math.min(pendingReveal.endLine ?? pendingReveal.startLine, view.state.doc.lines))
    const from = view.state.doc.line(startLine).from
    const to = view.state.doc.line(endLine).to
    view.dispatch({
      selection: { anchor: from, head: to },
      effects: EditorView.scrollIntoView(from, { y: 'start' }),
    })
    view.focus()
    clearPendingReveal()
  }, [clearPendingReveal, pendingReveal, tabId, viewRef])

  return (
    <div
      ref={containerRef}
      className="h-full overflow-hidden"
    />
  )
}

function isImageLikeFile(file: File): boolean {
  return file.type.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(file.name)
}
