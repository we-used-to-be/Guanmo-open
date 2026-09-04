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

let loadAllSequence = 0
const createQueues = new Map<string, Promise<unknown>>()

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
    set((state) => ({ loading: { ...state.loading, [documentId]: true }, error: null }))
    try {
      const marks = await loadReadingMarks(documentPath)
      set((state) => ({
        byDocumentId: { ...state.byDocumentId, [documentId]: marks },
        allMarks: marks.reduce(replaceMark, state.allMarks),
        loading: { ...state.loading, [documentId]: false },
      }))
      return marks
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      set((state) => ({ loading: { ...state.loading, [documentId]: false }, error: message }))
      toast.error(message)
      throw error
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
    const previous = get().byDocumentId[documentId] || []
    const optimistic = previous.find((mark) => mark.id === id)
    if (!optimistic) throw new Error('批注不存在')
    const optimisticNote = patch.note === undefined ? optimistic.note : (patch.note.trim() || undefined)
    const optimisticType: ReadingMarkType = optimisticNote?.trim() ? 'annotation' : 'highlight'
    const optimisticMark = { ...optimistic, ...patch, note: optimisticNote, type: optimisticType, updatedAt: Date.now() }
    const previousAll = get().allMarks
    const interruptedAllLoad = invalidateAllLoad(set, get)
    set({
      byDocumentId: { ...get().byDocumentId, [documentId]: replaceMark(previous, optimisticMark) },
      allMarks: replaceMark(previousAll, optimisticMark),
    })
    try {
      const mark = await updateReadingMark(id, patch)
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
      set((state) => ({ byDocumentId: { ...state.byDocumentId, [documentId]: previous }, allMarks: previousAll, error: message }))
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
    set({
      byDocumentId: { ...get().byDocumentId, [documentId]: previous.filter((mark) => mark.id !== id) },
      allMarks: previousAll.filter((mark) => mark.id !== id),
    })
    try {
      await deleteReadingMark(id)
      set((state) => ({ error: null, dataRevision: state.dataRevision + 1 }))
      refreshInterruptedAllCache(get, interruptedAllLoad)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      set((state) => ({ byDocumentId: { ...state.byDocumentId, [documentId]: previous }, allMarks: previousAll, error: message }))
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
