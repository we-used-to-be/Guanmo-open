import type { AssistantState } from '@/services/assistantState'
import {
  DEFAULT_APPEARANCE_CONFIG_V1,
  isAssistantVisualId,
  type AssistantVisualId,
} from './appearanceSchema'

export type AssistantVisualRenderer = 'sprite'

export interface AssistantStateAsset {
  readonly kind: 'inline-css'
  readonly state: AssistantState
}
export interface AssistantAnimationPolicy {
  readonly pausesWhenHidden: boolean
  readonly respectsReducedMotion: boolean
  readonly history: 'static'
}

export interface AssistantVisualDefinition {
  readonly id: AssistantVisualId
  readonly label: string
  readonly renderer: AssistantVisualRenderer
  readonly stateAssets: Readonly<Record<AssistantState, AssistantStateAsset>>
  readonly animationPolicy: AssistantAnimationPolicy
  readonly staticFallback: AssistantVisualId
}

const ASSISTANT_STATES: readonly AssistantState[] = [
  'idle',
  'reading',
  'retrieving',
  'searching',
  'thinking',
  'generating',
  'success',
  'error',
]

function createInlineStateAssets(): Readonly<Record<AssistantState, AssistantStateAsset>> {
  return Object.fromEntries(
    ASSISTANT_STATES.map((state) => [state, { kind: 'inline-css', state }]),
  ) as Record<AssistantState, AssistantStateAsset>
}

const BUILT_IN_ASSISTANT_VISUALS: readonly AssistantVisualDefinition[] = [
  {
    id: 'sprite',
    label: '简约小球',
    renderer: 'sprite',
    stateAssets: createInlineStateAssets(),
    animationPolicy: {
      pausesWhenHidden: true,
      respectsReducedMotion: true,
      history: 'static',
    },
    staticFallback: 'sprite',
  },
]

const visualsById = new Map(
  BUILT_IN_ASSISTANT_VISUALS.map((visual) => [visual.id, visual]),
)

export interface AssistantVisualRegistry {
  readonly builtInVisuals: readonly AssistantVisualDefinition[]
  getVisual: (visualId: unknown) => AssistantVisualDefinition
}

export const assistantVisualRegistry: AssistantVisualRegistry = {
  builtInVisuals: BUILT_IN_ASSISTANT_VISUALS,
  getVisual: (visualId) => visualsById.get(visualId as AssistantVisualId) ?? BUILT_IN_ASSISTANT_VISUALS[0],
}

export function resolveAssistantVisualDefinition(visualId: unknown): AssistantVisualDefinition {
  const resolvedId = isAssistantVisualId(visualId)
    ? visualId
    : DEFAULT_APPEARANCE_CONFIG_V1.assistantVisualId
  return assistantVisualRegistry.getVisual(resolvedId)
}
