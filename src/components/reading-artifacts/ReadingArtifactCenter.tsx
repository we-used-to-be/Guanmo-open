import { Check, ChevronDown, ChevronLeft, ChevronRight, ExternalLink, FileText, Filter } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
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
import { loadReadingArtifactItemByKeyCommand } from '@/services/agent/artifactCommands'
import { isDatabaseReady } from '@/services/database/db'
import { createMarkdownPreviewModel, getSourceOffsetForLine, type MarkdownPreviewModel } from '@/services/markdownPreviewModel'
import { readRememberedMarkdownFileForOpen } from '@/services/markdownFileOpenPolicy'
import { describeFileOperationError } from '@/services/fileOperationErrors'
import { toast } from '@/services/toast'
import {
  buildReadingArtifactItems,
  filterReadingArtifactItems,
  listRecentArtifacts,
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
import { MORPHING_MOTION_TOKENS } from '@/components/common/useMorphingMotion'

type DocumentAvailability = 'checking' | 'available' | 'unavailable'
type CenterView = 'recent' | 'documents' | 'detail' | 'focus'
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

const COLOR_RAIL_STYLES: Record<ReadingMarkColor, string> = {
  yellow: 'bg-amber-400',
  green: 'bg-emerald-400',
  blue: 'bg-sky-400',
  pink: 'bg-pink-400',
}

const COLOR_NOTE_STYLES: Record<ReadingMarkColor, CSSProperties> = {
  yellow: {
    borderColor: 'color-mix(in srgb, var(--gm-accent) 38%, var(--gm-border) 62%)',
    backgroundColor: 'color-mix(in srgb, var(--gm-accent) 12%, var(--gm-surface-elevated) 88%)',
  },
  green: {
    borderColor: 'color-mix(in srgb, var(--gm-primary) 38%, var(--gm-border) 62%)',
    backgroundColor: 'color-mix(in srgb, var(--gm-primary) 10%, var(--gm-surface-elevated) 90%)',
  },
  blue: {
    borderColor: 'color-mix(in srgb, #8fb7d8 38%, var(--gm-border) 62%)',
    backgroundColor: 'color-mix(in srgb, #8fb7d8 10%, var(--gm-surface-elevated) 90%)',
  },
  pink: {
    borderColor: 'color-mix(in srgb, #e98ab8 38%, var(--gm-border) 62%)',
    backgroundColor: 'color-mix(in srgb, #e98ab8 10%, var(--gm-surface-elevated) 90%)',
  },
}

const AI_QUESTION_STYLES: CSSProperties = {
  borderColor: 'color-mix(in srgb, var(--gm-border) 82%, var(--gm-primary) 18%)',
  backgroundColor: 'color-mix(in srgb, var(--gm-canvas) 74%, var(--gm-surface-elevated) 26%)',
}

const AI_REPLY_STYLES: CSSProperties = {
  borderColor: 'color-mix(in srgb, var(--gm-primary) 30%, var(--gm-border) 70%)',
  backgroundColor: 'color-mix(in srgb, var(--gm-primary) 7%, var(--gm-surface-elevated) 93%)',
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
  focusKey,
  onCloseFocus,
}: {
  onOpenAiSource: (artifact: ReadingArtifact, documentRef: ReadingArtifactDocumentRef) => void | Promise<void>
  focusKey?: string | null
  onCloseFocus?: () => void
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
  const [detailContent, setDetailContent] = useState<{
    items: ReadingArtifactItem[]
    filter: DetailFilter
    sort: 'source' | 'time'
    pending: boolean
    version: number
  }>({ items: [], filter: 'all', sort: 'source', pending: false, version: 0 })
  const [availability, setAvailability] = useState<Record<string, DocumentAvailability>>({})
  const [documentModel, setDocumentModel] = useState<MarkdownPreviewModel | null>(null)
  const [loadedItems, setLoadedItems] = useState<ReadingArtifactItem[]>([])
  const [loadedAiArtifacts, setLoadedAiArtifacts] = useState<ReadingArtifact[]>([])
  const [itemsTotal, setItemsTotal] = useState(0)
  const [itemsLoading, setItemsLoading] = useState(true)
  const [itemsLoadingMore, setItemsLoadingMore] = useState(false)
  const [itemsError, setItemsError] = useState<string | null>(null)
  const [documentPage, setDocumentPage] = useState<ReadingArtifactDocumentPage>({ documents: [], total: 0, hasMore: false })
  const [documentsLoading, setDocumentsLoading] = useState(true)
  const loadedItemsRef = useRef<ReadingArtifactItem[]>([])
  const loadedAiArtifactsRef = useRef<ReadingArtifact[]>([])
  const documentPageRef = useRef<ReadingArtifactDocumentPage>({ documents: [], total: 0, hasMore: false })
  const requestSequenceRef = useRef(0)
  const documentRequestSequenceRef = useRef(0)
  const searchDebounceRef = useRef<number | null>(null)
  const [expandedAiKey, setExpandedAiKey] = useState<string | null>(null)
  const reducedMotion = useReducedMotion() ?? false
  const rootRef = useRef<HTMLDivElement>(null)
  const contentScrollerRef = useRef<HTMLDivElement>(null)
  const detailHeadingRef = useRef<HTMLHeadingElement>(null)
  const returnFocusRef = useRef<HTMLButtonElement | null>(null)
  const previousViewRef = useRef<CenterView>('recent')
  const scrollPositionsRef = useRef<Record<CenterView, number>>({ recent: 0, documents: 0, detail: 0, focus: 0 })
  const focusReturnViewRef = useRef<CenterView>('recent')
  const [focusLoading, setFocusLoading] = useState(false)
  const [focusError, setFocusError] = useState<string | null>(null)

  const activeTypes = useMemo(() => {
    if (view !== 'detail' || detailFilter === 'all') return [...selectedTypes]
    if (detailFilter === 'ai') return [...selectedTypes].filter((type) => type !== 'highlight' && type !== 'annotation')
    return [...selectedTypes].filter((type) => type === detailFilter)
  }, [detailFilter, selectedTypes, view])

  const queryOptions = useMemo(() => ({
    view: view === 'detail' ? 'detail' as const : 'recent' as const,
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
    let detailSnapshot: ReadingArtifactItem[] | null = null
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
      if (view === 'detail') detailSnapshot = combined
      setItemsTotal(result.total)
    } catch (error) {
      if (requestId === requestSequenceRef.current) setItemsError(error instanceof Error ? error.message : String(error))
    } finally {
      if (requestId === requestSequenceRef.current) {
        setItemsLoading(false)
        setItemsLoadingMore(false)
        if (view === 'detail') {
          setDetailContent((current) => ({
            ...current,
            ...(detailSnapshot ? { items: detailSnapshot } : {}),
            ...(append ? {} : { filter: detailFilter, sort: detailSort, pending: false, version: current.version + 1 }),
          }))
        }
      }
    }
  }, [activeTypes, detailFilter, detailSort, query, queryOptions, selectedDocument, view, workspaceRoots])

  useEffect(() => {
    if (view === 'documents' || view === 'focus') {
      requestSequenceRef.current += 1
      return
    }
    if (view !== 'detail' || isDatabaseReady()) {
      void loadItems(false)
    }
  }, [loadItems, view])

  useEffect(() => {
    if (!focusKey) return
    if (view !== 'focus') focusReturnViewRef.current = view
    const requestId = ++requestSequenceRef.current
    setView('focus')
    setFocusLoading(true)
    setFocusError(null)
    void loadReadingArtifactItemByKeyCommand(focusKey, workspaceRoots)
      .then((loaded) => {
        if (requestId !== requestSequenceRef.current) return
        if (!loaded) {
          setFocusError('该阅读成果已不存在或无法读取')
          setLoadedItems([])
          setLoadedAiArtifacts([])
          return
        }
        loadedItemsRef.current = [loaded.item]
        loadedAiArtifactsRef.current = loaded.artifact ? [loaded.artifact] : []
        setLoadedItems([loaded.item])
        setLoadedAiArtifacts(loaded.artifact ? [loaded.artifact] : [])
        setItemsTotal(1)
        if (loaded.item.source === 'ai') setExpandedAiKey(loaded.item.key)
      })
      .catch((error) => {
        if (requestId === requestSequenceRef.current) setFocusError(error instanceof Error ? error.message : '读取成果失败')
      })
      .finally(() => {
        if (requestId === requestSequenceRef.current) setFocusLoading(false)
      })
  }, [focusKey, view, workspaceRoots])

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
    if (view === 'focus') return
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
  const recentItems = useMemo(() => listRecentArtifacts(items), [items])
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
        setAvailability((current) => current[ref.documentId] ? current : { ...current, [ref.documentId]: 'unavailable' })
        continue
      }
      setAvailability((current) => current[ref.documentId] ? current : { ...current, [ref.documentId]: 'checking' })
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

  const selectedDocumentAvailability = selectedDocument ? availability[selectedDocument.documentId] : undefined
  useEffect(() => {
    let cancelled = false
    setDocumentModel(null)
    if (view !== 'detail' || !selectedDocument?.filePath || selectedDocumentAvailability !== 'available') return
    void readRememberedMarkdownFileForOpen(selectedDocument.filePath)
      .then((content) => {
        if (!cancelled) setDocumentModel(createMarkdownPreviewModel(content))
      })
      .catch(() => {
        if (!cancelled) setAvailability((current) => ({ ...current, [selectedDocument.documentId]: 'unavailable' }))
    })
    return () => { cancelled = true }
  }, [selectedDocument?.documentId, selectedDocument?.filePath, selectedDocumentAvailability, view])

  useEffect(() => {
    setExpandedAiKey((current) => current && items.some((item) => item.key === current) ? current : null)
  }, [items])

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const scroller = contentScrollerRef.current
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
    const scroller = contentScrollerRef.current
    if (scroller) scrollPositionsRef.current[view] = scroller.scrollTop
    requestSequenceRef.current += 1
    const resetItems = next !== 'documents' && (next !== 'detail' || isDatabaseReady())
    if (resetItems) {
      loadedItemsRef.current = []
      loadedAiArtifactsRef.current = []
      setLoadedItems([])
      setLoadedAiArtifacts([])
      setItemsTotal(0)
      setItemsLoading(true)
    }
    setDetailContent((current) => ({ ...current, pending: next === 'detail' && isDatabaseReady() }))
    if (next === 'documents') {
      documentRequestSequenceRef.current += 1
      const emptyPage = { documents: [], total: 0, hasMore: false }
      documentPageRef.current = emptyPage
      setDocumentPage(emptyPage)
      setDocumentsLoading(true)
    }
    setExpandedAiKey(null)
    setView(next)
  }

  const openDocument = (documentRef: ReadingArtifactDocumentRef | null, origin?: HTMLButtonElement) => {
    returnFocusRef.current = origin ?? null
    setSelectedDocument(documentRef)
    setDetailFilter('all')
    const nextSort = documentRef ? 'source' : 'time'
    setDetailSort(nextSort)
    const databaseReady = isDatabaseReady()
    setDetailContent((current) => ({
      ...current,
      items: databaseReady ? current.items : items,
      filter: 'all',
      sort: nextSort,
      version: databaseReady ? current.version : current.version + 1,
    }))
    changeView('detail')
  }

  const changeDetailFilter = (next: DetailFilter) => {
    if (next === detailFilter) return
    setDetailFilter(next)
    const databaseReady = isDatabaseReady()
    if (!databaseReady) {
      setDetailContent((current) => ({ ...current, items, filter: next, pending: false, version: current.version + 1 }))
      return
    }
    setDetailContent((current) => ({ ...current, pending: true }))
  }

  const changeDetailSort = (next: 'source' | 'time') => {
    if (next === detailSort) return
    setDetailSort(next)
    const databaseReady = isDatabaseReady()
    if (!databaseReady) {
      setDetailContent((current) => ({ ...current, items, sort: next, pending: false, version: current.version + 1 }))
      return
    }
    setDetailContent((current) => ({ ...current, pending: true }))
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
    : view === 'focus' ? focusLoading : itemsLoading && items.length === 0
  const openReadingMark = async (markId: string) => {
    try {
      await navigateToReadingMark(markId)
    } catch (error) {
      toast.error(describeFileOperationError(error, '定位批注失败'))
    }
  }
  const detailItems = useMemo(() => detailContent.items.filter((item) => matchesDetailFilter(item, detailContent.filter)), [detailContent])
  const positionedDetail = useMemo(() => {
    if (!selectedDocument || detailContent.sort !== 'source' || !documentModel) return { positioned: [], other: detailItems }
    const positioned: Array<{ item: ReadingArtifactItem; position: number }> = []
    const other: ReadingArtifactItem[] = []
    for (const item of detailItems) {
      const position = positionForItem(item, selectedDocument.documentId, documentModel)
      if (position === null) other.push(item)
      else positioned.push({ item, position })
    }
    positioned.sort((left, right) => left.position - right.position || left.item.createdAt - right.item.createdAt)
    return { positioned: positioned.map((entry) => entry.item), other }
  }, [detailContent.sort, detailItems, documentModel, selectedDocument])

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
    <div ref={rootRef} data-product-tour="reading-artifact-center" className="flex h-full min-h-0 flex-col bg-gm-canvas text-gm-text">
      <div className="shrink-0 px-4 pt-3">
          {view !== 'detail' && view !== 'focus' ? (
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
              <div data-product-tour="reading-artifact-filters" className="relative mb-4 flex items-center gap-2">
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
              <button type="button" aria-label={view === 'focus' ? '返回阅读成果' : '返回按文档'} onClick={() => { if (view === 'focus') onCloseFocus?.(); changeView(view === 'focus' ? focusReturnViewRef.current : 'documents') }} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-gm-text-tertiary hover:bg-gm-surface-hover hover:text-gm-primary focus-visible:bg-gm-surface-hover focus-visible:outline-none">
                <ChevronLeft size={17} strokeWidth={1.8} aria-hidden="true" />
              </button>
              <div className="min-w-0 flex-1">
                <h2 ref={detailHeadingRef} tabIndex={-1} className="truncate text-body font-bold outline-none">{view === 'focus' ? '阅读成果' : (selectedDocument?.fileName ?? '独立成果')}</h2>
                {view === 'focus' && focusError && <div className="mt-1 text-micro text-gm-warning">{focusError}</div>}
                {view !== 'focus' && selectedDocument && availability[selectedDocument.documentId] === 'unavailable' && <div className="mt-1 text-micro text-gm-warning">来源文档不可用</div>}
              </div>
            </motion.div>
          )}

          {view === 'detail' && (
            <DetailControls
              independent={!selectedDocument}
              filter={detailFilter}
              sort={detailSort}
              onFilter={changeDetailFilter}
              onSort={changeDetailSort}
              reducedMotion={reducedMotion}
            />
          )}
      </div>

      <div ref={contentScrollerRef} role="region" aria-label="阅读成果内容" tabIndex={0} className="min-h-0 flex-1 overflow-y-auto px-4 pb-3 outline-none">
          {loading ? <EmptyState text="正在加载阅读成果…" /> : view === 'recent' ? (
            <RecentView items={recentItems} renderCard={renderCard} />
          ) : view === 'documents' ? (
            <DocumentView summaries={documentSummaries} availability={availability} onOpen={openDocument} />
          ) : view === 'focus' ? (
            items.length > 0 ? <div className="space-y-2">{items.map((item) => renderCard(item))}</div> : <EmptyState text={focusError || '该阅读成果不存在'} />
          ) : (
            <DetailView
              reducedMotion={reducedMotion}
              contentPending={detailContent.pending}
              contentVersion={detailContent.version}
              positioned={detailContent.sort === 'time' ? [...detailItems].sort((a, b) => a.createdAt - b.createdAt) : positionedDetail.positioned}
              other={detailContent.sort === 'source' ? positionedDetail.other : []}
              renderCard={(item) => renderCard(item, selectedDocument)}
            />
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
  const dates = new Map<string, ReadingArtifactItem[]>()
  for (const item of items) {
    const date = dateGroupLabel(item.createdAt)
    dates.set(date, [...(dates.get(date) ?? []), item])
  }
  return <div className="space-y-6">{[...dates].map(([date, grouped]) => <section key={date}><h3 className="mb-2 text-caption font-bold text-gm-text-secondary">{date}</h3><div className="space-y-2">{grouped.map((item) => renderCard(item))}</div></section>)}</div>
}

function DocumentView({ summaries, availability, onOpen }: { summaries: ReturnType<typeof listArtifactDocuments>; availability: Record<string, DocumentAvailability>; onOpen: (ref: ReadingArtifactDocumentRef | null, origin?: HTMLButtonElement) => void }) {
  if (summaries.length === 0) return <EmptyState text="当前条件下没有文档成果" />
  return <div className="divide-y divide-gm-border-subtle overflow-hidden rounded-lg border border-gm-border-subtle bg-gm-surface">{summaries.map((summary) => {
    const ref = summary.documentRef
    return <button key={ref?.documentId ?? '__independent__'} type="button" onClick={(event) => onOpen(ref, event.currentTarget)} className="group flex w-full items-center gap-3 px-2.5 py-3 text-left hover:bg-gm-surface-hover focus-visible:bg-gm-surface-hover focus-visible:outline-none"><span className="flex h-7 w-7 shrink-0 items-center justify-center text-gm-primary"><FileText size={16} strokeWidth={1.7} aria-hidden="true" /></span><span className="min-w-0 flex-1"><span className="block truncate text-caption font-bold">{ref?.fileName ?? '独立成果'}</span><span className="mt-0.5 block truncate text-micro text-gm-text-tertiary">{ref && availability[ref.documentId] === 'unavailable' ? '来源文档不可用' : `${summary.highlights} 高亮 · ${summary.annotations} 批注 · ${summary.aiArtifacts} AI 成果`}</span></span><span className="flex items-center gap-1 text-micro text-gm-text-tertiary"><span>{summary.total} 条</span><ChevronRight size={15} strokeWidth={1.8} aria-hidden="true" /></span></button>
  })}</div>
}

function DetailControls({ independent, filter, sort, onFilter, onSort, reducedMotion }: { independent: boolean; filter: DetailFilter; sort: 'source' | 'time'; onFilter: (value: DetailFilter) => void; onSort: (value: 'source' | 'time') => void; reducedMotion: boolean }) {
  return (
    <div className="mb-3 flex min-h-8 flex-wrap items-start gap-2">
      <nav aria-label="成果分类" role="tablist" className="flex min-w-0 flex-[1_1_12rem] flex-wrap items-center gap-1">
        {(['all', 'highlight', 'annotation', 'ai'] as const).map((value) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={filter === value}
            onClick={() => onFilter(value)}
            className={`relative h-8 shrink-0 rounded-md border border-transparent px-2.5 text-micro font-bold outline-none transition-colors focus-visible:border-gm-primary ${filter === value ? 'text-gm-primary' : 'text-gm-text-secondary hover:border-gm-border-subtle hover:bg-gm-surface'}`}
          >
            {({ all: '全部', highlight: '高亮', annotation: '批注', ai: 'AI 成果' })[value]}
            {filter === value && <motion.span layoutId="reading-artifact-detail-filter-indicator" transition={reducedMotion ? { duration: 0 } : { duration: 0.18, ease: [0.23, 1, 0.32, 1] }} className="pointer-events-none absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-gm-primary" aria-hidden="true" />}
          </button>
        ))}
      </nav>
      {!independent && <SortMenu value={sort} onChange={onSort} />}
    </div>
  )
}

function DetailView({ reducedMotion, contentPending, contentVersion, positioned, other, renderCard }: { reducedMotion: boolean; contentPending: boolean; contentVersion: number; positioned: ReadingArtifactItem[]; other: ReadingArtifactItem[]; renderCard: (item: ReadingArtifactItem) => React.ReactNode }) {
  return (
    <div aria-busy={contentPending} className="grid">
      <AnimatePresence initial={false} mode="sync">
        <motion.div
          key={contentVersion}
          initial={contentVersion === 0 || reducedMotion ? false : { opacity: 0 }}
          animate={{ opacity: contentPending ? 0.55 : 1 }}
          exit={reducedMotion ? { opacity: 1 } : { opacity: 0 }}
          transition={reducedMotion ? { duration: 0 } : { duration: 0.18, ease: [0.23, 1, 0.32, 1] }}
          className="col-start-1 row-start-1 min-w-0"
        >
          <div className="space-y-2">{positioned.map(renderCard)}</div>
          {other.length > 0 && <section className="mt-5 pt-1"><h3 className="mb-2 text-micro font-bold tracking-wide text-gm-text-tertiary">其他成果</h3><div className="space-y-2">{other.map(renderCard)}</div></section>}
          {positioned.length === 0 && other.length === 0 && <EmptyState text="当前条件下没有阅读成果" />}
        </motion.div>
      </AnimatePresence>
    </div>
  )
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

function ExpandableText({
  text,
  lines,
  expanded,
  reducedMotion,
  onOverflowChange,
  className,
}: {
  text: string
  lines: number
  expanded: boolean
  reducedMotion: boolean
  onOverflowChange: (overflow: boolean) => void
  className: string
}) {
  const textRef = useRef<HTMLDivElement>(null)
  const [metrics, setMetrics] = useState({ fullHeight: 0, collapsedHeight: 0, overflow: false })
  const [hasMeasured, setHasMeasured] = useState(false)
  const [enableMotion, setEnableMotion] = useState(false)
  const measure = useCallback(() => {
    const element = textRef.current
    if (!element) return
    const computed = window.getComputedStyle(element)
    const fontSize = Number.parseFloat(computed.fontSize) || 14
    const lineHeight = Number.parseFloat(computed.lineHeight) || fontSize * 1.5
    // Layout height stays stable while ancestor motion transforms visual bounds.
    const measuredHeight = element.scrollHeight
    const fallbackHeight = text.split(/\r?\n/).length * lineHeight
    const fullHeight = Math.max(measuredHeight, fallbackHeight)
    const collapsedHeight = Math.min(fullHeight, lineHeight * lines)
    const overflow = fullHeight > collapsedHeight + 1
    setMetrics((current) => current.fullHeight === fullHeight && current.collapsedHeight === collapsedHeight && current.overflow === overflow
      ? current
      : { fullHeight, collapsedHeight, overflow })
    setHasMeasured(true)
  }, [lines, text])

  useLayoutEffect(() => {
    measure()
    const element = textRef.current
    if (!element || typeof ResizeObserver !== 'function') return
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [measure])

  useEffect(() => {
    if (hasMeasured) onOverflowChange(metrics.overflow)
  }, [hasMeasured, metrics.overflow, onOverflowChange])

  useEffect(() => {
    setEnableMotion(true)
  }, [])

  const visibleHeight = expanded || !metrics.overflow ? 'auto' : metrics.collapsedHeight
  return (
    <motion.div
      animate={{ height: visibleHeight }}
      initial={false}
      transition={reducedMotion || !enableMotion ? { duration: 0 } : { height: MORPHING_MOTION_TOKENS.surface }}
      style={hasMeasured ? undefined : { visibility: 'hidden' }}
      className="relative overflow-hidden"
    >
      <div ref={textRef} className={className}>{text}</div>
      {!expanded && metrics.overflow && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 bottom-0 h-8"
          style={{ background: 'linear-gradient(to bottom, transparent, color-mix(in srgb, var(--gm-surface) 96%, #fff5e6 4%))' }}
        />
      )}
    </motion.div>
  )
}

function ArtifactCard({ item, availability, anchorStatus, currentDocument, reducedMotion, expanded, onToggleExpand, onNavigateMark, onUpdateMark, onDeleteMark, onDeleteAi, onOpenAiSource }: { item: ReadingArtifactItem; availability: Record<string, DocumentAvailability>; anchorStatus?: SourceAnchorStatus; currentDocument?: ReadingArtifactDocumentRef | null; reducedMotion: boolean; expanded: boolean; onToggleExpand?: () => void; onNavigateMark: () => void; onUpdateMark: (color?: ReadingMarkColor, note?: string) => Promise<unknown>; onDeleteMark: () => Promise<void>; onDeleteAi: () => Promise<void>; onOpenAiSource: (ref: ReadingArtifactDocumentRef) => void | Promise<void> }) {
  const [editing, setEditing] = useState(false)
  const [note, setNote] = useState(item.content ?? '')
  const [contentOverflow, setContentOverflow] = useState<Record<string, boolean>>({})
  const [manualExpanded, setManualExpanded] = useState(false)
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
  const color = item.color ?? 'yellow'
  const canExpand = Object.values(contentOverflow).some(Boolean)
  const contentExpanded = isUser ? manualExpanded : expanded
  const updateContentOverflow = useCallback((key: string, overflow: boolean) => {
    setContentOverflow((current) => current[key] === overflow ? current : { ...current, [key]: overflow })
  }, [])
  useEffect(() => {
    setContentOverflow({})
    setManualExpanded(false)
    setEditing(false)
    setNote(item.content ?? '')
  }, [item.content, item.id])
  const contentMotion = reducedMotion
    ? { initial: { opacity: 1, height: 'auto' }, animate: { opacity: 1, height: 'auto' }, exit: { opacity: 1, height: 0 }, transition: { duration: 0 } }
    : { initial: { opacity: 0, height: 0 }, animate: { opacity: 1, height: 'auto' }, exit: { opacity: 0, height: 0 }, transition: { height: { duration: 0.24, ease: 'easeOut' as const }, opacity: { duration: 0.16, ease: 'easeOut' as const } } }
  return <article data-state={isUser ? undefined : expanded ? 'open' : 'closed'} className="overflow-hidden rounded-2xl border border-gm-border-subtle bg-gm-surface shadow-[0_7px_20px_rgba(72,58,42,0.08)]" style={isUser ? { backgroundColor: 'color-mix(in srgb, var(--gm-surface) 96%, #fff5e6 4%)', borderColor: 'color-mix(in srgb, var(--gm-border-subtle) 76%, #d7b98c 24%)' } : { backgroundColor: 'color-mix(in srgb, var(--gm-surface) 97%, var(--gm-primary) 3%)', borderColor: 'color-mix(in srgb, var(--gm-border-subtle) 78%, var(--gm-primary) 22%)' }}>
    {isUser ? (
      <div className="p-3.5 sm:p-4">
        <div className="flex items-center gap-2 border-b border-gm-border-subtle/80 pb-2.5"><span className={`h-2.5 w-2.5 rounded-full ${COLOR_STYLES[color]}`} /><span className="text-caption font-bold text-gm-text-secondary">{TYPE_LABELS[item.type]}</span><span className="ml-auto text-micro text-gm-text-tertiary">{new Date(item.createdAt).toLocaleDateString('zh-CN')}</span></div>
        {(item.quote || editing || item.content) && <div id={contentId} className="mt-3 space-y-3">
          {item.quote && <div className="relative pl-3.5"><span className={`absolute inset-y-1 left-0 w-1 rounded-full ${COLOR_RAIL_STYLES[color]}`} /><ExpandableText text={`“${item.quote}”`} lines={item.type === 'annotation' ? 3 : 6} expanded={contentExpanded || editing} reducedMotion={reducedMotion} onOverflowChange={(value) => updateContentOverflow('quote', value)} className="whitespace-pre-wrap break-words font-serif text-body leading-[1.65] text-gm-text" /></div>}
          {item.type === 'annotation' && <section className="rounded-xl border px-3 py-2.5" style={COLOR_NOTE_STYLES[color]}><h4 className="mb-1.5 text-micro font-bold tracking-wide text-gm-primary">我的批注</h4>{editing ? <div><textarea value={note} onChange={(event) => setNote(event.target.value)} className="min-h-24 w-full resize-y rounded-lg border border-gm-border-subtle bg-gm-canvas/65 p-2.5 text-caption leading-relaxed text-gm-text outline-none focus:border-gm-primary" style={{ fontSize: 'var(--gm-ai-chat-font-size)' }} /><div className="mt-2 flex justify-end gap-2"><button type="button" onClick={() => { setNote(item.content ?? ''); setEditing(false) }} className="rounded-md px-2 py-1 text-micro text-gm-text-tertiary hover:bg-gm-surface-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-gm-primary/40">取消</button><button type="button" onClick={() => void onUpdateMark(undefined, note).then(() => setEditing(false))} className="rounded-md px-2 py-1 text-micro font-bold text-gm-primary hover:bg-gm-surface-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-gm-primary/40">保存</button></div></div> : item.content && <ExpandableText text={item.content} lines={5} expanded={contentExpanded} reducedMotion={reducedMotion} onOverflowChange={(value) => updateContentOverflow('note', value)} className="whitespace-pre-wrap break-words text-caption leading-[1.65] text-gm-text" />}</section>}
        </div>}
        {canExpand && !editing && <button type="button" aria-expanded={contentExpanded} aria-controls={contentId} onClick={() => { if (isUser) setManualExpanded((value) => !value); else onToggleExpand?.() }} className="mt-2 inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-micro font-bold text-gm-primary outline-none transition-colors hover:bg-gm-primary/5 focus-visible:ring-1 focus-visible:ring-gm-primary/40 active:scale-[0.98]"><span>{contentExpanded ? '收起' : '展开全文'}</span><ChevronDown size={14} strokeWidth={1.8} className={`transition-transform duration-200 ${contentExpanded ? 'rotate-180' : ''}`} aria-hidden="true" /></button>}
        {refs.length > 0 && <div className="mt-3 flex flex-wrap gap-1.5">{refs.map((ref) => <button key={ref.documentId} type="button" disabled={!ref.filePath || availability[ref.documentId] === 'unavailable'} onClick={onNavigateMark} className="flex min-w-0 max-w-full items-center gap-2 rounded-xl border border-gm-border-subtle/80 bg-gm-canvas/45 px-2.5 py-2 text-left text-micro text-gm-text-secondary transition-colors hover:border-gm-primary/35 hover:text-gm-primary disabled:cursor-not-allowed disabled:text-gm-warning"><FileText size={15} strokeWidth={1.7} aria-hidden="true" /><span className="truncate">{availability[ref.documentId] === 'unavailable' ? `${ref.fileName} · 来源文档不可用` : `${ref.fileName} · 查看原文`}</span><ChevronRight size={14} strokeWidth={1.8} className="ml-auto shrink-0 text-gm-text-tertiary" aria-hidden="true" /></button>)}</div>}
        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-gm-border-subtle/80 pt-3">{(['yellow', 'green', 'blue', 'pink'] as const).map((nextColor) => <button key={nextColor} type="button" aria-label={`改为${nextColor}`} onClick={() => void onUpdateMark(nextColor)} className={`h-4 w-4 rounded-full outline-none transition-transform hover:scale-110 focus-visible:ring-2 focus-visible:ring-gm-primary/50 focus-visible:ring-offset-2 ${COLOR_STYLES[nextColor]} ${color === nextColor ? 'ring-2 ring-gm-primary ring-offset-1' : ''}`} />)}{item.type === 'annotation' && <button type="button" onClick={() => setEditing(true)} className="ml-1 rounded-md px-2 py-1 text-micro font-bold text-gm-primary hover:bg-gm-primary/5 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-gm-primary/40">编辑批注</button>}<button type="button" onClick={remove} className="ml-auto rounded-md px-2 py-1 text-micro text-gm-text-tertiary hover:bg-gm-error/10 hover:text-gm-error focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-gm-error/40">删除</button></div>
      </div>
    ) : (
      <>
        <button id={triggerId} type="button" aria-expanded={expanded} aria-controls={contentId} onClick={onToggleExpand} className="group/trigger flex w-full items-start gap-3 border-b border-gm-border-subtle/80 px-3.5 py-3.5 text-left outline-none transition-colors duration-150 hover:bg-gm-surface-hover focus-visible:bg-gm-surface-hover active:scale-[0.995]">
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-2 text-micro font-bold text-gm-text-secondary"><span className="h-2.5 w-2.5 shrink-0 rounded-full bg-gm-primary" /><span className="rounded-full bg-gm-primary-subtle px-1.5 py-0.5 text-[10px] font-bold tracking-[0.04em] text-gm-primary">AI · {TYPE_LABELS[item.type]}</span>{(refs.length + webReferences.length) > 0 && <span className="font-normal text-gm-text-tertiary">· {refs.length + webReferences.length} 个来源</span>}<span className="ml-auto shrink-0 text-micro font-normal text-gm-text-tertiary">{new Date(item.createdAt).toLocaleDateString('zh-CN')}</span></span>
            <span className="mt-3 block line-clamp-2 text-caption font-bold leading-relaxed text-gm-text" style={{ fontSize: 'var(--gm-ai-chat-font-size)' }}>{collapsedTitle}</span>
            <span className="mt-1 block truncate text-micro leading-relaxed text-gm-text-tertiary" style={{ fontSize: 'var(--gm-ai-chat-meta-font-size)' }}>{replyPreview}</span>
          </span>
          <span className="flex shrink-0 items-center gap-1.5 pt-0.5 text-micro text-gm-text-tertiary"><span>{expanded ? '收起' : '展开'}</span><ChevronDown size={15} strokeWidth={1.8} className={`transition-transform duration-200 ${expanded ? 'rotate-180 text-gm-primary' : 'group-hover/trigger:translate-y-0.5'}`} aria-hidden="true" /></span>
        </button>
        <AnimatePresence initial={false}>
          {expanded && <motion.div key="details" id={contentId} role="region" aria-labelledby={triggerId} {...contentMotion} className="overflow-hidden">
            <div className="px-3.5 pb-3.5 pt-3.5">
              <div className="space-y-3">
                <section className="rounded-xl border px-3 py-2.5" style={AI_QUESTION_STYLES}><h4 className="mb-1.5 text-micro font-bold tracking-wide text-gm-primary">原问题</h4><p className="text-caption leading-[1.65] text-gm-text" style={{ fontSize: 'var(--gm-ai-chat-font-size)' }}>{question || '未记录原问题'}</p></section>
                <section className="rounded-xl border px-3 py-2.5" style={AI_REPLY_STYLES}><h4 className="mb-1.5 text-micro font-bold tracking-wide text-gm-primary">AI 回复</h4>{item.content?.trim() ? <div tabIndex={0} aria-label="AI 回复正文" className="max-h-80 overflow-y-auto pr-1 prose max-w-none text-caption leading-[1.65] text-gm-text [&_p]:my-1.5 [&_p]:text-[length:var(--gm-ai-chat-font-size)] [&_li]:text-[length:var(--gm-ai-chat-font-size)] [&_ul]:my-1.5 [&_ol]:my-1.5 [&_pre]:max-w-full [&_pre]:overflow-x-auto" style={{ fontSize: 'var(--gm-ai-chat-font-size)' }}><ReactMarkdown remarkPlugins={[remarkGfm]}>{item.content}</ReactMarkdown></div> : <p className="text-caption text-gm-text-tertiary" style={{ fontSize: 'var(--gm-ai-chat-font-size)' }}>暂无 AI 回复内容</p>}</section>
                <section><h4 className="mb-1.5 text-micro font-bold tracking-wide text-gm-text-tertiary">参考资料</h4><div className="flex flex-wrap gap-1.5">{refs.map((ref) => <button key={ref.documentId} type="button" aria-label={!ref.filePath || availability[ref.documentId] === 'unavailable' ? `${ref.fileName} · 来源文档不可用` : `${ref.fileName} · 查看原文`} disabled={!ref.filePath || availability[ref.documentId] === 'unavailable'} onClick={() => void onOpenAiSource(ref)} className="flex min-w-0 max-w-full items-center gap-2 rounded-xl border border-gm-border-subtle/80 bg-gm-canvas/45 px-2.5 py-2 text-left text-micro text-gm-text-secondary transition-colors hover:border-gm-primary/35 hover:text-gm-primary disabled:cursor-not-allowed disabled:text-gm-warning"><FileText size={15} strokeWidth={1.7} aria-hidden="true" /><span className="truncate">{availability[ref.documentId] === 'unavailable' || !ref.filePath ? `${ref.fileName} · 来源文档不可用` : `${ref.fileName} · 查看原文`}</span><ChevronRight size={14} strokeWidth={1.8} className="ml-auto shrink-0 text-gm-text-tertiary" aria-hidden="true" /></button>)}{webReferences.map((reference, index) => <a key={`${reference.url}-${index}`} aria-label={`打开来源 ${reference.title || reference.url}`} href={reference.url} target="_blank" rel="noreferrer" className="flex min-w-0 max-w-full items-center gap-2 rounded-xl border border-gm-border-subtle/80 bg-gm-canvas/45 px-2.5 py-2 text-left text-micro text-gm-text-secondary transition-colors hover:border-gm-primary/35 hover:text-gm-primary"><ExternalLink size={15} strokeWidth={1.7} aria-hidden="true" /><span className="truncate">{reference.title || reference.url}</span><ChevronRight size={14} strokeWidth={1.8} className="ml-auto shrink-0 text-gm-text-tertiary" aria-hidden="true" /></a>)}{refs.length === 0 && webReferences.length === 0 && <span className="text-micro text-gm-text-tertiary">暂无可跳转来源</span>}</div>{anchorStatus === 'changed' && <p className="mt-1.5 text-micro text-gm-warning">原文已变更，定位可能偏移</p>}</section>
              </div>
              <div className="mt-3 flex justify-end border-t border-gm-border-subtle/80 pt-3"><button type="button" onClick={remove} className="rounded-md px-2 py-1 text-micro text-gm-text-tertiary hover:bg-gm-error/10 hover:text-gm-error focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-gm-error/40">删除成果</button></div>
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
