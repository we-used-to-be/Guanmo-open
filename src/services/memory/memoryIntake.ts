import { invoke } from '@tauri-apps/api/core'
import { isDatabaseReady } from '@/services/database/db'
import { UnsupportedCapabilityError } from '@/services/externalHttp'
import { isWebRuntime } from '@/services/runtimeCapabilities'
import { normalizeMemoryScopeKey } from './memoryPolicy'

export interface MemoryIntakeMessage {
  id: string
  sessionId: string
  content: string
  metadata?: string | null
  createdAt: number
}

/** This fingerprint detects source edits; authorization still requires source validation. */
export async function fingerprintMemorySource(content: string, metadata: string | null | undefined, createdAt: number): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify([content, metadata ?? null, createdAt]))
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}

/** V3 identity follows the visible user text, so later persistence of hidden tag context stays idempotent. */
export async function fingerprintGlobalMemorySource(visibleText: string, createdAt: number): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify([visibleText, createdAt]))
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}

/** Optional v2 path; callers must persist the session first and retain the captured scope. */
export async function persistMemoryIntake(message: MemoryIntakeMessage, scopeKey: string | null): Promise<boolean> {
  if (isWebRuntime()) throw new UnsupportedCapabilityError('长期记忆后台登记')
  if (!isDatabaseReady()) throw new Error('memory_intake_database_not_ready')
  const normalizedScopeKey = normalizeMemoryScopeKey('project', scopeKey)
  if (scopeKey !== null && normalizedScopeKey === null) throw new Error('invalid_memory_intake_scope')
  const sourceFingerprint = await fingerprintMemorySource(message.content, message.metadata, message.createdAt)
  if (!isDatabaseReady()) throw new Error('memory_intake_database_not_ready')
  return invoke<boolean>('persist_memory_intake_transaction', {
    request: { message: { ...message, metadata: message.metadata ?? null }, scopeKey: normalizedScopeKey, sourceFingerprint },
  })
}

/** Persist the accepted chat message and its global v3 intake receipt atomically in Rust. */
export async function persistGlobalMemoryMessage(
  session: { id: string; title: string },
  message: MemoryIntakeMessage,
): Promise<boolean> {
  if (isWebRuntime()) throw new UnsupportedCapabilityError('长期记忆后台登记')
  if (!isDatabaseReady()) throw new Error('memory_intake_database_not_ready')
  if (message.sessionId !== session.id) throw new Error('invalid_memory_intake_session')
  return invoke<boolean>('persist_chat_message_with_memory_intake', {
    request: { session, message: { ...message, role: 'user', metadata: message.metadata ?? null }, policyVersion: 3 },
  })
}
