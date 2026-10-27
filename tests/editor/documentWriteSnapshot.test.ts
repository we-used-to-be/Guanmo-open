import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useEditorStore, type Tab } from '@/stores/editorStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { applyDocumentWriteSnapshot, captureDocumentWriteSnapshot, runDocumentSaveTransaction, saveDocument, validateDocumentWriteSnapshot } from '@/services/documentSave'
import { scheduleMarkdownDocumentIndex } from '@/services/rag/indexer'

const writer = vi.hoisted(() => vi.fn())
vi.mock('@/services/fileSystem', () => ({ saveFile: writer, selectSaveTarget: vi.fn() }))
vi.mock('@/services/rag/indexer', () => ({ scheduleMarkdownDocumentIndex: vi.fn() }))
vi.mock('@/hooks/useTauri', () => ({ isTauri: () => true }))
vi.mock('@/services/toast', () => ({ toast: { warning: vi.fn(), error: vi.fn() } }))

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
function tab(content = 'before'): Tab {
  return { id: 'snapshot-tab', filePath: 'X:/anonymous/a.md', title: 'a.md', content, savedContent: 'before', originalContent: 'before', modified: content !== 'before' }
}
beforeEach(() => {
  useSettingsStore.setState({ editor: { ...useSettingsStore.getState().editor, autoSave: false } })
  useEditorStore.setState({ tabs: [] })
  useEditorStore.setState({ tabs: [tab()], activeTabId: 'snapshot-tab' })
  writer.mockReset().mockResolvedValue('written')
  vi.mocked(scheduleMarkdownDocumentIndex).mockClear()
})
afterEach(() => { useSettingsStore.setState({ editor:{ ...useSettingsStore.getState().editor, autoSave:false } }); vi.useRealTimers() })

it('sealed operation waits for ordinary saves and retains its own path lock', async () => {
  const gate = deferred()
  const operationGate = deferred()
  writer.mockImplementationOnce(() => gate.promise)
  const first = saveDocument('snapshot-tab')
  const operation = vi.fn(() => operationGate.promise)
  const transaction = runDocumentSaveTransaction('x:\\ANONYMOUS\\A.md', operation)
  expect(operation).not.toHaveBeenCalled()
  gate.resolve(); await first
  expect(operation).toHaveBeenCalledOnce()
  useEditorStore.getState().updateTabContent('snapshot-tab', 'user draft')
  const next = saveDocument('snapshot-tab')
  expect(writer).toHaveBeenCalledTimes(1)
  await expect(runDocumentSaveTransaction('X:/anonymous/a.md', async () => {})).rejects.toThrow('DOCUMENT_SAVE_BUSY')
  await runDocumentSaveTransaction('X:/anonymous/other.md', async () => {})
  operationGate.resolve(); await transaction; await next
  expect(writer.mock.calls.map(call => call[1])).toEqual(['before', 'user draft'])
})

it('dirty Tab, duplicate paths, close/reopen and newly opened targets invalidate snapshots', () => {
  useEditorStore.setState({ tabs: [tab('dirty')] })
  expect(() => captureDocumentWriteSnapshot('X:/anonymous/a.md', 'before')).toThrow('DOCUMENT_SAVE_CONFLICT')
  useEditorStore.setState({ tabs: [tab()] })
  const snapshot = captureDocumentWriteSnapshot('X:/anonymous/a.md', 'before')
  useEditorStore.setState({ tabs: [] })
  useEditorStore.setState({ tabs: [tab()] })
  expect(() => validateDocumentWriteSnapshot(snapshot)).toThrow('DOCUMENT_SAVE_CONFLICT')
  useEditorStore.setState({ tabs: [] })
  const closed = captureDocumentWriteSnapshot('X:/anonymous/a.md', 'before')
  useEditorStore.setState({ tabs: [tab()] })
  expect(() => validateDocumentWriteSnapshot(closed)).toThrow('DOCUMENT_SAVE_CONFLICT')
  useEditorStore.setState({ tabs: [tab(), { ...tab(), id: 'duplicate' }] })
  expect(() => captureDocumentWriteSnapshot('X:/anonymous/a.md', 'before')).toThrow('DOCUMENT_SAVE_CONFLICT')
})

it('edits made while waiting in the queue reject the sealed write without staging content', async () => {
  const gate = deferred()
  writer.mockImplementationOnce(() => gate.promise)
  const snapshot = captureDocumentWriteSnapshot('X:/anonymous/a.md', 'before')
  const first = saveDocument('snapshot-tab')
  const commit = vi.fn().mockResolvedValue(undefined)
  const applying = applyDocumentWriteSnapshot(snapshot, 'external', commit)
  const rejected = expect(applying).rejects.toThrow('DOCUMENT_SAVE_CONFLICT')
  useEditorStore.getState().updateTabContent('snapshot-tab', 'draft')
  gate.resolve(); await first; await rejected
  expect(commit).not.toHaveBeenCalled()
  expect(useEditorStore.getState().tabs[0]).toMatchObject({ content: 'draft', savedContent: 'before' })
})

