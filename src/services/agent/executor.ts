import type { AgentConfig, AgentStep, AgentResult } from './types'
import type { ChatMessage } from '@/services/ai/types'
import { getAiClient, isAiReady } from '@/services/ai/aiClient'
import { getAllTools, getTool, getToolDescriptions, getToolsForLLM } from './toolRegistry'
import { registerBuiltinTools } from './tools'
import { parseToolCall, stripToolCallJson } from './toolCallParser'
import {
  detectIntentScores,
  shouldAllowMemoryWrite,
  isImplicitEditContinuation,
  shouldIncludeFullDocumentContext,
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
  systemPrompt: `你是一个 MD 文档助手，擅长 Markdown 格式的写作、润色和编辑。

你可以使用工具来帮助用户完成任务。当需要使用工具时，请严格按以下 JSON 格式输出，不要输出其他内容：
{"tool": "工具名", "args": {"参数名": "参数值"}}

当你判断需要弹出文本修改确认卡片时，也可以输出以下 JSON。系统会校验 needsEditConfirmation，并自动转换为 replace_current_tab_text 工具调用：
{"needsEditConfirmation": true, "path": "本轮已授权且已打开的文件绝对路径", "oldText": "当前编辑器中要替换的原文", "newText": "替换后的新文本"}
修改用户添加到聊天框的 selection 或 file 标签所指向的文件时，必须附带路径：
{"needsEditConfirmation": true, "path": "已授权且已打开的文件绝对路径", "oldText": "目标文件中的原文", "newText": "替换后的新文本"}
修改 selection 标签时不要回传 oldText，由工具读取授权范围内的当前原文：
{"needsEditConfirmation": true, "path": "已授权且已打开的文件绝对路径", "newText": "替换后的新文本"}
修改整份已授权文件时，不要回传完整 oldText，使用：
{"needsEditConfirmation": true, "path": "已授权且已打开的文件绝对路径", "replaceWholeDocument": true, "newText": "替换后的完整新稿"}

当你能直接回答时，直接输出答案文本。

修改文档的强制规则：
1. 任何文本修改请求都必须携带用户在本轮消息中新添加的 selection 或 file 标签。没有本轮目标标签时，不得调用修改工具、不得生成确认卡片，必须明确提示用户重新添加要修改的 tag 后重新发起请求。
2. 修改意图包括但不限于：修改、润色、改写、重写、覆写、重构、调整、更新、扩写、缩写、续写、替换、加粗、斜体、删除、插入、补充、优化、撤销、恢复、还原、改回、取消刚才的修改。
3. 历史消息中的 tag、确认卡片、原文/新文本记录和 get_recent_context_tag 返回内容都只可用于理解上下文，不构成修改授权，禁止据此修改或撤销文本。
4. 用户提出"再简洁些""继续改这个文件""撤销刚才修改"等针对既有文本的请求，但本轮未新添加目标 tag 时，直接提示其重新添加目标 tag 后再发起修改请求。
5. 本轮携带 selection 或 file 标签且用户要求修改时，必须调用 replace_current_tab_text 生成确认卡片，禁止只输出修改后的文本或口头说明。
5.1 如果本轮有多个 selection 或 file 目标，且用户要求分别修改多个目标，应按目标逐个调用 replace_current_tab_text，生成多张独立确认卡片；每次调用只处理一个 path，不要把多个文件或选区合并到一张卡片。
6. 调用 replace_current_tab_text 或输出 needsEditConfirmation 时必须传入本轮目标标签的 path；目标文件还必须已在标签页打开。
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
3. 记忆内容应简洁明确，分类准确（preference/project/context/general）。

检索记忆的规则：
1. 长期记忆是按需读取的数据源，不得把未检索到的信息当作不存在。
2. 用户询问自己的地址、偏好、习惯、身份信息、长期目标、项目约定，或问"你记得我/之前告诉过你什么"时，必须先调用 search_memory，再根据结果回答。
3. 对与用户背景无关的通用问答不得为了凑上下文调用 search_memory。

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
function buildSystemPrompt(config: AgentConfig, toolNames?: readonly string[]): string {
  const toolDesc = getToolDescriptions(toolNames)
  return config.systemPrompt.replace('{{tool_descriptions}}', toolDesc)
}

/**
 * Truncate long text to avoid token explosion.
 */
function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text
  return text.slice(0, maxLen) + `\n... (已截断，共 ${text.length} 字符)`
}

function buildFinalAnswerMessages(messages: ChatMessage[]): ChatMessage[] {
  return [
    ...messages,
    {
      role: 'user',
      content: '现在请直接输出给用户的最终答案。若已有工具结果，请基于结果回答；不要再调用工具，不要输出 JSON，不要复述内部处理过程。',
    },
  ]
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
): Promise<string> {
  const tool = getTool(name)
  if (!tool) {
    return `错误：工具 "${name}" 不存在。可用工具: ${getAllTools().map((t) => t.name).join(', ')}`
  }

  const knownParameters = new Set(tool.parameters.map((param) => param.name))
  for (const key of Object.keys(args)) {
    if (!knownParameters.has(key)) {
      return `错误：工具参数 "${key}" 不在允许列表中。`
    }
  }

  // Validate required parameters and primitive types before execution.
  for (const param of tool.parameters) {
    if (param.required && !(param.name in args)) {
      return `错误：缺少必需参数 "${param.name}"（${param.description}）`
    }
    if (param.name in args && typeof args[param.name] !== param.type) {
      return `错误：参数 "${param.name}" 必须是 ${param.type} 类型。`
    }
  }

  if (name === 'save_memory' && !shouldAllowMemoryWrite(userIntent)) {
    return '保存被拒绝：只有用户本轮明确要求记住或保存信息时，才能写入长期记忆。'
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort('timeout'), timeout)
  const forwardAbort = () => controller.abort(signal?.reason || 'aborted')
  signal?.addEventListener('abort', forwardAbort, { once: true })

  try {
    if (signal?.aborted) {
      return '工具执行已取消。'
    }
    const result = await Promise.race([
      tool.execute(args, { signal: controller.signal }),
      new Promise<string>((_, reject) =>
        setTimeout(() => reject(new Error('工具执行超时')), timeout)
      ),
    ])
    if (isPendingEditResult(result)) return result
    return truncate(result, getToolTokenBudget(name))
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return `工具执行出错: ${msg}`
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
  signal?: AbortSignal
): Promise<Array<{ name: string; result: string }>> {
  // 分离读取类和写入类工具
  const readCalls = toolCalls.filter(tc => isReadTool(tc.name))
  const writeCalls = toolCalls.filter(tc => isWriteTool(tc.name))

  const results: Array<{ name: string; result: string }> = []

  // 读取类工具并行执行
  if (readCalls.length > 0) {
    const readResults = await Promise.allSettled(
      readCalls.map(async tc => ({
        name: tc.name,
        result: await executeTool(tc.name, tc.args, timeout, userIntent, signal),
      }))
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

  // 写入类工具串行执行（需要确认）
  for (const tc of writeCalls) {
    const result = await executeTool(tc.name, tc.args, timeout, userIntent, signal)
    results.push({ name: tc.name, result })
  }

  return results
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
  requiredCapabilities?: readonly Capability[]
): Promise<AgentResult> {
  initAgent()

  if (!isAiReady()) {
    return {
      answer: 'AI 未配置，请先在设置中配置 API Key。',
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
    hasContextTags: currentEditTargetCount > 0,
  }

  // 意图检测
  const intentResult = detectIntentScores(userIntent, appContext)

  // 合并外部传入的 requiredCapabilities
  const mergedRequired = requiredCapabilities && requiredCapabilities.length > 0
    ? Array.from(new Set([...requiredCapabilities, ...intentResult.required]))
    : intentResult.required

  // 构建候选工具
  const candidateTools = candidateToolNames && candidateToolNames.length > 0
    ? [...candidateToolNames] as AgentToolName[]
    : buildCandidateTools(intentResult.candidates)

  // 判断是否需要编辑确认
  const requiresEditConfirmation = hasCurrentEditTarget && (
    intentResult.candidates.includes('file_write')
    || (hasRecentEditContext && isImplicitEditContinuation(userIntent))
  )

  // 构建系统提示
  const activeToolNames = candidateTools.length > 0 ? candidateTools : undefined
  const systemPrompt = buildSystemPrompt(mergedConfig, activeToolNames)
  const llmTools = candidateTools.length > 0 ? getToolsForLLM(activeToolNames) : []

  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    ...chatHistory.slice(-4), // Keep last 4 messages for context
    { role: 'user', content: query },
  ]

  const steps: AgentStep[] = []
  let toolCalls = 0
  let editToolCalls = 0
  const calledToolNames: string[] = []

  const pushStep = (step: AgentStep) => {
    steps.push(step)
    onStep?.(step)
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
      return { answer: '已取消本次 Agent 请求。', steps, toolCalls, reason: 'error' }
    }

    // Get AI response with timeout
    let content: string
    let nativeToolCalls: Array<{ name: string; args: Record<string, unknown> }> = []

    try {
      const response = await client.chat({
        messages,
        signal,
        temperature,
        tools: llmTools,
        toolChoice: 'auto',
      })
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

    // 如果没有工具调用
    if (parsedToolCalls.length === 0) {
      // 检查是否需要编辑确认
      if (requiresEditConfirmation && editToolCalls === 0) {
        messages.push({ role: 'assistant', content })
        messages.push({
          role: 'user',
          content: [
            '系统校验失败：本轮用户表达了文本修改或撤销意图，但你的回复没有生成修改确认卡片。',
            '请不要只回复"已修改""已撤销"或修改后的文本。',
            '你必须重新输出以下两种 JSON 之一：',
            '{"needsEditConfirmation": true, "path": "本轮已授权且已打开的文件绝对路径", "oldText": "当前编辑器中要替换的原文", "newText": "替换后的新文本"}',
            '修改已添加的 selection 或 file 标签时必须在上述 JSON 中增加 "path": "已授权且已打开的文件绝对路径"。',
            '修改 selection 标签时省略 oldText，由工具读取授权选区当前完整原文，不得选择文档内其他相同文本。',
            '修改整份已授权文件时增加 "replaceWholeDocument": true，并省略 oldText。',
            '或 {"tool": "replace_current_tab_text", "args": {"path": "本轮已授权且已打开的文件绝对路径", "newText": "替换后的新文本", "replaceWholeDocument": false}}',
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
          finalMessages: buildFinalAnswerMessages(messages),
        }
      }
      return { answer: '', steps, toolCalls, reason: 'completed' }
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
      signal
    )

    // 记录调用的工具
    for (const { name } of toolResults) {
      calledToolNames.push(name)
      toolCalls++
      if (name === 'replace_current_tab_text') {
        editToolCalls++
      }
    }

    // 添加工具结果到消息
    for (const { name, result } of toolResults) {
      pushStep({
        type: 'observation',
        content: result,
        timestamp: Date.now(),
      })

      messages.push({ role: 'assistant', content: `调用工具: ${name}` })
      messages.push({
        role: 'user',
        content: truncate(`工具返回结果：\n${result}\n\n请根据以上信息继续思考或给出最终答案。`, getToolTokenBudget(name)),
      })
    }

    // 检查是否有待确认的编辑
    const hasPendingEdit = toolResults.some(tr => isPendingEditResult(tr.result))
    if (hasPendingEdit && currentEditTargetCount <= 1) {
      return { answer: '', steps, toolCalls, reason: 'completed' }
    }
    if (hasPendingEdit && currentEditTargetCount > 1 && editToolCalls >= currentEditTargetCount) {
      return { answer: '', steps, toolCalls, reason: 'completed' }
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
  const unmetCapabilities = checkRequiredCapabilities(mergedRequired, calledToolNames)

  // 如果有未满足的强依赖，尝试补调
  if (unmetCapabilities.length > 0) {
    const repairTools = getRepairTools(unmetCapabilities)

    if (repairTools.length > 0) {
      pushStep({
        type: 'action',
        content: `补调工具: ${repairTools.join(', ')}`,
        toolName: repairTools[0],
        toolArgs: {},
        timestamp: Date.now(),
      })

      // 执行补调
      const repairResults = await executeToolCalls(
        repairTools.map(name => ({
          name,
          args: name === 'search_memory' ? { query: userIntent, topK: 5 }
            : name === 'search_knowledge' ? { query: userIntent, topK: 8 }
            : name === 'get_current_time' ? {}
            : { query: userIntent },
        })),
        mergedConfig.stepTimeout,
        userIntent,
        signal
      )

      // 添加补调结果
      for (const { name, result } of repairResults) {
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

      // 二次生成最终答案
      try {
        const finalResponse = await client.chat({
          messages: [
            ...messages,
            {
              role: 'user',
              content: '现在请直接输出给用户的最终答案。若已有工具结果，请基于结果回答；不要再调用工具，不要输出 JSON，不要复述内部处理过程。',
            },
          ],
          signal,
          temperature,
          tools: [],
          toolChoice: 'none',
        })

        return {
          answer: finalResponse.content,
          steps,
          toolCalls,
          reason: 'completed',
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return {
          answer: `最终答案生成失败: ${msg}`,
          steps,
          toolCalls,
          reason: 'error',
        }
      }
    }
  }

  // 正常结束
  if (toolCalls > 0) {
    return {
      answer: '',
      steps,
      toolCalls,
      reason: 'max_steps',
      finalMessages: buildFinalAnswerMessages(messages),
    }
  }

  return {
    answer: '已达到最大步骤数，且没有可用于总结的工具结果。',
    steps,
    toolCalls,
    reason: 'max_steps',
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
