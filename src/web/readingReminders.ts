import { UnsupportedCapabilityError } from './externalHttp'

export type ReadingReminderStatus = 'pending' | 'scheduled' | 'fired' | 'cancel_pending' | 'cancelled' | 'failed'

export interface ReadingReminder {
  id: string
  title: string
  description: string | null
  dueAtUtc: number
  createdTimezone: string
  status: ReadingReminderStatus
  sourceArtifactId: string | null
  sourceFilePath: string | null
  sourceMessageId: string | null
  notificationId: number | null
  errorCode: string | null
  createdAt: number
  updatedAt: number
}

export interface CreateReadingReminderInput {
  id: string
  title: string
  description?: string | null
  dueAtUtc: number
  createdTimezone: string
  sourceArtifactId?: string | null
  sourceFilePath?: string | null
  sourceMessageId?: string | null
}

const unsupported = async (): Promise<never> => {
  throw new UnsupportedCapabilityError('阅读提醒')
}

export const loadReadingRemindersCommand = unsupported
export const createReadingReminder = unsupported
export const cancelReadingReminder = unsupported
export const deleteReadingReminder = unsupported
export const retryReadingReminder = unsupported
export const editReadingReminderTime = unsupported
