// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), ready: vi.fn(), web: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))
vi.mock('@/services/database/db', () => ({ isDatabaseReady: mocks.ready }))
vi.mock('@/services/runtimeCapabilities', () => ({ isWebRuntime: mocks.web }))
vi.mock('@/services/externalHttp', () => ({ UnsupportedCapabilityError: class extends Error {} }))
import { decodeMemoryEvidence } from '@/services/memory/memoryEvidence'
import { prepareMemoryWindowWrite, persistMemoryWindowCandidate } from '@/services/memory/memoryWindowPersistence'
import type { Memory } from '@/services/database/persistence'
import type { MemoryWindowCandidate } from '@/services/memory/memoryWindowCandidates'
import type { MemoryWindowPacket } from '@/services/memory/memoryWindowInput'
import type { MemoryWindowClaim } from '@/services/memory/memoryWindowLedger'

const locked = { sessionId: 's', scopeKey: 'p', epoch: 0, sourceIds: ['u1', 'u2'], prefixIds: [], windowId: 'window:1' }
const claim = { key: 'window', value: JSON.stringify(locked), record: locked } as unknown as MemoryWindowClaim
const lockedV3 = { version: 3, sessionId: 's', scopeKey: null, epoch: 0, sourceIds: ['u1'], receiptValues: ['{}'],
  prefixIds: ['u0'], prefixReceiptValues: ['{}'], windowId: 'window:1' }
const claimV3 = { key: 'window', value: JSON.stringify(lockedV3), record: lockedV3 } as unknown as MemoryWindowClaim
const singlePacket = (): MemoryWindowPacket => ({ turns: [{ id: 'u1', role: 'user', contextOnly: false, text: '我喜欢技术回答先给结论' }],
  snapshots: [{ id: 'u1', sessionId: 's', role: 'user', parentId: null, content: '我喜欢技术回答先给结论', metadata: null, createdAt: 1700000000000 }],
  newSourceIds: ['u1'], segmentedSourceIds: [], needsModel: true, estimatedInputTokens: 100 })
const packetV3 = (text = '我喜欢技术回答先给结论'): MemoryWindowPacket => ({ policyVersion: 3,
  turns: [{ id: 'u1', role: 'user', contextOnly: false, text }],
  snapshots: [{ id: 'u1', sessionId: 's', role: 'user', parentId: null, content: text, metadata: null, createdAt: 1700000000000 }],
  newSourceIds: ['u1'], segmentedSourceIds: [], needsModel: true, estimatedInputTokens: 100 })
const singleCandidate = (): MemoryWindowCandidate => ({ content: '技术回答先给结论', category: 'preference', kind: 'semantic', scope: 'global',
  primarySourceId: 'u1', supportingSourceIds: [], subject: 'user', factKey: 'answer_order', factValue: '结论', confidence: 0.95,
  segmented: false, requiresSemanticReview: true })
const candidateV3 = (changes: Partial<MemoryWindowCandidate> = {}): MemoryWindowCandidate => ({ ...singleCandidate(),
  sensitivity: 'normal', ...changes })
const existing = (): Memory => ({ id: 'manual', content: '技术回答先给推导', category: 'preference', source: 'manual_created', locked: true,
  status: 'active', scopeType: 'global', scopeKey: null, subject: 'user', factKey: 'answer_order', factValue: '推导',
  createdAt: 1000, updatedAt: 2000 })

beforeEach(() => { vi.clearAllMocks(); mocks.ready.mockReturnValue(true); mocks.web.mockReturnValue(false) })

