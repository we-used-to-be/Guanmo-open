/**
 * 助手消息导出为 Markdown。
 *
 * 仅由用户主动触发（按钮），不向 Agent 开放写文件能力。
 * 复用既有 saveFileAs（原生对话框 + .md 校验 + 写入 + 授权）、editorStore.addTab 与
 * scheduleMarkdownDocumentIndex；不在导出正文写入绝对路径、聊天隐私或内部调试字段。
 */
import type { ChatMessageSource, LocalChatMessageSource, WebChatMessageSource } from '@/services/ai/types'
import { saveFileAs } from '@/services/fileSystem'
import { useEditorStore } from '@/stores/editorStore'
import { scheduleMarkdownDocumentIndex } from '@/services/rag/indexer'
import { toast } from '@/services/toast'
import { describeFileOperationError } from '@/services/fileOperationErrors'

export interface AssistantMessageExportInput {
  content: string
  question?: string
  sources?: ChatMessageSource[]
  timestamp?: number
}

function formatQuestionFrontmatter(question: string | undefined): string | null {
  const normalized = question?.trim().replace(/\r\n?/g, '\n')
  if (!normalized) return null
  const indented = normalized.split('\n').map((line) => `  ${line}`).join('\n')
  return `---\nai_question: |-\n${indented}\n---`
}

function formatExportDate(timestamp: number): string {
  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) return ''
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function formatLocalSource(source: LocalChatMessageSource): string {
  const heading = source.titlePath?.length
    ? source.titlePath.join(' / ')
    : source.heading
  const location = `L${source.startLine}-${source.endLine}`
  // 不写入绝对路径，仅保留可读文件名、标题路径与行号范围。
  return heading
    ? `- **${source.fileName}** · ${heading} · ${location}`
    : `- **${source.fileName}** · ${location}`
}

function formatWebSource(source: WebChatMessageSource): string {
  const meta = [source.siteName, source.publishedAt].filter(Boolean).join(' / ')
  return meta ? `- [${source.title}](${source.url}) · ${meta}` : `- [${source.title}](${source.url})`
}

function formatSource(source: ChatMessageSource): string {
  if (source.kind === 'memory') return `- **记忆**：${source.content}`
  return source.kind === 'web' ? formatWebSource(source) : formatLocalSource(source)
}

/**
 * 由确定性应用代码组装导出 Markdown：标题 + 正文 + 可读来源。
 * 不写入绝对路径、聊天隐私或内部调试字段；无来源时不输出来源区块。
 */
export function buildAssistantMessageMarkdown(input: AssistantMessageExportInput): string {
  const { content, question, sources = [], timestamp } = input
  const sections: string[] = []
  const questionFrontmatter = formatQuestionFrontmatter(question)
  if (questionFrontmatter) sections.push(questionFrontmatter)
  sections.push('# AI 阅读回复')

  if (typeof timestamp === 'number' && Number.isFinite(timestamp)) {
    const dateStr = formatExportDate(timestamp)
    if (dateStr) sections.push(`> 生成于 ${dateStr}`)
  }

  const body = content.trim()
  if (body) sections.push(body)

  if (sources.length > 0) {
    const lines = sources.map(formatSource).filter(Boolean)
    if (lines.length > 0) {
      sections.push('---')
      sections.push('## 来源')
      sections.push(lines.join('\n'))
    }
  }

  return `${sections.join('\n\n').trim()}\n`
}

/**
 * 保存助手消息为 Markdown：打开既有保存对话框 → 写入 → 开为新标签 → 调度 RAG 索引。
 * 取消、非法扩展名或写入失败均不留下半成品标签页；失败时仅提示错误。
 */
export async function saveAssistantMessageAsMarkdown(
  content: string,
  sources?: ChatMessageSource[],
  question?: string,
): Promise<{ saved: boolean }> {
  const markdown = buildAssistantMessageMarkdown({ content, question, sources, timestamp: Date.now() })
  try {
    const result = await saveFileAs(markdown)
    if (!result) return { saved: false }
    useEditorStore.getState().addTab(result.path, result.name, result.content)
    scheduleMarkdownDocumentIndex(result.path, result.name, result.content)
    toast.success(`已保存为 ${result.name}`)
    return { saved: true }
  } catch (err) {
    toast.error(describeFileOperationError(err, '保存失败'))
    return { saved: false }
  }
}
