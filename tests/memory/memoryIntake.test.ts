// @vitest-environment node
import { createHash } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), ready: vi.fn(), web: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))
vi.mock('@/services/database/db', () => ({ isDatabaseReady: mocks.ready }))
vi.mock('@/services/runtimeCapabilities', () => ({ isWebRuntime: mocks.web }))
vi.mock('@/services/externalHttp', () => ({ UnsupportedCapabilityError: class extends Error {} }))

import { fingerprintMemorySource, persistGlobalMemoryMessage, persistMemoryIntake } from '@/services/memory/memoryIntake'

beforeEach(() => { vi.clearAllMocks(); mocks.ready.mockReturnValue(true); mocks.web.mockReturnValue(false) })

describe('memory intake transaction bridge', () => {
  it('persists accepted chat messages as global v3 user sources', async () => {
    mocks.invoke.mockResolvedValueOnce(true)
    const session = { id: 's', title: '匿名会话' }
    const message = { id: 'u', sessionId: 's', content: '匿名消息', createdAt: 1700000000000 }
    await expect(persistGlobalMemoryMessage(session, message)).resolves.toBe(true)
    expect(mocks.invoke).toHaveBeenCalledWith('persist_chat_message_with_memory_intake', {
      request: { session, message: { ...message, role: 'user', metadata: null }, policyVersion: 3 },
    })
  })

  it('binds a deterministic fingerprint to the original message and captured scope', async () => {
    const message = { id: 'u', sessionId: 's', content: '匿名内容😀', metadata: '{"displayContent":"匿名"}', createdAt: 1700000000000 }
    const fingerprint = createHash('sha256').update(JSON.stringify([message.content, message.metadata, message.createdAt]), 'utf8').digest('hex')
    mocks.invoke.mockResolvedValueOnce(true)
    await expect(persistMemoryIntake(message, 'P')).resolves.toBe(true)
    expect(mocks.invoke).toHaveBeenCalledWith('persist_memory_intake_transaction', {
      request: { message, scopeKey: 'p', sourceFingerprint: fingerprint },
    })
    expect(await fingerprintMemorySource(message.content, null, message.createdAt)).not.toBe(fingerprint)
    expect(await fingerprintMemorySource(message.content, undefined, message.createdAt)).toBe(await fingerprintMemorySource(message.content, null, message.createdAt))
    expect(await fingerprintMemorySource(message.content, message.metadata, message.createdAt + 1)).not.toBe(fingerprint)
  })

  it('does not invoke a write for Web or while the database is unavailable', async () => {
    const message = { id: 'u', sessionId: 's', content: '匿名', createdAt: 1 }
    mocks.web.mockReturnValueOnce(true)
    await expect(persistMemoryIntake(message, null)).rejects.toThrow()
    mocks.ready.mockReturnValueOnce(false)
    await expect(persistMemoryIntake(message, null)).rejects.toThrow('memory_intake_database_not_ready')
    expect(mocks.invoke).not.toHaveBeenCalled()
  })

  it('rejects a blank project scope rather than treating it as global', async () => {
    await expect(persistMemoryIntake({ id: 'u', sessionId: 's', content: '匿名', createdAt: 1 }, '  '))
      .rejects.toThrow('invalid_memory_intake_scope')
    expect(mocks.invoke).not.toHaveBeenCalled()
  })

  it('rechecks database availability after computing the fingerprint', async () => {
    mocks.ready.mockReturnValueOnce(true).mockReturnValueOnce(false)
    await expect(persistMemoryIntake({ id: 'u', sessionId: 's', content: '匿名', createdAt: 1 }, null))
      .rejects.toThrow('memory_intake_database_not_ready')
    expect(mocks.invoke).not.toHaveBeenCalled()
  })
})
