import { useEditorStore, type Tab } from '@/stores/editorStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { saveFile, selectSaveTarget } from '@/services/fileSystem'
import { isTauri } from '@/hooks/useTauri'
import { getRuntimeCapabilities } from '@/services/runtimeCapabilities'
import { normalizeFilePath } from '@/services/pathIdentity'
import { scheduleMarkdownDocumentIndex } from '@/services/rag/indexer'
import { describeFileOperationError } from '@/services/fileOperationErrors'
import { toast } from '@/services/toast'

type Source = 'manual' | 'auto'
export interface SaveReceipt {
  status: 'written' | 'downloaded' | 'cancelled'
  content: string
  path: string
  currentSaved: boolean
}
interface Owner { id: string; identity: object; originalPath: string | null }
interface Waiter { resolve: (receipt: SaveReceipt) => void; reject: (error: unknown) => void }
interface Request {
  owner: Owner | null
  path: string
  title: string
  content: string
  source: Source
  bind: boolean
  waiters: Waiter[]
}
interface Queue {
  running?: Request
  pending?: Request
  timer?: ReturnType<typeof setTimeout>
  exclusive?: () => Promise<void>
  exclusiveRunning?: boolean
}

export interface DocumentWriteSnapshot {
  readonly path: string
  readonly content: string
  readonly owner: Owner | null
}

const queues = new Map<string, Queue>()
const failures = new Map<string, number>()
const identities = new Map<string, { path: string | null; identity: object }>()
const selectors = new Map<object, Promise<SaveReceipt | null>>()
function key(path: string): string { return isTauri() ? normalizeFilePath(path) : path }
function ownerFor(tab: Tab): Owner {
  let entry = identities.get(tab.id)
  if (!entry || entry.path !== (tab.filePath ? key(tab.filePath) : null)) {
    entry = { path: tab.filePath ? key(tab.filePath) : null, identity: {} }
    identities.set(tab.id, entry)
  }
  return { id: tab.id, identity: entry.identity, originalPath: tab.filePath }
}
function current(owner: Owner | null): Tab | undefined {
  if (!owner || identities.get(owner.id)?.identity !== owner.identity) return
  const tab = useEditorStore.getState().tabs.find((item) => item.id === owner.id)
  if (tab && (tab.filePath ? key(tab.filePath) : null) === (owner.originalPath ? key(owner.originalPath) : null)) return tab
}
function autoEnabled(): boolean {
  return useSettingsStore.getState().editor.autoSave && (isTauri() || getRuntimeCapabilities().browserFileWrite)
}
function receipt(request: Request, status: SaveReceipt['status']): SaveReceipt {
  const tab = current(request.owner)
  return { status, path: request.path, content: request.content, currentSaved: status === 'written' && !!tab && tab.content === request.content }
}
function cancel(request: Request) {
  for (const waiter of request.waiters) waiter.resolve(receipt(request, 'cancelled'))
}
function delay(): number { return useSettingsStore.getState().editor.autoSaveDelay || 1000 }

// Tab lifetime/path changes invalidate receipts, but never release an in-flight path lock.
useEditorStore.subscribe((state) => {
  for (const [id, entry] of identities) {
    const tab = state.tabs.find((item) => item.id === id)
    if (!tab || (tab.filePath ? key(tab.filePath) : null) !== entry.path) identities.delete(id)
  }
  cancelPending()
})
useSettingsStore.subscribe(() => { if (!autoEnabled()) cancelPending() })
function cancelPending() {
  for (const [pathKey, queue] of queues) {
    if (queue.pending && ((queue.pending.owner && !current(queue.pending.owner)) || (queue.pending.source === 'auto' && !autoEnabled()))) {
      cancel(queue.pending)
      queue.pending = undefined
      if (queue.timer) clearTimeout(queue.timer)
      queue.timer = undefined
      if (!queue.running && !queue.exclusiveRunning) void drain(pathKey, queue)
    }
  }
}

function enqueue(request: Omit<Request, 'waiters'>): Promise<SaveReceipt> {
  const pathKey = key(request.path)
  let queue = queues.get(pathKey)
  if (!queue) { queue = {}; queues.set(pathKey, queue) }
  if (request.source === 'manual') failures.delete(pathKey)
  if (request.source === 'auto' && (failures.get(pathKey) ?? 0) >= 3) return Promise.resolve(receipt({ ...request, waiters: [] }, 'cancelled'))
  const promise = new Promise<SaveReceipt>((resolve, reject) => {
    const waiter = { resolve, reject }
    const running = queue.running
    if (!queue.pending && running && running.content === request.content && running.owner?.identity === request.owner?.identity && running.bind === request.bind) {
      running.waiters.push(waiter)
      return
    }
    const pending = queue.pending
    if (pending && pending.owner?.identity !== request.owner?.identity) cancel(pending)
    queue.pending = {
      ...request,
      source: pending && pending.owner?.identity === request.owner?.identity && pending.source === 'manual' ? 'manual' : request.source,
      waiters: [...(pending && pending.owner?.identity === request.owner?.identity ? pending.waiters : []), waiter],
    }
    if (!queue.running && !queue.exclusiveRunning) {
      if (queue.timer && request.source === 'manual') { clearTimeout(queue.timer); queue.timer = undefined }
      if (!queue.timer) void drain(pathKey, queue)
    }
  })
  return promise
}

