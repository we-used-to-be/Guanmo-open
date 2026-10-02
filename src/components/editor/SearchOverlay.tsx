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

/**
 * 在匹配列表中选取离锚点（当前光标/视口 offset）最近的匹配下标。
 * - 无锚点或空列表 → 0（保持现状：跳文档首个匹配）。
 * - 距离相等时取 `from >= anchor` 的后者（搜索方向优先）。
 */
export function findNearestMatchIndex(matches: { from: number; to: number }[], anchor: number | undefined): number {
  if (matches.length === 0 || anchor === undefined) return 0
  let best = 0
  let bestDist = Number.POSITIVE_INFINITY
  for (let i = 0; i < matches.length; i += 1) {
    const dist = Math.abs(matches[i].from - anchor)
    if (dist < bestDist || (dist === bestDist && matches[i].from >= anchor)) {
      best = i
      bestDist = dist
    }
  }
  return best
}

// --- Component ---

interface SearchOverlayProps {
  onClose: () => void
  editorViewRef?: React.MutableRefObject<EditorView | null>
  searchRequest?: SearchRequest
  previewSources?: Array<{
    content: string
    paneRef: React.RefObject<HTMLDivElement | null>
    previewRef: React.RefObject<{
      scrollToOffset: (offset: number) => void
      setSearchState?: (state: { query: string; activeOffset?: number } | null) => void
      /** 可见文本投影搜索（与预览高亮同一语义）；未提供时回退原文扫描 */
      searchVisible?: (query: string) => Array<{ from: number; to: number }>
      /** 当前视口顶部对应的源码 offset；未提供时锚点兜底为文档首个匹配 */
      getViewportOffset?: () => number | undefined
    } | null>
  }>
}

export interface SearchRequest {
  requestId: number
  target: 'editor' | 'preview'
  initialQuery: string
  anchor?: {
    offset: number
    sourceIndex?: number
  }
}

interface PreviewMatch {
  sourceIndex: number
  from: number
  to: number
}

