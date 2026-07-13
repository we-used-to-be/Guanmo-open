import type { AgentConfig, AgentStep, AgentResult } from './types'
import type { ChatMessage, ChatMessageSource } from '@/services/ai/types'
import { getAiClient, isAiReady } from '@/services/ai/aiClient'
import { getAllTools, getTool, getToolDescriptions, getToolsForLLM } from './toolRegistry'
import { registerBuiltinTools } from './tools'
import { parseToolCall, stripToolCallJson } from './toolCallParser'
import {
  detectIntentScores,
  shouldAllowMemoryWrite,
  isImplicitEditContinuation,
  shouldIncludeFullDocumentContext,
  isLocalResearchIntent,
  isWebComparisonIntent,
  isFileSummaryIntent,
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

let toolsRegistered = false

function isPendingEditResult(text: string): boolean {
  try {
    const parsed = JSON.parse(text)
    return Boolean(parsed && typeof parsed === 'object' && parsed.__pendingEdit)
  } catch {
    return false
  }
}

const DEFAULT_CONFIG: AgentConfig = {
  maxSteps: 6,
  stepTimeout: 30000,
  systemPrompt: `${BASE_SYSTEM_PROMPT}

${CONTEXT_SAFETY_PROMPT}

你是一个 MD 文档助手，擅长 Markdown 格式的写作、润色和编辑。

你可以使用工具来帮助用户完成任务。当需要使用工具时，请严格按以下 JSON 格式输出，不要输出其他内容：
{"tool": "工具名", "args": {"参数名": "参数值"}}

当你判断需要弹出文本修改确认卡片时，也可以输出以下 JSON。系统会校验 needsEditConfirmation，并自动转换为 replace_current_tab_text 工具调用：
{"needsEditConfirmation": true, "targetId": "本轮可编辑目标 ID", "oldText": "当前编辑器中要替换的原文", "newText": "替换后的新文本"}
修改用户添加到聊天框的 selection 或 file 标签所指向的文件时，优先使用【本轮可编辑目标】里的 targetId：
{"needsEditConfirmation": true, "targetId": "edit-target-1", "oldText": "目标文件中的原文", "newText": "替换后的新文本"}
修改 selection 标签时不要回传 oldText，由工具读取授权范围内的当前原文：
{"needsEditConfirmation": true, "targetId": "edit-target-1", "newText": "替换后的新文本"}
修改整份已授权文件时，不要回传完整 oldText，使用：
{"needsEditConfirmation": true, "targetId": "edit-target-1", "replaceWholeDocument": true, "newText": "替换后的完整新稿"}

当你能直接回答时，直接输出答案文本。

选区上下文读取规则：
1. selection 标签正文已直接提供；问题明确提到上下文、前后文、结合上下文、附近内容、周围内容，或依赖原因、推导、对比、正确性时，优先调用 read_selection_context。
2. 工具顺序固定为：选区正文 → read_selection_context Level 1 → 必要时 Level 2 → 用户明确要求全文时 read_context_file。不得因为存在 selection 标签就默认读取全文。
3. read_selection_context 必须先调用 Level 1（当前语义原子 + 700 tokens 预算内的高相关邻居）；只有原因、推导、对比、关系、错误分析等问题在 Level 1 后仍明显信息不足，或选区是孤立片段时，才调用 Level 2（累计 1400 tokens，delta only）。
4. Level 2 累计扩展到上文 4 Chunk + 当前 Chunk + 下文 2 Chunk，但只返回 Level 1 尚未读取的新增 Chunk。同一轮禁止跳级或重复读取同一层。
5. 不得因为 Level 2 仍不足就直接读取全文；只有用户明确要求阅读全文或全文分析时，才调用 read_context_file。

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
11. replace_current_tab_text 只会生成用户确认卡片，不会直接写入文件。调用该工具后，等待用户在确认卡片中确认或拒绝。
12. 对携带本轮目标 tag 的修改意图，最终必须输出工具 JSON 或 needsEditConfirmation JSON；未携带时只提示用户重新添加 tag。
13. 调用 replace_current_tab_text 或输出 needsEditConfirmation 时只输出 JSON，不要同时输出解释文本。

保存记忆的规则：
1. 当用户要求记住、保存记忆、记下来时，调用 save_memory 工具保存。
2. 调用 save_memory 后，必须用自然语言回复，说明保存了什么内容，并告知用户可以基于这个记忆做什么。
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
1. 查询工具可以自动执行；产生持久化写入的 save_memory 仅可在用户本轮明确要求保存记忆时调用。
2. 文件修改只能生成待确认卡片，用户确认前不得宣称已完成写入。
3. 不得伪造工具结果，也不得向用户展示内部工具编排或推理内容。

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
  return `${prompt}

${CUSTOM_PROMPT_POLICY}

【用户偏好层】
${preference}`
}

/**
 * Truncate long text to avoid token explosion.
 */
function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text
  return text.slice(0, maxLen) + `\n... (已截断，共 ${text.length} 字符)`
}

const LOCAL_RESEARCH_ANSWER_PROMPT = `本轮是本地阅读研究问题。必须基于已调用的本地资料工具结果回答，不能接 Web 搜索，不能编造未检索到的资料。

回答结构必须包含：
1. 结论摘要
2. 主要依据
3. 来源列表
4. 推断部分
5. 信息不足 / 需要补充的资料

要求：
- 每条关键结论都要能回到本地来源；来源至少写出文件名、标题路径或 heading、行号范围。
- 多个来源冲突、片段不足或覆盖不完整时，必须明确说明冲突或缺口，不能强行下结论。
- “推断部分”只能写从来源合理推出的内容，并标明它不是原文直接结论。
- 如果 search_knowledge 返回空结果或只有弱相关片段，回答重点应是信息缺口，不要套用确定性结论。`

const WEB_COMPARISON_ANSWER_PROMPT = `本轮是“Web + 本地资料对照”问题。必须区分本地知识库结果与 Web 搜索结果，不得把 Web 结果写成本地资料事实，也不得把本地片段当作最新外部事实。
回答结构优先包含：
1. 本地资料结论
2. Web 资料结论
3. 一致点
4. 冲突点
5. 补充点
6. 无法确认 / 仍需人工判断

要求：
- 本地来源写出文件名、标题路径或 heading、行号范围。
- Web 来源写出标题、URL、站点名或发布日期（如有）。
- 如果本地资料为空但 Web 有结果，明确说明“未找到本地依据，仅基于外部资料”。
- 如果 Web 搜索关闭、未配置、失败或为空，降级为本地研究回答，并明确说明未完成外部对照。
- 多个来源冲突或覆盖不完整时，只能说明冲突、缺口和可推断范围，不能强行下结论。`

const FILE_SUMMARY_ANSWER_PROMPT = `本轮是单文件总结。必须优先基于 read_context_file 返回的已授权文件内容回答；只有文件读取失败或内容不足时，才可用 search_knowledge 片段补充，并明确标注范围。

回答必须是结构化文件总结，不能只输出泛泛一段话。先判断文档类型，并采用对应结构：
- 学习笔记：核心概念、重点、易错点、复习问题
- 会议/记录：结论、待办、负责人、风险
- 项目文档：目标、方案、接口/约束、未决问题
- 普通文章：摘要、主要观点、关键细节、可追问方向

所有类型都必须补充：
1. 来源依据：写出文件名、heading 或标题路径、行号范围；不得伪造来源。
2. 信息缺口：内容不足、读取失败、截断、缺少负责人/接口/结论等都要明确说明。
3. 后续操作建议：只给可追问或可继续阅读的建议，不要自动写回文档、保存记忆或更新知识库。

如果 read_context_file 返回内容被截断，不得声称已覆盖全文；必须说明“当前总结基于已读取范围”。`

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

function addUniqueSources(target: ChatMessageSource[], sources: ChatMessageSource[]) {
  const sourceKey = (source: ChatMessageSource) => source.kind === 'web'
    ? `web:${source.url}`
    : `local:${source.filePath}:${source.startLine}:${source.endLine}`
  const seen = new Set(target.map(sourceKey))
  for (const source of sources) {
    const key = sourceKey(source)
    if (seen.has(key)) continue
    seen.add(key)
    target.push(source)
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
  signal?: AbortSignal
): Promise<ToolExecutionResult> {
  const tool = getTool(name)
  if (!tool) {
    const result = `错误：工具 "${name}" 不存在。可用工具: ${getAllTools().map((t) => t.name).join(', ')}`
    return { result, rawResult: result }
  }

  const knownParameters = new Set(tool.parameters.map((param) => param.name))
  for (const key of Object.keys(args)) {
    if (!knownParameters.has(key)) {
      const result = `错误：工具参数 "${key}" 不在允许列表中。`
      return { result, rawResult: result }
    }
  }

  // Validate required parameters and primitive types before execution.
  for (const param of tool.parameters) {
    if (param.required && !(param.name in args)) {
      const result = `错误：缺少必需参数 "${param.name}"（${param.description}）`
      return { result, rawResult: result }
    }
    if (param.name in args && typeof args[param.name] !== param.type) {
      const result = `错误：参数 "${param.name}" 必须是 ${param.type} 类型。`
      return { result, rawResult: result }
    }
  }

  if (name === 'save_memory' && !shouldAllowMemoryWrite(userIntent)) {
    const result = '保存被拒绝：只有用户本轮明确要求记住或保存信息时，才能写入长期记忆。'
    return { result, rawResult: result }
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort('timeout'), timeout)
  const forwardAbort = () => controller.abort(signal?.reason || 'aborted')
  signal?.addEventListener('abort', forwardAbort, { once: true })

  try {
    if (signal?.aborted) {
      const result = '工具执行已取消。'
      return { result, rawResult: result }
    }
    const result = await Promise.race([
      tool.execute(args, { signal: controller.signal }),
      new Promise<string>((_, reject) =>
        setTimeout(() => reject(new Error('工具执行超时')), timeout)
      ),
    ])
    if (isPendingEditResult(result)) return { result, rawResult: result }
    return {
      result: name === 'read_selection_context' ? result : truncate(result, getToolTokenBudget(name)),
      rawResult: result,
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const result = `工具执行出错: ${msg}`
    return { result, rawResult: result }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', forwardAbort)
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
): Promise<Array<{ name: string; result: string; rawResult?: string; executed?: boolean }>> {
  // 分离读取类和写入类工具
  const readCalls = toolCalls.filter(tc => isReadTool(tc.name))
  const writeCalls = toolCalls.filter(tc => isWriteTool(tc.name))

  const results: Array<{ name: string; result: string; rawResult?: string; executed?: boolean }> = []

  const regularReadCalls = readCalls.filter((call) => call.name !== 'read_selection_context')
  const selectionContextCalls = readCalls.filter((call) => call.name === 'read_selection_context')

  // 普通读类工具并行执行；selectionContext 需要按层级串行执行。
  if (regularReadCalls.length > 0) {
    const readResults = await Promise.allSettled(
      regularReadCalls.map(async tc => {
        const executed = await executeTool(tc.name, tc.args, timeout, userIntent, signal)
        return {
          name: tc.name,
          result: executed.result,
          rawResult: executed.rawResult,
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

    const executed = await executeTool(call.name, call.args, timeout, userIntent, signal)
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
    results.push({ name: call.name, result: executed.result, rawResult: executed.rawResult })
  }

  // 写入类工具本轮只允许执行第一个，避免多个确认卡片之间出现授权范围错配。
  const firstWriteCall = writeCalls[0]
  if (firstWriteCall) {
    const executed = await executeTool(firstWriteCall.name, firstWriteCall.args, timeout, userIntent, signal)
    results.push({ name: firstWriteCall.name, result: executed.result, rawResult: executed.rawResult })
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
export async function runAgent(
  query: string,
  chatHistory: ChatMessage[] = [],
  config: Partial<AgentConfig> = {},
  rawQuery?: string,
  hasRecentEditContext = false,
  hasCurrentEditTarget = false,
  currentEditTargetCount = 0,
  candidateToolNames?: readonly string[],
  hasPrefetchedMemoryLookup = false,
  signal?: AbortSignal,
  temperature?: number,
  onStep?: (step: AgentStep) => void,
  requiredCapabilities?: readonly Capability[],
  untrustedContext?: string,
  customPreferencePrompt?: string,
  streamEnabled = true
): Promise<AgentResult> {
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

  // 构建应用上下文
  const appContext: AppContext = {
    hasRecentEdit: hasRecentEditContext,
    hasOpenFile: hasCurrentEditTarget,
    hasSelection: Boolean(getAgentScopeContext()?.contextTags.some((tag) => tag.type === 'selection')),
    hasContextTags: currentEditTargetCount > 0,
  }

  // 意图检测
  const intentResult = detectIntentScores(userIntent, appContext)
  const isWebComparison = isWebComparisonIntent(userIntent)
  const isLocalResearch = !isWebComparison && isLocalResearchIntent(userIntent)
  const isFileSummary = !isWebComparison && isFileSummaryIntent(userIntent, appContext)
  const answerInstruction = isWebComparison
    ? WEB_COMPARISON_ANSWER_PROMPT
    : isFileSummary ? FILE_SUMMARY_ANSWER_PROMPT
    : isLocalResearch ? LOCAL_RESEARCH_ANSWER_PROMPT : undefined

  // 合并外部传入的 requiredCapabilities
  const mergedRequired = requiredCapabilities && requiredCapabilities.length > 0
    ? Array.from(new Set([...requiredCapabilities, ...intentResult.required]))
    : intentResult.required

  // 构建候选工具
  const candidateTools = candidateToolNames && candidateToolNames.length > 0
    ? [...candidateToolNames] as AgentToolName[]
    : buildCandidateTools(intentResult.candidates)
  if (isFileSummary && !candidateTools.includes('read_context_file')) {
    candidateTools.unshift('read_context_file')
  }

  // 判断是否需要编辑确认
  const requiresEditConfirmation = hasCurrentEditTarget && (
    intentResult.candidates.includes('file_write')
    || (hasRecentEditContext && isImplicitEditContinuation(userIntent))
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
    ...chatHistory.slice(-4), // Keep last 4 messages for context
    ...(contextMessage ? [contextMessage] : []),
    ...(answerInstruction ? [{ role: 'user' as const, content: answerInstruction }] : []),
    { role: 'user', content: query },
  ]

  const steps: AgentStep[] = []
  let toolCalls = 0
  let editToolCalls = 0
  const knowledgeSources: ChatMessageSource[] = []
  const calledToolNames: string[] = []
  const selectionContextReadLevels = new Map<string, 1 | 2>()
  if (hasPrefetchedMemoryLookup) {
    calledToolNames.push('search_memory')
  }

  const pushStep = (step: AgentStep) => {
    steps.push(step)
    onStep?.(step)
  }

  const requestAgentCompletion = async () => {
    if (!streamEnabled) {
      return client.chat({
        messages,
        signal,
        temperature,
        tools: llmTools,
        toolChoice: 'auto',
      })
    }

    let content = ''
    const toolCallBuffers = new Map<number, { id?: string; name: string; arguments: string }>()

    for await (const chunk of client.streamChat({
      messages,
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
      }
      if (chunk.done) break
    }

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
  }

  const repairUnmetReadCapabilities = async (): Promise<boolean> => {
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
      mergedConfig.stepTimeout,
      userIntent,
      signal,
      selectionContextReadLevels,
    )

    for (const { name, result, rawResult } of repairResults) {
      addUniqueSources(knowledgeSources, extractSourcesFromToolResult(name, rawResult || result))
      calledToolNames.push(name)
      toolCalls++
      pushStep({
        type: 'observation',
        content: result,
        timestamp: Date.now(),
      })
      messages.push({
        role: 'user',
        content: `系统已补调 ${name} 工具。请依据结果回答：\n${result}`,
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
      const response = await client.chat({
        messages,
        signal,
        temperature,
        tools: [],
        toolChoice: 'none',
      })

      return {
        answer: response.content,
        steps,
        toolCalls: 0,
        reason: 'completed',
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return {
        answer: `AI 请求失败: ${msg}`,
        steps,
        toolCalls: 0,
        reason: 'error',
      }
    }
  }

  // 有候选工具，进入 Agent 循环
  for (let i = 0; i < mergedConfig.maxSteps; i++) {
    if (signal?.aborted) {
      return { answer: '已取消本次 Agent 请求。', steps, toolCalls, reason: 'error', sources: knowledgeSources }
    }

    // Get AI response with timeout
    let content: string
    let nativeToolCalls: Array<{ name: string; args: Record<string, unknown> }> = []

    try {
      const response = await requestAgentCompletion()
      content = response.content

      // 收集所有原生工具调用
      if (response.toolCalls && response.toolCalls.length > 0) {
        for (const tc of response.toolCalls) {
          if (getTool(tc.name)) {
            nativeToolCalls.push({ name: tc.name, args: tc.args })
          }
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return {
        answer: `AI 请求失败: ${msg}`,
        steps,
        toolCalls,
        reason: 'error',
      }
    }

    pushStep({
      type: 'thought',
      content,
      timestamp: Date.now(),
    })

    // 解析工具调用（原生优先，JSON降级）
    let parsedToolCalls: Array<{ name: string; args: Record<string, unknown>; rawJson?: string }> = []

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
            '{"needsEditConfirmation": true, "targetId": "本轮可编辑目标 ID", "oldText": "当前编辑器中要替换的原文", "newText": "替换后的新文本"}',
            '修改已添加的 selection 或 file 标签时必须优先使用【本轮可编辑目标】里的 targetId。',
            '修改 selection 标签时省略 oldText，由工具读取授权选区当前完整原文，不得选择文档内其他相同文本。',
            '修改整份已授权文件时增加 "replaceWholeDocument": true，并省略 oldText。',
            '或 {"tool": "replace_current_tab_text", "args": {"targetId": "本轮可编辑目标 ID", "newText": "替换后的新文本", "replaceWholeDocument": false}}',
          ].join('\n'),
        })
        continue
      }

      // 最终答案
      const cleanAnswer = stripToolCallJson(content)
      if (cleanAnswer || content) {
        return {
          answer: '',
          steps,
          toolCalls,
          reason: 'completed',
          finalMessages: buildFinalAnswerMessages(messages, answerInstruction),
          sources: knowledgeSources,
        }
      }
      return { answer: '', steps, toolCalls, reason: 'completed', sources: knowledgeSources }
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
    pushStep({
      type: 'action',
      content: `调用工具: ${parsedToolCalls.map(tc => tc.name).join(', ')}`,
      toolName: parsedToolCalls[0].name,
      toolArgs: parsedToolCalls[0].args,
      timestamp: Date.now(),
    })

    const toolResults = await executeToolCalls(
      parsedToolCalls.map(tc => ({ name: tc.name, args: tc.args })),
      mergedConfig.stepTimeout,
      userIntent,
      signal,
      selectionContextReadLevels,
    )

    // 记录调用的工具
    for (const toolResult of toolResults) {
      const { name } = toolResult
      const executed = toolResult.executed !== false
      if (executed) {
        addUniqueSources(knowledgeSources, extractSourcesFromToolResult(name, toolResult.rawResult || toolResult.result))
      }
      if (executed) {
        calledToolNames.push(name)
        toolCalls++
      }
      if (executed && name === 'replace_current_tab_text') {
        editToolCalls++
      }
    }

    // 添加工具结果到消息
    for (const { name, result, executed } of toolResults) {
      pushStep({
        type: 'observation',
        content: result,
        timestamp: Date.now(),
      })

      messages.push({ role: 'assistant', content: executed === false ? `未执行工具: ${name}` : `调用工具: ${name}` })
      messages.push({
        role: 'user',
        content: name === 'read_selection_context'
          ? `工具返回结果：\n${result}\n\n请根据以上信息继续思考或给出最终答案。`
          : truncate(`工具返回结果：\n${result}\n\n请根据以上信息继续思考或给出最终答案。`, getToolTokenBudget(name)),
      })
    }

    // 检查是否有待确认的编辑
    const hasPendingEdit = toolResults.some(tr => isPendingEditResult(tr.result))
    if (hasPendingEdit) {
      return { answer: '', steps, toolCalls, reason: 'completed', sources: knowledgeSources }
    }

    // 智能裁剪历史（保留最近的用户消息和工具结果）
    if (messages.length > 20) {
      const systemMessage = messages[0]
      const userMessage = messages[messages.length - 1] // 最近的用户消息

      // 找到最近的工具结果消息
      let lastToolResultIndex = -1
      for (let j = messages.length - 1; j >= 0; j--) {
        if (messages[j].role === 'user' && messages[j].content.includes('工具返回结果')) {
          lastToolResultIndex = j
          break
        }
      }

      // 找到最近的用户消息（非工具结果）
      let lastUserMessageIndex = -1
      for (let j = messages.length - 1; j >= 0; j--) {
        if (messages[j].role === 'user' && !messages[j].content.includes('工具返回结果')) {
          lastUserMessageIndex = j
          break
        }
      }

      // 确定保留的起始位置
      let keepFromIndex = 1 // 默认从第二条消息开始保留

      if (lastToolResultIndex > 0) {
        // 如果有工具结果，从工具结果前一条消息开始保留
        keepFromIndex = Math.max(1, lastToolResultIndex - 1)
      } else if (lastUserMessageIndex > 0) {
        // 如果没有工具结果，从最近用户消息前一条开始保留
        keepFromIndex = Math.max(1, lastUserMessageIndex - 1)
      }

      // 计算要保留的消息数量（最多保留15条）
      const maxKeep = 15
      const availableMessages = messages.length - keepFromIndex
      const keepCount = Math.min(maxKeep, availableMessages)

      // 如果需要裁剪
      if (keepCount < availableMessages) {
        keepFromIndex = messages.length - keepCount
      }

      // 重建消息数组
      const recentMessages = messages.slice(keepFromIndex)
      messages.length = 0
      messages.push(systemMessage, ...recentMessages)

      // 确保最近的用户消息在最后
      if (messages[messages.length - 1].role !== 'user') {
        messages.push(userMessage)
      }
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
      sources: knowledgeSources,
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
      sources: knowledgeSources,
    }
  }

  return {
    answer: '已达到最大步骤数，且没有可用于总结的工具结果。',
    steps,
    toolCalls,
    reason: 'max_steps',
    sources: knowledgeSources,
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
