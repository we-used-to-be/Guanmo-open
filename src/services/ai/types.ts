/** 对话协议类型 */
export type ChatProtocol = 'openai-chat' | 'anthropic-messages' | 'openai-responses'

/** Embedding 协议类型 */
export type EmbeddingProtocol = 'openai-embedding'

/** 供应商标识 */
export type ProviderId = 'openai' | 'deepseek' | 'mimo' | 'siliconflow' | 'zhipu' | 'ollama' | 'coding-plan' | 'anthropic' | 'groq' | 'openrouter' | 'moonshot' | 'custom'

export interface EmbeddingConfig {
  protocol: EmbeddingProtocol
  provider: ProviderId
  baseUrl: string
  apiKey: string
  embeddingModel: string
}

export interface AiConfig {
  protocol: ChatProtocol
  provider: ProviderId
  baseUrl: string
  apiKey: string
  chatModel: string
  streamEnabled: boolean
  webSearchEnabled: boolean
  customPreferencePrompt: string
  timeout: number
  maxContextLength: number
  temperature: number
  topP: number
  embedding: EmbeddingConfig
}

export interface ChatMessageTag {
  type: 'file' | 'selection' | 'folder' | 'memory' | 'web'
  title: string
  filePath: string | null
  folderPath?: string
  content?: string | null
  preview: string
  startLine?: number
  endLine?: number
  selectionFrom?: number
  selectionTo?: number
}

export interface ChatMessageContextMeta {
  tagCount: number
  ragSourceCount: number
  webSearchUsed: boolean
}

export interface LocalChatMessageSource {
  kind?: 'local'
  filePath: string
  fileName: string
  titlePath?: string[]
  heading?: string
  startLine: number
  endLine: number
}

export interface WebChatMessageSource {
  kind: 'web'
  title: string
  url: string
  siteName?: string
  publishedAt?: string
  snippet?: string
}

export type ChatMessageSource = LocalChatMessageSource | WebChatMessageSource

export interface EditConfirmation {
  id: string
  messageId?: string
  oldText: string
  newText: string
  tabId: string
  tabTitle: string
  replaceFrom?: number
  replaceTo?: number
  replaceWholeDocument?: boolean
  changeSummary?: string
  selectionFrom?: number
  selectionTo?: number
  status: 'pending' | 'applied' | 'rejected'
}

export interface ChatMessage {
  id?: string
  parentId?: string
  role: 'system' | 'user' | 'assistant'
  content: string
  timestamp?: number
  tags?: ChatMessageTag[]
  displayContent?: string
  contextMeta?: ChatMessageContextMeta
  sources?: ChatMessageSource[]
  editConfirmation?: EditConfirmation
  hidden?: boolean
  sessionId?: string
  sessionTitle?: string
}

export interface ChatToolCall {
  id?: string
  name: string
  args: Record<string, unknown>
}

export interface ChatTool {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: {
      type: 'object'
      properties: Record<string, { type: string; description: string }>
      required: string[]
    }
  }
}

export interface ChatRequest {
  messages: ChatMessage[]
  stream?: boolean
  temperature?: number
  maxTokens?: number
  signal?: AbortSignal
  tools?: ChatTool[]
  toolChoice?: 'auto' | 'none'
}

export interface ChatResponse {
  id: string
  content: string
  role: 'assistant'
  toolCalls?: ChatToolCall[]
  usage?: {
    promptTokens: number
    completionTokens: number
    totalTokens: number
  }
}

export interface StreamChunk {
  content: string
  done: boolean
  toolCallDeltas?: Array<{
    index: number
    id?: string
    name?: string
    arguments?: string
  }>
}

export interface EmbeddingResponse {
  embedding: number[]
  usage?: {
    totalTokens: number
  }
}

/** 连通性校验结果 */
export interface ValidateResult {
  ok: boolean
  /** 错误类型：auth_failed | network_error | not_found | timeout | unknown */
  error?: string
  /** 人类可读的中文错误提示 */
  message?: string
  /** 校验成功时返回可用模型列表 */
  models?: string[]
}

export interface AiProvider {
  chat(request: ChatRequest): Promise<ChatResponse>
  streamChat(request: ChatRequest): AsyncIterable<StreamChunk>
  embedding(text: string, signal?: AbortSignal): Promise<EmbeddingResponse>
  batchEmbedding(texts: string[], signal?: AbortSignal): Promise<number[][]>
  validateConfig(): Promise<ValidateResult>
  listModels(): Promise<string[]>
}

export const DEFAULT_AI_CONFIG: AiConfig = {
  protocol: 'openai-chat',
  provider: 'custom',
  baseUrl: '',
  apiKey: '',
  chatModel: '',
  streamEnabled: true,
  webSearchEnabled: false,
  customPreferencePrompt: '',
  timeout: 60000,
  maxContextLength: 8192,
  temperature: 0.7,
  topP: 1,
  embedding: {
    protocol: 'openai-embedding',
    provider: 'custom',
    baseUrl: '',
    apiKey: '',
    embeddingModel: '',
  },
}

/** 系统流程固定温度（不读取用户设置） */
export const SYSTEM_TEMPERATURE = {
  routing: 0,
  agentPlanning: 0.1,
  ragRewrite: 0.1,
  memoryExtract: 0.1,
  editConfirm: 0.1,
} as const

