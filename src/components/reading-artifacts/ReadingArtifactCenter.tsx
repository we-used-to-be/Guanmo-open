import { Check, ChevronDown, ChevronLeft, ChevronRight, ExternalLink, FileText, Filter } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { fileExists } from '@/hooks/useTauri'
import type { ReadingArtifact, SourceAnchorStatus } from '@/services/database/readingArtifacts'
import {
  loadReadingArtifactCenterItemsPage,
  loadReadingArtifactDocumentSummariesPage,
  type ReadingArtifactDocumentPage,
} from '@/services/database/readingArtifactCenter'
import { isDatabaseReady } from '@/services/database/db'
import { createMarkdownPreviewModel, getSourceOffsetForLine, type MarkdownPreviewModel } from '@/services/markdownPreviewModel'
import { readRememberedMarkdownFileForOpen } from '@/services/markdownFileOpenPolicy'
import { describeFileOperationError } from '@/services/fileOperationErrors'
import { toast } from '@/services/toast'
import {
  buildReadingArtifactItems,
  filterReadingArtifactItems,
  listArtifactDocuments,
  listArtifactsByDocument,
  type ReadingArtifactDocumentRef,
  type ReadingArtifactItem,
  type ReadingArtifactItemType,
} from '@/services/readingArtifactCenter'
import { navigateToReadingMark } from '@/services/readingMarkNavigation'
import { resolveReadingMarkAnchor, type ReadingMarkColor } from '@/services/readingMarks'
import { normalizeFilePath } from '@/services/pathIdentity'
import { useAppStore } from '@/stores/appStore'
import { useReadingArtifactsStore } from '@/stores/readingArtifactsStore'
import { useReadingMarksStore } from '@/stores/readingMarksStore'

type DocumentAvailability = 'checking' | 'available' | 'unavailable'
type CenterView = 'recent' | 'documents' | 'detail'
type DetailFilter = 'all' | 'highlight' | 'annotation' | 'ai'

const ALL_TYPES: ReadingArtifactItemType[] = [
  'highlight',
  'annotation',
  'summary',
  'question_set',
  'reading_note',
  'ai_explanation',
]

const TYPE_LABELS: Record<ReadingArtifactItemType, string> = {
  highlight: '高亮',
  annotation: '批注',
  summary: '摘要',
  question_set: '问题集',
  reading_note: '阅读笔记',
  ai_explanation: 'AI 解读',
}

const COLOR_STYLES: Record<ReadingMarkColor, string> = {
  yellow: 'bg-yellow-300',
  green: 'bg-emerald-300',
  blue: 'bg-sky-300',
  pink: 'bg-pink-300',
}

function dateGroupLabel(timestamp: number): string {
  const value = new Date(timestamp)
  const today = new Date()
  const startToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()
  const startValue = new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime()
  if (startValue === startToday) return '今天'
  if (startValue === startToday - 86_400_000) return '昨天'
  return value.toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' })
}

function sourceGroupLabel(item: ReadingArtifactItem): string {
  return item.documentRefs.length > 0
    ? item.documentRefs.map((ref) => ref.fileName).join(' + ')
    : '独立成果'
}

function documentFileName(fileName: string, filePath: string): string {
  return fileName.includes('/') || fileName.includes('\\')
    ? fileName.split(/[/\\]/).filter(Boolean).pop() || fileName
    : fileName || filePath
}

function documentIdForSummary(summary: { documentId: string; filePath: string }): string {
  if (summary.documentId === '__independent__' || summary.documentId.startsWith('legacy-source:')) return summary.documentId
  return `path:${normalizeFilePath(summary.filePath || summary.documentId)}`
}

function matchesDetailFilter(item: ReadingArtifactItem, filter: DetailFilter): boolean {
  if (filter === 'all') return true
  if (filter === 'ai') return item.source === 'ai'
  return item.source === 'user' && item.type === filter
}

