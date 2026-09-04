import {
  clearAllChatSessions,
  clearMemoriesByStatus,
  confirmMemoryCandidate,
  loadMemoryCount,
  loadMemoryPage,
  persistMemory,
  removeMemory,
  toggleMemoryLocked,
  updateMemoryStatus,
} from '@/services/database/persistence'
import type {
  LoadMemoryOptions,
  Memory,
  MemoryPage,
} from '@/services/database/persistence'

export type {
  LoadMemoryOptions,
  Memory,
  MemoryPage,
  MemorySource,
  MemoryStatus,
} from '@/services/database/persistence'

export type SettingsMemoryPageOptions = LoadMemoryOptions & {
  limit: number
  offset?: number
}

export function clearSavedChatSessions(): Promise<void> {
  return clearAllChatSessions()
}

export function clearCandidateMemories(): Promise<void> {
  return clearMemoriesByStatus(['candidate'])
}

export function loadSettingsMemoryPage(options: SettingsMemoryPageOptions): Promise<MemoryPage> {
  return loadMemoryPage(options)
}

export function loadSettingsMemoryCount(options: LoadMemoryOptions = {}): Promise<number> {
  return loadMemoryCount(options)
}

export function deleteSettingsMemory(id: string): Promise<void> {
  return removeMemory(id)
}

export function toggleSettingsMemoryLocked(id: string, locked: boolean): Promise<void> {
  return toggleMemoryLocked(id, locked)
}

export function archiveSettingsMemory(id: string): Promise<void> {
  return updateMemoryStatus(id, 'archived')
}

export function confirmSettingsMemoryCandidate(id: string): Promise<boolean> {
  return confirmMemoryCandidate(id)
}

export function ignoreSettingsMemoryCandidate(id: string): Promise<void> {
  return updateMemoryStatus(id, 'ignored')
}

export function persistSettingsMemory(memory: Memory): Promise<void> {
  return persistMemory(memory)
}
