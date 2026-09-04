import { describe, expect, it } from 'vitest'
import {
  assistantVisualRegistry,
  resolveAssistantVisualDefinition,
} from '@/services/appearance/assistantRegistry'
import { resolveAppearanceConfig } from '@/services/appearance/appearanceSchema'
import type { AssistantState } from '@/services/assistantState'

const ALL_STATES: AssistantState[] = [
  'idle',
  'reading',
  'retrieving',
  'searching',
  'thinking',
  'generating',
  'success',
  'error',
]

describe('Assistant Visual Registry', () => {
  it('为八个 AssistantState 提供安全的内置 descriptor', () => {
    const visual = assistantVisualRegistry.getVisual('sprite')

    expect(visual).toMatchObject({
      id: 'sprite',
      renderer: 'sprite',
      staticFallback: 'sprite',
      animationPolicy: {
        pausesWhenHidden: true,
        respectsReducedMotion: true,
        history: 'static',
      },
    })
    expect(Object.keys(visual.stateAssets)).toEqual(ALL_STATES)
  })

  it('未知或损坏的 visual ID 回退为内置 sprite', () => {
    expect(resolveAssistantVisualDefinition('missing').id).toBe('sprite')
    expect(resolveAssistantVisualDefinition({ renderer: 'user-code' }).renderer).toBe('sprite')
    expect(resolveAppearanceConfig({ assistantVisualId: 'user-code' }).assistantVisualId).toBe('sprite')
  })
})
