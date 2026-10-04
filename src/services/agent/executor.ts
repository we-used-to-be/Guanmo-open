import type { AgentConfig, AgentProgressStage, AgentStep, AgentResult, AgentRunRequest, RoutingDecision } from './types'
import type { ChatMessage, ChatMessageSource, ReadingArtifactMessageReference } from '@/services/ai/types'
import { getAiClient, isAiReady } from '@/services/ai/aiClient'
import { getAllTools, getTool, getToolDescriptions, getToolsForLLM } from './toolRegistry'
import { registerBuiltinTools } from './tools'
import { normalizeActionMessage, parseToolCall, stripToolCallJson } from './toolCallParser'
import {
  detectIntentScores,
  shouldAllowMemoryWrite,
  isImplicitEditContinuation,
  shouldIncludeFullDocumentContext,
  isLocalResearchIntent,
  isWebComparisonIntent,
  isFileSummaryIntent,
  isDocumentRewriteIntent,
  type Capability,
  type AppContext,
} from './intentDetector'
import {
  buildCandidateTools,
  checkRequiredCapabilities,
  getRepairTools,
  isWriteTool,
  isReadTool,
  getToolTokenBudget,
  type AgentToolName,
} from './toolSelector'
import { getAgentScopeContext } from '@/services/aiScope'
import { BASE_SYSTEM_PROMPT, CONTEXT_SAFETY_PROMPT, CUSTOM_PROMPT_POLICY, buildUntrustedContextMessage } from '@/services/ai/systemPrompts'
import {
  createSourceReferenceRegistry,
  findSourceReferenceId,
  parseSourceReferences,
  registerSourceReferences,
  type SourceReferenceRegistry,
} from '@/services/ai/sourceReferences'
import {
  FILE_SUMMARY_ANSWER_PROMPT,
  LOCAL_RESEARCH_ANSWER_PROMPT,
  WEB_COMPARISON_ANSWER_PROMPT,
} from './answerInstructions'
import { dropOldestCompleteTurns, isModelContextOverflowError } from '@/services/ai/contextBudget'
import { extractReadingArtifactReferences, mergeReadingArtifactReferences } from './readingArtifactReferences'
import {
  finishAgentTrace,
  finishAgentTraceSpan,
  startAgentTrace,
  startAgentTraceSpan,
} from '@/services/devAgentDiagnostics'

let toolsRegistered = false

function isPendingEditResult(text: string): boolean {
  try {
    const parsed = JSON.parse(text)
    return Boolean(parsed && typeof parsed === 'object' && parsed.__pendingEdit)
  } catch {
    return false
  }
}

function isPendingActionResult(text: string): boolean {
  try {
    const parsed = JSON.parse(text)
    return Boolean(parsed && typeof parsed === 'object' && parsed.__pendingAction)
  } catch {
    return false
  }
}

const DEFAULT_CONFIG: AgentConfig = {
  maxSteps: 6,
  maxToolCalls: 8,
  stepTimeout: 30000,
  deadlineMs: 120000,
  systemPrompt: `${BASE_SYSTEM_PROMPT}

${CONTEXT_SAFETY_PROMPT}

你是一个 MD 文档助手，擅长 Markdown 格式的写作、润色和编辑。

你可以使用工具来帮助用户完成任务。当需要使用工具时，每次工具调用都必须生成一句给用户看的行动说明。使用 JSON 格式调用时，请严格按以下格式输出，不要输出其他内容：
{"tool": "工具名", "args": {"参数名": "参数值"}, "actionMessage": "我会先搜索相关资料"}

actionMessage 必须是简短的单行行动说明，只描述接下来要做的事，不是工具参数；不要放入 args，不要包含路径、原文或“已完成”等结果性表述。使用原生 tool call 协议时，必须把这句话放在同轮独立的文本 content 中。批量调用时用一句话概括本批次动作。

当你判断需要弹出文本修改确认卡片时，也可以输出以下 JSON。系统会校验 needsEditConfirmation，并自动转换为 replace_current_tab_text 工具调用：
{"needsEditConfirmation": true, "targetId": "本轮可编辑目标 ID", "oldText": "当前编辑器中要替换的原文", "newText": "替换后的新文本", "changeSummary": "简短变更摘要", "actionMessage": "我会先生成修改确认卡片"}
修改用户添加到聊天框的 selection 或 file 标签所指向的文件时，优先使用【本轮可编辑目标】里的 targetId：
{"needsEditConfirmation": true, "targetId": "edit-target-1", "oldText": "目标文件中的原文", "newText": "替换后的新文本", "changeSummary": "调整语气、保留原意", "actionMessage": "我会先生成修改确认卡片"}
修改 selection 标签时不要回传 oldText，由工具读取授权范围内的当前原文：
{"needsEditConfirmation": true, "targetId": "edit-target-1", "newText": "替换后的新文本", "changeSummary": "润色表达、保留原意", "actionMessage": "我会先生成修改确认卡片"}
修改整份已授权文件时，不要回传完整 oldText，使用：
{"needsEditConfirmation": true, "targetId": "edit-target-1", "replaceWholeDocument": true, "newText": "替换后的完整新稿", "changeSummary": "优化标题层级、压缩重复、保留原意", "actionMessage": "我会先生成修改确认卡片"}

当你能直接回答时，直接输出答案文本。

选区上下文读取规则：
1. selection 标签正文已直接提供；问题明确提到上下文、前后文、结合上下文、附近内容、周围内容，或依赖原因、推导、对比、正确性时，优先调用 read_selection_context。
2. 工具顺序固定为：选区正文 → read_selection_context Level 1 → 必要时 Level 2 → 用户明确要求全文时 read_context_file。不得因为存在 selection 标签就默认读取全文。
3. 用户明确说“上文、上方、前面、之前”时传 direction=before；说“下文、下方、下面、后面、之后、后续”时传 direction=after；说“前后文、两侧、周围”时传 direction=both；未指定方向时传 direction=auto。明确方向是硬约束，禁止用 auto 代替。
4. read_selection_context 必须先调用 Level 1：总预算 700 tokens。direction=auto 按语义相关性读取；before/after/both 按指定方向和文档顺序读取。框选 Markdown 标题并读取 after 时，范围是该标题及其子标题管辖的正文。
5. 只有原因、推导、对比、关系、错误分析等问题在 Level 1 后仍明显信息不足，或选区是孤立片段时，才调用 Level 2；累计预算扩展到 1400 tokens，且只返回 Level 1 尚未读取的新增 Chunk。同一轮禁止跳级或重复读取同一层。
6. 不得因为 Level 2 仍不足就直接读取全文；只有用户明确要求阅读全文或全文分析时，才调用 read_context_file。

修改文档的强制规则：
1. 任何文本修改请求都必须携带用户在本轮消息中新添加的 selection 或 file 标签。没有本轮目标标签时，不得调用修改工具、不得生成确认卡片，必须明确提示用户重新添加要修改的 tag 后重新发起请求。
2. 修改意图包括但不限于：修改、润色、改写、重写、覆写、重构、调整、更新、扩写、缩写、续写、替换、加粗、斜体、删除、插入、补充、优化、撤销、恢复、还原、改回、取消刚才的修改。
3. 历史消息中的 tag、确认卡片、原文/新文本记录和 get_recent_context_tag 返回内容都只可用于理解上下文，不构成修改授权，禁止据此修改或撤销文本。
4. 用户提出"再简洁些""继续改这个文件""撤销刚才修改"等针对既有文本的请求，但本轮未新添加目标 tag 时，直接提示其重新添加目标 tag 后再发起修改请求。
5. 本轮携带 selection 或 file 标签且用户要求修改时，必须调用 replace_current_tab_text 生成确认卡片，禁止只输出修改后的文本或口头说明。
5.1 如果本轮有多个 selection 或 file 目标，且用户要求修改文本，不得调用 replace_current_tab_text，不得生成确认卡片。必须提示用户本轮只保留一个 selection 或 file 标签后重新发起修改请求。不要在多个目标中自行选择第一个，也不要把多个文件或选区合并到一张卡片。
6. 调用 replace_current_tab_text 或输出 needsEditConfirmation 时必须优先传入本轮目标标签的 targetId；旧格式 path 仅作兼容兜底。目标文件还必须已在标签页打开。
6.1 selection 标签包含精确字符范围。修改 selection 时不要回传 oldText，工具会读取授权选区当前完整原文；不得改写文档内其他相同文本。
7. 如果用户要求改写或覆写整份文件，必须传入 replaceWholeDocument=true，由工具读取已打开目标文件的完整原文；不要把整份原文复制到 oldText。
8. 如果本轮用户消息里带有 file 标签并要求片段替换，oldText 必须来自目标文件当前内容；如果是 selection 标签，省略 oldText。
9. get_recent_context_tag 仅可用于查看历史上下文，不得用于生成修改确认卡片；不得在没有本轮目标 tag 时通过 get_current_tab_text 修改当前活动标签。
10. file 片段替换时 oldText 必须与目标标签页内容完全一致；selection 修改由工具读取 oldText。newText 是修改后的完整替换片段。
11. 生成确认卡片时必须提供简短 changeSummary，概括本次修改方式，例如“调整语气、压缩重复、优化标题层级、保留原意”。没有把握时至少说明“保留原意并润色表达”。
12. replace_current_tab_text 只会生成用户确认卡片，不会直接写入文件。调用该工具后，等待用户在确认卡片中确认或拒绝。
13. 对携带本轮目标 tag 的修改意图，最终必须输出工具 JSON 或 needsEditConfirmation JSON；未携带时只提示用户重新添加 tag。
14. 调用 replace_current_tab_text 或输出 needsEditConfirmation 时只输出 JSON，不要同时输出解释文本。

保存记忆的规则：
1. 当用户要求记住、保存记忆、记下来时，调用 save_memory 生成行动确认卡片。
2. save_memory 不会直接写入；生成确认卡后等待用户确认，不得提前声称已保存。
3. 记忆内容应简洁明确，分类准确（preference/project/learning/profile/instruction）。

检索记忆的规则：
1. 长期记忆是按需读取的数据源，不得把未检索到的信息当作不存在。
2. 用户询问自己的地址、偏好、习惯、身份信息、长期目标、项目约定，或问"你记得我/之前告诉过你什么"时，必须先调用 search_memory，再根据结果回答。
3. 对与用户背景无关的通用问答不得为了凑上下文调用 search_memory。

知识库与文件读取的规则：
1. search_knowledge 可以检索本地知识库中已索引的文档，即使目标文件当前未打开、未添加到聊天框上下文，也可以调用它查询和回答。
2. 不得仅因为用户没有添加文件 tag、文件未打开或当前上下文没有正文，就声称无法查询知识库；应先调用 search_knowledge 获取已索引片段。
3. read_context_file 用于读取用户已添加到聊天框上下文的精确文件内容；文件未打开但已添加为上下文时，仍可以调用 read_context_file 读取磁盘内容。
4. 只有需要精确读取整份未授权文件、或需要修改文件时，才要求用户添加目标文件上下文；修改文件还必须目标文件已打开。
5. 如果 search_knowledge 只返回片段而不足以完整总结整篇文章，应基于片段说明当前结论范围，并提示用户添加目标文件以读取完整原文。

工具安全规则：
1. 查询工具可以自动执行；write_local、schedule 等副作用工具必须返回已注册的确认提案，模型 JSON 不得直接触发执行。
2. 文件修改、保存记忆、保存阅读成果、新建 Markdown 笔记和创建提醒都只能生成待确认卡片，用户确认前不得宣称已完成。
3. 新建 Markdown 笔记不得提供或猜测绝对路径，确认后由用户通过系统保存对话框选择目标。
4. 不得伪造工具结果，也不得向用户展示内部工具编排或推理内容。

可用工具：
{{tool_descriptions}}`,
}