async function drain(pathKey: string, queue: Queue): Promise<void> {
  if (queue.running || queue.exclusiveRunning) return
  const request = queue.pending
  queue.pending = undefined
  if (!request) {
    const operation = queue.exclusive
    if (!operation) { queues.delete(pathKey); return }
    queue.exclusive = undefined
    queue.exclusiveRunning = true
    try { await operation() } finally {
      queue.exclusiveRunning = false
      void drain(pathKey, queue)
    }
    return
  }
  const tab = current(request.owner)
  if ((request.owner && !tab) || (request.source === 'auto' && !autoEnabled())) {
    cancel(request)
    void drain(pathKey, queue)
    return
  }
  if (tab && autoEnabled()) request.content = tab.content
  queue.running = request
  let succeeded = false
  let downloaded = false
  try {
    const result = await saveFile(request.path, request.content)
    const status = result === 'downloaded' ? 'downloaded' : 'written'
    succeeded = status === 'written'
    downloaded = status === 'downloaded'
    if (succeeded) {
      failures.delete(pathKey)
      if (current(request.owner)) {
        if (request.bind) {
          useEditorStore.getState().saveTabAs(request.owner!.id, request.path, request.title, request.content)
          request.owner = ownerFor(useEditorStore.getState().tabs.find((item) => item.id === request.owner!.id)!)
        } else useEditorStore.getState().markTabSaved(request.owner!.id, request.content)
      }
      scheduleMarkdownDocumentIndex(request.path, request.title, request.content, request.source === 'auto' ? 5000 : 1200)
    }
    for (const waiter of request.waiters) waiter.resolve(receipt(request, status))
  } catch (error) {
    const count = (failures.get(pathKey) ?? 0) + 1
    failures.set(pathKey, count)
    for (const waiter of request.waiters) waiter.reject(error)
    if (request.source === 'auto') {
      const message = describeFileOperationError(error, '保存失败')
      if (count >= 3) toast.error(`自动保存「${request.title}」失败: ${message}`)
      else toast.warning(`自动保存失败: ${request.title}，${message}`)
    }
  } finally {
    queue.running = undefined
  }
  const latest = current(request.owner)
  if (!downloaded && latest && autoEnabled() && latest.content !== (succeeded ? request.content : latest.savedContent) && (failures.get(pathKey) ?? 0) < 3) {
    const pending = queue.pending as Request | undefined
    if (!pending || pending.owner?.identity === request.owner?.identity) {
      queue.pending = { ...request, bind: false, content: latest.content, source: pending?.source ?? 'auto', waiters: pending?.waiters ?? [] }
    }
  }
  if (downloaded && queue.pending?.source === 'auto') {
    cancel(queue.pending)
    queue.pending = undefined
  }
  // Undoing to the confirmed disk snapshot supersedes an obsolete queued edit.
  if (queue.pending) {
    const pendingTab = current(queue.pending.owner)
    if (pendingTab && !queue.pending.bind && pendingTab.content === pendingTab.savedContent && pendingTab.content !== queue.pending.content) {
      cancel(queue.pending)
      queue.pending = undefined
    }
  }
  if (!queue.pending) { void drain(pathKey, queue); return }
  if (!succeeded && queue.pending.source === 'auto') {
    if ((failures.get(pathKey) ?? 0) >= 3) { cancel(queue.pending); queue.pending = undefined; void drain(pathKey, queue); return }
    queue.timer = setTimeout(() => { queue.timer = undefined; void drain(pathKey, queue) }, delay())
  } else void drain(pathKey, queue)
}

// A sealed external write shares the ordinary save lock, but is never coalesced
// with a user save or replaced with a newer Tab body.
export function runDocumentSaveTransaction<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const pathKey = key(path)
  let queue = queues.get(pathKey)
  if (!queue) { queue = {}; queues.set(pathKey, queue) }
  if (queue.exclusive || queue.exclusiveRunning) return Promise.reject(new Error('DOCUMENT_SAVE_BUSY'))
  const promise = new Promise<T>((resolve, reject) => {
    queue.exclusive = async () => {
      try { resolve(await operation()) } catch (error) { reject(error) }
    }
  })
  if (!queue.running && !queue.timer) void drain(pathKey, queue)
  return promise
}

