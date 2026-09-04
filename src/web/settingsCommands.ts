import { UnsupportedCapabilityError } from './externalHttp'
const unsupported = async (): Promise<never> => { throw new UnsupportedCapabilityError('长期记忆和持久聊天历史') }
export const archiveSettingsMemory = unsupported
export const clearCandidateMemories = unsupported
export const clearSavedChatSessions = unsupported
export const confirmSettingsMemoryCandidate = unsupported
export const deleteSettingsMemory = unsupported
export const ignoreSettingsMemoryCandidate = unsupported
export const loadSettingsMemoryCount = unsupported
export const loadSettingsMemoryPage = unsupported
export const persistSettingsMemory = unsupported
export const toggleSettingsMemoryLocked = unsupported
