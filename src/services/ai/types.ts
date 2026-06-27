export interface EmbeddingConfig {
  baseUrl: string
  apiKey: string
  embeddingModel: string
}

export interface AiConfig {
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

export interface ChatMessageSource {
  filePath: string
  fileName: string
  titlePath?: string[]
  heading?: string
  startLine: number
  endLine: number
}

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

export interface AiProvider {
  chat(request: ChatRequest): Promise<ChatResponse>
  streamChat(request: ChatRequest): AsyncIterable<StreamChunk>
  embedding(text: string, signal?: AbortSignal): Promise<EmbeddingResponse>
  batchEmbedding(texts: string[], signal?: AbortSignal): Promise<number[][]>
  validateConfig(): Promise<boolean>
  listModels(): Promise<string[]>
}

export const DEFAULT_AI_CONFIG: AiConfig = {
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
  baseUrl: string
  chatModel?: string
  embeddingModel?: string
}

export const AI_CHAT_PRESETS: AiPreset[] = [
  { key: 'custom', label: '自定义', baseUrl: '' },
  { key: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', chatModel: 'gpt-4o-mini' },
  { key: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', chatModel: 'deepseek-chat' },
  { key: 'mimo', label: 'MiMo (小米)', baseUrl: 'https://api.xiaomimimo.com/v1', chatModel: 'mimo-v2.5' },
  { key: 'siliconflow', label: 'SiliconFlow', baseUrl: 'https://api.siliconflow.cn/v1', chatModel: 'Qwen/Qwen2.5-72B-Instruct' },
  { key: 'zhipu', label: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', chatModel: 'glm-4-flash' },
  { key: 'ollama', label: 'Ollama 本地', baseUrl: 'http://localhost:11434/v1', chatModel: 'qwen2.5:7b' },
]

export const AI_EMBEDDING_PRESETS: AiPreset[] = [
  { key: 'custom', label: '自定义', baseUrl: '' },
  { key: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', embeddingModel: 'text-embedding-3-small' },
  { key: 'siliconflow', label: 'SiliconFlow', baseUrl: 'https://api.siliconflow.cn/v1', embeddingModel: 'BAAI/bge-large-zh-v1.5' },
  { key: 'zhipu', label: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', embeddingModel: 'embedding-3' },
  { key: 'ollama', label: 'Ollama 本地', baseUrl: 'http://localhost:11434/v1', embeddingModel: 'nomic-embed-text' },
]
