import { render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AiPanel } from '@/components/ai/AiPanel'
import { resolveAiAvatarStyle } from '@/stores/settingsStore'

const aiChat = vi.hoisted(() => ({
  messages: [
    { id: 'user-1', role: 'user' as const, content: '匿名问题', timestamp: 1 },
    { id: 'assistant-1', parentId: 'user-1', role: 'assistant' as const, content: '匿名回答', timestamp: 2 },
  ],
  streaming: false,
  error: null,
  timeline: [],
  sendMessage: vi.fn(),
  cancelStream: vi.fn(),
}))

const readingArtifacts = vi.hoisted(() => ({
  artifacts: [],
  loading: false,
  filter: 'all' as 'all' | 'summary' | 'question_set' | 'annotation' | 'note',
  query: '',
  page: 1,
  pageSize: 20,
  total: 0,
  selectedId: null,
  anchorStatuses: {},
  loadArtifacts: vi.fn(),
  setFilter: vi.fn(),
  setQuery: vi.fn(),
  setPage: vi.fn(),
  setSelected: vi.fn(),
  deleteArtifact: vi.fn(),
  saveArtifactFromMessage: vi.fn(),
  checkAnchor: vi.fn(),
  resetAnchorStatus: vi.fn(),
}))

vi.mock('@/hooks/useAiChat', () => ({
  useAiChat: () => aiChat,
}))

vi.mock('@/stores/readingArtifactsStore', () => ({
  useReadingArtifactsStore: (selector: (state: typeof readingArtifacts) => unknown) => selector(readingArtifacts),
}))

describe('AI 头像统一使用小球（AiAvatar）', () => {
  const scrollTo = vi.fn()

  beforeEach(() => {
    scrollTo.mockReset()
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
      configurable: true,
      value: scrollTo,
    })
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0)
      return 1
    })
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    delete (HTMLElement.prototype as { scrollTo?: unknown }).scrollTo
  })

  it('统一渲染小球，不再渲染旧图标或吉祥物', () => {
    render(<AiPanel />)
    const sprites = document.querySelectorAll<HTMLElement>('.gm-ai-sprite')
    expect(sprites.length).toBeGreaterThan(0)
    expect(document.querySelectorAll('.gm-ai-avatar--sprite').length).toBeGreaterThan(0)
    expect(document.querySelector('.gm-ai-chat-icon')).toBeNull()
    expect(document.querySelector('.gm-ai-mascot-image')).toBeNull()
    expect(sprites[0]?.style.width).toBe('44px')
    for (const sprite of sprites) {
      // aiChat.streaming === false，所有消息头像均为静态 idle
      expect(sprite.getAttribute('data-state')).toBe('idle')
    }
  })

  it('只让当前流式消息的小球播放动态，历史消息保持静态', () => {
    const originalMessages = aiChat.messages
    const originalStreaming = aiChat.streaming
    aiChat.messages = [
      { id: 'user-1', role: 'user' as const, content: '第一个问题', timestamp: 1 },
      { id: 'assistant-1', parentId: 'user-1', role: 'assistant' as const, content: '历史回答', timestamp: 2 },
      { id: 'user-2', role: 'user' as const, content: '第二个问题', timestamp: 3 },
      { id: 'assistant-2', parentId: 'user-2', role: 'assistant' as const, content: '最新回答', timestamp: 4 },
    ]
    aiChat.streaming = true

    try {
      render(<AiPanel />)
      const sprites = Array.from(document.querySelectorAll<HTMLElement>('.gm-ai-sprite'))
      expect(sprites.map((sprite) => sprite.getAttribute('data-animated'))).toEqual(['false', 'true'])
    } finally {
      aiChat.messages = originalMessages
      aiChat.streaming = originalStreaming
    }
  })

})

describe('旧头像配置迁移（resolveAiAvatarStyle）', () => {
  const current = {
    appearance: {
      customCursorEnabled: false,
      aiAvatarStyle: 'sprite',
      themeId: 'warm',
      lastLightThemeId: 'warm',
    },
  } as const

  it('旧 aiAvatarStyle=icon 迁移为 sprite', () => {
    expect(resolveAiAvatarStyle({ aiAvatarStyle: 'icon' }, current)).toBe('sprite')
  })

  it('旧 aiAvatarStyle=mascot 迁移为 sprite', () => {
    expect(resolveAiAvatarStyle({ aiAvatarStyle: 'mascot' }, current)).toBe('sprite')
  })

  it('旧 aiMascotAvatarEnabled=true 迁移为 sprite', () => {
    expect(resolveAiAvatarStyle({ aiMascotAvatarEnabled: true }, current)).toBe('sprite')
  })

  it('旧 aiMascotAvatarEnabled=false 迁移为 sprite', () => {
    expect(resolveAiAvatarStyle({ aiMascotAvatarEnabled: false }, current)).toBe('sprite')
  })

  it('新枚举字段优先于旧布尔值', () => {
    expect(
      resolveAiAvatarStyle({ aiAvatarStyle: 'sprite', aiMascotAvatarEnabled: true }, current),
    ).toBe('sprite')
  })

  it('非法枚举值、缺失字段和旧布尔值均回落为 sprite', () => {
    expect(resolveAiAvatarStyle({ aiAvatarStyle: 'bogus', aiMascotAvatarEnabled: true }, current)).toBe('sprite')
    expect(resolveAiAvatarStyle({}, current)).toBe('sprite')
  })
})
