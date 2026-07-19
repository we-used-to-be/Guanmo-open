import { useState, useRef, useCallback, useEffect } from 'react'
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate } from '@codemirror/view'
import { StateField, StateEffect, Range } from '@codemirror/state'

// --- CodeMirror manual search via decorations ---

const markDeco = Decoration.mark({ class: 'cm-searchMatch' })
const activeDeco = Decoration.mark({ class: 'cm-searchMatch-selected' })

interface SearchState {
  query: string
  caseSensitive: boolean
  currentMatch: number
  matches: { from: number; to: number }[]
}

const setSearchQuery = StateEffect.define<SearchState>()
const clearSearch = StateEffect.define()

const searchField = StateField.define<DecorationSet>({
  create() {
    return Decoration.none
  },
  update(deco, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setSearchQuery)) {
        const { query, caseSensitive, currentMatch, matches } = effect.value
        if (!query || matches.length === 0) return Decoration.none
        const decos: Range<Decoration>[] = matches.map((m, i) =>
          (i === currentMatch ? activeDeco : markDeco).range(m.from, m.to)
        )
        return Decoration.set(decos.sort((a, b) => a.from - b.from))
      }
      if (effect.is(clearSearch)) {
        return Decoration.none
      }
    }
    return deco.map(tr.changes)
  },
  provide: (f) => EditorView.decorations.from(f),
})

function findMatches(doc: string, query: string, caseSensitive: boolean): { from: number; to: number }[] {
  if (!query) return []
  const matches: { from: number; to: number }[] = []
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const regex = new RegExp(escaped, caseSensitive ? 'g' : 'gi')
  let match: RegExpExecArray | null
  while ((match = regex.exec(doc)) !== null) {
    matches.push({ from: match.index, to: match.index + match[0].length })
  }
  return matches
}

// --- Component ---

interface SearchOverlayProps {
  onClose: () => void
  editorViewRef?: React.MutableRefObject<EditorView | null>
  previewPanes?: React.RefObject<HTMLDivElement>[]
}

