export interface ShortcutItem {
  id: string
  key: string
  label: string
  category: string
}

export const SHORTCUTS: ShortcutItem[] = [
  { id: 'new-file', key: 'Ctrl+N', label: '新建文件', category: '文件' },
  { id: 'open-file', key: 'Ctrl+O', label: '打开文件', category: '文件' },
  { id: 'save-file', key: 'Ctrl+S', label: '保存当前文件', category: '文件' },
  { id: 'export-html', key: 'Ctrl+Shift+E', label: '导出当前文档为 HTML', category: '文件' },
  { id: 'command-palette', key: 'Ctrl+Shift+P', label: '打开命令面板', category: '导航' },
  { id: 'quick-open', key: 'Ctrl+P', label: '快速打开', category: '导航' },
  { id: 'settings', key: 'Ctrl+,', label: '打开设置', category: '导航' },
  { id: 'toggle-sidebar', key: 'Ctrl+B', label: '切换侧边栏', category: '视图' },
  { id: 'toggle-ai', key: 'Ctrl+J', label: '切换 AI 面板', category: '视图' },
  { id: 'toggle-preview', key: 'Ctrl+Shift+V', label: '切换编辑/预览', category: '视图' },
  { id: 'toggle-diff', key: 'Ctrl+Shift+D', label: '切换 Markdown Diff', category: '视图' },
  { id: 'view-edit', key: 'Ctrl+Shift+1', label: '切换到编辑模式', category: '视图' },
  { id: 'view-preview', key: 'Ctrl+Shift+2', label: '切换到预览模式', category: '视图' },
  { id: 'view-edit-preview', key: 'Ctrl+Shift+3', label: '切换到编辑+预览', category: '视图' },
  { id: 'view-dual-preview', key: 'Ctrl+Shift+4', label: '切换到对照阅读', category: '视图' },
  { id: 'view-diff-preview', key: 'Ctrl+Shift+5', label: '切换到 Diff 对比', category: '视图' },
  { id: 'search', key: 'Ctrl+F', label: '搜索当前文档', category: '编辑' },
]

export function findShortcutConflicts(shortcuts: ShortcutItem[] = SHORTCUTS): string[] {
  const seen = new Map<string, string>()
  const conflicts: string[] = []
  for (const shortcut of shortcuts) {
    const normalized = shortcut.key.toUpperCase()
    const existing = seen.get(normalized)
    if (existing) {
      conflicts.push(`${shortcut.key}: ${existing} / ${shortcut.label}`)
    } else {
      seen.set(normalized, shortcut.label)
    }
  }
  return conflicts
}