/**
 * Initialize the agent system.
 */
export function initAgent() {
  if (!toolsRegistered) {
    registerBuiltinTools()
    toolsRegistered = true
  }
}

/**
 * Build the system prompt with tool descriptions.
 */
function buildSystemPrompt(config: AgentConfig, toolNames?: readonly string[], customPreferencePrompt?: string): string {
  const toolDesc = getToolDescriptions(toolNames)
  const prompt = config.systemPrompt.replace('{{tool_descriptions}}', toolDesc)
  const preference = customPreferencePrompt?.trim()
  if (!preference) return prompt
  return `${prompt}\n\n${CUSTOM_PROMPT_POLICY}\n\n【用户偏好层】\n${preference}`
}

/**
 * Truncate long text to avoid token explosion.
 */
function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text
  return text.slice(0, maxLen) + `\n... (已截断，共 ${text.length} 字符)`
}

function truncateKnowledgeResult(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text
  try {
    const parsed = JSON.parse(text)
    if (!isPlainObject(parsed) || !Array.isArray(parsed.results)) return truncate(text, maxLen)
    const totalResultCount = parsed.results.length
    const included: unknown[] = []
    for (const result of parsed.results) {
      const candidate = JSON.stringify({
        ...parsed,
        resultCount: included.length + 1,
        totalResultCount,
        omittedResultCount: totalResultCount - included.length - 1,
        results: [...included, result],
      }, null, 2)
      if (candidate.length > maxLen) break
      included.push(result)
    }
    return JSON.stringify({
      ...parsed,
      status: included.length > 0 ? parsed.status : 'truncated',
      resultCount: included.length,
      totalResultCount,
      omittedResultCount: totalResultCount - included.length,
      results: included,
    }, null, 2)
  } catch {
    return truncate(text, maxLen)
  }
}

function truncateWebSearchResult(text: string, maxLen: number): string {
  try {
    const parsed = JSON.parse(text)
    if (!isPlainObject(parsed) || !Array.isArray(parsed.results)) return truncate(text, maxLen)

    const totalResultCount = parsed.results.length
    const serialize = (results: unknown[]) => JSON.stringify({
      ...parsed,
      status: results.length > 0 ? parsed.status : 'truncated',
      resultCount: results.length,
      totalResultCount,
      omittedResultCount: totalResultCount - results.length,
      results,
    }, null, 2)
    const fitsAfterReferenceAnnotation = (results: unknown[]) => serialize(
      results.map((result) => isPlainObject(result)
        ? { ...result, referenceId: '[S999999999]' }
        : result),
    ).length <= maxLen

    if (fitsAfterReferenceAnnotation(parsed.results)) return text

    const included: unknown[] = []
    for (const result of parsed.results) {
      if (fitsAfterReferenceAnnotation([...included, result])) {
        included.push(result)
        continue
      }

      if (!isPlainObject(result) || typeof result.snippet !== 'string') break
      const { snippet, ...sourceMetadata } = result
      if (!fitsAfterReferenceAnnotation([...included, sourceMetadata])) break

      let low = 0
      let high = snippet.length
      let compactResult: Record<string, unknown> = sourceMetadata
      while (low <= high) {
        const length = Math.floor((low + high) / 2)
        const candidate = {
          ...sourceMetadata,
          snippet: length < snippet.length ? `${snippet.slice(0, length)}…` : snippet,
        }
        if (fitsAfterReferenceAnnotation([...included, candidate])) {
          compactResult = candidate
          low = length + 1
        } else {
          high = length - 1
        }
      }
      included.push(compactResult)
      break
    }

    return serialize(included)
  } catch {
    return truncate(text, maxLen)
  }
}

