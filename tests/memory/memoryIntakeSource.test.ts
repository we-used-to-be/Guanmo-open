// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ select: vi.fn(), ready: vi.fn() }))
vi.mock('@/services/database/db', () => ({ isDatabaseReady: mocks.ready, getDatabase: () => ({ select: mocks.select }) }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('@/services/runtimeCapabilities', () => ({ isWebRuntime: () => false }))
vi.mock('@/services/externalHttp', () => ({ UnsupportedCapabilityError: class extends Error {} }))

import { fingerprintMemorySource } from '@/services/memory/memoryIntake'
import { readMemoryIntakeSource, splitMemoryInput } from '@/services/memory/memoryIntakeSource'

const source = (content: string, metadata: string | null = null) => ({
  id: 'u', session_id: 's', role: 'user', parent_id: null, content, metadata, created_at: 1700000000000,
})
async function identity(row: ReturnType<typeof source>) {
  return { sourceId: row.id, sessionId: row.session_id,
    sourceFingerprint: await fingerprintMemorySource(row.content, row.metadata, row.created_at) }
}
beforeEach(() => { vi.clearAllMocks(); mocks.ready.mockReturnValue(true) })

describe('v2 registered source reader', () => {
  it('keeps a normal message without value filtering and binds exact session and raw snapshot', async () => {
    const row = source('定第二个。')
    mocks.select.mockResolvedValue([row])
    const result = await readMemoryIntakeSource(await identity(row))
    expect(result).toEqual({ kind: 'ready', visibleText: row.content, snapshot: {
      id: 'u', sessionId: 's', role: 'user', parentId: null, content: row.content, metadata: null, createdAt: row.created_at,
    } })
    expect(mocks.select.mock.calls[0][1]).toEqual(['u', 's'])
  })

  it('invalidates a deleted source and changes to content, metadata, role, or time', async () => {
    const original = source('选第二个。')
    const originalIdentity = await identity(original)
    for (const row of [null, { ...original, content: '选第一个。' }, { ...original, metadata: '{}' },
      { ...original, role: 'assistant' }, { ...original, created_at: original.created_at + 1 }]) {
      mocks.select.mockResolvedValueOnce(row ? [row] : [])
      expect(await readMemoryIntakeSource(originalIdentity)).toEqual({ kind: 'invalidated' })
    }
  })

  it('does not return sensitive, refused, explicit, or quoted material as model input', async () => {
    for (const [text, reason] of [['密码是匿名口令', 'sensitive'], ['不要记住我的偏好', 'refusal'],
      ['记住：以后先给结论', 'explicit'], ['翻译：我喜欢早起', 'transformation']] as const) {
      const row = source(text)
      mocks.select.mockResolvedValueOnce([row])
      expect(await readMemoryIntakeSource(await identity(row))).toEqual({ kind: 'gap', reason })
    }
  })

  it('uses visible text for tagged messages and never falls back to raw attachments or malformed metadata', async () => {
    const raw = '【上下文】匿名附件内容', visible = '这段讲了什么？'
    const withView = source(raw, JSON.stringify({ tags: [{ id: 'tag' }], displayContent: visible }))
    mocks.select.mockResolvedValueOnce([withView])
    const result = await readMemoryIntakeSource(await identity(withView))
    expect(result.kind).toBe('ready')
    if (result.kind === 'ready') expect(result.visibleText).toBe(visible)
    for (const metadata of [JSON.stringify({ tags: [{ id: 'tag' }] }), '{invalid', JSON.stringify({ displayContent: 1 })]) {
      const row = source(raw, metadata)
      mocks.select.mockResolvedValueOnce([row])
      expect(await readMemoryIntakeSource(await identity(row))).toEqual({ kind: 'gap', reason: 'missing_visible_text' })
    }
  })

  it('splits long inputs losslessly without cutting Unicode characters, and bounds excessive input', async () => {
    const row = source('普通内容'.repeat(2000))
    mocks.select.mockResolvedValueOnce([row])
    const result = await readMemoryIntakeSource(await identity(row))
    expect(result.kind).toBe('segmented')
    if (result.kind === 'segmented') {
      expect(result.segments.join('')).toBe(row.content)
      expect(result.segments.every(segment => new TextEncoder().encode(segment).length <= 3000)).toBe(true)
    }
    const emoji = '😀'.repeat(4000)
    expect(splitMemoryInput(emoji)?.join('')).toBe(emoji)
    const escaped = '\u0000"\\'.repeat(2000), parts = splitMemoryInput(escaped)
    expect(parts?.join('')).toBe(escaped)
    expect(parts?.every(segment => new TextEncoder().encode(JSON.stringify(segment)).length - 2 <= 3000)).toBe(true)
    expect(splitMemoryInput('x'.repeat(384001))).toBeNull()
    mocks.ready.mockReturnValueOnce(false)
    expect(await readMemoryIntakeSource(await identity(row))).toEqual({ kind: 'blocked' })
  })
})
