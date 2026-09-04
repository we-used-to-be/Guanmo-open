import { toast } from '@/services/toast'
import type { PersistedTabRestoreIssue } from '@/services/sessionRestore'
import { useEditorStore } from '@/stores/editorStore'

export function showSessionRestoreIssues(issues: PersistedTabRestoreIssue[]): void {
  const unavailable = issues.filter((issue) => issue.kind === 'unavailable')
  if (unavailable.length > 0) {
    const message = unavailable.length === 1
      ? `无法读取「${unavailable[0].title}」，文件可能已移动、删除或暂时不可用；标签已保留。`
      : `${unavailable.length} 个标签对应的文件已移动、删除或暂时不可用；标签已保留。`
    toast.show({
      id: 'session-restore-unavailable',
      title: '文件恢复不完整',
      message,
      type: 'warning',
      duration: null,
    })
  }

  const tooLarge = issues.filter((issue) => issue.kind === 'too-large')
  if (tooLarge.length > 0) {
    const preservedDrafts = tooLarge.filter((issue) => issue.preservedDraft)
    const message = tooLarge.length === 1
      ? preservedDrafts.length === 1
        ? `「${tooLarge[0].title}」文件过大，已保留未保存内容，未刷新磁盘版本。`
        : `「${tooLarge[0].title}」文件过大，本次启动已跳过恢复。`
      : preservedDrafts.length > 0
        ? `${tooLarge.length} 个文件超过打开上限，其中 ${preservedDrafts.length} 个标签保留了未保存内容。`
        : `${tooLarge.length} 个文件超过打开上限，本次启动已跳过恢复。`
    toast.show({
      id: 'session-restore-too-large',
      title: '已跳过过大文件',
      message,
      type: 'warning',
      duration: null,
    })
  }

  const changed = issues.filter((issue) => issue.kind === 'external-change')
  if (changed.length === 0) return
  const currentTabs = useEditorStore.getState().tabs
  const preservedDrafts = changed.filter((issue) => currentTabs.find((tab) => tab.id === issue.tabId)?.modified)
  const message = changed.length === 1
    ? preservedDrafts.length === 1
      ? `「${changed[0].title}」的磁盘内容已变化，已保留你的未保存内容。`
      : `「${changed[0].title}」的磁盘内容已变化，已刷新为最新版本。`
    : preservedDrafts.length > 0
      ? `${changed.length} 个文件的磁盘内容已变化，其中 ${preservedDrafts.length} 个标签保留了未保存内容。`
      : `${changed.length} 个文件的磁盘内容已变化，已刷新为最新版本。`
  toast.show({
    id: 'session-restore-external-change',
    title: '启动内容已过期',
    message,
    type: 'warning',
    duration: null,
  })
}