function truncateToolResultForModel(toolName: string, text: string, maxLen: number): string {
  if (toolName === 'search_knowledge') return truncateKnowledgeResult(text, maxLen)
  if (toolName === 'web_search') return truncateWebSearchResult(text, maxLen)
  return truncate(text, maxLen)
}

function resolveToolResultMaxChars(toolName: string): number {
  return getToolTokenBudget(toolName)
}

function buildFinalAnswerMessages(messages: ChatMessage[], finalInstruction?: string): ChatMessage[] {
  return [
    ...messages,
    {
      role: 'user',
      content: [
        '现在请直接输出给用户的最终答案。若已有工具结果，请基于结果回答；不要再调用工具，不要输出 JSON，不要复述内部处理过程。',
        finalInstruction,
      ].filter(Boolean).join('\n\n'),
    },
  ]
}

interface ToolExecutionResult {
  result: string
  rawResult: string
  status: 'success' | 'timeout' | 'cancelled' | 'tool_error'
}

interface ToolRunResult {
  status: ToolExecutionResult['status']
  value?: string
  error?: unknown
}

async function runToolWithTimeout(
  execute: (signal: AbortSignal) => Promise<string>,
  timeout: number,
  signal?: AbortSignal,
): Promise<ToolRunResult> {
  const controller = new AbortController()
  let settleControl: (result: ToolRunResult) => void = () => undefined
  const control = new Promise<ToolRunResult>((resolve) => {
    settleControl = resolve
  })
  const forwardAbort = () => {
    controller.abort(signal?.reason || 'aborted')
    settleControl({ status: 'cancelled' })
  }
  signal?.addEventListener('abort', forwardAbort, { once: true })

  const timer = setTimeout(() => {
    controller.abort('timeout')
    settleControl({ status: 'timeout' })
  }, timeout)

  try {
    if (signal?.aborted) {
      forwardAbort()
      return await control
    }
    const execution = Promise.resolve().then(() => execute(controller.signal)).then<ToolRunResult, ToolRunResult>(
      value => ({ status: 'success', value }),
      error => ({
        status: controller.signal.aborted
          ? controller.signal.reason === 'timeout' ? 'timeout' : 'cancelled'
          : 'tool_error',
        error,
      }),
    )
    return await Promise.race([execution, control])
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', forwardAbort)
  }
}

