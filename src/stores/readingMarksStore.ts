import { create } from 'zustand'
import {
  createReadingMark,
  buildReadingMarkRangeIndex,
  deleteReadingMark,
  findReadingMarkConflict,
  type CreateReadingMarkResult,
  loadReadingMarks,
  loadReadingMarksPage,
  readingDocumentId,
  updateReadingMark,
  type CreateReadingMarkInput,
  type ReadingMark,
  type ReadingMarkType,
  type UpdateReadingMarkPatch,
} from '@/services/readingMarks'
import type { MarkdownPreviewModel } from '@/services/markdownPreviewModel'
import { toast } from '@/services/toast'

interface ReadingMarksState {
  byDocumentId: Record<string, ReadingMark[]>
  allMarks: ReadingMark[]
  allLoaded: boolean
  allLoading: boolean
  loading: Record<string, boolean>
  error: string | null
  dataRevision: number
  pendingNavigation: { markId: string; documentPath: string } | null
  load: (documentPath: string) => Promise<ReadingMark[]>
  loadAll: () => Promise<ReadingMark[]>
  create: (input: CreateReadingMarkInput, model: MarkdownPreviewModel) => Promise<CreateReadingMarkResult>
  update: (id: string, documentPath: string, patch: UpdateReadingMarkPatch) => Promise<ReadingMark>
  remove: (id: string, documentPath: string) => Promise<void>
  requestNavigation: (markId: string, documentPath: string) => void
  clearNavigation: () => void
}

function replaceMark(list: ReadingMark[], mark: ReadingMark): ReadingMark[] {
  const index = list.findIndex((item) => item.id === mark.id)
  if (index < 0) return [...list, mark]
  const next = list.slice()
  next[index] = mark
  return next
}

function rollbackMark(list: ReadingMark[], previous: ReadingMark[], id: string, optimistic?: ReadingMark): ReadingMark[] {
  // A different operation may have replaced this row while persistence was pending.
  if (list.find((mark) => mark.id === id) !== optimistic) return list
  const original = previous.find((mark) => mark.id === id)
  return original ? replaceMark(list, original) : list.filter((mark) => mark.id !== id)
}

let loadAllSequence = 0
const createQueues = new Map<string, Promise<unknown>>()
const documentLoads = new Map<string, { changedIds: Set<string> }>()

function trackDocumentChange(documentId: string, id: string): void {
  documentLoads.get(documentId)?.changedIds.add(id)
}

function invalidateAllLoad(
  set: (partial: Partial<ReadingMarksState>) => void,
  get: () => ReadingMarksState,
): boolean {
  if (!get().allLoading) return false
  loadAllSequence += 1
  set({ allLoading: false })
  return true
}

function refreshInterruptedAllCache(get: () => ReadingMarksState, interrupted: boolean): void {
  if (interrupted && !get().allLoading) void get().loadAll()
}