function getAiReplyPreview(content?: string): string {
  if (!content?.trim()) return '暂无 AI 回复内容'
  return content
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[`*_>#]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function positionForItem(
  item: ReadingArtifactItem,
  documentId: string,
  model: MarkdownPreviewModel,
): number | null {
  if (item.backing === 'reading_mark' && item.anchor) {
    if (!item.anchor) return null
    return resolveReadingMarkAnchor(model, {
      id: item.id,
      documentId,
      documentPath: item.documentRefs[0]?.filePath ?? '',
      type: 'highlight',
      anchor: item.anchor,
      color: item.color ?? 'yellow',
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    })?.from ?? item.anchor.startOffset
  }
  const ref = item.documentRefs.find((candidate) => candidate.documentId === documentId)
  if (!ref) return null
  for (const location of ref.locations) {
    if (typeof location.startOffset === 'number') return location.startOffset
    if (typeof location.startLine === 'number') {
      const offset = getSourceOffsetForLine(model, location.startLine)
      if (typeof offset === 'number') return offset
    }
  }
  return null
}

export function ReadingArtifactCenter({
  onOpenAiSource,
}: {
  onOpenAiSource: (artifact: ReadingArtifact, documentRef: ReadingArtifactDocumentRef) => void | Promise<void>
}) {
  const workspaceRoots = useAppStore((state) => state.workspaceRoots)
  const updateMark = useReadingMarksStore((state) => state.update)
  const removeMark = useReadingMarksStore((state) => state.remove)
  const marksRevision = useReadingMarksStore((state) => state.dataRevision)
  const deleteAiArtifact = useReadingArtifactsStore((state) => state.deleteArtifact)
  const artifactsRevision = useReadingArtifactsStore((state) => state.dataRevision)
  const anchorStatuses = useReadingArtifactsStore((state) => state.anchorStatuses)
  const checkAiAnchor = useReadingArtifactsStore((state) => state.checkAnchor)
  const [view, setView] = useState<CenterView>('recent')
  const [query, setQuery] = useState('')
  const [searchInput, setSearchInput] = useState('')
  const [filterOpen, setFilterOpen] = useState(false)
  const [selectedTypes, setSelectedTypes] = useState<Set<ReadingArtifactItemType>>(() => new Set(ALL_TYPES))
  const [selectedDocument, setSelectedDocument] = useState<ReadingArtifactDocumentRef | null | undefined>(undefined)
  const [detailFilter, setDetailFilter] = useState<DetailFilter>('all')
  const [detailSort, setDetailSort] = useState<'source' | 'time'>('source')
  const [availability, setAvailability] = useState<Record<string, DocumentAvailability>>({})
  const [documentModel, setDocumentModel] = useState<MarkdownPreviewModel | null>(null)
  const [loadedItems, setLoadedItems] = useState<ReadingArtifactItem[]>([])
  const [loadedAiArtifacts, setLoadedAiArtifacts] = useState<ReadingArtifact[]>([])
  const [itemsTotal, setItemsTotal] = useState(0)
  const [itemsLoading, setItemsLoading] = useState(false)
  const [itemsLoadingMore, setItemsLoadingMore] = useState(false)
  const [itemsError, setItemsError] = useState<string | null>(null)
  const [documentPage, setDocumentPage] = useState<ReadingArtifactDocumentPage>({ documents: [], total: 0, hasMore: false })
  const [documentsLoading, setDocumentsLoading] = useState(false)
  const loadedItemsRef = useRef<ReadingArtifactItem[]>([])
  const loadedAiArtifactsRef = useRef<ReadingArtifact[]>([])
  const documentPageRef = useRef<ReadingArtifactDocumentPage>({ documents: [], total: 0, hasMore: false })
  const requestSequenceRef = useRef(0)
  const documentRequestSequenceRef = useRef(0)
  const searchDebounceRef = useRef<number | null>(null)
  const [expandedAiKey, setExpandedAiKey] = useState<string | null>(null)
  const reducedMotion = useReducedMotion() ?? false
  const rootRef = useRef<HTMLDivElement>(null)
  const detailHeadingRef = useRef<HTMLHeadingElement>(null)
  const returnFocusRef = useRef<HTMLButtonElement | null>(null)
  const previousViewRef = useRef<CenterView>('recent')
  const scrollPositionsRef = useRef<Record<CenterView, number>>({ recent: 0, documents: 0, detail: 0 })

  const activeTypes = useMemo(() => {
    if (view !== 'detail' || detailFilter === 'all') return [...selectedTypes]
    if (detailFilter === 'ai') return [...selectedTypes].filter((type) => type !== 'highlight' && type !== 'annotation')
    return [...selectedTypes].filter((type) => type === detailFilter)
  }, [detailFilter, selectedTypes, view])

  const queryOptions = useMemo(() => ({
    view: view === 'documents' ? 'recent' as const : view,
    document: view === 'detail' ? selectedDocument : undefined,
    documentId: view === 'detail' ? (selectedDocument?.documentId ?? null) : undefined,
    documentPath: view === 'detail' ? selectedDocument?.filePath : undefined,
    documentFileName: view === 'detail' ? selectedDocument?.fileName : undefined,
    independent: view === 'detail' && selectedDocument === null,
    query,
    types: activeTypes,
    sort: view === 'detail' ? detailSort : 'time' as const,
    limit: 40,
  }), [activeTypes, detailSort, query, selectedDocument, view])

  const loadItems = useCallback(async (append: boolean) => {
    const offset = append ? loadedItemsRef.current.length : 0
    const requestId = ++requestSequenceRef.current
    if (append) setItemsLoadingMore(true)
    else setItemsLoading(true)
    setItemsError(null)
    try {
      const result = await loadReadingArtifactCenterItemsPage({ ...queryOptions, offset })
      if (requestId !== requestSequenceRef.current) return
      const projected = buildReadingArtifactItems(
        result.marks,
        result.artifacts,
        workspaceRoots,
      )
      const filtered = filterReadingArtifactItems(projected, new Set(activeTypes), query)
      const next = view === 'detail'
        ? listArtifactsByDocument(filtered, selectedDocument?.documentId ?? null)
        : filtered
      const combined = append ? [...loadedItemsRef.current, ...next] : next
      const nextArtifacts = append
        ? [...loadedAiArtifactsRef.current, ...result.artifacts.filter((artifact) => !loadedAiArtifactsRef.current.some((current) => current.id === artifact.id))]
        : result.artifacts
      loadedAiArtifactsRef.current = nextArtifacts
      setLoadedAiArtifacts(nextArtifacts)
      loadedItemsRef.current = combined
      setLoadedItems(combined)
      setItemsTotal(result.total)
    } catch (error) {
      if (requestId === requestSequenceRef.current) setItemsError(error instanceof Error ? error.message : String(error))
    } finally {
      if (requestId === requestSequenceRef.current) {
        setItemsLoading(false)
        setItemsLoadingMore(false)
      }
    }
  }, [activeTypes, query, queryOptions, selectedDocument, view, workspaceRoots])

  useEffect(() => {
    if (view === 'documents') {
      requestSequenceRef.current += 1
      return
    }
    if (view !== 'detail' || isDatabaseReady()) {
      loadedItemsRef.current = []
      loadedAiArtifactsRef.current = []
      setLoadedItems([])
      setLoadedAiArtifacts([])
      setItemsTotal(0)
      void loadItems(false)
    }
  }, [loadItems, view])

  const loadDocuments = useCallback(async (append: boolean) => {
    const offset = append ? documentPageRef.current.documents.length : 0
    const requestId = ++documentRequestSequenceRef.current
    setDocumentsLoading(true)
    setItemsError(null)
    try {
      const result = await loadReadingArtifactDocumentSummariesPage({ query, types: activeTypes, limit: 40, offset })
      if (requestId !== documentRequestSequenceRef.current) return
      const nextPage = {
        ...result,
        documents: append ? [...documentPageRef.current.documents, ...result.documents] : result.documents,
      }
      documentPageRef.current = nextPage
      setDocumentPage(nextPage)
    } catch (error) {
      if (requestId === documentRequestSequenceRef.current) setItemsError(error instanceof Error ? error.message : String(error))
    } finally {
      if (requestId === documentRequestSequenceRef.current) setDocumentsLoading(false)
    }
  }, [activeTypes, query])

  useEffect(() => {
    if (view !== 'documents') {
      documentRequestSequenceRef.current += 1
      return
    }
    const emptyPage = { documents: [], total: 0, hasMore: false }
    documentPageRef.current = emptyPage
    setDocumentPage(emptyPage)
    void loadDocuments(false)
  }, [loadDocuments, view])

  useEffect(() => {
    if (marksRevision === 0 && artifactsRevision === 0) return
    if (view === 'documents') void loadDocuments(false)
    else void loadItems(false)
  }, [artifactsRevision, loadDocuments, loadItems, marksRevision, view])

  useEffect(() => {
    for (const artifact of loadedAiArtifacts) {
      if (artifact.source?.filePath && !anchorStatuses[artifact.id]) void checkAiAnchor(artifact)
    }
  }, [anchorStatuses, checkAiAnchor, loadedAiArtifacts])

  const aiById = useMemo(() => new Map(loadedAiArtifacts.map((artifact) => [artifact.id, artifact])), [loadedAiArtifacts])
  const items = loadedItems
  const recentItems = items
  const documentSummaries = useMemo(() => documentPage.documents.map((summary) => ({
      documentRef: summary.documentId === '__independent__' ? null : {
        documentId: documentIdForSummary(summary),
        filePath: summary.filePath,
        fileName: documentFileName(summary.fileName, summary.filePath),
        locations: [],
      },
      total: summary.total,
      highlights: summary.highlights,
      annotations: summary.annotations,
      aiArtifacts: summary.aiArtifacts,
      latestCreatedAt: summary.latestCreatedAt,
    })), [documentPage.documents])

  useEffect(() => {
    const refs = new Map<string, ReadingArtifactDocumentRef>()
    for (const item of items) {
      for (const ref of item.documentRefs) refs.set(ref.documentId, ref)
    }
    let cancelled = false
    for (const ref of refs.values()) {
      if (!ref.filePath) {
        setAvailability((current) => ({ ...current, [ref.documentId]: 'unavailable' }))
        continue
      }
      setAvailability((current) => ({ ...current, [ref.documentId]: 'checking' }))
      void fileExists(ref.filePath)
        .then((exists) => {
          if (!cancelled) setAvailability((current) => ({ ...current, [ref.documentId]: exists ? 'available' : 'unavailable' }))
        })
        .catch(() => {
          if (!cancelled) setAvailability((current) => ({ ...current, [ref.documentId]: 'unavailable' }))
        })
    }
    return () => { cancelled = true }
  }, [items])

  useEffect(() => {
    let cancelled = false
    setDocumentModel(null)
    if (view !== 'detail' || !selectedDocument?.filePath || availability[selectedDocument.documentId] !== 'available') return
    void readRememberedMarkdownFileForOpen(selectedDocument.filePath)
      .then((content) => {
        if (!cancelled) setDocumentModel(createMarkdownPreviewModel(content))
      })
      .catch(() => {
        if (!cancelled) setAvailability((current) => ({ ...current, [selectedDocument.documentId]: 'unavailable' }))
      })
    return () => { cancelled = true }
  }, [availability, selectedDocument, view])

  useEffect(() => {
    setExpandedAiKey((current) => current && items.some((item) => item.key === current) ? current : null)
  }, [items])

  useEffect(() => {
    const scroller = rootRef.current?.parentElement
    const frame = requestAnimationFrame(() => {
      if (scroller) scroller.scrollTop = view === 'detail' ? 0 : scrollPositionsRef.current[view]
      const previous = previousViewRef.current
      if (previous !== view) {
        if (view === 'detail') detailHeadingRef.current?.focus()
        else if (previous === 'detail') returnFocusRef.current?.focus()
        previousViewRef.current = view
      }
    })
    return () => cancelAnimationFrame(frame)
  }, [view])

  const changeView = (next: CenterView) => {
    if (next === view) return
    const scroller = rootRef.current?.parentElement
    if (scroller) scrollPositionsRef.current[view] = scroller.scrollTop
    setExpandedAiKey(null)
    setView(next)
  }

  const openDocument = (documentRef: ReadingArtifactDocumentRef | null, origin?: HTMLButtonElement) => {
    returnFocusRef.current = origin ?? null
    setSelectedDocument(documentRef)
    setDetailFilter('all')
    setDetailSort(documentRef ? 'source' : 'time')
    changeView('detail')
  }

  const toggleType = (type: ReadingArtifactItemType) => {
    setSelectedTypes((current) => {
      const next = new Set(current)
      if (next.has(type)) next.delete(type)
      else next.add(type)
      return next
    })
  }

  useEffect(() => () => {
    if (searchDebounceRef.current !== null) window.clearTimeout(searchDebounceRef.current)
  }, [])

  const loading = view === 'documents'
    ? documentsLoading && documentPage.documents.length === 0
    : itemsLoading && items.length === 0
  const openReadingMark = async (markId: string) => {
    try {
      await navigateToReadingMark(markId)
    } catch (error) {
      toast.error(describeFileOperationError(error, '定位批注失败'))
    }
  }
  const detailItems = useMemo(() => items.filter((item) => matchesDetailFilter(item, detailFilter)), [detailFilter, items])
  const positionedDetail = useMemo(() => {
    if (!selectedDocument || detailSort !== 'source' || !documentModel) return { positioned: [], other: detailItems }
    const positioned: Array<{ item: ReadingArtifactItem; position: number }> = []
    const other: ReadingArtifactItem[] = []
    for (const item of detailItems) {
      const position = positionForItem(item, selectedDocument.documentId, documentModel)
      if (position === null) other.push(item)
      else positioned.push({ item, position })
    }
    positioned.sort((left, right) => left.position - right.position || left.item.createdAt - right.item.createdAt)
    return { positioned: positioned.map((entry) => entry.item), other }
  }, [detailItems, detailSort, documentModel, selectedDocument])

  const renderCard = (item: ReadingArtifactItem, currentDocument?: ReadingArtifactDocumentRef | null) => (
    <ArtifactCard
      key={item.key}
      item={item}
      availability={availability}
      anchorStatus={item.source === 'ai' ? anchorStatuses[item.id] : undefined}
      currentDocument={currentDocument}
      reducedMotion={reducedMotion}
      expanded={item.source === 'ai' && expandedAiKey === item.key}
      onToggleExpand={item.source === 'ai' ? () => setExpandedAiKey((current) => current === item.key ? null : item.key) : undefined}
      onNavigateMark={() => void openReadingMark(item.id)}
      onUpdateMark={(color, note) => {
        const path = item.documentRefs[0]?.filePath
        if (!path) return Promise.reject(new Error('来源文档不可用'))
        return updateMark(item.id, path, { ...(color ? { color } : {}), ...(note !== undefined ? { note } : {}) })
      }}
      onDeleteMark={() => {
        const path = item.documentRefs[0]?.filePath
        return path ? removeMark(item.id, path) : Promise.reject(new Error('来源文档不可用'))
      }}
      onDeleteAi={() => deleteAiArtifact(item.id)}
      onOpenAiSource={(ref) => {
      const artifact = aiById.get(item.id)
        if (artifact) return onOpenAiSource(artifact, ref)
      }}
    />
  )

  return (
    <div ref={rootRef} className="min-h-full bg-gm-canvas px-4 py-3 text-gm-text">
      <div>
          {view !== 'detail' ? (
            <>
              <nav aria-label="阅读成果视图" role="tablist" className="mb-3 flex items-center gap-5 border-b border-gm-border-subtle">
                {(['recent', 'documents'] as const).map((value) => (
                  <button
                    key={value}
                    type="button"
                    role="tab"
                    aria-selected={view === value}
                    onClick={() => changeView(value)}
                    className={`border-b-2 px-0.5 pb-2 text-caption font-bold ${view === value ? 'border-gm-primary text-gm-text' : 'border-transparent text-gm-text-tertiary hover:text-gm-text-secondary'}`}
                  >
                    {value === 'recent' ? '最近' : '按文档'}
                  </button>
                ))}
              </nav>
              <div className="relative mb-4 flex items-center gap-2">
                <input type="search" value={searchInput} onChange={(event) => {
                  const value = event.target.value
                  setSearchInput(value)
                  if (searchDebounceRef.current !== null) window.clearTimeout(searchDebounceRef.current)
                  searchDebounceRef.current = window.setTimeout(() => {
                    searchDebounceRef.current = null
                    setQuery(value)
                  }, 300)
                }} placeholder="搜索阅读成果" className="min-w-0 flex-1 rounded-md border border-gm-border bg-gm-surface px-2.5 py-2 text-caption outline-none placeholder:text-gm-text-disabled focus:border-gm-primary" />
                <button type="button" aria-expanded={filterOpen} onClick={() => setFilterOpen((value) => !value)} className="flex shrink-0 items-center gap-1.5 rounded-md border border-gm-border bg-gm-surface px-2.5 py-2 text-caption font-bold text-gm-text-secondary hover:bg-gm-surface-hover">
                  <Filter size={14} strokeWidth={1.8} aria-hidden="true" />
                  <span>筛选</span>
                  <span className="border-l border-gm-border-subtle pl-1.5 text-micro text-gm-text-tertiary">{selectedTypes.size}/{ALL_TYPES.length}</span>
                </button>
                {filterOpen && <TypeFilter selected={selectedTypes} onToggle={toggleType} onClose={() => setFilterOpen(false)} />}
              </div>
            </>
          ) : (
            <motion.div
              initial={reducedMotion ? false : { opacity: 0, transform: 'translateX(6px)' }}
              animate={{ opacity: 1, transform: 'translateX(0)' }}
              transition={reducedMotion ? { duration: 0 } : { duration: 0.16, ease: [0.23, 1, 0.32, 1] }}
              className="mb-3 flex items-center gap-2"
            >
              <button type="button" aria-label="返回按文档" onClick={() => changeView('documents')} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-gm-text-tertiary hover:bg-gm-surface-hover hover:text-gm-primary focus-visible:bg-gm-surface-hover focus-visible:outline-none">
                <ChevronLeft size={17} strokeWidth={1.8} aria-hidden="true" />
              </button>
              <div className="min-w-0 flex-1">
                <h2 ref={detailHeadingRef} tabIndex={-1} className="truncate text-body font-bold outline-none">{selectedDocument?.fileName ?? '独立成果'}</h2>
                {selectedDocument && availability[selectedDocument.documentId] === 'unavailable' && <div className="mt-1 text-micro text-gm-warning">来源文档不可用</div>}
              </div>
            </motion.div>
          )}

          {loading ? <EmptyState text="正在加载阅读成果…" /> : view === 'recent' ? (
            <RecentView items={recentItems} renderCard={renderCard} />
          ) : view === 'documents' ? (
            <DocumentView summaries={documentSummaries} availability={availability} onOpen={openDocument} />
          ) : (
            <motion.div
              initial={reducedMotion ? false : { opacity: 0, transform: 'translateX(6px)' }}
              animate={{ opacity: 1, transform: 'translateX(0)' }}
              transition={reducedMotion ? { duration: 0 } : { duration: 0.16, ease: [0.23, 1, 0.32, 1] }}
            >
              <DetailView
                independent={!selectedDocument}
                filter={detailFilter}
                sort={detailSort}
                onFilter={setDetailFilter}
                onSort={setDetailSort}
                positioned={detailSort === 'time' ? [...detailItems].sort((a, b) => a.createdAt - b.createdAt) : positionedDetail.positioned}
                other={detailSort === 'source' ? positionedDetail.other : []}
                renderCard={(item) => renderCard(item, selectedDocument)}
              />
            </motion.div>
          )}
          {itemsError && (
            <div className="mt-3 flex items-center justify-center gap-2 text-micro text-gm-error">
              <span>加载失败：{itemsError}</span>
              <button type="button" className="underline underline-offset-2" onClick={() => void (view === 'documents' ? loadDocuments(false) : loadItems(false))}>重试</button>
            </div>
          )}
          {view !== 'documents' && items.length > 0 && items.length < itemsTotal && (
            <button type="button" disabled={itemsLoadingMore} onClick={() => void loadItems(true)} className="mt-3 w-full rounded-md border border-gm-border py-2 text-caption text-gm-text-secondary hover:bg-gm-surface-hover disabled:opacity-50">{itemsLoadingMore ? '加载中…' : '加载更多'}</button>
          )}
          {view === 'documents' && documentPage.documents.length > 0 && documentPage.documents.length < documentPage.total && (
            <button type="button" disabled={documentsLoading} onClick={() => void loadDocuments(true)} className="mt-3 w-full rounded-md border border-gm-border py-2 text-caption text-gm-text-secondary hover:bg-gm-surface-hover disabled:opacity-50">{documentsLoading ? '加载中…' : '加载更多'}</button>
          )}
      </div>
    </div>
  )
}

function TypeFilter({ selected, onToggle, onClose }: { selected: ReadonlySet<ReadingArtifactItemType>; onToggle: (type: ReadingArtifactItemType) => void; onClose: () => void }) {
  return (
    <div className="absolute right-0 top-10 z-30 w-48 rounded-lg border border-gm-border bg-gm-surface p-2 shadow-lg">
      <div className="flex items-center justify-between px-1 pb-1 text-micro font-bold text-gm-text-tertiary"><span>人工成果</span><button type="button" onClick={onClose}>完成</button></div>
      {(['highlight', 'annotation'] as const).map((type) => <FilterCheck key={type} type={type} checked={selected.has(type)} onToggle={onToggle} />)}
      <div className="mt-2 border-t border-gm-border-subtle px-1 pb-1 pt-2 text-micro font-bold text-gm-text-tertiary">AI 成果</div>
      {(['summary', 'question_set', 'reading_note', 'ai_explanation'] as const).map((type) => <FilterCheck key={type} type={type} checked={selected.has(type)} onToggle={onToggle} />)}
    </div>
  )
}

function FilterCheck({ type, checked, onToggle }: { type: ReadingArtifactItemType; checked: boolean; onToggle: (type: ReadingArtifactItemType) => void }) {
  return <label className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-caption hover:bg-gm-surface-hover"><input type="checkbox" checked={checked} onChange={() => onToggle(type)} />{TYPE_LABELS[type]}</label>
}

function RecentView({ items, renderCard }: { items: ReadingArtifactItem[]; renderCard: (item: ReadingArtifactItem) => React.ReactNode }) {
  if (items.length === 0) return <EmptyState text="当前条件下没有阅读成果" />
  const dates = new Map<string, Map<string, ReadingArtifactItem[]>>()
  for (const item of items) {
    const date = dateGroupLabel(item.createdAt)
    const source = sourceGroupLabel(item)
    const sources = dates.get(date) ?? new Map<string, ReadingArtifactItem[]>()
    sources.set(source, [...(sources.get(source) ?? []), item])
    dates.set(date, sources)
  }
  return <div className="space-y-6">{[...dates].map(([date, sources]) => <section key={date}><h3 className="mb-2 text-caption font-bold text-gm-text-secondary">{date}</h3><div className="space-y-4">{[...sources].map(([source, grouped]) => <div key={source}><div className="mb-1.5 truncate text-micro font-bold text-gm-text-tertiary">{source}</div><div className="space-y-2">{grouped.map((item) => renderCard(item))}</div></div>)}</div></section>)}</div>
}

function DocumentView({ summaries, availability, onOpen }: { summaries: ReturnType<typeof listArtifactDocuments>; availability: Record<string, DocumentAvailability>; onOpen: (ref: ReadingArtifactDocumentRef | null, origin?: HTMLButtonElement) => void }) {
  if (summaries.length === 0) return <EmptyState text="当前条件下没有文档成果" />
  return <div className="divide-y divide-gm-border-subtle overflow-hidden rounded-lg border border-gm-border-subtle bg-gm-surface">{summaries.map((summary) => {
    const ref = summary.documentRef
    return <button key={ref?.documentId ?? '__independent__'} type="button" onClick={(event) => onOpen(ref, event.currentTarget)} className="group flex w-full items-center gap-3 px-2.5 py-3 text-left hover:bg-gm-surface-hover focus-visible:bg-gm-surface-hover focus-visible:outline-none"><span className="flex h-7 w-7 shrink-0 items-center justify-center text-gm-primary"><FileText size={16} strokeWidth={1.7} aria-hidden="true" /></span><span className="min-w-0 flex-1"><span className="block truncate text-caption font-bold">{ref?.fileName ?? '独立成果'}</span><span className="mt-0.5 block truncate text-micro text-gm-text-tertiary">{ref && availability[ref.documentId] === 'unavailable' ? '来源文档不可用' : `${summary.highlights} 高亮 · ${summary.annotations} 批注 · ${summary.aiArtifacts} AI 成果`}</span></span><span className="flex items-center gap-1 text-micro text-gm-text-tertiary"><span>{summary.total} 条</span><ChevronRight size={15} strokeWidth={1.8} aria-hidden="true" /></span></button>
  })}</div>
}

function DetailView({ independent, filter, sort, onFilter, onSort, positioned, other, renderCard }: { independent: boolean; filter: DetailFilter; sort: 'source' | 'time'; onFilter: (value: DetailFilter) => void; onSort: (value: 'source' | 'time') => void; positioned: ReadingArtifactItem[]; other: ReadingArtifactItem[]; renderCard: (item: ReadingArtifactItem) => React.ReactNode }) {
  return <>
    <div className="mb-3 flex min-h-8 flex-wrap items-start gap-2">
      <nav aria-label="成果分类" role="tablist" className="flex min-w-0 flex-[1_1_12rem] flex-wrap items-center gap-1">
        {(['all', 'highlight', 'annotation', 'ai'] as const).map((value) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={filter === value}
            onClick={() => onFilter(value)}
            className={`h-8 shrink-0 rounded-md border px-2.5 text-micro font-bold outline-none transition-colors focus-visible:border-gm-primary ${filter === value ? 'border-gm-primary bg-gm-primary-subtle text-gm-primary' : 'border-transparent text-gm-text-secondary hover:border-gm-border-subtle hover:bg-gm-surface'}`}
          >
            {({ all: '全部', highlight: '高亮', annotation: '批注', ai: 'AI 成果' })[value]}
          </button>
        ))}
      </nav>
      {!independent && <SortMenu value={sort} onChange={onSort} />}
    </div>
    <div className="space-y-2">{positioned.map(renderCard)}</div>
    {other.length > 0 && <section className="mt-5 pt-1"><h3 className="mb-2 text-micro font-bold tracking-wide text-gm-text-tertiary">其他成果</h3><div className="space-y-2">{other.map(renderCard)}</div></section>}
    {positioned.length === 0 && other.length === 0 && <EmptyState text="当前条件下没有阅读成果" />}
  </>
}

function SortMenu({ value, onChange }: { value: 'source' | 'time'; onChange: (value: 'source' | 'time') => void }) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const label = value === 'source' ? '原文顺序' : '时间顺序'

  useEffect(() => {
    if (!open) return
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setOpen(false)
      triggerRef.current?.focus()
    }
    document.addEventListener('pointerdown', closeOnOutsidePointer)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointer)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [open])

  const select = (next: 'source' | 'time') => {
    onChange(next)
    setOpen(false)
    triggerRef.current?.focus()
  }

  return (
    <div ref={rootRef} className="relative ml-auto shrink-0">
      <button
        ref={triggerRef}
        type="button"
        aria-label={`排序：${label}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        className="flex h-8 items-center gap-1.5 rounded-md border border-gm-border bg-gm-surface px-2.5 text-micro font-bold text-gm-text-secondary outline-none transition-colors hover:bg-gm-surface-hover focus-visible:border-gm-primary focus-visible:ring-1 focus-visible:ring-gm-primary/30"
      >
        <span>{label}</span>
        <ChevronDown size={14} strokeWidth={1.8} className={`transition-transform duration-150 ${open ? 'rotate-180' : ''}`} aria-hidden="true" />
      </button>
      {open && (
        <div role="menu" aria-label="排序方式" className="absolute right-0 top-full z-30 mt-1 min-w-full whitespace-nowrap rounded-lg border border-gm-border bg-gm-surface-elevated p-1 shadow-lg">
          {(['source', 'time'] as const).map((option) => {
            const optionLabel = option === 'source' ? '原文顺序' : '时间顺序'
            const selected = value === option
            return (
              <button
                key={option}
                type="button"
                role="menuitemradio"
                aria-checked={selected}
                onClick={() => select(option)}
                className={`flex w-full items-center justify-between gap-3 rounded-md px-2 py-1.5 text-left text-micro outline-none transition-colors hover:bg-gm-surface-hover focus-visible:bg-gm-surface-hover ${selected ? 'font-bold text-gm-primary' : 'text-gm-text-secondary'}`}
              >
                <span>{optionLabel}</span>
                <Check size={13} strokeWidth={2} className={selected ? 'opacity-100' : 'opacity-0'} aria-hidden="true" />
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

function ArtifactCard({ item, availability, anchorStatus, currentDocument, reducedMotion, expanded, onToggleExpand, onNavigateMark, onUpdateMark, onDeleteMark, onDeleteAi, onOpenAiSource }: { item: ReadingArtifactItem; availability: Record<string, DocumentAvailability>; anchorStatus?: SourceAnchorStatus; currentDocument?: ReadingArtifactDocumentRef | null; reducedMotion: boolean; expanded: boolean; onToggleExpand?: () => void; onNavigateMark: () => void; onUpdateMark: (color?: ReadingMarkColor, note?: string) => Promise<unknown>; onDeleteMark: () => Promise<void>; onDeleteAi: () => Promise<void>; onOpenAiSource: (ref: ReadingArtifactDocumentRef) => void | Promise<void> }) {
  const [editing, setEditing] = useState(false)
  const [note, setNote] = useState(item.content ?? '')
  const isUser = item.source === 'user'
  const refs = currentDocument ? [currentDocument] : item.documentRefs
  const webReferences = item.references?.filter((reference) => reference.kind === 'web') ?? []
  const question = item.question?.trim() || ''
  const collapsedTitle = question || item.title || '未记录原问题'
  const replyPreview = getAiReplyPreview(item.content)
  const remove = () => {
    const message = isUser ? '确认删除这条人工成果吗？正文中的高亮或批注也会同步移除。' : '确认删除这条 AI 阅读成果吗？多文档入口会一并移除。'
    if (window.confirm(message)) void (isUser ? onDeleteMark() : onDeleteAi())
  }
  const contentId = `reading-artifact-${item.id}`
  const triggerId = `${contentId}-trigger`
  const contentMotion = reducedMotion
    ? { initial: { opacity: 1, height: 'auto' }, animate: { opacity: 1, height: 'auto' }, exit: { opacity: 1, height: 0 }, transition: { duration: 0 } }
    : { initial: { opacity: 0, height: 0 }, animate: { opacity: 1, height: 'auto' }, exit: { opacity: 0, height: 0 }, transition: { height: { duration: 0.24, ease: 'easeOut' as const }, opacity: { duration: 0.16, ease: 'easeOut' as const } } }
  return <article data-state={isUser ? undefined : expanded ? 'open' : 'closed'} className="overflow-hidden rounded-xl border border-gm-border-subtle bg-gm-surface shadow-sm">
    {isUser ? (
      <div className="p-3">
        <div className="flex items-center gap-2"><span className={`h-2.5 w-2.5 rounded-full ${item.color ? COLOR_STYLES[item.color] : 'bg-gm-primary/50'}`} /><span className="text-micro font-bold text-gm-text-secondary">{TYPE_LABELS[item.type]}</span><span className="ml-auto text-micro text-gm-text-tertiary">{new Date(item.createdAt).toLocaleDateString('zh-CN')}</span></div>
        {(item.quote || editing || item.content) && <div className="mt-2 max-h-64 overflow-y-auto pr-1">
          {item.quote && <blockquote className="border-l-2 border-gm-border pl-2 text-caption leading-relaxed text-gm-text-secondary">“{item.quote}”</blockquote>}
          {editing ? <div className={item.quote ? 'mt-2' : ''}><textarea value={note} onChange={(event) => setNote(event.target.value)} className="min-h-20 w-full rounded-lg border border-gm-border bg-gm-canvas p-2 text-caption outline-none focus:border-gm-primary" /><div className="mt-1 flex justify-end gap-2"><button type="button" onClick={() => { setNote(item.content ?? ''); setEditing(false) }} className="text-micro text-gm-text-tertiary">取消</button><button type="button" onClick={() => void onUpdateMark(undefined, note).then(() => setEditing(false))} className="text-micro font-bold text-gm-primary">保存</button></div></div> : item.content && <p className={item.quote ? 'mt-2 whitespace-pre-wrap text-caption leading-relaxed text-gm-text' : 'whitespace-pre-wrap text-caption leading-relaxed text-gm-text'}>{item.content}</p>}
        </div>}
        {refs.length > 0 && <div className="mt-2 flex flex-wrap gap-1">{refs.map((ref) => <button key={ref.documentId} type="button" disabled={!ref.filePath || availability[ref.documentId] === 'unavailable'} onClick={onNavigateMark} className="rounded-md border border-gm-border-subtle px-2 py-1 text-micro text-gm-text-secondary hover:text-gm-primary disabled:cursor-not-allowed disabled:text-gm-warning">{availability[ref.documentId] === 'unavailable' ? `${ref.fileName} · 来源文档不可用` : `${ref.fileName} · 查看原文`}</button>)}</div>}
        <div className="mt-2 flex items-center gap-2 border-t border-gm-border-subtle pt-2">{(['yellow', 'green', 'blue', 'pink'] as const).map((color) => <button key={color} type="button" aria-label={`改为${color}`} onClick={() => void onUpdateMark(color)} className={`h-4 w-4 rounded-full ${COLOR_STYLES[color]} ${item.color === color ? 'ring-2 ring-gm-primary ring-offset-1' : ''}`} />)}{item.type === 'annotation' && <button type="button" onClick={() => setEditing(true)} className="ml-1 text-micro text-gm-primary">编辑批注</button>}<button type="button" onClick={remove} className="ml-auto text-micro text-gm-error">删除</button></div>
      </div>
    ) : (
      <>
        <button id={triggerId} type="button" aria-expanded={expanded} aria-controls={contentId} onClick={onToggleExpand} className="group/trigger flex w-full items-start gap-3 px-3.5 py-3.5 text-left outline-none transition-colors duration-150 hover:bg-gm-surface-hover focus-visible:bg-gm-surface-hover active:scale-[0.995]">
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-1.5 text-micro font-bold text-gm-text-secondary"><span className="rounded-full bg-gm-primary-subtle px-1.5 py-0.5 text-[10px] font-bold tracking-[0.04em] text-gm-primary">AI · {TYPE_LABELS[item.type]}</span>{(refs.length + webReferences.length) > 0 && <span className="font-normal text-gm-text-tertiary">· {refs.length + webReferences.length} 个来源</span>}</span>
            <span className="mt-1 block line-clamp-2 text-caption font-bold leading-relaxed text-gm-text">{collapsedTitle}</span>
            <span className="mt-1 block truncate text-micro leading-relaxed text-gm-text-tertiary">{replyPreview}</span>
          </span>
          <span className="flex shrink-0 items-center gap-1.5 pt-0.5 text-micro text-gm-text-tertiary"><span>{expanded ? '收起' : '展开'}</span><ChevronDown size={15} strokeWidth={1.8} className={`transition-transform duration-200 ${expanded ? 'rotate-180 text-gm-primary' : 'group-hover/trigger:translate-y-0.5'}`} aria-hidden="true" /></span>
        </button>
        <AnimatePresence initial={false}>
          {expanded && <motion.div key="details" id={contentId} role="region" aria-labelledby={triggerId} {...contentMotion} className="overflow-hidden">
            <div className="mx-3.5 mb-3.5 border-t border-gm-border-subtle pt-3.5">
              <div className="space-y-3">
                <section className="rounded-lg bg-gm-canvas/60 px-3 py-2.5"><h4 className="mb-1 text-micro font-bold tracking-wide text-gm-text-tertiary">原问题</h4><p className="text-caption leading-relaxed text-gm-text">{question || '未记录原问题'}</p></section>
                <section><h4 className="mb-1.5 text-micro font-bold tracking-wide text-gm-text-tertiary">AI 回复</h4>{item.content?.trim() ? <div tabIndex={0} aria-label="AI 回复正文" className="max-h-80 overflow-y-auto rounded-lg border border-gm-border-subtle bg-gm-canvas/35 px-3 py-2.5 pr-1 prose prose-sm max-w-none text-caption leading-relaxed text-gm-text-secondary [&_p]:my-1.5 [&_ul]:my-1.5 [&_ol]:my-1.5 [&_pre]:max-w-full [&_pre]:overflow-x-auto"><ReactMarkdown remarkPlugins={[remarkGfm]}>{item.content}</ReactMarkdown></div> : <p className="text-caption text-gm-text-tertiary">暂无 AI 回复内容</p>}</section>
                <section><h4 className="mb-1.5 text-micro font-bold tracking-wide text-gm-text-tertiary">参考资料</h4><div className="flex flex-wrap gap-x-3 gap-y-1">{refs.map((ref) => <button key={ref.documentId} type="button" aria-label={!ref.filePath || availability[ref.documentId] === 'unavailable' ? `${ref.fileName} · 来源文档不可用` : `${ref.fileName} · 查看原文`} disabled={!ref.filePath || availability[ref.documentId] === 'unavailable'} onClick={() => void onOpenAiSource(ref)} className="inline-flex max-w-full items-center gap-1 px-0.5 py-1 text-micro text-gm-primary underline-offset-2 hover:underline disabled:cursor-not-allowed disabled:text-gm-warning"><FileText size={13} strokeWidth={1.7} aria-hidden="true" /><span className="truncate">{availability[ref.documentId] === 'unavailable' || !ref.filePath ? `${ref.fileName} · 来源文档不可用` : `${ref.fileName} · 查看原文`}</span></button>)}{webReferences.map((reference, index) => <a key={`${reference.url}-${index}`} aria-label={`打开来源 ${reference.title || reference.url}`} href={reference.url} target="_blank" rel="noreferrer" className="inline-flex max-w-full items-center gap-1 px-0.5 py-1 text-micro text-gm-primary underline-offset-2 hover:underline"><ExternalLink size={13} strokeWidth={1.7} aria-hidden="true" /><span className="truncate">{reference.title || reference.url}</span></a>)}{refs.length === 0 && webReferences.length === 0 && <span className="text-micro text-gm-text-tertiary">暂无可跳转来源</span>}</div>{anchorStatus === 'changed' && <p className="mt-1.5 text-micro text-gm-warning">原文已变更，定位可能偏移</p>}</section>
              </div>
              <div className="mt-3 flex justify-end border-t border-gm-border-subtle pt-2"><button type="button" onClick={remove} className="text-micro text-gm-text-tertiary hover:text-gm-error">删除成果</button></div>
            </div>
          </motion.div>}
        </AnimatePresence>
      </>
    )}
  </article>
}

function EmptyState({ text }: { text: string }) {
  return <div className="py-12 text-center text-caption text-gm-text-tertiary">{text}</div>
}
