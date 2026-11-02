// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ lease: vi.fn() }))
vi.mock('@/services/memory/memoryWindowLedger', () => ({ isMemoryWindowLeaseCurrent: mocks.lease }))
vi.mock('@/services/database/db', () => ({ isDatabaseReady: () => true, getDatabase: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('@/services/runtimeCapabilities', () => ({ isWebRuntime: () => false }))
vi.mock('@/services/externalHttp', () => ({ UnsupportedCapabilityError: class extends Error {} }))
import { createMemoryWindowRequest, requestMemoryWindowProposals, verifyMemoryWindowProposals } from '@/services/memory/memoryWindowModel'
import { parseMemoryWindowCandidates } from '@/services/memory/memoryWindowCandidates'
import type { MemoryWindowPacket } from '@/services/memory/memoryWindowInput'
import type { MemoryWindowClaim } from '@/services/memory/memoryWindowLedger'
import type { Memory } from '@/services/database/persistence'

const record = { version: 2, sessionId: 's', scopeKey: 'private-workspace-path', epoch: 0, windowId: 'window', status: 'running',
  owner: 'worker', leaseUntil: Date.now() + 60_000, nextAttemptAt: 0, attempts: 1, createdAt: Date.now(),
  sourceIds: ['u1'], receiptValues: ['{}'], prefixIds: [], prefixReceiptValues: [] }
const claim = { key: 'window', value: JSON.stringify(record), record } as unknown as MemoryWindowClaim
const packet = (): MemoryWindowPacket => ({ turns: [{ id: 'u1', role: 'user', contextOnly: false, text: '我喜欢技术回答先给结论。' }],
  newSourceIds: ['u1'], segmentedSourceIds: [], needsModel: true, estimatedInputTokens: 100,
  snapshots: [{ id: 'u1', sessionId: 's', role: 'user', parentId: null, content: '【上下文】不应外发的附件', metadata: null, createdAt: 1 }] })
const memory = (changes: Partial<Memory> = {}): Memory => ({ id: 'm', content: '技术回答先给结论', category: 'preference',
  source: 'auto_extracted', locked: false, status: 'active', scopeType: 'project', scopeKey: 'private-workspace-path',
  createdAt: 1, updatedAt: 1, ...changes })
const response = JSON.stringify([{ content: '技术回答优先给出结论', category: 'preference', kind: 'semantic', scope: 'global',
  primarySourceId: 'u1', supportingSourceIds: [], subject: 'user', factKey: 'answer_order', factValue: '结论', confidence: 0.9 }])

beforeEach(() => { vi.clearAllMocks(); mocks.lease.mockResolvedValue(true) })

describe('bounded memory model proposals', () => {
  it.each(['password=ExampleCredential123', 'secret: ExampleCredential123', 'token:ExampleCredential123', 'token = ExampleCredential123'])('blocks credential markers in both user and assistant turns before any model call: %s', async secret => {
    const chat = vi.fn(async () => ({ content: '[]' }))
    for (const role of ['user', 'assistant'] as const) {
      const input = packet()
      input.policyVersion = 3
      if (role === 'user') input.turns[0].text = secret
      else input.turns.push({ id: 'a1', role, parentId: 'u1', contextOnly: false, text: secret })
      await expect(requestMemoryWindowProposals(claim, input, [], { chat }, { foregroundBusy: () => false }))
        .rejects.toThrow('unsafe_memory_window_turn')
    }
    expect(chat).not.toHaveBeenCalled()
  })

  it('excludes legacy automatic memories with hard secrets from the request catalogue', () => {
    const input = packet()
    input.policyVersion = 3
    const built = createMemoryWindowRequest(input, null, [memory({ scopeType: 'global', scopeKey: null,
      content: '用户邮箱是 anon@example.invalid', factValue: 'anon@example.invalid' })])
    expect(built.kind).toBe('ready')
    expect(JSON.stringify(built)).not.toContain('anon@example.invalid')
  })
  it('sends only safe turn fields and eligible catalog entries, without raw snapshots or workspace paths', () => {
    const input = packet()
    Object.assign(input.turns[0], { extra: '不应外发的字段' })
    const built = createMemoryWindowRequest(input, 'private-workspace-path', [memory(), memory({ id: 'manual', source: 'manual' }),
      memory({ id: 'sensitive', content: '密码是匿名口令' }), memory({ id: 'other', scopeKey: 'another-path' })])
    expect(built.kind).toBe('ready')
    if (built.kind !== 'ready') return
    const text = JSON.stringify(built.request)
    expect(text).not.toContain('不应外发的附件')
    expect(text).not.toContain('不应外发的字段')
    expect(text).not.toContain('private-workspace-path')
    expect(text).not.toContain('匿名口令')
    expect(text).not.toContain('another-path')
    expect(text).not.toContain('manual')
    expect(built.estimatedInputTokens).toBeLessThanOrEqual(6000)
    expect(built.request).toMatchObject({ maxTokens: 800, temperature: 0.1, reasoningMode: 'off' })
  })

  it('performs one bounded model call, validates proposals and exposes only numeric usage', async () => {
    const chat = vi.fn(async () => ({ content: response, usage: { promptTokens: 123, completionTokens: 45, secret: 'hidden' } }))
    const result = await requestMemoryWindowProposals(claim, packet(), [], { chat }, { foregroundBusy: () => false })
    expect(chat).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({ kind: 'proposals', candidates: [{ requiresSemanticReview: true }], rejected: 0,
      usage: { promptTokens: 123, completionTokens: 45 } })
    expect(JSON.stringify(result)).not.toContain('hidden')
  })

  it('does not call the model for NOOP, foreground activity, or invalid input', async () => {
    const chat = vi.fn(async () => ({ content: '[]' }))
    expect(await requestMemoryWindowProposals(claim, { ...packet(), needsModel: false }, [], { chat }, { foregroundBusy: () => false })).toEqual({ kind: 'noop' })
    expect(await requestMemoryWindowProposals(claim, packet(), [], { chat }, { foregroundBusy: () => true })).toEqual({ kind: 'deferred' })
    const unsafe = packet(); unsafe.turns[0].text = '密码是匿名口令'
    await expect(requestMemoryWindowProposals(claim, unsafe, [], { chat }, { foregroundBusy: () => false })).rejects.toThrow('unsafe_memory_window_turn')
    expect(chat).not.toHaveBeenCalled()
  })

  it('discards a late response after cancellation or loss of lease', async () => {
    let release: ((value: { content: string }) => void) | undefined
    const chat = vi.fn(() => new Promise<{ content: string }>(resolve => { release = resolve }))
    const controller = new AbortController()
    const task = requestMemoryWindowProposals(claim, packet(), [], { chat }, { foregroundBusy: () => false, signal: controller.signal })
    await vi.waitFor(() => expect(chat).toHaveBeenCalledTimes(1))
    controller.abort()
    await expect(task).resolves.toEqual({ kind: 'deferred' })
    release?.({ content: response })
    mocks.lease.mockReset().mockResolvedValueOnce(true).mockResolvedValueOnce(false)
    expect(await requestMemoryWindowProposals(claim, packet(), [], { chat: async () => ({ content: response }) }, { foregroundBusy: () => false }))
      .toEqual({ kind: 'lost_lease' })
  })

  it('stops waiting for a non-cooperative provider on timeout', async () => {
    const chat = vi.fn(() => new Promise<{ content: string }>(() => {}))
    await expect(requestMemoryWindowProposals(claim, packet(), [], { chat }, { foregroundBusy: () => false, timeoutMs: 10 }))
      .resolves.toEqual({ kind: 'retry' })
    expect(chat).toHaveBeenCalledTimes(1)
  })

  it('checks every proposal with a separate bounded model request without claiming independent proof', async () => {
    const candidates = parseMemoryWindowCandidates(response, packet(), record.scopeKey).candidates
    const chat = vi.fn(async () => ({ content: '[{"index":0,"supported":true}]', usage: { promptTokens: 55, completionTokens: 7 } }))
    const result = await verifyMemoryWindowProposals(claim, packet(), candidates, { chat }, { foregroundBusy: () => false })
    expect(result).toMatchObject({ kind: 'verified', verdicts: [{ supported: true, candidate: { requiresSemanticReview: true } }],
      usage: { promptTokens: 55, completionTokens: 7 } })
    const sent = JSON.stringify(chat.mock.calls)
    expect(sent).not.toContain('不应外发的附件')
    expect(sent).not.toContain('private-workspace-path')
    expect(chat).toHaveBeenCalledTimes(1)
  })

  it('does not accept missing or duplicate verifier verdicts', async () => {
    const candidates = parseMemoryWindowCandidates(response, packet(), record.scopeKey).candidates
    const chat = vi.fn(async () => ({ content: '[]' }))
    expect(await verifyMemoryWindowProposals(claim, packet(), candidates, { chat }, { foregroundBusy: () => false })).toEqual({ kind: 'retry' })
    expect(await verifyMemoryWindowProposals(claim, packet(), [], { chat }, { foregroundBusy: () => false })).toEqual({ kind: 'noop' })
    expect(chat).toHaveBeenCalledTimes(1)
  })
})