/** 用户可调温度（仅影响普通聊天类输出） */
export function userChatTemperature(userTemp: number): number {
  return userTemp
}

export interface AiPreset {
  key: string
  label: string
  protocol: ChatProtocol | EmbeddingProtocol
  provider: ProviderId
  baseUrl: string
  chatModel?: string
  embeddingModel?: string
}

export const AI_CHAT_PRESETS: AiPreset[] = [
  // ── 通用 / 手动输入 ──
  { key: 'custom', label: '自定义', protocol: 'openai-chat', provider: 'custom', baseUrl: '' },

  // ── OpenAI Chat Completions ──
  { key: 'openai', label: 'OpenAI', protocol: 'openai-chat', provider: 'openai', baseUrl: 'https://api.openai.com/v1', chatModel: 'gpt-4o-mini' },
  { key: 'deepseek', label: 'DeepSeek', protocol: 'openai-chat', provider: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', chatModel: 'deepseek-chat' },
  { key: 'zhipu', label: '智谱 GLM', protocol: 'openai-chat', provider: 'zhipu', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', chatModel: 'glm-4-flash' },
  { key: 'moonshot', label: '月之暗面 Moonshot', protocol: 'openai-chat', provider: 'moonshot', baseUrl: 'https://api.moonshot.cn/v1', chatModel: 'moonshot-v1-8k' },
  { key: 'mimo', label: 'MiMo (小米)', protocol: 'openai-chat', provider: 'mimo', baseUrl: 'https://api.xiaomimimo.com/v1', chatModel: 'mimo-v2.5' },
  { key: 'siliconflow', label: 'SiliconFlow', protocol: 'openai-chat', provider: 'siliconflow', baseUrl: 'https://api.siliconflow.cn/v1', chatModel: 'Qwen/Qwen2.5-72B-Instruct' },
  { key: 'groq', label: 'Groq', protocol: 'openai-chat', provider: 'groq', baseUrl: 'https://api.groq.com/openai/v1', chatModel: 'llama-3.3-70b-versatile' },
  { key: 'openrouter', label: 'OpenRouter', protocol: 'openai-chat', provider: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', chatModel: 'openai/gpt-4o-mini' },
  { key: 'ollama', label: 'Ollama 本地', protocol: 'openai-chat', provider: 'ollama', baseUrl: 'http://localhost:11434/v1', chatModel: 'qwen2.5:7b' },

  // ── Coding Plan 系列 (均为 openai-chat 协议) ──
  { key: 'coding-ali', label: 'Coding Plan · 阿里百炼', protocol: 'openai-chat', provider: 'coding-plan', baseUrl: 'https://coding.dashscope.aliyuncs.com/v1', chatModel: 'qwen3.7-plus' },
  { key: 'coding-iflytek', label: 'Coding Plan · 讯飞星辰', protocol: 'openai-chat', provider: 'coding-plan', baseUrl: 'https://maas-coding-api.cn-huabei-1.xf-yun.com/v2', chatModel: 'xingchen-coding-plus' },
  { key: 'coding-tencent', label: 'Coding Plan · 腾讯云', protocol: 'openai-chat', provider: 'coding-plan', baseUrl: 'https://api.lkeap.cloud.tencent.com/coding/v3', chatModel: 'hunyuan-code' },

  // ── Anthropic Messages (Provider 待实现) ──
  { key: 'anthropic', label: 'Anthropic', protocol: 'anthropic-messages', provider: 'anthropic', baseUrl: 'https://api.anthropic.com', chatModel: 'claude-sonnet-4-20250514' },

  // ── OpenAI Responses (Provider 待实现) ──
  { key: 'openai-responses', label: 'OpenAI (Responses)', protocol: 'openai-responses', provider: 'openai', baseUrl: 'https://api.openai.com/v1', chatModel: 'gpt-4o-mini' },
]

/** 用户自定义预设（持久化到 localStorage，apiKey 除外） */
export interface CustomPreset {
  id: string
  label: string
  protocol: ChatProtocol | EmbeddingProtocol
  provider: ProviderId
  baseUrl: string
  chatModel?: string
  embeddingModel?: string
  /** 预留能力开关（如 stream/tools/vision 等） */
  capabilities?: Record<string, boolean>
}

export const AI_EMBEDDING_PRESETS: AiPreset[] = [
  { key: 'custom', label: '自定义', protocol: 'openai-embedding', provider: 'custom', baseUrl: '' },
  { key: 'openai', label: 'OpenAI', protocol: 'openai-embedding', provider: 'openai', baseUrl: 'https://api.openai.com/v1', embeddingModel: 'text-embedding-3-small' },
  { key: 'siliconflow', label: 'SiliconFlow', protocol: 'openai-embedding', provider: 'siliconflow', baseUrl: 'https://api.siliconflow.cn/v1', embeddingModel: 'BAAI/bge-large-zh-v1.5' },
  { key: 'zhipu', label: '智谱 GLM', protocol: 'openai-embedding', provider: 'zhipu', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', embeddingModel: 'embedding-3' },
  { key: 'ollama', label: 'Ollama 本地', protocol: 'openai-embedding', provider: 'ollama', baseUrl: 'http://localhost:11434/v1', embeddingModel: 'nomic-embed-text' },
]