export function SearchOverlay({ onClose, editorViewRef, searchRequest, previewSources = [] }: SearchOverlayProps) {
  const isEditor = !!editorViewRef
  const [query, setQuery] = useState(searchRequest?.initialQuery ?? '')
  const [replaceText, setReplaceText] = useState('')
  const [matchCount, setMatchCount] = useState(0)
  const [currentMatch, setCurrentMatch] = useState(0)
  const currentMatchRef = useRef(0)
  const matchesRef = useRef<{ from: number; to: number }[]>([])
  const previewMatchesRef = useRef<PreviewMatch[]>([])
  const inputRef = useRef<HTMLInputElement>(null)
  const appliedSearchRequestIdRef = useRef<number | null>(null)

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
    const sources = previewSources
    return () => {
      const view = editorViewRef?.current
      if (view && view.state.field(searchField, false)) {
        view.dispatch({ effects: clearSearch.of(null) })
      }
      // 搜索关闭：清除各预览实例的模型驱动高亮（虚拟块卸载/挂载不再残留）
      for (const source of sources) {
        source.previewRef.current?.setSearchState?.(null)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // --- Editor search ---
  const doEditorSearch = useCallback((searchQuery: string, anchorOffset?: number) => {
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
    // 锚点取当前光标：优先跳离光标最近的匹配，而不是文档首个匹配
    const nearest = findNearestMatchIndex(matches, anchorOffset ?? view.state.selection.main.head)
    currentMatchRef.current = nearest
    setCurrentMatch(matches.length > 0 ? nearest : 0)
    setMatchCount(matches.length)

    if (matches.length > 0) {
      // Move cursor to nearest match
      view.dispatch({
        selection: { anchor: matches[nearest].from, head: matches[nearest].to },
        effects: setSearchQuery.of({ query: searchQuery, caseSensitive: false, currentMatch: nearest, matches }),
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
    setCurrentMatch(next)
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
    setCurrentMatch(prev)
    view.dispatch({
      selection: { anchor: matches[prev].from, head: matches[prev].to },
      effects: setSearchQuery.of({ query, caseSensitive: false, currentMatch: prev, matches }),
      scrollIntoView: true,
    })
  }, [editorViewRef, query])

  // --- Preview search (model-driven highlights via setSearchState) ---
  /** 同步搜索状态到各预览实例：active 匹配仅在目标 pane，其余 pane 仅保留普通高亮 */
  const syncPreviewSearchState = useCallback((searchQuery: string, activeSourceIndex: number, activeOffset?: number) => {
    previewSources.forEach((source, index) => {
      const state = searchQuery
        ? (index === activeSourceIndex && activeOffset !== undefined
          ? { query: searchQuery, activeOffset }
          : { query: searchQuery })
        : null
      source.previewRef.current?.setSearchState?.(state)
    })
  }, [previewSources])

  const revealPreviewMatch = useCallback((match: PreviewMatch, searchQuery: string) => {
    syncPreviewSearchState(searchQuery, match.sourceIndex, match.from)
    previewSources[match.sourceIndex]?.previewRef.current?.scrollToOffset(match.from)
  }, [previewSources, syncPreviewSearchState])

  const searchPreview = useCallback((searchQuery: string, initialAnchor?: SearchRequest['anchor']) => {
    const matches = previewSources.flatMap((source, sourceIndex) => {
      // 优先使用预览实例的可见文本投影搜索（与预览高亮、复制同一语义），
      // 避免命中链接 URL / Markdown 标记等不可见源码；实例未提供时回退原文扫描。
      const visible = source.previewRef.current?.searchVisible?.(searchQuery)
      if (visible) return visible.map((match) => ({ ...match, sourceIndex }))
      return findMatches(source.content, searchQuery, false).map((match) => ({ ...match, sourceIndex }))
    })
    previewMatchesRef.current = matches
    // 初次由选区触发时优先定位到选区所在 pane/offset；普通输入继续按活动 pane 视口定位。
    let nearest = 0
    if (initialAnchor) {
      const sourceMatches = typeof initialAnchor.sourceIndex === 'number'
        ? matches.filter((match) => match.sourceIndex === initialAnchor.sourceIndex)
        : matches
      const selected = sourceMatches[findNearestMatchIndex(sourceMatches, initialAnchor.offset)]
      if (selected) nearest = matches.indexOf(selected)
    } else {
      let anchorSourceIndex = 0
      const activeEl = document.activeElement
      if (activeEl) {
        const focusedIndex = previewSources.findIndex((source) => source.paneRef.current?.contains(activeEl))
        if (focusedIndex >= 0) anchorSourceIndex = focusedIndex
      }
      const anchor = previewSources[anchorSourceIndex]?.previewRef.current?.getViewportOffset?.()
      nearest = findNearestMatchIndex(matches, anchor)
    }
    currentMatchRef.current = nearest
    setCurrentMatch(matches.length > 0 ? nearest : 0)
    setMatchCount(matches.length)
    if (!searchQuery) {
      syncPreviewSearchState('', -1)
      return
    }
    if (matches[nearest]) revealPreviewMatch(matches[nearest], searchQuery)
    else syncPreviewSearchState(searchQuery, -1)
  }, [previewSources, revealPreviewMatch, syncPreviewSearchState])

  const navigatePreview = useCallback((direction: 1 | -1) => {
    if (!query) return
    const matches = previewMatchesRef.current
    if (matches.length === 0) return
    const nextIdx = direction === 1
      ? (currentMatchRef.current + 1) % matches.length
      : (currentMatchRef.current - 1 + matches.length) % matches.length
    currentMatchRef.current = nextIdx
    setCurrentMatch(nextIdx)
    revealPreviewMatch(matches[nextIdx], query)
  }, [query, revealPreviewMatch])

  // --- Combined ---
  const doSearch = useCallback((q: string, initialAnchor?: SearchRequest['anchor']) => {
    setQuery(q)
    if (isEditor) doEditorSearch(q, initialAnchor?.offset)
    else searchPreview(q, initialAnchor)
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

  useEffect(() => {
    if (!searchRequest?.initialQuery || appliedSearchRequestIdRef.current === searchRequest.requestId) return
    appliedSearchRequestIdRef.current = searchRequest.requestId
    doSearch(searchRequest.initialQuery, searchRequest.anchor)
  }, [doSearch, searchRequest])

  return (
    <div
      data-editor-search-overlay
      data-search-target={isEditor ? 'editor' : 'preview'}
      className="absolute top-2 right-2 z-50 bg-gm-surface border border-gm-border rounded-xl shadow-lg p-3 min-w-[300px]"
    >
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
              {matchCount > 0 ? `${currentMatch + 1}/${matchCount}` : '无'}
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