export function SearchOverlay({ onClose, editorViewRef, previewPanes = [] }: SearchOverlayProps) {
  const isEditor = !!editorViewRef
  const [query, setQuery] = useState('')
  const [replaceText, setReplaceText] = useState('')
  const [matchCount, setMatchCount] = useState(0)
  const currentMatchRef = useRef(0)
  const matchesRef = useRef<{ from: number; to: number }[]>([])
  const inputRef = useRef<HTMLInputElement>(null)

  // Ensure searchField is in editor's extensions
  useEffect(() => {
    const view = editorViewRef?.current
    if (!view) return
    // Add searchField if not already present
    if (!view.state.field(searchField, false)) {
      view.dispatch({ effects: StateEffect.appendConfig.of(searchField) })
    }
  }, [editorViewRef])

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [onClose])

  // Clear on unmount
  useEffect(() => {
    return () => {
      const view = editorViewRef?.current
      if (view && view.state.field(searchField, false)) {
        view.dispatch({ effects: clearSearch.of(null) })
      }
      if (typeof CSS !== 'undefined' && CSS.highlights) {
        CSS.highlights.delete('search-highlight')
        CSS.highlights.delete('search-highlight-active')
      }
    }
  }, [editorViewRef])

  // --- Editor search ---
  const doEditorSearch = useCallback((searchQuery: string) => {
    const view = editorViewRef?.current
    if (!view || !view.state.field(searchField, false)) return
    if (!searchQuery) {
      view.dispatch({ effects: clearSearch.of(null) })
      matchesRef.current = []
      setMatchCount(0)
      return
    }
    const doc = view.state.doc.toString()
    const matches = findMatches(doc, searchQuery, false)
    matchesRef.current = matches
    currentMatchRef.current = 0
    setMatchCount(matches.length)

    if (matches.length > 0) {
      // Move cursor to first match
      view.dispatch({
        selection: { anchor: matches[0].from, head: matches[0].to },
        effects: setSearchQuery.of({ query: searchQuery, caseSensitive: false, currentMatch: 0, matches }),
        scrollIntoView: true,
      })
    } else {
      view.dispatch({ effects: setSearchQuery.of({ query: searchQuery, caseSensitive: false, currentMatch: -1, matches: [] }) })
    }
  }, [editorViewRef])

  const editorNext = useCallback(() => {
    const view = editorViewRef?.current
    if (!view || !view.state.field(searchField, false)) return
    const matches = matchesRef.current
    if (matches.length === 0) return
    const next = (currentMatchRef.current + 1) % matches.length
    currentMatchRef.current = next
    view.dispatch({
      selection: { anchor: matches[next].from, head: matches[next].to },
      effects: setSearchQuery.of({ query, caseSensitive: false, currentMatch: next, matches }),
      scrollIntoView: true,
    })
  }, [editorViewRef, query])

  const editorPrev = useCallback(() => {
    const view = editorViewRef?.current
    if (!view || !view.state.field(searchField, false)) return
    const matches = matchesRef.current
    if (matches.length === 0) return
    const prev = (currentMatchRef.current - 1 + matches.length) % matches.length
    currentMatchRef.current = prev
    view.dispatch({
      selection: { anchor: matches[prev].from, head: matches[prev].to },
      effects: setSearchQuery.of({ query, caseSensitive: false, currentMatch: prev, matches }),
      scrollIntoView: true,
    })
  }, [editorViewRef, query])

  // --- Preview search (CSS Highlight API) ---
  const searchPreview = useCallback((searchQuery: string) => {
    if (typeof CSS === 'undefined' || !CSS.highlights) return
    CSS.highlights.delete('search-highlight')
    CSS.highlights.delete('search-highlight-active')
    if (!searchQuery) { setMatchCount(0); return }

    const allRanges: globalThis.Range[] = []
    for (const paneRef of previewPanes) {
      const el = paneRef.current
      if (!el) continue
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
      let node: Text | null
      while ((node = walker.nextNode() as Text)) {
        const text = node.textContent || ''
        const regex = new RegExp(escapeRegex(searchQuery), 'gi')
        let match: RegExpExecArray | null
        while ((match = regex.exec(text)) !== null) {
          const range = document.createRange()
          range.setStart(node, match.index)
          range.setEnd(node, match.index + match[0].length)
          allRanges.push(range)
        }
      }
    }

    if (allRanges.length > 0) {
      CSS.highlights.set('search-highlight', new Highlight(...allRanges))
      CSS.highlights.set('search-highlight-active', new Highlight(allRanges[0]))
    }
    setMatchCount(allRanges.length)
  }, [previewPanes])

  const navigatePreview = useCallback((direction: 1 | -1) => {
    if (typeof CSS === 'undefined' || !CSS.highlights || !query) return
    const allRanges: globalThis.Range[] = []
    for (const paneRef of previewPanes) {
      const el = paneRef.current
      if (!el) continue
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
      let node: Text | null
      while ((node = walker.nextNode() as Text)) {
        const text = node.textContent || ''
        const regex = new RegExp(escapeRegex(query), 'gi')
        let match: RegExpExecArray | null
        while ((match = regex.exec(text)) !== null) {
          const range = document.createRange()
          range.setStart(node, match.index)
          range.setEnd(node, match.index + match[0].length)
          allRanges.push(range)
        }
      }
    }
    if (allRanges.length === 0) return

    const activeHighlight = CSS.highlights.get('search-highlight-active')
    if (!activeHighlight) return
    const currentActive = Array.from(activeHighlight)[0]
    const currentIdx = currentActive ? allRanges.findIndex(
      r => r.startContainer === currentActive.startContainer && r.startOffset === currentActive.startOffset
    ) : -1
    const nextIdx = direction === 1
      ? (currentIdx + 1) % allRanges.length
      : (currentIdx - 1 + allRanges.length) % allRanges.length
    CSS.highlights.set('search-highlight-active', new Highlight(allRanges[nextIdx]))
    allRanges[nextIdx].startContainer.parentElement?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [query, previewPanes])

  // --- Combined ---
  const doSearch = useCallback((q: string) => {
    setQuery(q)
    if (isEditor) doEditorSearch(q)
    else searchPreview(q)
  }, [isEditor, doEditorSearch, searchPreview])

  const handleNext = useCallback(() => {
    if (!query) return
    if (isEditor) editorNext()
    else navigatePreview(1)
  }, [query, isEditor, editorNext, navigatePreview])

  const handlePrev = useCallback(() => {
    if (!query) return
    if (isEditor) editorPrev()
    else navigatePreview(-1)
  }, [query, isEditor, editorPrev, navigatePreview])

  const handleReplace = useCallback(() => {
    const view = editorViewRef?.current
    if (!view || !query) return
    const sel = view.state.selection.main
    const selectedText = view.state.sliceDoc(sel.from, sel.to)
    if (selectedText.toLowerCase() === query.toLowerCase()) {
      view.dispatch({ changes: { from: sel.from, to: sel.to, insert: replaceText } })
    }
    editorNext()
  }, [editorViewRef, query, replaceText, editorNext])

  const handleReplaceAll = useCallback(() => {
    const view = editorViewRef?.current
    if (!view || !query) return
    const doc = view.state.doc.toString()
    const regex = new RegExp(escapeRegex(query), 'gi')
    const replaced = doc.replace(regex, replaceText)
    if (replaced !== doc) {
      view.dispatch({ changes: { from: 0, to: doc.length, insert: replaced } })
    }
    doEditorSearch(query)
  }, [editorViewRef, query, replaceText, doEditorSearch])

  const handleInputKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      if (e.shiftKey) handlePrev()
      else handleNext()
    }
  }, [handleNext, handlePrev])

  useEffect(() => { inputRef.current?.focus() }, [])

  return (
    <div data-editor-search-overlay className="absolute top-2 right-2 z-50 bg-gm-surface border border-gm-border rounded-xl shadow-lg p-3 animate-slideInUp min-w-[300px]">
      <div className="flex flex-col gap-2">
        {/* Search row */}
        <div className="flex items-center gap-2">
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => doSearch(e.target.value)}
            onKeyDown={handleInputKeyDown}
            placeholder="搜索..."
            className="flex-1 h-8 px-3 text-caption text-gm-text bg-gm-canvas border border-gm-border rounded-lg outline-none focus:border-gm-primary transition-colors"
          />
          <button onClick={handlePrev} className="p-1.5 rounded-lg text-gm-text-tertiary hover:text-gm-text hover:bg-gm-surface-hover transition-colors" title="上一个 (Shift+Enter)">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 15l-6-6-6 6" /></svg>
          </button>
          <button onClick={handleNext} className="p-1.5 rounded-lg text-gm-text-tertiary hover:text-gm-text hover:bg-gm-surface-hover transition-colors" title="下一个 (Enter)">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M6 9l6 6 6-6" /></svg>
          </button>
          {query && (
            <span className="text-micro text-gm-text-tertiary whitespace-nowrap min-w-[40px] text-center">
              {matchCount > 0 ? `${currentMatchRef.current + 1}/${matchCount}` : '无'}
            </span>
          )}
          <button onClick={onClose} className="p-1.5 rounded-lg text-gm-text-tertiary hover:text-gm-text hover:bg-gm-surface-hover transition-colors">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6L6 18M6 6l12 12" /></svg>
          </button>
        </div>

        {/* Replace row (editor only) */}
        {isEditor && (
          <div className="flex items-center gap-2">
            <input
              value={replaceText}
              onChange={(e) => setReplaceText(e.target.value)}
              placeholder="替换..."
              className="flex-1 h-8 px-3 text-caption text-gm-text bg-gm-canvas border border-gm-border rounded-lg outline-none focus:border-gm-primary transition-colors"
            />
            <button onClick={handleReplace} className="px-2.5 py-1.5 text-micro font-bold text-gm-text-secondary hover:text-gm-text bg-gm-surface-hover hover:bg-gm-surface-overlay rounded-lg transition-colors whitespace-nowrap">
              替换
            </button>
            <button onClick={handleReplaceAll} className="px-2.5 py-1.5 text-micro font-bold text-gm-text-secondary hover:text-gm-text bg-gm-surface-hover hover:bg-gm-surface-overlay rounded-lg transition-colors whitespace-nowrap">
              全部替换
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