function tabsAtPath(path: string): Tab[] {
  return useEditorStore.getState().tabs.filter(tab => tab.filePath && key(tab.filePath) === key(path))
}

export function captureDocumentWriteSnapshot(path: string, content: string): DocumentWriteSnapshot {
  const tabs = tabsAtPath(path)
  if (tabs.length > 1 || tabs.some(tab => tab.content !== content || tab.savedContent !== content)) throw new Error('DOCUMENT_SAVE_CONFLICT')
  return { path, content, owner: tabs[0] ? ownerFor(tabs[0]) : null }
}

export function validateDocumentWriteSnapshot(snapshot: DocumentWriteSnapshot): void {
  const tabs = tabsAtPath(snapshot.path)
  const tab = current(snapshot.owner)
  if (snapshot.owner
    ? !tab || tabs.length !== 1 || tabs[0] !== tab || tab.content !== snapshot.content || tab.savedContent !== snapshot.content
    : tabs.length !== 0) throw new Error('DOCUMENT_SAVE_CONFLICT')
}

export function applyDocumentWriteSnapshot(snapshot: DocumentWriteSnapshot, content: string, write: () => Promise<void>): Promise<SaveReceipt> {
  return runDocumentSaveTransaction(snapshot.path, async () => {
    validateDocumentWriteSnapshot(snapshot)
    // Never stage the proposal in the Tab before Rust confirms the disk write:
    // a rejected/failed proposal must not become a later auto-save.
    await write()
    const tab = current(snapshot.owner)
    if (tab) {
      if (tab.content === snapshot.content && tab.savedContent === snapshot.content) {
        const queue = queues.get(key(snapshot.path))
        if (queue?.pending?.owner?.identity === snapshot.owner?.identity && queue?.pending) {
          cancel(queue.pending)
          queue.pending = undefined
        }
        useEditorStore.getState().updateTabContent(tab.id, content)
      }
      useEditorStore.getState().markTabSaved(tab.id, content)
    }
    const title = tab?.title ?? snapshot.path.split(/[\\/]/).pop() ?? 'Markdown'
    scheduleMarkdownDocumentIndex(tab?.filePath ?? snapshot.path, title, content, 1200)
    return { status: 'written', path: snapshot.path, content, currentSaved: !!tab && current(snapshot.owner)?.content === content }
  })
}

export function saveDocument(tabId: string, source: Source = 'manual'): Promise<SaveReceipt | null> {
  const tab = useEditorStore.getState().tabs.find((item) => item.id === tabId)
  if (!tab) return Promise.resolve(null)
  if (!tab.filePath) return source === 'manual' ? saveDocumentAs(tabId) : Promise.resolve(null)
  return enqueue({ owner: ownerFor(tab), path: tab.filePath, title: tab.title, content: tab.content, source, bind: false })
}

export function saveDocumentAs(tabId: string): Promise<SaveReceipt | null> {
  const tab = useEditorStore.getState().tabs.find((item) => item.id === tabId)
  if (!tab) return Promise.resolve(null)
  const owner = ownerFor(tab)
  const existing = selectors.get(owner.identity)
  if (existing) return existing
  const promise = (async () => {
    const target = await selectSaveTarget()
    const latest = current(owner)
    if (!target || !latest) return null
    return enqueue({ owner, path: target.path, title: target.name, content: latest.content, source: 'manual', bind: true })
  })().catch((error: unknown) => {
    if (error instanceof Error && error.name === 'AbortError') return null
    throw error
  }).finally(() => { selectors.delete(owner.identity) })
  selectors.set(owner.identity, promise)
  return promise
}

export async function saveDocumentCopy(content: string, tabId?: string): Promise<SaveReceipt | null> {
  const tab = useEditorStore.getState().tabs.find((item) => item.id === tabId)
  const owner = tab ? ownerFor(tab) : null
  const target = await selectSaveTarget()
  if (!target) return null
  if (owner) {
    const latest = current(owner)
    if (!latest) return null
    content = latest.content
  }
  return enqueue({ owner: null, path: target.path, title: target.name, content, source: 'manual', bind: false })
}

export async function persistDocumentContent(tabId: string, content: string): Promise<SaveReceipt | null> {
  const tab = useEditorStore.getState().tabs.find((item) => item.id === tabId)
  if (!tab) return null
  useEditorStore.getState().updateTabContent(tabId, content)
  return tab.filePath ? saveDocument(tabId) : null
}

export async function saveActiveDocument(): Promise<void> {
  const id = useEditorStore.getState().activeTabId
  if (!id) return
  try {
    const result = await saveDocument(id)
    if (result?.status === 'downloaded') toast.success('已触发下载')
    else if (result?.currentSaved) toast.success('已保存')
  } catch (error) { toast.error(describeFileOperationError(error, '保存失败')) }
}
