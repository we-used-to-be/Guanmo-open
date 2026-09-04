import type { ComponentType } from 'react'
import { AiSprite } from '@/components/ai/AiSprite'
import {
  resolveAssistantVisualDefinition,
  type AssistantVisualRenderer,
} from '@/services/appearance/assistantRegistry'
import type { AssistantVisualId } from '@/services/appearance/appearanceSchema'
import type { AssistantState } from '@/services/assistantState'

export interface AssistantVisualProps {
  visualId?: AssistantVisualId | string | null
  state?: AssistantState
  animated?: boolean
  size?: number
  className?: string
}
type BuiltInRendererProps = Omit<AssistantVisualProps, 'visualId'>

const BUILT_IN_RENDERERS: Record<AssistantVisualRenderer, ComponentType<BuiltInRendererProps>> = {
  sprite: AiSprite,
}

/** 只允许从固定 renderer map 选择，避免设置数据变成任意组件或脚本入口。 */
export function AssistantVisual({ visualId, className, ...props }: AssistantVisualProps) {
  const definition = resolveAssistantVisualDefinition(visualId)
  const Renderer = BUILT_IN_RENDERERS[definition.renderer]
    ?? BUILT_IN_RENDERERS[definition.staticFallback]

  return (
    <Renderer
      {...props}
      className={[`gm-ai-visual--${definition.id}`, className].filter(Boolean).join(' ')}
    />
  )
}