it('success updates a clean Tab only after the actual disk receipt', async () => {
  const gate = deferred()
  const snapshot = captureDocumentWriteSnapshot('X:/anonymous/a.md', 'before')
  const applying = applyDocumentWriteSnapshot(snapshot, 'external', () => gate.promise)
  expect(useEditorStore.getState().tabs[0].content).toBe('before')
  gate.resolve()
  expect(await applying).toMatchObject({ status: 'written', currentSaved: true })
  expect(useEditorStore.getState().tabs[0]).toMatchObject({ content: 'external', savedContent: 'external', modified: false })
  expect(writer).not.toHaveBeenCalled()
  expect(scheduleMarkdownDocumentIndex).toHaveBeenCalledWith(snapshot.path, 'a.md', 'external', 1200)
})

it('edits during an already dispatched write survive and ordinary saves follow the exclusive write', async () => {
  const gate = deferred()
  const snapshot = captureDocumentWriteSnapshot('X:/anonymous/a.md', 'before')
  const applying = applyDocumentWriteSnapshot(snapshot, 'external', () => gate.promise)
  useEditorStore.getState().updateTabContent('snapshot-tab', 'user draft')
  const saving = saveDocument('snapshot-tab')
  expect(writer).not.toHaveBeenCalled()
  gate.resolve()
  expect(await applying).toMatchObject({ currentSaved: false })
  await saving
  expect(writer.mock.calls.map(call => call[1])).toEqual(['user draft'])
  expect(useEditorStore.getState().tabs[0]).toMatchObject({ content: 'user draft', savedContent: 'user draft' })
})

it('failed write leaves Tab and indexing untouched, and releases the queue', async () => {
  const snapshot = captureDocumentWriteSnapshot('X:/anonymous/a.md', 'before')
  await expect(applyDocumentWriteSnapshot(snapshot, 'external', async () => { throw new Error('synthetic failure') })).rejects.toThrow('synthetic failure')
  expect(useEditorStore.getState().tabs[0]).toMatchObject({ content: 'before', savedContent: 'before', modified: false })
  expect(scheduleMarkdownDocumentIndex).not.toHaveBeenCalled()
  await saveDocument('snapshot-tab')
  expect(writer).toHaveBeenCalledOnce()
})

it('a redundant save of the unchanged pre-commit body cannot undo the external write', async () => {
  const gate = deferred()
  const snapshot = captureDocumentWriteSnapshot('X:/anonymous/a.md', 'before')
  const applying = applyDocumentWriteSnapshot(snapshot, 'external', () => gate.promise)
  const redundant = saveDocument('snapshot-tab')
  gate.resolve(); await applying
  expect(await redundant).toMatchObject({ status:'cancelled' })
  expect(writer).not.toHaveBeenCalled()
  expect(useEditorStore.getState().tabs[0]).toMatchObject({ content:'external', savedContent:'external' })
})

it('a canonical Rust path shares the Tab identity and existing indexing path', async () => {
  const snapshot = captureDocumentWriteSnapshot('\\\\?\\X:\\anonymous\\a.md', 'before')
  await applyDocumentWriteSnapshot(snapshot, 'external', async () => {})
  expect(scheduleMarkdownDocumentIndex).toHaveBeenCalledWith('X:/anonymous/a.md', 'a.md', 'external', 1200)
  expect(useEditorStore.getState().tabs[0]).toMatchObject({ content:'external', savedContent:'external' })
})

it('an exclusive waiter survives bounded auto-save failures and is not deleted with the last retry', async () => {
  vi.useFakeTimers()
  useSettingsStore.setState({ editor:{ ...useSettingsStore.getState().editor, autoSave:true, autoSaveDelay:100 } })
  useEditorStore.getState().updateTabContent('snapshot-tab', 'dirty')
  writer.mockRejectedValue(new Error('synthetic failure'))
  await expect(saveDocument('snapshot-tab', 'auto')).rejects.toThrow('synthetic failure')
  const operation = vi.fn().mockResolvedValue('exclusive result')
  const transaction = runDocumentSaveTransaction('X:/anonymous/a.md', operation)
  expect(operation).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(300)
  expect(await transaction).toBe('exclusive result')
  expect(operation).toHaveBeenCalledOnce(); expect(writer).toHaveBeenCalledTimes(3)
})

it('closing/reopening during committed I/O never mutates the replacement Tab', async () => {
  const gate = deferred()
  const snapshot = captureDocumentWriteSnapshot('X:/anonymous/a.md', 'before')
  const applying = applyDocumentWriteSnapshot(snapshot, 'external', () => gate.promise)
  useEditorStore.setState({ tabs: [] })
  useEditorStore.setState({ tabs: [tab('replacement draft')] })
  gate.resolve()
  expect(await applying).toMatchObject({ currentSaved: false })
  expect(useEditorStore.getState().tabs[0]).toMatchObject({ content: 'replacement draft', savedContent: 'before' })
})
