import { useCallback, useEffect, useRef } from 'react'
import { useEditorStore } from '@/stores/editorStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { openFile, saveFile } from '@/services/fileSystem'
import { scheduleMarkdownDocumentIndex } from '@/services/rag/indexer'
import { isSameFilePath } from '@/services/pathIdentity'
import { toast } from '@/services/toast'
import { describeFileOperationError } from '@/services/fileOperationErrors'
import { isTauri } from '@/hooks/useTauri'

const AUTO_SAVE_INDEX_DELAY = 5000

export function useFileOperations() {
  const addTab = useEditorStore((s) => s.addTab)
  const tabs = useEditorStore((s) => s.tabs)
  const editor = useSettingsStore((s) => s.editor)
  const autoSaveTimersRef = useRef<Map<string, { timer: ReturnType<typeof setTimeout>; content: string }>>(new Map())
  const autoSaveRetriesRef = useRef<Map<string, number>>(new Map())

  const handleNewFile = useCallback(() => {
    addTab(undefined, '未命名.md')
  }, [addTab])

  const handleOpenFile = useCallback(async () => {
    try {
      const file = await openFile()
      if (file) {
        // Check if file is already open
        const existing = tabs.find((t) => isSameFilePath(t.filePath, file.path))
        if (existing) {
          useEditorStore.getState().setActiveTab(existing.id)
          return
        }
        addTab(file.path, file.name, file.content)
        scheduleMarkdownDocumentIndex(file.path, file.name, file.content)
      }
    } catch (err) {
      console.error('Open file failed:', err)
      toast.error('打开文件失败')
    }
  }, [addTab, tabs])

  const handleSaveFile = useCallback(async () => {
    const state = useEditorStore.getState()
    const tab = state.tabs.find((t) => t.id === state.activeTabId)
    if (!tab) return

    try {
      if (tab.filePath) {
        await saveFile(tab.filePath, tab.content)
        scheduleMarkdownDocumentIndex(tab.filePath, tab.title, tab.content)
        // Clear modified flag
        useEditorStore.setState((s) => ({
          tabs: s.tabs.map((t) =>
            t.id === tab.id ? { ...t, savedContent: tab.content, modified: false } : t
          ),
        }))
        toast.success('已保存')
      } else {
        // Save As
        const { saveFileAs } = await import('@/services/fileSystem')
        const result = await saveFileAs(tab.content)
        if (result) {
          scheduleMarkdownDocumentIndex(result.path, result.name, result.content)
          useEditorStore.setState((s) => ({
            tabs: s.tabs.map((t) =>
              t.id === tab.id
                ? { ...t, filePath: result.path, title: result.name, savedContent: result.content, modified: false }
                : t
            ),
          }))
          toast.success('已保存')
        }
      }
    } catch (err) {
      console.error('Save file failed:', err)
      toast.error(describeFileOperationError(err, '保存失败'))
    }
  }, [])

  // Auto-save effect
  useEffect(() => {
    const clearAutoSaveTimers = () => {
      for (const { timer } of autoSaveTimersRef.current.values()) {
        clearTimeout(timer)
      }
      autoSaveTimersRef.current.clear()
    }

    if (!isTauri() || !editor.autoSave) {
      clearAutoSaveTimers()
      autoSaveRetriesRef.current.clear()
      return
    }

    const MAX_RETRIES = 3
    const delay = editor.autoSaveDelay || 1000

    const scheduleTabSave = (tabId: string, content: string) => {
      const timer = setTimeout(async () => {
        autoSaveTimersRef.current.delete(tabId)
        const state = useEditorStore.getState()
        const tab = state.tabs.find((t) => t.id === tabId)
        if (!tab?.modified || !tab.filePath || tab.content !== content) return

        const retries = autoSaveRetriesRef.current.get(tab.id) || 0
        if (retries >= MAX_RETRIES) return

        try {
          await saveFile(tab.filePath, content)
          scheduleMarkdownDocumentIndex(tab.filePath, tab.title, content, AUTO_SAVE_INDEX_DELAY)
          autoSaveRetriesRef.current.delete(tab.id)
          useEditorStore.setState((s) => ({
            tabs: s.tabs.map((t) =>
              t.id === tab.id && t.content === content
                ? { ...t, savedContent: content, modified: false }
                : t
            ),
          }))
        } catch (err) {
          const nextRetries = retries + 1
          autoSaveRetriesRef.current.set(tab.id, nextRetries)
          console.error(`Auto-save failed for ${tab.title} (${nextRetries}/${MAX_RETRIES}):`, err)
          if (nextRetries >= MAX_RETRIES) {
            toast.error(`自动保存「${tab.title}」失败: ${describeFileOperationError(err, '保存失败')}`)
          } else {
            toast.warning(`自动保存失败: ${tab.title}，${describeFileOperationError(err, '保存失败')}`)
            scheduleTabSave(tab.id, content)
          }
        }
      }, delay)

      autoSaveTimersRef.current.set(tabId, { timer, content })
    }

    const modifiedTabIds = new Set<string>()
    for (const tab of tabs) {
      if (!tab.modified || !tab.filePath) continue
      modifiedTabIds.add(tab.id)
      const existing = autoSaveTimersRef.current.get(tab.id)
      if (existing?.content === tab.content) continue
      if (existing) {
        clearTimeout(existing.timer)
      }
      scheduleTabSave(tab.id, tab.content)
    }

    for (const [tabId, { timer }] of autoSaveTimersRef.current) {
      if (modifiedTabIds.has(tabId)) continue
      clearTimeout(timer)
      autoSaveTimersRef.current.delete(tabId)
      autoSaveRetriesRef.current.delete(tabId)
    }

    return clearAutoSaveTimers
  }, [editor.autoSave, editor.autoSaveDelay, tabs])

  return { handleNewFile, handleOpenFile, handleSaveFile }
}
