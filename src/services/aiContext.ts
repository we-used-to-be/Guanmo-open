import { useAppStore } from '@/stores/appStore'
import { useChatStore } from '@/stores/chatStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { MAX_SELECTION_CHARS } from '@/types/contextTag'

const PREVIEW_LENGTH = 160
export const AI_SHORTCUT_SUBMIT_EVENT = 'guanmo:submit-ai-shortcut'

function truncateSelection(text: string): string {
  if (text.length <= MAX_SELECTION_CHARS) return text
  return `${text.slice(0, MAX_SELECTION_CHARS)}\n\n...（内容已截断，共 ${text.length} 字符）`
}

function extractFileName(path: string): string {
  return path.split(/[/\\]/).pop() || path
}

/** 打开 AI 面板 */
function ensureAiPanelOpen() {
  const app = useAppStore.getState()
  if (!app.aiPanelOpen) app.toggleAiPanel()
}

/**
 * 添加选中文本作为 contextTag
 */
export function addSelectionContextTag(args: {
  title: string
  filePath?: string | null
  text: string
  startLine?: number
  endLine?: number
  selectionFrom?: number
  selectionTo?: number
}) {
  const text = args.text
  if (!text.trim()) return

  ensureAiPanelOpen()

  const truncated = truncateSelection(text)
  const fileName = args.filePath ? extractFileName(args.filePath) : args.title

  useChatStore.getState().addContextTag({
    type: 'selection',
    title: fileName,
    filePath: args.filePath ?? null,
    content: truncated,
    preview: text.slice(0, PREVIEW_LENGTH),
    startLine: args.startLine,
    endLine: args.endLine,
    selectionFrom: args.selectionFrom,
    selectionTo: args.selectionTo,
  })
}

/**
 * 添加文件引用作为 contextTag（不预读文件内容）
 */
export function addFileContextTag(args: {
  title: string
  filePath?: string | null
}) {
  ensureAiPanelOpen()

  const fileName = args.filePath ? extractFileName(args.filePath) : args.title

  useChatStore.getState().addContextTag({
    type: 'file',
    title: fileName,
    filePath: args.filePath ?? null,
    content: null,
    preview: args.filePath || args.title,
  })
}

// ─── 向后兼容：旧函数内部改为调用新 tag API ───

/** @deprecated 使用 addSelectionContextTag 代替 */
export function appendSelectionToAiDraft(args: {
  title: string
  filePath?: string | null
  text: string
}) {
  addSelectionContextTag(args)
}

/** @deprecated 使用 addFileContextTag 代替 */
export function appendFileToAiDraft(args: {
  title: string
  filePath?: string | null
  content: string
}) {
  addFileContextTag(args)
}

/** 追加文本到输入草稿（其他场景保留使用） */
export function appendToAiDraft(content: string) {
  if (!content.trim()) return
  ensureAiPanelOpen()
  useChatStore.getState().appendDraftInput(content.trim())
}

export function setAiShortcutPrompt(prompt: string) {
  if (!prompt.trim()) return
  ensureAiPanelOpen()
  useChatStore.getState().setDraftInput(prompt)
  if (useSettingsStore.getState().editor.autoSendAiShortcut && typeof window !== 'undefined') {
    window.setTimeout(() => window.dispatchEvent(new Event(AI_SHORTCUT_SUBMIT_EVENT)), 0)
  }
}

/**
 * 添加文件夹引用作为 contextTag
 */
export function addFolderContextTag(args: {
  title: string
  folderPath: string
}) {
  ensureAiPanelOpen()

  const name = args.folderPath.split(/[/\\]/).pop() || args.title

  useChatStore.getState().addContextTag({
    type: 'folder',
    title: name,
    filePath: null,
    folderPath: args.folderPath,
    content: null,
    preview: args.folderPath,
  })
}
