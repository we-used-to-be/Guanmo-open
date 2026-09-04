import { UnsupportedCapabilityError } from './externalHttp'
const unsupported = async (): Promise<never> => { throw new UnsupportedCapabilityError('持久聊天历史') }
export const persistConversationSession = unsupported
export const loadRecentConversationTurns = unsupported
export const deleteConversationSession = unsupported
