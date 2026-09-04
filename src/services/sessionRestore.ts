import type { Tab } from '@/stores/editorStore'
import { isWorkspaceDisplayFile } from '@/services/fileTree'
import { parseFileTooLargeError, readRememberedMarkdownFileForOpen } from '@/services/markdownFileOpenPolicy'
export { mergeBackgroundRestoredTab } from '@/services/sessionRestorePolicy'

interface RestorePersistedTabsOptions {
  activeTabId?: string | null
  concurrency?: number
  readFile?: (path: string) => Promise<string>
  detectExternalChanges?: boolean
  onTabRestored?: (tab: Tab, index: number) => void
  onTabRestoreIssue?: (issue: PersistedTabRestoreIssue, index: number) => void
}

export interface PersistedTabRestoreIssue {
  kind: 'external-change' | 'unavailable' | 'too-large'
  tabId: string
  title: string
  actualBytes?: number
  limitBytes?: number
  preservedDraft?: boolean
}

export function getRestorablePersistedTabs(tabs: Tab[]): Tab[] {
  return tabs.filter((tab) => !tab.filePath || isWorkspaceDisplayFile(tab.filePath))
}

async function restorePersistedTab(
  tab: Tab,
  readFile: (path: string) => Promise<string>,
  detectExternalChanges: boolean,
): Promise<{ tab: Tab | null; issue?: PersistedTabRestoreIssue }> {
  if (!tab.filePath) {
    return {
      tab: {
        ...tab,
        originalContent: tab.originalContent ?? tab.savedContent ?? tab.content,
      },
    }
  }

  try {
    const diskContent = await readFile(tab.filePath)
    const externallyChanged = tab.modified
      ? diskContent !== tab.savedContent
      : detectExternalChanges && diskContent !== tab.content
    const issue = externallyChanged
      ? { kind: 'external-change' as const, tabId: tab.id, title: tab.title }
      : undefined
    if (tab.modified) {
      return {
        tab: {
          ...tab,
          originalContent: tab.originalContent ?? tab.savedContent ?? tab.content,
          savedContent: diskContent,
          modified: tab.content !== diskContent,
        },
        issue,
      }
    }
    return {
      tab: {
        ...tab,
        content: diskContent,
        savedContent: diskContent,
        originalContent: diskContent,
        modified: false,
      },
      issue,
    }
  } catch (error) {
    const tooLarge = parseFileTooLargeError(error)
    if (tooLarge && !tab.modified) {
      return {
        tab: null,
        issue: {
          kind: 'too-large',
          tabId: tab.id,
          title: tab.title,
          actualBytes: tooLarge.actualBytes,
          limitBytes: tooLarge.limitBytes,
        },
      }
    }
    console.warn('[SessionRestore] Failed to read persisted tab', {
      errorType: error instanceof Error ? error.name : typeof error,
    })
    return {
      tab: {
        ...tab,
        originalContent: tab.originalContent ?? tab.savedContent ?? tab.content,
      },
      issue: tooLarge
        ? {
            kind: 'too-large',
            tabId: tab.id,
            title: tab.title,
            actualBytes: tooLarge.actualBytes,
            limitBytes: tooLarge.limitBytes,
            preservedDraft: true,
          }
        : { kind: 'unavailable', tabId: tab.id, title: tab.title },
    }
  }
}

/**
 * 恢复持久化标签页。
 * 未修改的磁盘文件刷新为当前文件内容；有未保存修改的标签保留持久化内容，避免丢失草稿。
 */
export async function restorePersistedTabs(
  tabs: Tab[],
  options: RestorePersistedTabsOptions = {}
): Promise<Tab[]> {
  const restorableTabs = getRestorablePersistedTabs(tabs)
  const restored: Array<Tab | undefined> = [...restorableTabs]
  const readFile = options.readFile ?? readRememberedMarkdownFileForOpen
  const activeIndex = restorableTabs.findIndex((tab) => tab.id === options.activeTabId)
  const pendingIndexes = restorableTabs.map((_, index) => index)
  if (activeIndex > 0) {
    pendingIndexes.splice(activeIndex, 1)
    pendingIndexes.unshift(activeIndex)
  }
  const concurrency = Math.max(1, Math.min(options.concurrency ?? 1, pendingIndexes.length || 1))

  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (pendingIndexes.length > 0) {
      const index = pendingIndexes.shift()
      if (index === undefined) return
      const result = await restorePersistedTab(
        restorableTabs[index],
        readFile,
        options.detectExternalChanges ?? false,
      )
      const tab = result.tab
      if (tab) {
        restored[index] = tab
        options.onTabRestored?.(tab, index)
      } else {
        restored[index] = undefined
      }
      if (result.issue) options.onTabRestoreIssue?.(result.issue, index)
    }
  }))

  return restored.filter((tab): tab is Tab => Boolean(tab))
}
