/**
 * 深度思考模式适配器层
 *
 * 将统一的 reasoningMode ('off' | 'on') 转换为各厂商特有的 API 参数。
 * 避免在业务代码中写死具体模型判断。
 */

import type { ProviderId } from './types'

/** 模型能力声明 */
export type ReasoningSupport = true | false | 'unknown'

/** 适配器接口 */
interface ReasoningAdapter {
  /** 判断模型是否支持推理 */
  supportsReasoning(model: string): ReasoningSupport
  /** 用户显式开启时，是否允许通过真实请求探测支持情况 */
  probeWhenRequested: boolean
  /** 将 reasoningMode 转换为厂商特有参数并应用到请求体 */
  applyReasoning(body: Record<string, unknown>, mode: 'off' | 'on', model: string): void
  /** 移除请求体中的推理参数（用于失败重试） */
  removeReasoning(body: Record<string, unknown>): void
}

/** DeepSeek 适配器 */
const deepseekAdapter: ReasoningAdapter = {
  supportsReasoning(model) {
    // DeepSeek Flash/V4、reasoner 等支持
    if (model === 'deepseek-flash' || model.includes('v4') || model.includes('reasoner')) return true
    return 'unknown'
  },
  probeWhenRequested: true,
  applyReasoning(body, mode, _model) {
    body.thinking = { type: mode === 'on' ? 'enabled' : 'disabled' }
  },
  removeReasoning(body) {
    delete body.thinking
  },
}

/** OpenAI 适配器 */
const openaiAdapter: ReasoningAdapter = {
  supportsReasoning(model) {
    // GPT-6 与 o1、o3 系列支持
    if (model.startsWith('gpt-6') || model.startsWith('o1') || model.startsWith('o3')) return true
    return 'unknown'
  },
  probeWhenRequested: true,
  applyReasoning(body, mode, _model) {
    if (mode === 'on') {
      body.reasoning_effort = 'medium'
    }
    // OpenAI 的 reasoning 模型不支持 temperature 参数
    if (mode === 'on') {
      delete body.temperature
    }
  },
  removeReasoning(body) {
    delete body.reasoning_effort
  },
}

/** Anthropic (Claude) 适配器 */
const anthropicAdapter: ReasoningAdapter = {
  supportsReasoning(model) {
    // Claude 3.5 Sonnet 等支持
    if (model.includes('claude')) return true
    return 'unknown'
  },
  probeWhenRequested: false,
  applyReasoning(body, mode, _model) {
    body.thinking = { type: mode === 'on' ? 'enabled' : 'disabled' }
  },
  removeReasoning(body) {
    delete body.thinking
  },
}

/** Gemini 适配器 */
const geminiAdapter: ReasoningAdapter = {
  supportsReasoning(model) {
    // gemini-2.0-flash-thinking 等支持
    if (model.includes('thinking')) return true
    return 'unknown'
  },
  probeWhenRequested: true,
  applyReasoning(body, mode, _model) {
    if (mode === 'on') {
      body.thinkingConfig = { thinkingBudget: 1024 }
    } else {
      body.thinkingConfig = { thinkingBudget: 0 }
    }
  },
  removeReasoning(body) {
    delete body.thinkingConfig
  },
}

/** Qwen 适配器 */
const qwenAdapter: ReasoningAdapter = {
  supportsReasoning(model) {
    // qwen-max 等支持
    if (model.includes('qwen')) return true
    return 'unknown'
  },
  probeWhenRequested: true,
  applyReasoning(body, mode, _model) {
    body.enable_thinking = mode === 'on'
  },
  removeReasoning(body) {
    delete body.enable_thinking
  },
}

/** GLM 适配器（暂不支持） */
const glmAdapter: ReasoningAdapter = {
  supportsReasoning() {
    return 'unknown'
  },
  probeWhenRequested: false,
  applyReasoning(_body, _mode, _model) {
    // GLM 暂不支持思考模式
  },
  removeReasoning(_body) {
    // 无需移除
  },
}

/** 通用适配器（默认） */
const defaultAdapter: ReasoningAdapter = {
  supportsReasoning() {
    return 'unknown'
  },
  probeWhenRequested: false,
  applyReasoning(_body, _mode, _model) {
    // 未知模型不添加参数
  },
  removeReasoning(_body) {
    // 无需移除
  },
}

/** 适配器映射表 */
const adapters: Record<string, ReasoningAdapter> = {
  deepseek: deepseekAdapter,
  openai: openaiAdapter,
  anthropic: anthropicAdapter,
  gemini: geminiAdapter,
  qwen: qwenAdapter,
  zhipu: glmAdapter,
  mimo: defaultAdapter,
  siliconflow: defaultAdapter,
  ollama: defaultAdapter,
  groq: defaultAdapter,
  openrouter: defaultAdapter,
  moonshot: defaultAdapter,
  'coding-plan': defaultAdapter,
  custom: defaultAdapter,
}

/**
 * 获取指定 Provider 的适配器
 */
export function getAdapter(provider: ProviderId): ReasoningAdapter {
  return adapters[provider] || defaultAdapter
}

/**
 * 判断模型是否支持推理
 */
export function supportsReasoning(provider: ProviderId, model: string): ReasoningSupport {
  const adapter = getAdapter(provider)
  return adapter.supportsReasoning(model)
}

/**
 * 将 reasoningMode 应用到请求体
 *
 * @returns 是否已添加参数；unknown 模型仅由可探测的适配器发起真实请求验证
 */
export function applyReasoningMode(
  provider: ProviderId,
  model: string,
  body: Record<string, unknown>,
  mode: 'off' | 'on'
): boolean {
  const support = supportsReasoning(provider, model)

  // false: 明确不支持，忽略
  if (support === false) return false

  const adapter = getAdapter(provider)
  if (support === 'unknown' && (mode !== 'on' || !adapter.probeWhenRequested)) return false

  // 已知支持，或用户显式开启后允许通过 400/422 响应安全探测
  adapter.applyReasoning(body, mode, model)
  return true
}

/**
 * 移除请求体中的推理参数（用于失败重试）
 */
export function removeReasoningParams(provider: ProviderId, body: Record<string, unknown>): void {
  const adapter = getAdapter(provider)
  adapter.removeReasoning(body)
}
