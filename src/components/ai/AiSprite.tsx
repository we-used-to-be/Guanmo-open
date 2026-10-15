import { useEffect, useState } from 'react'
import './ai-sprite.css'
import { useAssistantState } from '@/hooks/useAssistantState'
import { ASSISTANT_STATE_LABELS, type AssistantState } from '@/services/assistantState'

export type AssistantReaction = 'heart' | 'happy' | 'wink' | 'star' | 'shy'

interface AiSpriteProps {
  /** 覆盖展示状态（如历史消息头像固定 idle）；缺省时跟随全局 AI 助手状态 */
  state?: AssistantState
  /** 是否播放状态动作；历史消息头像应关闭动画 */
  animated?: boolean
  size?: number
  className?: string
  reaction?: AssistantReaction | null
}

/**
 * AI 状态小球：简约圆球与两枚眼睛，纯展示组件。
 * 所有动画由组件专属样式按 data-state 驱动。
 */
export function AiSprite({ state, animated = true, size = 32, className = '', reaction = null }: AiSpriteProps) {
  const liveState = useAssistantState()
  const current = state ?? liveState
  const [paused, setPaused] = useState(() => document.visibilityState === 'hidden')

  useEffect(() => {
    const handleVisibilityChange = () => {
      setPaused(document.visibilityState === 'hidden')
    }
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [])

  return (
    <span
      className={`gm-ai-sprite ${className}`.trim()}
      role="img"
      aria-label={ASSISTANT_STATE_LABELS[current]}
      data-state={current}
      data-reaction={reaction ?? undefined}
      data-animated={animated ? 'true' : 'false'}
      data-paused={paused ? 'true' : undefined}
      style={{ width: size, height: size }}
    >
      <svg width={size} height={size} viewBox="0 0 64 64" fill="none" aria-hidden="true">
        <defs>
          <radialGradient id="gmAiSpriteBodyFill" cx="30%" cy="24%" r="78%">
            <stop offset="0%" stopColor="var(--gm-sprite-body-highlight)" />
            <stop offset="44%" stopColor="var(--gm-sprite-body)" />
            <stop offset="100%" stopColor="var(--gm-sprite-body-shadow)" />
          </radialGradient>
        </defs>

        <g className="gm-ai-sprite__core">
          <circle className="gm-ai-sprite__body" cx="32" cy="32" r="23" fill="url(#gmAiSpriteBodyFill)" stroke="var(--gm-sprite-stroke)" strokeWidth="1.5" />

          <g className="gm-ai-sprite__face">
            <ellipse className="gm-ai-sprite__eye" cx="24.5" cy="31.5" rx="3.1" ry="4.3" fill="var(--gm-sprite-face)" />
            <ellipse className="gm-ai-sprite__eye" cx="39.5" cy="31.5" rx="3.1" ry="4.3" fill="var(--gm-sprite-face)" />
            {reaction && (
              <g className="gm-ai-sprite__expression" stroke="var(--gm-sprite-face)" strokeWidth="2.5" strokeLinecap="round">
                {reaction === 'heart' ? (
                  <g fill="var(--gm-sprite-affection)" stroke="none">
                    <path d="M24.5 35.5 19.5 30.5C16 26 22 23.5 24.5 27 27 23.5 33 26 29.5 30.5Z" />
                    <path d="M39.5 35.5 34.5 30.5C31 26 37 23.5 39.5 27 42 23.5 48 26 44.5 30.5Z" />
                  </g>
                ) : reaction === 'star' ? (
                  <g fill="var(--gm-sprite-sparkle)" stroke="none">
                    <path d="m24.5 25 1.8 4.7L31 31.5l-4.7 1.8-1.8 4.7-1.8-4.7-4.7-1.8 4.7-1.8Z" />
                    <path d="m39.5 25 1.8 4.7L46 31.5l-4.7 1.8-1.8 4.7-1.8-4.7-4.7-1.8 4.7-1.8Z" />
                  </g>
                ) : reaction === 'shy' ? (
                  <g stroke="none">
                    <ellipse cx="23" cy="33" rx="2.5" ry="3.3" fill="var(--gm-sprite-face)" />
                    <ellipse cx="38" cy="33" rx="2.5" ry="3.3" fill="var(--gm-sprite-face)" />
                    <g fill="var(--gm-sprite-affection)" opacity="0.55">
                      <ellipse cx="18" cy="38" rx="4" ry="2" />
                      <ellipse cx="45" cy="38" rx="4" ry="2" />
                    </g>
                  </g>
                ) : (
                  <>
                    {reaction === 'happy' && <path d="M20.5 32Q24.5 25.5 28.5 32" />}
                    <path d="M35.5 32Q39.5 25.5 43.5 32" />
                  </>
                )}
              </g>
            )}
          </g>
          {reaction && reaction !== 'shy' && (
            <g key={reaction} className="gm-ai-sprite__reaction-accent">
              {reaction === 'heart' ? (
                <path d="M49 18 44 13C40 8 46 5 49 9 52 5 58 8 54 13Z" fill="var(--gm-sprite-affection)" />
              ) : (
                <path d="m49 9 1.8 5.2L56 16l-5.2 1.8L49 23l-1.8-5.2L42 16l5.2-1.8Z" fill="var(--gm-sprite-sparkle)" />
              )}
            </g>
          )}
        </g>
      </svg>
    </span>
  )
}