describe('v2 atomic memory write bridge', () => {
  it('uses stable fact/source identity even if the model paraphrases content', async () => {
    const a = await prepareMemoryWindowWrite(claim, singlePacket(), { candidate: singleCandidate(), supported: true }, [], 1700000000100)
    const b = await prepareMemoryWindowWrite(claim, singlePacket(), { candidate: { ...singleCandidate(), content: '技术回答优先给出结论' }, supported: true }, [], 1700000000200)
    expect(a.operationId).toBe(b.operationId)
    expect(a.memory.id).toBe('mem-v2-' + a.operationId)
    expect(a.memory.status).toBe('active')
    expect(decodeMemoryEvidence(a.memory.evidence)).toMatchObject({ version: 2, sourceId: 'u1' })
    expect(a.source.lease).toEqual({ key: claim.key, value: claim.value })
  })

  it('preserves a manual active record and prepares a replacement candidate with a version snapshot', async () => {
    const old = existing()
    const request = await prepareMemoryWindowWrite(claim, singlePacket(), { candidate: singleCandidate(), supported: true }, [old])
    expect(request).not.toBeNull()
    expect(request!.memory).toMatchObject({ status: 'candidate', supersedesId: 'manual' })
    expect(decodeMemoryEvidence(request!.memory.evidence)).toMatchObject({ replacement: { id: 'manual', updatedAt: 2000 } })
    expect(old).toMatchObject({ status: 'active', locked: true, content: '技术回答先给推导' })
  })

  it('keeps multi-source and segmented proposals as candidates', async () => {
    const packet = singlePacket()
    packet.turns.push({ id: 'a1', role: 'assistant', parentId: 'u1', contextOnly: false, text: '可以先给结论。' },
      { id: 'u2', role: 'user', contextOnly: false, text: '我就选这个。' })
    packet.snapshots.push({ id: 'a1', sessionId: 's', role: 'assistant', parentId: 'u1', content: '可以先给结论。', metadata: null, createdAt: 1700000000001 },
      { id: 'u2', sessionId: 's', role: 'user', parentId: null, content: '我就选这个。', metadata: null, createdAt: 1700000000002 })
    packet.newSourceIds.push('u2')
    const candidate = { ...singleCandidate(), primarySourceId: 'u2', supportingSourceIds: ['u1', 'a1'] }
    const result = await prepareMemoryWindowWrite(claim, packet, { candidate, supported: true }, [])
    expect(result).not.toBeNull()
    expect(result!.memory.status).toBe('candidate')
    expect(result!.source.snapshots.map(item => item.id)).toEqual(['u1', 'a1', 'u2'])
    const segmented = singlePacket(); segmented.segmentedSourceIds = ['u1']
    segmented.turns[0].segment = { index: 0, total: 2, continuationBefore: false, continuationAfter: true }
    const segmentedResult = await prepareMemoryWindowWrite(claim, segmented, { candidate: singleCandidate(), supported: true }, [])
    expect(segmentedResult?.memory.status).toBe('candidate')
  })

  it('fails closed on unvalidated verdicts, unsupported runtimes and unknown command responses', async () => {
    await expect(prepareMemoryWindowWrite(claim, singlePacket(), { candidate: singleCandidate(), supported: false } as never, []))
      .rejects.toThrow('invalid_memory_window_write')
    const request = await prepareMemoryWindowWrite(claim, singlePacket(), { candidate: singleCandidate(), supported: true }, [])
    mocks.web.mockReturnValueOnce(true)
    await expect(persistMemoryWindowCandidate(request)).rejects.toThrow()
    mocks.ready.mockReturnValueOnce(false)
    await expect(persistMemoryWindowCandidate(request)).rejects.toThrow('memory_window_database_not_ready')
    mocks.invoke.mockResolvedValueOnce('unexpected')
    await expect(persistMemoryWindowCandidate(request)).rejects.toThrow('invalid_memory_window_write_result')
    mocks.invoke.mockResolvedValueOnce('inserted')
    await expect(persistMemoryWindowCandidate(request)).resolves.toBe('inserted')
  })

  it('writes normal v3 facts active, sensitive and conflicting facts as candidates', async () => {
    const normal = await prepareMemoryWindowWrite(claimV3, packetV3(), { candidate: candidateV3(), supported: true }, [], 1700000000100)
    expect(normal).not.toBeNull()
    expect(normal!.memory).toMatchObject({ id: 'mem-v3-' + normal!.operationId, status: 'active', scopeType: 'global', scopeKey: null })
    expect(decodeMemoryEvidence(normal!.memory.evidence)).toMatchObject({ version: 3, policyVersion: 3, sensitivity: 'normal' })

    const health = await prepareMemoryWindowWrite(claimV3, packetV3('我长期有高血压，希望饮食清淡'), { candidate: candidateV3({
      content: '用户长期有高血压', category: 'profile', factKey: 'health', factValue: '高血压', sensitivity: 'sensitive',
    }), supported: true }, [], 1700000000100)
    expect(health!.memory.status).toBe('candidate')
    expect(decodeMemoryEvidence(health!.memory.evidence)).toMatchObject({ version: 3, sensitivity: 'sensitive' })

    const conflict = await prepareMemoryWindowWrite(claimV3, packetV3(), { candidate: candidateV3(), supported: true }, [existing()])
    expect(conflict?.memory).toMatchObject({ status: 'candidate', supersedesId: null })
    expect(decodeMemoryEvidence(conflict?.memory.evidence)).toMatchObject({ version: 3, reviewReason: 'semantic',
      conflicts: [{ id: 'manual', updatedAt: 2000 }] })
  })

  it('admits a directly stated v3 identity without a personal-fact keyword allowlist', async () => {
    const candidate = candidateV3({ content: '用户是自由摄影师', category: 'profile', factKey: 'occupation', factValue: '自由摄影师' })
    const direct = await prepareMemoryWindowWrite(claimV3, packetV3('我是自由摄影师。'), { candidate, supported: true }, [])
    expect(direct?.memory.status).toBe('active')
    const question = await prepareMemoryWindowWrite(claimV3, packetV3('我是自由摄影师，你知道吗？'), { candidate, supported: true }, [])
    expect(question?.memory.status).toBe('active')
  })

  it('activates a model paraphrase when the source and format are valid', async () => {
    const text = '我的职业是独立开发者，我长期从事软件开发。'
    const paraphrase = candidateV3({ content: '用户是独立开发者，长期从事软件开发', category: 'profile', factKey: 'occupation',
      factValue: '独立开发者，长期从事软件开发', evidenceQuote: '我的职业是独立开发者，我长期从事软件开发' })
    const request = await prepareMemoryWindowWrite(claimV3, packetV3(text), { candidate: paraphrase, supported: true }, [])
    expect(request?.memory.status).toBe('active')
    expect(decodeMemoryEvidence(request?.memory.evidence)).toMatchObject({ version: 3 })
  })

  it('does not use local keyword heuristics to override the model interpretation', async () => {
    const candidate = candidateV3({ content: '用户是自由摄影师', category: 'profile', factKey: 'occupation', factValue: '自由摄影师' })
    for (const text of ['我如果是自由摄影师。', '这次我是自由摄影师。', '我有个朋友是自由摄影师。', '我姐姐是自由摄影师。', '我是自由摄影师吗？']) {
      expect((await prepareMemoryWindowWrite(claimV3, packetV3(text), { candidate, supported: true }, []))?.memory.status).toBe('active')
    }
  })

  it('promotes an explicitly accepted multi-turn fact and dispatches v3 to its dedicated Rust command', async () => {
    const packet = packetV3('好，就用 Rust')
    packet.turns.unshift({ id: 'u0', role: 'user', contextOnly: true, text: '我在选择学习语言。' },
      { id: 'a0', role: 'assistant', parentId: 'u0', contextOnly: true, text: '我建议 Rust。' })
    packet.snapshots.unshift(
      { id: 'u0', sessionId: 's', role: 'user', parentId: null, content: '我在选择学习语言。', metadata: null, createdAt: 1699999999000 },
      { id: 'a0', sessionId: 's', role: 'assistant', parentId: 'u0', content: '我建议 Rust。', metadata: null, createdAt: 1699999999500 },
    )
    const accepted = candidateV3({ content: '用户选择 Rust 学习', category: 'learning', primarySourceId: 'u1',
      supportingSourceIds: ['u0', 'a0'], factKey: 'learning_language', factValue: 'Rust' })
    const request = await prepareMemoryWindowWrite(claimV3, packet, { candidate: accepted, supported: true }, [], 1700000000100)
    expect(request?.memory.status).toBe('active')
    mocks.invoke.mockResolvedValueOnce('inserted')
    await expect(persistMemoryWindowCandidate(request!)).resolves.toBe('inserted')
    expect(mocks.invoke).toHaveBeenCalledWith('persist_memory_v3_transaction', { request })
  })
})