export const useReadingMarksStore = create<ReadingMarksState>((set, get) => ({
  byDocumentId: {},
  allMarks: [],
  allLoaded: false,
  allLoading: false,
  loading: {},
  error: null,
  dataRevision: 0,
  pendingNavigation: null,
  async load(documentPath) {
    const documentId = readingDocumentId(documentPath)
    if (!documentPath) return []
    const request = { changedIds: new Set<string>() }
    documentLoads.set(documentId, request)
    const previous = get().byDocumentId[documentId]
    const isCurrent = () => documentLoads.get(documentId) === request && get().byDocumentId[documentId] === previous
    set((state) => ({ loading: { ...state.loading, [documentId]: true }, error: null }))
    try {
      const loaded = await loadReadingMarks(documentPath)
      if (documentLoads.get(documentId) !== request) return get().byDocumentId[documentId] || []
      // Keep changed rows from the live cache, but still hydrate untouched rows on first load.
      const current = get().byDocumentId[documentId] || []
      const marks = request.changedIds.size
        ? [...loaded.filter((mark) => !request.changedIds.has(mark.id)), ...current.filter((mark) => request.changedIds.has(mark.id))]
        : isCurrent() ? loaded : current
      set((state) => ({
        byDocumentId: { ...state.byDocumentId, [documentId]: marks },
        allMarks: marks.reduce(replaceMark, state.allMarks),
        loading: { ...state.loading, [documentId]: false },
      }))
      return marks
    } catch (error) {
      if (!isCurrent()) return get().byDocumentId[documentId] || []
      const message = error instanceof Error ? error.message : String(error)
      set((state) => ({ loading: { ...state.loading, [documentId]: false }, error: message }))
      toast.error(message)
      throw error
    } finally {
      if (documentLoads.get(documentId) === request) {
        documentLoads.delete(documentId)
        set((state) => ({ loading: { ...state.loading, [documentId]: false } }))
      }
    }
  },
  async loadAll() {
    if (get().allLoading) return get().allMarks
    const requestId = ++loadAllSequence
    set({ allLoading: true, error: null })
    try {
      const marks: ReadingMark[] = []
      const pageSize = 200
      for (let offset = 0; ; offset += pageSize) {
        const page = await loadReadingMarksPage(pageSize, offset)
        if (requestId !== loadAllSequence) return get().allMarks
        marks.push(...page)
        if (page.length < pageSize) break
      }
      const byDocumentId: Record<string, ReadingMark[]> = {}
      for (const mark of marks) {
        const list = byDocumentId[mark.documentId] ?? []
        list.push(mark)
        byDocumentId[mark.documentId] = list
      }
      if (requestId === loadAllSequence) set({ allMarks: marks, byDocumentId, allLoaded: true, allLoading: false })
      return marks
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (requestId === loadAllSequence) {
        set({ allLoading: false, error: message })
        toast.error(message)
      }
      throw error
    }
  },
  async create(input, model) {
    const documentId = readingDocumentId(input.documentPath)
    const previous = createQueues.get(documentId) ?? Promise.resolve()
    const operation = previous.catch(() => undefined).then(async () => {
      const anchor = buildReadingMarkRangeIndex(model, get().byDocumentId[documentId] || [])
      const conflict = findReadingMarkConflict(anchor, input.selection.from, input.selection.to)
      if (conflict) return { status: 'conflict' as const, ...conflict }
      try {
        const mark = await createReadingMark(input, model)
        trackDocumentChange(documentId, mark.id)
        const interruptedAllLoad = invalidateAllLoad(set, get)
        set((state) => ({
          byDocumentId: { ...state.byDocumentId, [documentId]: replaceMark(state.byDocumentId[documentId] || [], mark) },
          allMarks: replaceMark(state.allMarks, mark),
          error: null,
          dataRevision: state.dataRevision + 1,
        }))
        refreshInterruptedAllCache(get, interruptedAllLoad)
        return { status: 'created' as const, mark }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        set({ error: message })
        toast.error(message)
        throw error
      }
    })
    createQueues.set(documentId, operation)
    try {
      return await operation
    } finally {
      if (createQueues.get(documentId) === operation) createQueues.delete(documentId)
    }
  },
  async update(id, documentPath, patch) {
    const documentId = readingDocumentId(documentPath)
    let previous = get().byDocumentId[documentId] || []
    let optimistic = previous.find((mark) => mark.id === id)
    if (!optimistic) {
      await get().load(documentPath)
      previous = get().byDocumentId[documentId] || []
      optimistic = previous.find((mark) => mark.id === id)
    }
    if (!optimistic) throw new Error('批注不存在')
    const optimisticNote = patch.note === undefined ? optimistic.note : (patch.note.trim() || undefined)
    const optimisticType: ReadingMarkType = optimisticNote?.trim() ? 'annotation' : 'highlight'
    const optimisticMark = { ...optimistic, ...patch, note: optimisticNote, type: optimisticType, updatedAt: Date.now() }
    const previousAll = get().allMarks
    const interruptedAllLoad = invalidateAllLoad(set, get)
    trackDocumentChange(documentId, id)
    set({
      byDocumentId: { ...get().byDocumentId, [documentId]: replaceMark(previous, optimisticMark) },
      allMarks: replaceMark(previousAll, optimisticMark),
    })
    try {
      const mark = await updateReadingMark(id, patch)
      trackDocumentChange(documentId, id)
      set((state) => ({
        byDocumentId: { ...state.byDocumentId, [documentId]: replaceMark(state.byDocumentId[documentId] || [], mark) },
        allMarks: replaceMark(state.allMarks, mark),
        error: null,
        dataRevision: state.dataRevision + 1,
      }))
      refreshInterruptedAllCache(get, interruptedAllLoad)
      return mark
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      trackDocumentChange(documentId, id)
      set((state) => ({
        byDocumentId: { ...state.byDocumentId, [documentId]: rollbackMark(state.byDocumentId[documentId] || [], previous, id, optimisticMark) },
        allMarks: rollbackMark(state.allMarks, previousAll, id, optimisticMark),
        error: message,
      }))
      refreshInterruptedAllCache(get, interruptedAllLoad)
      toast.error(message)
      throw error
    }
  },
  async remove(id, documentPath) {
    const documentId = readingDocumentId(documentPath)
    const previous = get().byDocumentId[documentId] || []
    const previousAll = get().allMarks
    const interruptedAllLoad = invalidateAllLoad(set, get)
    trackDocumentChange(documentId, id)
    set({
      byDocumentId: { ...get().byDocumentId, [documentId]: previous.filter((mark) => mark.id !== id) },
      allMarks: previousAll.filter((mark) => mark.id !== id),
    })
    try {
      await deleteReadingMark(id)
      trackDocumentChange(documentId, id)
      set((state) => ({
        byDocumentId: { ...state.byDocumentId, [documentId]: (state.byDocumentId[documentId] || []).filter((mark) => mark.id !== id) },
        allMarks: state.allMarks.filter((mark) => mark.id !== id),
        error: null,
        dataRevision: state.dataRevision + 1,
      }))
      refreshInterruptedAllCache(get, interruptedAllLoad)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      trackDocumentChange(documentId, id)
      set((state) => ({
        byDocumentId: { ...state.byDocumentId, [documentId]: rollbackMark(state.byDocumentId[documentId] || [], previous, id) },
        allMarks: rollbackMark(state.allMarks, previousAll, id),
        error: message,
      }))
      refreshInterruptedAllCache(get, interruptedAllLoad)
      toast.error(message)
      throw error
    }
  },
  requestNavigation(markId, documentPath) {
    set({ pendingNavigation: { markId, documentPath } })
  },
  clearNavigation() {
    set({ pendingNavigation: null })
  },
}))