function buildToolCallKey(name: string, args: Record<string, unknown>): string {
  return JSON.stringify([
    name,
    Object.keys(args).sort().map((key) => [key, args[key]]),
  ])
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function sourceFileName(filePath: string, fallback?: string): string {
  return filePath.split(/[/\\]/).pop() || fallback || filePath
}

function extractKnowledgeSourcesFromResult(result: string): ChatMessageSource[] {
  try {
    const parsed = JSON.parse(result)
    if (!isPlainObject(parsed) || !Array.isArray(parsed.results)) return []

    return parsed.results.flatMap((item): ChatMessageSource[] => {
      if (!isPlainObject(item)) return []
      if (
        typeof item.filePath !== 'string'
        || typeof item.startLine !== 'number'
        || typeof item.endLine !== 'number'
      ) {
        return []
      }

      return [{
        filePath: item.filePath,
        fileName: sourceFileName(item.filePath, typeof item.title === 'string' ? item.title : undefined),
        titlePath: Array.isArray(item.titlePath)
          ? item.titlePath.filter((part): part is string => typeof part === 'string')
          : undefined,
        heading: typeof item.heading === 'string' ? item.heading : undefined,
        startLine: item.startLine,
        endLine: item.endLine,
      }]
    })
  } catch {
    return []
  }
}

function extractSelectionContextSourcesFromResult(result: string): ChatMessageSource[] {
  try {
    const parsed = JSON.parse(result)
    if (!isPlainObject(parsed) || !Array.isArray(parsed.chunks) || !isPlainObject(parsed.source)) return []
    const source = parsed.source
    if (typeof source.filePath !== 'string') return []
    const filePath = source.filePath

    return parsed.chunks.flatMap((chunk): ChatMessageSource[] => {
      if (!isPlainObject(chunk)) return []
      if (typeof chunk.startLine !== 'number' || typeof chunk.endLine !== 'number') return []
      const titlePath = Array.isArray(chunk.headingPath)
        ? chunk.headingPath.filter((part): part is string => typeof part === 'string')
        : undefined
      return [{
        filePath,
        fileName: typeof source.fileName === 'string'
          ? source.fileName
          : sourceFileName(filePath, typeof source.title === 'string' ? source.title : undefined),
        titlePath,
        heading: titlePath?.length ? titlePath[titlePath.length - 1] : undefined,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
      }]
    })
  } catch {
    return []
  }
}

function extractContextFileSourcesFromResult(result: string): ChatMessageSource[] {
  try {
    const parsed = JSON.parse(result)
    if (!isPlainObject(parsed) || !isPlainObject(parsed.source)) return []
    const source = parsed.source
    if (
      typeof source.filePath !== 'string'
      || typeof source.startLine !== 'number'
      || typeof source.endLine !== 'number'
    ) {
      return []
    }

    return [{
      filePath: source.filePath,
      fileName: typeof source.fileName === 'string'
        ? source.fileName
        : sourceFileName(source.filePath, typeof source.title === 'string' ? source.title : undefined),
      heading: typeof source.title === 'string' ? source.title : undefined,
      startLine: source.startLine,
      endLine: source.endLine,
    }]
  } catch {
    return []
  }
}

function extractWebSourcesFromResult(result: string): ChatMessageSource[] {
  try {
    const parsed = JSON.parse(result)
    if (!isPlainObject(parsed) || !Array.isArray(parsed.results)) return []

    return parsed.results.flatMap((item): ChatMessageSource[] => {
      if (!isPlainObject(item) || typeof item.url !== 'string') return []
      return [{
        kind: 'web',
        title: typeof item.title === 'string' && item.title.trim() ? item.title : item.url,
        url: item.url,
        siteName: typeof item.siteName === 'string' ? item.siteName : undefined,
        publishedAt: typeof item.publishedAt === 'string' ? item.publishedAt : undefined,
        snippet: typeof item.snippet === 'string' ? item.snippet : undefined,
      }]
    })
  } catch {
    return []
  }
}

function extractSourcesFromToolResult(toolName: string, result: string): ChatMessageSource[] {
  if (toolName === 'search_knowledge') return extractKnowledgeSourcesFromResult(result)
  if (toolName === 'read_selection_context') return extractSelectionContextSourcesFromResult(result)
  if (toolName === 'read_context_file') return extractContextFileSourcesFromResult(result)
  if (toolName === 'web_search') return extractWebSourcesFromResult(result)
  return []
}

function withSourceReferenceId<T extends Record<string, unknown>>(value: T, id: string | undefined): T {
  return id ? { ...value, referenceId: `[${id}]` } : value
}

function findSourceReferenceIdForToolPayload(
  toolName: string,
  payload: Record<string, unknown>,
  registry: SourceReferenceRegistry,
): string | undefined {
  const parsed = toolName === 'read_selection_context'
    ? { source: payload.source, chunks: [payload.chunk] }
    : toolName === 'read_context_file'
      ? { source: payload.source }
      : { results: [payload] }
  const source = extractSourcesFromToolResult(toolName, JSON.stringify(parsed))[0]
  return source ? findSourceReferenceId(registry, source) : undefined
}

function annotateToolResultWithSourceReferences(
  toolName: string,
  result: string,
  registry: SourceReferenceRegistry,
): string {
  if (!['search_knowledge', 'read_selection_context', 'read_context_file', 'web_search'].includes(toolName)) {
    return result
  }

  try {
    const parsed = JSON.parse(result)
    if (!isPlainObject(parsed)) return result

    if ((toolName === 'search_knowledge' || toolName === 'web_search') && Array.isArray(parsed.results)) {
      return JSON.stringify({
        ...parsed,
        results: parsed.results.map((item) => {
          if (!isPlainObject(item)) return item
          const id = findSourceReferenceIdForToolPayload(toolName, item, registry)
          return withSourceReferenceId(item, id)
        }),
      }, null, 2)
    }

    if (toolName === 'read_selection_context' && Array.isArray(parsed.chunks)) {
      return JSON.stringify({
        ...parsed,
        chunks: parsed.chunks.map((chunk) => {
          if (!isPlainObject(chunk)) return chunk
          const id = findSourceReferenceIdForToolPayload(toolName, { source: parsed.source, chunk }, registry)
          return withSourceReferenceId(chunk, id)
        }),
      }, null, 2)
    }

    if (toolName === 'read_context_file' && isPlainObject(parsed.source)) {
      const id = findSourceReferenceIdForToolPayload(toolName, parsed, registry)
      return JSON.stringify({
        ...parsed,
        source: withSourceReferenceId(parsed.source, id),
      }, null, 2)
    }
  } catch {
    return result
  }

  return result
}

export function prepareAgentToolResultForModel(
  registry: SourceReferenceRegistry,
  toolName: string,
  result: string,
): { registry: SourceReferenceRegistry; result: string } {
  const sources = extractSourcesFromToolResult(toolName, result)
  const nextRegistry = registerSourceReferences(registry, sources)
  return {
    registry: nextRegistry,
    result: annotateToolResultWithSourceReferences(toolName, result, nextRegistry),
  }
}

/**
 * 执行单个工具调用
 */
async function executeTool(
  name: string,
  args: Record<string, unknown>,
  timeout: number,
  userIntent: string,
  signal?: AbortSignal,
  onProgress?: (stage: AgentProgressStage) => void,
  diagnosticRunId?: string,
): Promise<ToolExecutionResult> {
  const tool = getTool(name)
  if (!tool) {
    const result = `错误：工具 "${name}" 不存在。可用工具: ${getAllTools().map((t) => t.name).join(', ')}`
    return { result, rawResult: result, status: 'tool_error' }
  }

  const knownParameters = new Set(tool.parameters.map((param) => param.name))
  for (const key of Object.keys(args)) {
    if (!knownParameters.has(key)) {
      const result = `错误：工具参数 "${key}" 不在允许列表中。`
      return { result, rawResult: result, status: 'tool_error' }
    }
  }

  // Validate required parameters and primitive types before execution.
  for (const param of tool.parameters) {
    if (param.required && !(param.name in args)) {
      const result = `错误：缺少必需参数 "${param.name}"（${param.description}）`
      return { result, rawResult: result, status: 'tool_error' }
    }
    if (param.name in args && typeof args[param.name] !== param.type) {
      const result = `错误：参数 "${param.name}" 必须是 ${param.type} 类型。`
      return { result, rawResult: result, status: 'tool_error' }
    }
  }

  if (name === 'save_memory' && !shouldAllowMemoryWrite(userIntent)) {
    const result = '保存被拒绝：只有用户本轮明确要求记住或保存信息时，才能写入长期记忆。'
    return { result, rawResult: result, status: 'tool_error' }
  }

  const toolSpanId = startAgentTraceSpan(diagnosticRunId, 'tool', { tool: name })
  let execution: Awaited<ReturnType<typeof runToolWithTimeout>>
  try {
    execution = await runToolWithTimeout(
      toolSignal => tool.execute(args, { signal: toolSignal, onProgress }),
      timeout,
      signal,
    )
  } catch (error) {
    finishAgentTraceSpan(diagnosticRunId, toolSpanId, 'error', { result: 'exception' })
    throw error
  }
  finishAgentTraceSpan(
    diagnosticRunId,
    toolSpanId,
    execution.status === 'success' ? 'success' : execution.status === 'tool_error' ? 'error' : execution.status,
  )
  if (execution.status !== 'success') {
    const result = execution.status === 'timeout'
      ? '工具执行超时。'
      : execution.status === 'cancelled'
        ? '工具执行已取消。'
        : `工具执行出错: ${execution.error instanceof Error ? execution.error.message : String(execution.error)}`
    return { result, rawResult: result, status: execution.status }
  }

  const result = execution.value || ''
  try {
    const isRejectedResult = /^(?:错误：|参数 |修改被拒绝|替换失败|整文替换被拒绝|保存被拒绝)/.test(result.trim())
    if (
      tool.confirmationPolicy === 'required'
      && !isPendingEditResult(result)
      && !isPendingActionResult(result)
      && !isRejectedResult
    ) {
      const blocked = `错误：工具 "${name}" 声明为必须确认，但未返回受支持的行动提案。`
      return { result: blocked, rawResult: blocked, status: 'tool_error' }
    }
    if (isPendingEditResult(result) || isPendingActionResult(result)) return { result, rawResult: result, status: 'success' }
    return {
      // search_knowledge 必须走结构化截断：observation 的 content 会被时间线
      // 与来源提取用 JSON.parse 解析，硬截断会破坏 JSON 导致误报"检索失败"。
      result: name === 'read_selection_context' ? result : truncateToolResultForModel(name, result, getToolTokenBudget(name)),
      rawResult: result,
      status: 'success',
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const result = `工具执行出错: ${msg}`
    return { result, rawResult: result, status: 'tool_error' }
  }
}

/**
 * 执行多个工具调用（支持并行）
 */
async function executeToolCalls(
  toolCalls: Array<{ name: string; args: Record<string, unknown> }>,
  timeout: number,
  userIntent: string,
  signal?: AbortSignal,
  selectionContextReadLevels?: Map<string, 1 | 2>,
  onProgress?: (stage: AgentProgressStage) => void,
  readResultCache?: Map<string, Promise<ToolExecutionResult>>,
  maxNewToolCalls = Number.POSITIVE_INFINITY,
  allowWriteBeyondBudget = false,
  diagnosticRunId?: string,
): Promise<Array<{ name: string; result: string; rawResult?: string; status?: ToolExecutionResult['status']; executed?: boolean; reused?: boolean }>> {
  // 分离读取类和写入类工具
  const readCalls = toolCalls.filter(tc => isReadTool(tc.name))
  const writeCalls = toolCalls.filter(tc => isWriteTool(tc.name))

  const results: Array<{ name: string; result: string; rawResult?: string; status?: ToolExecutionResult['status']; executed?: boolean }> = []

  const regularReadCalls = readCalls.filter((call) => call.name !== 'read_selection_context')
  const selectionContextCalls = readCalls.filter((call) => call.name === 'read_selection_context')
  let remainingNewToolCalls = maxNewToolCalls

  // 普通读类工具并行执行；selectionContext 需要按层级串行执行。
  if (regularReadCalls.length > 0) {
    const readResults = await Promise.allSettled(
      regularReadCalls.map(async tc => {
        const cacheKey = buildToolCallKey(tc.name, tc.args)
        const cached = readResultCache?.get(cacheKey)
        if (cached) {
          const reused = await cached
          return {
            name: tc.name,
            result: reused.result,
            rawResult: reused.rawResult,
            status: reused.status,
            executed: false,
            reused: true,
          }
        }
        if (remainingNewToolCalls <= 0) {
          return {
            name: tc.name,
            result: '系统已达到本轮工具调用上限，未执行新的工具调用。请基于已有结果回答，并明确说明信息可能不完整。',
            executed: false,
          }
        }
        remainingNewToolCalls--
        const pending = executeTool(tc.name, tc.args, timeout, userIntent, signal, onProgress, diagnosticRunId)
        readResultCache?.set(cacheKey, pending)
        const executed = await pending
        return {
          name: tc.name,
          result: executed.result,
          rawResult: executed.rawResult,
          status: executed.status,
        }
      })
    )

    for (const result of readResults) {
      if (result.status === 'fulfilled') {
        results.push(result.value)
      } else {
        results.push({
          name: 'unknown',
          result: `工具执行失败: ${result.reason}`,
        })
      }
    }
  }

  for (const call of selectionContextCalls) {
    if (remainingNewToolCalls <= 0) {
      results.push({
        name: call.name,
        result: '系统已达到本轮工具调用上限，未执行新的工具调用。请基于已有结果回答，并明确说明信息可能不完整。',
        executed: false,
      })
      continue
    }
    const level: 1 | 2 = call.args.level === 2 ? 2 : 1
    const selectionTargets = getAgentScopeContext()?.editTargets?.filter((target) => target.type === 'selection') || []
    const targetId = typeof call.args.targetId === 'string'
      ? call.args.targetId
      : selectionTargets.length === 1 ? selectionTargets[0].id : '__unresolved_selection__'
    const completedLevel = selectionContextReadLevels?.get(targetId) || 0
    const rejected = validateSelectionContextReadLevel(completedLevel, level)
    if (rejected) {
      results.push({ name: call.name, result: rejected, rawResult: rejected, executed: false })
      continue
    }

    remainingNewToolCalls--
    const executed = await executeTool(call.name, call.args, timeout, userIntent, signal, onProgress, diagnosticRunId)
    let succeeded = false
    try {
      const parsed = JSON.parse(executed.rawResult || executed.result)
      const roles = new Set(
        Array.isArray(parsed?.chunks)
          ? parsed.chunks.map((chunk: { role?: unknown }) => chunk.role)
          : [],
      )
      succeeded = level === 1
        ? roles.has('before') && roles.has('current') && roles.has('after')
        : Array.isArray(parsed?.chunks) && parsed.chunks.length > 0
    } catch {
      succeeded = false
    }
    if (succeeded) selectionContextReadLevels?.set(targetId, level)
    results.push({ name: call.name, result: executed.result, rawResult: executed.rawResult, status: executed.status })
  }

  // 写入类工具本轮只允许执行第一个，避免多个确认卡片之间出现授权范围错配。
  const firstWriteCall = writeCalls[0]
  if (firstWriteCall) {
    if (remainingNewToolCalls <= 0 && !allowWriteBeyondBudget) {
      results.push({
        name: firstWriteCall.name,
        result: '系统已达到本轮工具调用上限，未执行新的工具调用。请基于已有结果回答，并明确说明信息可能不完整。',
        executed: false,
      })
    } else {
      if (remainingNewToolCalls > 0) remainingNewToolCalls--
      const executed = await executeTool(firstWriteCall.name, firstWriteCall.args, timeout, userIntent, signal, onProgress, diagnosticRunId)
      results.push({ name: firstWriteCall.name, result: executed.result, rawResult: executed.rawResult, status: executed.status })
    }
  }
  for (const tc of writeCalls.slice(1)) {
    results.push({
      name: tc.name,
      executed: false,
      result: '系统已拒绝本轮后续写入操作：为避免多个写入目标之间出现错配，本轮只执行第一个写入请求。请先确认或拒绝当前确认卡片，再为下一个内容重新发起一次修改。',
    })
  }

  return results
}

export function validateSelectionContextReadLevel(completedLevel: 0 | 1 | 2, requestedLevel: 1 | 2): string | null {
  if (requestedLevel === 2 && completedLevel === 0) {
    return '系统拒绝跳级读取：请先调用 read_selection_context level=1，再根据结果判断是否需要 level=2。'
  }
  if (requestedLevel <= completedLevel) {
    return `系统拒绝重复读取：read_selection_context level=${requestedLevel} 已在本轮读取。`
  }
  return null
}

/**
 * Run the agent with a user query.
 * Uses structured JSON tool calling with intent-based tool selection.
 */
async function runAgentInternal({
  query,
  chatHistory = [],
  config = {},
  rawQuery,
  hasRecentEditContext = false,
  hasCurrentEditTarget = false,
  currentEditTargetCount = 0,
  candidateToolNames,
  hasPrefetchedMemoryLookup = false,
  signal,
  temperature,
  onStep,
  onStreamContent,
  requiredCapabilities,
  untrustedContext,
  customPreferencePrompt,
  streamEnabled = true,
  routingDecision,
}: AgentRunRequest, deadlineAt: number, diagnosticRunId?: string): Promise<AgentResult> {
  initAgent()

  if (!isAiReady()) {
    return {
      answer: 'AI 未配置，请先在设置中配置 API Key 或选择本地模型（如 Ollama）。',
      steps: [],
      toolCalls: 0,
      reason: 'completed',
    }
  }

  const mergedConfig = { ...DEFAULT_CONFIG, ...config }
  const client = getAiClient()
  const userIntent = rawQuery || query

  // 使用统一路由决策或回退到旧逻辑
  const rd: RoutingDecision | undefined = routingDecision

  // 回退时构建 appContext 和 intentResult（仅当 rd 不存在时使用）
  const fallbackAppContext = (): AppContext => ({
    hasRecentEdit: hasRecentEditContext,
    hasOpenFile: hasCurrentEditTarget,
    hasSelection: Boolean(getAgentScopeContext()?.contextTags.some((tag) => tag.type === 'selection')),
    hasContextTags: currentEditTargetCount > 0,
  })

  // 意图检测 — 优先使用统一路由决策
  const isDocumentRewrite = rd?.isDocumentRewrite ?? isDocumentRewriteIntent(userIntent)
  const isWebComparison = rd?.isWebComparison ?? isWebComparisonIntent(userIntent)
  const isLocalResearch = rd?.isLocalResearch ?? (!isWebComparison && isLocalResearchIntent(userIntent))
  const isFileSummary = rd?.isFileSummary ?? (!isWebComparison && isFileSummaryIntent(userIntent, fallbackAppContext()))
  const answerInstruction = rd?.answerInstruction ?? (
    isWebComparison
      ? WEB_COMPARISON_ANSWER_PROMPT
      : isFileSummary ? FILE_SUMMARY_ANSWER_PROMPT
      : isLocalResearch ? LOCAL_RESEARCH_ANSWER_PROMPT : undefined
  )

  // 合并外部传入的 requiredCapabilities
  const mergedRequired = rd
    ? (requiredCapabilities && requiredCapabilities.length > 0
      ? Array.from(new Set([...requiredCapabilities, ...rd.required]))
      : rd.required)
    : (() => {
        const intentResult = detectIntentScores(userIntent, fallbackAppContext())
        return requiredCapabilities && requiredCapabilities.length > 0
          ? Array.from(new Set([...requiredCapabilities, ...intentResult.required]))
          : intentResult.required
      })()

  // 构建候选工具 — 优先使用统一路由决策
  const candidateTools = rd
    ? rd.candidateTools
    : (candidateToolNames && candidateToolNames.length > 0
      ? [...candidateToolNames] as AgentToolName[]
      : buildCandidateTools(detectIntentScores(userIntent, fallbackAppContext()).candidates))

  // 工具列表调整（rd 已包含调整，回退时需手动调整）
  if (!rd) {
    const fbCtx = fallbackAppContext()
    const fbIntent = detectIntentScores(userIntent, fbCtx)
    if (
      isDocumentRewrite
      && fbCtx.hasSelection
      && fbIntent.candidates.includes('selection_context')
      && !candidateTools.includes('read_selection_context')
    ) {
      candidateTools.unshift('read_selection_context')
    }
    if (isFileSummary && !candidateTools.includes('read_context_file')) {
      candidateTools.unshift('read_context_file')
    }
  }

  if (isDocumentRewrite && currentEditTargetCount === 0) {
    return {
      answer: '本轮没有可修改的 selection 或 file 标签。请重新框选要改写的文本，或把要整体改写的文件添加为 tag 后再发起请求。',
      steps: [],
      toolCalls: 0,
      reason: 'completed',
    }
  }

  // 判断是否需要编辑确认 — 优先使用统一路由决策
  const requiresEditConfirmation = rd?.requiresEditConfirmation ?? (
    hasCurrentEditTarget && (
      detectIntentScores(userIntent, fallbackAppContext()).candidates.includes('file_write')
      || (hasRecentEditContext && isImplicitEditContinuation(userIntent))
    )
  )

  if (requiresEditConfirmation && currentEditTargetCount > 1) {
    return {
      answer: '本轮检测到多个可修改目标。为避免不同 tag 之间混淆，我不会生成修改确认卡片。请只保留一个 selection 或 file 标签后重新发起修改请求；需要修改多个位置时，请分多次处理。',
      steps: [],
      toolCalls: 0,
      reason: 'completed',
    }
  }

  // 构建系统提示
  const activeToolNames = candidateTools.length > 0 ? candidateTools : undefined
  const systemPrompt = buildSystemPrompt(mergedConfig, activeToolNames, customPreferencePrompt)
  const llmTools = candidateTools.length > 0 ? getToolsForLLM(activeToolNames) : []

  const contextMessage = buildUntrustedContextMessage(untrustedContext || '')
  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    ...chatHistory,
    ...(contextMessage ? [contextMessage] : []),
    ...(answerInstruction ? [{ role: 'user' as const, content: answerInstruction }] : []),
    { role: 'user', content: query },
  ]

  const steps: AgentStep[] = []
  let toolCalls = 0
  let editToolCalls = 0
  let sourceRegistry = createSourceReferenceRegistry()
  let artifactReferences: ReadingArtifactMessageReference[] = []
  const calledToolNames: string[] = []
  const selectionContextReadLevels = new Map<string, 1 | 2>()
  const readResultCache = new Map<string, Promise<ToolExecutionResult>>()
  const remainingDeadlineMs = () => Math.max(0, deadlineAt - Date.now())
  const sourceMetadata = () => ({
    sources: sourceRegistry.entries.map((entry) => entry.source),
    sourceRegistry,
    ...(artifactReferences.length ? { artifactReferences } : {}),
  })
  const rememberArtifactReferences = (name: string, result: string) => {
    const next = extractReadingArtifactReferences(name, result)
    if (next.length) artifactReferences = mergeReadingArtifactReferences(artifactReferences, next)
  }
  const prepareVisibleToolResult = (name: string, result: string): string => {
    const prepared = prepareAgentToolResultForModel(sourceRegistry, name, result)
    sourceRegistry = prepared.registry
    return prepared.result
  }
  const deadlineResult = (): AgentResult => ({
    answer: '',
    steps,
    toolCalls,
    reason: 'deadline',
    finalMessages: buildFinalAnswerMessages(
      messages,
      '本轮已达到整次任务时限。请仅基于已有证据给出可确认的结论，并明确声明尚未取得或验证的信息。',
    ),
    ...sourceMetadata(),
  })
  if (hasPrefetchedMemoryLookup) {
    calledToolNames.push('search_memory')
  }

  const pushStep = (step: AgentStep) => {
    steps.push(step)
    onStep?.(step)
  }
  const pushToolProgress = (progressStage: AgentProgressStage) => pushStep({
    type: 'progress',
    content: progressStage,
    progressStage,
    timestamp: Date.now(),
  })

  const waitForToolStartPaint = () => new Promise<void>((resolve) => {
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => resolve())
      return
    }
    setTimeout(resolve, 0)
  })

  const requestAgentCompletion = async () => {
    const send = async (currentMessages: ChatMessage[]) => {
      if (remainingDeadlineMs() <= 0) throw new DOMException('Agent deadline exceeded', 'TimeoutError')
      const canStreamAnswer = checkRequiredCapabilities(mergedRequired, calledToolNames).length === 0
      const modelSpanId = startAgentTraceSpan(diagnosticRunId, 'model_request', {
        streaming: streamEnabled,
        messageCount: currentMessages.length,
      })
      try {
        if (!streamEnabled) {
          const response = await client.chat({
            messages: currentMessages,
            signal,
            temperature,
            tools: llmTools,
            toolChoice: 'auto',
          })
          finishAgentTraceSpan(diagnosticRunId, modelSpanId, 'success')
          return response
        }

        let content = ''
        const toolCallBuffers = new Map<number, { id?: string; name: string; arguments: string }>()

        for await (const chunk of client.streamChat({
          messages: currentMessages,
          signal,
          temperature,
          tools: llmTools,
          toolChoice: 'auto',
        })) {
          if (chunk.toolCallDeltas?.length) {
            for (const delta of chunk.toolCallDeltas) {
              const current = toolCallBuffers.get(delta.index) || { name: '', arguments: '' }
              toolCallBuffers.set(delta.index, {
                id: delta.id || current.id,
                name: current.name + (delta.name || ''),
                arguments: current.arguments + (delta.arguments || ''),
              })
            }
          }
          if (chunk.content) {
            content += chunk.content
            if (canStreamAnswer) onStreamContent?.(content)
          }
          if (chunk.done) break
        }

        finishAgentTraceSpan(diagnosticRunId, modelSpanId, 'success')
        return {
          id: '',
          content,
          role: 'assistant' as const,
          toolCalls: Array.from(toolCallBuffers.values())
            .filter((call) => call.name)
            .map((call) => {
              let args: Record<string, unknown> = {}
              try {
                args = call.arguments ? JSON.parse(call.arguments) : {}
              } catch {
                args = {}
              }
              return { id: call.id, name: call.name, args }
            }),
        }
      } catch (error) {
        const status = signal?.reason === 'deadline' || error instanceof DOMException && error.name === 'TimeoutError'
          ? 'timeout'
          : signal?.aborted ? 'cancelled' : 'error'
        finishAgentTraceSpan(diagnosticRunId, modelSpanId, status, { error: status })
        throw error
      }
    }

    try {
      return await send(messages)
    } catch (error) {
      if (!isModelContextOverflowError(error) || signal?.aborted) throw error
      console.warn('[Agent context] provider reported context overflow; retrying after dropping oldest turn')
      return send(dropOldestCompleteTurns(messages))
    }
  }

  const repairUnmetReadCapabilities = async (): Promise<boolean> => {
    if (remainingDeadlineMs() <= 0) return false
    const unmetCapabilities = checkRequiredCapabilities(mergedRequired, calledToolNames)
    const repairTools = getRepairTools(unmetCapabilities)
      .filter((name) => candidateTools.includes(name))
    const prioritizedRepairTools = isFileSummary && repairTools.includes('read_context_file')
      ? ['read_context_file' as AgentToolName]
      : repairTools.includes('read_selection_context')
      ? ['read_selection_context' as AgentToolName]
      : repairTools

    const scopeContext = getAgentScopeContext()
    const scopeFilePath = scopeContext?.contextTags.find(
      (tag) => (tag.type === 'file' || tag.type === 'selection') && typeof tag.filePath === 'string'
    )?.filePath
    const selectionTargets = scopeContext?.editTargets?.filter((target) => target.type === 'selection') || []
    const scopeSelectionTargetId = selectionTargets.length === 1 ? selectionTargets[0].id : undefined
    const runnableRepairTools = prioritizedRepairTools.filter((name) => (
      (name !== 'read_context_file' || Boolean(scopeFilePath))
      && (name !== 'read_selection_context' || Boolean(scopeSelectionTargetId))
    ))

    if (runnableRepairTools.length === 0) return false

    pushStep({
      type: 'action',
      content: `补调工具: ${runnableRepairTools.join(', ')}`,
      toolName: runnableRepairTools[0],
      toolArgs: {},
      timestamp: Date.now(),
    })

    const repairResults = await executeToolCalls(
      runnableRepairTools.map(name => ({
        name,
        args: name === 'search_memory' ? { query: userIntent, topK: 5 }
          : name === 'search_knowledge' ? { query: userIntent, topK: (isLocalResearch || isWebComparison) ? 12 : 8 }
          : name === 'read_selection_context' ? { targetId: scopeSelectionTargetId }
          : name === 'read_context_file' ? { path: scopeFilePath, maxLength: 12000 }
          : name === 'get_current_time' ? {}
          : { query: userIntent },
      })),
      Math.min(mergedConfig.stepTimeout, remainingDeadlineMs()),
      userIntent,
      signal,
      selectionContextReadLevels,
      pushToolProgress,
      readResultCache,
      Math.max(0, mergedConfig.maxToolCalls - toolCalls),
      false,
      diagnosticRunId,
    )

    for (const { name, result, rawResult, executed } of repairResults) {
      rememberArtifactReferences(name, rawResult || result)
      if (executed !== false) {
        calledToolNames.push(name)
        toolCalls++
      }
      pushStep({
        type: 'observation',
        content: result,
        toolName: name,
        timestamp: Date.now(),
      })
      const modelResult = truncateToolResultForModel(name, rawResult || result, resolveToolResultMaxChars(name))
      const visibleModelResult = prepareVisibleToolResult(name, modelResult)
      messages.push({
        role: 'user',
        content: `系统已补调 ${name} 工具。请依据结果回答：\n${visibleModelResult}`,
      })
    }

    return repairResults.length > 0
  }

  // 如果没有候选工具，直接普通流式回复
  if (candidateTools.length === 0) {
    pushStep({
      type: 'thought',
      content: '无候选工具，直接普通回复',
      timestamp: Date.now(),
    })

    try {
      let response
      try {
        response = await client.chat({
          messages,
          signal,
          temperature,
          tools: [],
          toolChoice: 'none',
        })
      } catch (error) {
        if (!isModelContextOverflowError(error) || signal?.aborted) throw error
        console.warn('[Agent context] provider reported context overflow; retrying after dropping oldest turn')
        response = await client.chat({
          messages: dropOldestCompleteTurns(messages),
          signal,
          temperature,
          tools: [],
          toolChoice: 'none',
        })
      }

      return {
        answer: response.content,
        steps,
        toolCalls: 0,
        reason: 'completed',
      }
    } catch (err) {
      if (signal?.reason === 'deadline' || remainingDeadlineMs() <= 0) return deadlineResult()
      const msg = err instanceof Error ? err.message : String(err)
      return {
        answer: `AI 请求失败: ${msg}`,
        steps,
        toolCalls: 0,
        reason: 'error',
        ...sourceMetadata(),
      }
    }
  }

  // 有候选工具，进入 Agent 循环
  for (let i = 0; i < mergedConfig.maxSteps; i++) {
    if (signal?.aborted) {
      if (signal.reason === 'deadline') return deadlineResult()
      return { answer: '已取消本次 Agent 请求。', steps, toolCalls, reason: 'error', ...sourceMetadata() }
    }
    if (toolCalls >= mergedConfig.maxToolCalls && (!requiresEditConfirmation || editToolCalls > 0)) {
      return {
        answer: '',
        steps,
        toolCalls,
        reason: 'max_tool_calls',
        finalMessages: buildFinalAnswerMessages(
          messages,
          '本轮已达到工具调用上限。请仅基于已有结果给出当前可确认的结论，并明确说明仍缺少的信息。',
        ),
        ...sourceMetadata(),
      }
    }

    // Get AI response with timeout
    let content: string
    const nativeToolCalls: Array<{ name: string; args: Record<string, unknown>; actionMessage?: string }> = []

    try {
      const response = await requestAgentCompletion()
      content = response.content

      // 收集所有原生工具调用
      if (response.toolCalls && response.toolCalls.length > 0) {
        const actionMessage = normalizeActionMessage(stripToolCallJson(content))
        for (const tc of response.toolCalls) {
          if (getTool(tc.name)) {
            nativeToolCalls.push({ name: tc.name, args: tc.args, actionMessage })
          }
        }
      }
    } catch (err) {
      if (signal?.reason === 'deadline' || remainingDeadlineMs() <= 0) return deadlineResult()
      const msg = err instanceof Error ? err.message : String(err)
      return {
        answer: `AI 请求失败: ${msg}`,
        steps,
        toolCalls,
        reason: 'error',
        ...sourceMetadata(),
      }
    }

    pushStep({
      type: 'thought',
      content,
      timestamp: Date.now(),
    })

    // 解析工具调用（原生优先，JSON降级）
    let parsedToolCalls: Array<{ name: string; args: Record<string, unknown>; rawJson?: string; actionMessage?: string }> = []

    if (nativeToolCalls.length > 0) {
      parsedToolCalls = nativeToolCalls.map(tc => ({ ...tc, rawJson: undefined }))
    } else {
      // 尝试从文本中解析工具调用
      const parsed = parseToolCall(content)
      if (parsed) {
        parsedToolCalls = [{ ...parsed, rawJson: parsed.rawJson }]
      }
    }

    const disallowedToolCalls = parsedToolCalls.filter((tc) => !candidateTools.includes(tc.name as AgentToolName))
    if (disallowedToolCalls.length > 0) {
      parsedToolCalls = parsedToolCalls.filter((tc) => candidateTools.includes(tc.name as AgentToolName))
      if (parsedToolCalls.length === 0) {
        messages.push({ role: 'assistant', content })
        messages.push({
          role: 'user',
          content: `系统拒绝了不在本轮候选集合内的工具：${disallowedToolCalls.map((tc) => tc.name).join(', ')}。请直接回答，或只使用本轮可用工具。`,
        })
        continue
      }
    }

    // 如果没有工具调用
    if (parsedToolCalls.length === 0) {
      const repaired = !requiresEditConfirmation && await repairUnmetReadCapabilities()
      if (repaired) continue

      // 检查是否需要编辑确认
      if (requiresEditConfirmation && editToolCalls === 0) {
        messages.push({ role: 'assistant', content })
        messages.push({
          role: 'user',
          content: [
            '系统校验失败：本轮用户表达了文本修改或撤销意图，但你的回复没有生成修改确认卡片。',
            '请不要只回复"已修改""已撤销"或修改后的文本。',
            '你必须重新输出以下两种 JSON 之一：',
            '{"needsEditConfirmation": true, "targetId": "本轮可编辑目标 ID", "oldText": "当前编辑器中要替换的原文", "newText": "替换后的新文本", "changeSummary": "简短变更摘要", "actionMessage": "我会先生成修改确认卡片"}',
            '修改已添加的 selection 或 file 标签时必须优先使用【本轮可编辑目标】里的 targetId。',
            '修改 selection 标签时省略 oldText，由工具读取授权选区当前完整原文，不得选择文档内其他相同文本。',
            '修改整份已授权文件时增加 "replaceWholeDocument": true，并省略 oldText。',
            '或 {"tool": "replace_current_tab_text", "args": {"targetId": "本轮可编辑目标 ID", "newText": "替换后的新文本", "replaceWholeDocument": false, "changeSummary": "简短变更摘要"}, "actionMessage": "我会先生成修改确认卡片"}',
          ].join('\n'),
        })
        continue
      }

      // 最终答案
      const cleanAnswer = stripToolCallJson(content)
      const parsedAnswer = parseSourceReferences(cleanAnswer || content, sourceRegistry)
      if (cleanAnswer || content) {
        return {
          answer: parsedAnswer.content,
          steps,
          toolCalls,
          reason: 'completed',
          referencedSourceIds: parsedAnswer.referencedIds,
          ...sourceMetadata(),
        }
      }
      return { answer: '', steps, toolCalls, reason: 'completed', ...sourceMetadata() }
    }

    // 过滤工具调用 JSON 从思考步骤
    const toolCallJsons = parsedToolCalls
      .filter(tc => tc.rawJson)
      .map(tc => tc.rawJson!)
    let thoughtText = content
    for (const json of toolCallJsons) {
      thoughtText = thoughtText.replace(json, '').trim()
    }
    if (thoughtText) {
      steps[steps.length - 1] = { type: 'thought', content: thoughtText, timestamp: steps[steps.length - 1].timestamp }
    }

    // 执行工具调用
    for (const toolCall of parsedToolCalls) {
      pushStep({
        type: 'action',
        content: `调用工具: ${toolCall.name}`,
        toolName: toolCall.name,
        toolArgs: toolCall.args,
        actionMessage: toolCall.actionMessage,
        timestamp: Date.now(),
      })
    }

    if (parsedToolCalls.some(({ name }) => (
      name === 'read_context_file'
      || name === 'read_selection_context'
      || name === 'replace_current_tab_text'
    ))) {
      await waitForToolStartPaint()
    }

    const toolResults = await executeToolCalls(
      parsedToolCalls.map(tc => ({ name: tc.name, args: tc.args })),
      Math.min(mergedConfig.stepTimeout, remainingDeadlineMs()),
      userIntent,
      signal,
      selectionContextReadLevels,
      pushToolProgress,
      readResultCache,
      Math.max(0, mergedConfig.maxToolCalls - toolCalls),
      requiresEditConfirmation && editToolCalls === 0,
      diagnosticRunId,
    )

    // 记录调用的工具
    for (const toolResult of toolResults) {
      const { name } = toolResult
      const executed = toolResult.executed !== false
      if (executed) {
        calledToolNames.push(name)
        toolCalls++
      }
      if (executed && name === 'replace_current_tab_text') {
        editToolCalls++
      }
    }

    // 添加工具结果到消息
    for (const { name, result, rawResult, executed, reused } of toolResults) {
      rememberArtifactReferences(name, rawResult || result)
      pushStep({
        type: 'observation',
        content: result,
        toolName: name,
        timestamp: Date.now(),
      })

      const modelResult = name === 'read_selection_context'
        ? result
        : truncateToolResultForModel(name, rawResult || result, resolveToolResultMaxChars(name))
      const visibleModelResult = prepareVisibleToolResult(name, modelResult)
      messages.push({
        role: 'assistant',
        content: reused ? `复用本轮工具结果: ${name}` : executed === false ? `未执行工具: ${name}` : `调用工具: ${name}`,
      })
      messages.push({
        role: 'user',
        content: `工具返回结果：\n${visibleModelResult}\n\n请根据以上信息继续思考或给出最终答案。`,
      })
    }

    // 检查是否有待确认的编辑
    const hasPendingConfirmation = toolResults.some(
      (tr) => isPendingEditResult(tr.result) || isPendingActionResult(tr.result),
    )
    if (hasPendingConfirmation) {
      return { answer: '', steps, toolCalls, reason: 'completed', ...sourceMetadata() }
    }

  }

  // 达到最大步数，检查强依赖
  if (await repairUnmetReadCapabilities()) {
    return {
      answer: '',
      steps,
      toolCalls,
      reason: 'completed',
      finalMessages: buildFinalAnswerMessages(messages, answerInstruction),
      ...sourceMetadata(),
    }
  }

  // 正常结束
  if (toolCalls > 0) {
    return {
      answer: '',
      steps,
      toolCalls,
      reason: 'max_steps',
      finalMessages: buildFinalAnswerMessages(messages, answerInstruction),
      ...sourceMetadata(),
    }
  }

  return {
    answer: '已达到最大步骤数，且没有可用于总结的工具结果。',
    steps,
    toolCalls,
    reason: 'max_steps',
    ...sourceMetadata(),
  }
}

