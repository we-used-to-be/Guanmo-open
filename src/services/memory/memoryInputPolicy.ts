import { containsForbiddenMemorySecret, containsSensitiveMemoryText, isExplicitMemoryWriteIntent } from './memoryPolicy'

const transformation = /^(?:请|帮我|麻烦|能否)?(?:翻译|改写|润色|重写|总结|概括|解释|分析|生成|编写|仿写|创作|虚构|假设|举例)|^(?:引用|原文|文章|文档|书中|摘录|示例|小说|角色)(?:里|中|写|说|提到|内容|记录|[：:\s])|^[“「"]/
const refusal = /(?:不要|别|无需|不必|不用|禁止).{0,8}(?:记住|记下|记忆|保存)/

export function isVisibleSelectionQuestion(text: string, metadata: string | null): boolean {
  if (!metadata) return false
  try {
    const value = JSON.parse(metadata)
    return value && typeof value === 'object' && !Array.isArray(value)
      && value.displayContent === text && Array.isArray(value.tags)
      && value.tags.some((tag: unknown) => tag && typeof tag === 'object' && (tag as { type?: unknown }).type === 'selection')
  } catch { return false }
}

export function classifyGlobalMemoryInputGap(text: string, selectionQuestion = false): 'sensitive' | 'refusal' | 'explicit' | 'transformation' | null {
  if (containsForbiddenMemorySecret(text)) return 'sensitive'
  if (refusal.test(text)) return 'refusal'
  if (isExplicitMemoryWriteIntent(text)) return 'explicit'
  if (!selectionQuestion && transformation.test(text.trim())) return 'transformation'
  return null
}

export function classifyMemoryInputGap(text: string): 'sensitive' | 'refusal' | 'explicit' | 'transformation' | null {
  if (containsSensitiveMemoryText(text)) return 'sensitive'
  if (refusal.test(text)) return 'refusal'
  if (isExplicitMemoryWriteIntent(text)) return 'explicit'
  if (transformation.test(text.trim())) return 'transformation'
  return null
}
