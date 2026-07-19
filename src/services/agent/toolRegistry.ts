import type { ChatTool } from '@/services/ai/types'
import type { ToolDefinition } from './types'

const tools = new Map<string, ToolDefinition>()

const TOOL_USAGE_GUIDANCE: Record<string, string> = {
  search_knowledge: [
    '使用时机：当用户要在本地知识库、笔记、文档、RAG、已索引资料中查找“有没有、在哪里、哪些文件提到、相关资料”时必须优先调用。',
    '返回内容：命中文件、行号、片段和索引状态；可用于回答“相关内容在哪里/大意是什么”。若需要阅读全文、总结整篇或改写文件，必须让用户把目标文件加入上下文，或在已授权时再读文件。',
    '不要混淆：知识库是文档索引，不是长期记忆；用户问个人偏好、地址、称呼、项目约定或之前告诉过你的信息时用 search_memory。',
  ].join('\n'),
  search_memory: [
    '使用时机：当用户询问个人偏好、地址、称呼、习惯、身份信息、长期目标、项目约定、之前/上次告诉过你的内容，或明确要求查记忆时必须优先调用。',
    '返回内容：已确认的长期记忆上下文；未调用前不得回答“没有相关记忆”。',
    '不要混淆：长期记忆不是知识库文档；用户问本地文档、笔记、RAG 或索引资料时用 search_knowledge。',
  ].join('\n'),
  list_database_contents: '使用时机：只用于查看知识库索引和 embedding 队列概览，不返回长期记忆；需要记忆库概览时用 list_memories。',
  list_memories: '使用时机：只用于查看记忆库概览和候选记忆，不返回知识库文档；需要本地文档索引概览时用 list_database_contents。',
  read_selection_context: [
    '使用时机：本轮有 selection，且问题明确提到上下文、前后文、结合上下文、附近内容、周围内容，或依赖原因、推导、正确性、对比、关系时优先调用。普通总结、翻译、润色、改写、解释、说明不需要调用。',
    '方向参数：用户明确说“上文/上方/前面/之前”时传 before；“下文/下方/下面/后面/之后/后续”时传 after；“前后文/两侧/周围”时传 both；未指定方向时传 auto。before/after 是硬约束，不得用 auto 代替。',
    '返回内容：auto 按语义相关性选择邻居；before/after/both 按指定方向和文档顺序读取。框选 Markdown 标题并读取 after 时，只返回该标题及其子标题管辖的正文。Level 1 总预算 700 tokens；Level 2 累计扩展到 1400 tokens，第二次只返回新增 Chunk。',
    '工具顺序：先使用选区正文，再调用 level=1；只有信息明显不足且问题涉及原因、推导、对比、关系、错误分析或选区孤立时，才调用 level=2。禁止跳级、重复层级和自动读取全文；read_context_file 仅用于用户明确要求全文。',
  ].join('\n'),
}

function withUsageGuidance(tool: ToolDefinition): string {
  const guidance = TOOL_USAGE_GUIDANCE[tool.name]
  return guidance ? `${tool.description}\n${guidance}` : tool.description
}

export function registerTool(tool: ToolDefinition) {
  if (tools.has(tool.name)) {
    console.warn(`Tool "${tool.name}" already registered, overwriting`)
  }
  tools.set(tool.name, tool)
}

export function getTool(name: string): ToolDefinition | undefined {
  return tools.get(name)
}

export function getAllTools(): ToolDefinition[] {
  return Array.from(tools.values())
}

export function getToolDescriptions(names?: readonly string[]): string {
  const selectedTools = names
    ? names.map((name) => tools.get(name)).filter((tool): tool is ToolDefinition => Boolean(tool))
    : getAllTools()

  return selectedTools
    .map((t) => {
      const paramLines = t.parameters
        .map((p) => `  - ${p.name} (${p.type}${p.required ? ', required' : ''}): ${p.description}`)
        .join('\n')
      const description = withUsageGuidance(t)
      if (paramLines) {
        return `### ${t.name}\n${description}\n参数:\n${paramLines}`
      }
      return `### ${t.name}\n${description}`
    })
    .join('\n\n')
}

export function getToolsForLLM(names?: readonly string[]): ChatTool[] {
  const selectedTools = names
    ? names.map((name) => tools.get(name)).filter((tool): tool is ToolDefinition => Boolean(tool))
    : getAllTools()

  return selectedTools.map((tool) => ({
    type: 'function' as const,
    function: {
      name: tool.name,
      description: withUsageGuidance(tool),
      parameters: {
        type: 'object' as const,
        properties: Object.fromEntries(
          tool.parameters.map((p) => [
            p.name,
            {
              type: p.type,
              description: p.description,
            },
          ])
        ),
        required: tool.parameters.filter((p) => p.required).map((p) => p.name),
      },
    },
  }))
}