export async function runAgent(request: AgentRunRequest): Promise<AgentResult> {
  const deadlineMs = Math.max(1, Math.floor(request.config?.deadlineMs ?? DEFAULT_CONFIG.deadlineMs))
  const deadlineAt = Date.now() + deadlineMs
  const controller = new AbortController()
  const parentSignal = request.signal
  const forwardCancellation = () => controller.abort(parentSignal?.reason)
  if (parentSignal?.aborted) forwardCancellation()
  else parentSignal?.addEventListener('abort', forwardCancellation, { once: true })
  const timer = setTimeout(() => controller.abort('deadline'), deadlineMs)
  const ownsDiagnosticTrace = !('diagnosticRunId' in request)
  const diagnosticRunId = ownsDiagnosticTrace ? startAgentTrace({
    mode: request.routingDecision?.mode ?? 'agent',
    metadata: {
      candidateToolCount: request.candidateToolNames?.length ?? 0,
      streamEnabled: request.streamEnabled !== false,
      routeMode: request.routingDecision?.mode ?? 'agent',
      routeReasons: request.routingDecision?.reasonCodes.join(',') ?? 'unknown',
    },
  }) : request.diagnosticRunId

  try {
    const result = await runAgentInternal({ ...request, signal: controller.signal }, deadlineAt, diagnosticRunId)
    const status = result.reason === 'deadline'
      ? 'timeout'
      : result.reason === 'error'
        ? (controller.signal.aborted ? 'cancelled' : 'error')
        : 'completed'
    if (ownsDiagnosticTrace) {
      finishAgentTrace(diagnosticRunId, status, {
        reason: result.reason,
        toolCalls: result.toolCalls,
        stepCount: result.steps.length,
      })
    }
    return result
  } catch (error) {
    const status = controller.signal.reason === 'deadline' ? 'timeout' : controller.signal.aborted ? 'cancelled' : 'error'
    if (ownsDiagnosticTrace) finishAgentTrace(diagnosticRunId, status, { reason: status })
    throw error
  } finally {
    clearTimeout(timer)
    parentSignal?.removeEventListener('abort', forwardCancellation)
  }
}

/**
 * Check if a query should use agent mode.
 */
export function shouldUseAgent(query: string, contextTagCount?: number, hasRecentEditContext = false): boolean {
  const appContext: AppContext = {
    hasRecentEdit: hasRecentEditContext,
    hasContextTags: (contextTagCount || 0) > 0,
  }
  const result = detectIntentScores(query, appContext)
  return result.candidates.length > 0
}

/**
 * Select agent tool names (for backward compatibility).
 */
export function selectAgentToolNames(
  query: string,
  contextTagCount?: number,
  hasRecentEditContext = false
): AgentToolName[] {
  const appContext: AppContext = {
    hasRecentEdit: hasRecentEditContext,
    hasContextTags: (contextTagCount || 0) > 0,
  }
  const result = detectIntentScores(query, appContext)
  return buildCandidateTools(result.candidates)
}
