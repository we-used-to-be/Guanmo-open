import {
  deleteReadingReminderRow,
  loadReadingReminderById,
  loadReadingReminders,
  persistReadingReminder,
  updateReadingReminderState,
  type ReadingReminder,
} from './database/readingReminders'
import {
  notificationIdForReminder,
  readingReminderNotificationAdapter,
  type ReadingReminderNotificationAdapter,
} from './readingReminderNotifications'
import { refreshReadingReminderRuntime } from './readingReminderRuntime'

export type { ReadingReminder } from './database/readingReminders'

export async function loadReadingRemindersCommand(): Promise<ReadingReminder[]> {
  return loadReadingReminders()
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

function errorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (message === 'notification_unavailable') return message
  if (message === 'unsupported_platform') return message
  if (/notification_registration_failed/.test(message)) return 'notification_registration_failed'
  if (/notification_show_failed/.test(message)) return 'notification_show_failed'
  if (/notification_cancel_failed/.test(message)) return 'notification_cancel_failed'
  if (/notification_list_failed/.test(message)) return 'notification_list_failed'
  if (/permission/i.test(message)) return 'notification_permission_denied'
  if (/due_time|due time/i.test(message)) return 'reminder_due_time_invalid'
  return 'notification_schedule_failed'
}

function validateFutureTime(dueAtUtc: number): void {
  if (!Number.isFinite(dueAtUtc) || dueAtUtc <= Date.now()) {
    throw new Error('reminder_due_time_invalid')
  }
}

async function scheduleReminder(
  reminder: Pick<ReadingReminder, 'id' | 'title' | 'description' | 'dueAtUtc' | 'notificationId'>,
  adapter: ReadingReminderNotificationAdapter,
  requestPermission: boolean,
): Promise<ReadingReminder> {
  validateFutureTime(reminder.dueAtUtc)
  const notificationId = reminder.notificationId ?? notificationIdForReminder(reminder.id)
  try {
    const granted = await adapter.ensurePermission(requestPermission)
    if (!granted) throw new Error('notification_permission_denied')
    await adapter.schedule({
      id: notificationId,
      title: reminder.title,
      body: reminder.description || undefined,
      dueAtUtc: reminder.dueAtUtc,
    })
    await updateReadingReminderState(reminder.id, 'scheduled', { notificationId, errorCode: null })
  } catch (error) {
    await updateReadingReminderState(reminder.id, 'failed', {
      notificationId,
      errorCode: errorCode(error),
    })
    throw error
  }
  refreshReadingReminderRuntime()
  return (await loadReadingReminderById(reminder.id))!
}

export async function createReadingReminder(
  input: CreateReadingReminderInput,
  adapter: ReadingReminderNotificationAdapter = readingReminderNotificationAdapter,
): Promise<ReadingReminder> {
  const existing = await loadReadingReminderById(input.id)
  if (existing && ['scheduled', 'fired'].includes(existing.status)) return existing
  validateFutureTime(input.dueAtUtc)

  const notificationId = existing?.notificationId ?? notificationIdForReminder(input.id)
  await persistReadingReminder({
    ...input,
    status: 'pending',
    notificationId,
    errorCode: null,
  })

  return scheduleReminder({ ...input, description: input.description ?? null, notificationId }, adapter, true)
}

export async function cancelReadingReminder(
  id: string,
  adapter: ReadingReminderNotificationAdapter = readingReminderNotificationAdapter,
): Promise<void> {
  const reminder = await loadReadingReminderById(id)
  if (!reminder || reminder.status === 'cancelled') return
  await updateReadingReminderState(id, 'cancel_pending', { errorCode: null })
  try {
    if (reminder.notificationId) await adapter.cancel(reminder.notificationId)
    await updateReadingReminderState(id, 'cancelled', { errorCode: null })
    refreshReadingReminderRuntime()
  } catch (error) {
    await updateReadingReminderState(id, 'failed', { errorCode: 'notification_cancel_failed' })
    throw error
  }
}

export async function deleteReadingReminder(
  id: string,
  adapter: ReadingReminderNotificationAdapter = readingReminderNotificationAdapter,
): Promise<void> {
  const reminder = await loadReadingReminderById(id)
  if (!reminder) return
  if (reminder.notificationId) {
    try {
      await adapter.cancel(reminder.notificationId)
    } catch {
      console.warn('[Reminder] failed to cancel scheduled notification before delete')
    }
  }
  await deleteReadingReminderRow(id)
  refreshReadingReminderRuntime()
}

export async function retryReadingReminder(
  id: string,
  adapter: ReadingReminderNotificationAdapter = readingReminderNotificationAdapter,
): Promise<ReadingReminder | undefined> {
  const reminder = await loadReadingReminderById(id)
  if (!reminder || reminder.status !== 'failed') return reminder
  if (reminder.errorCode === 'notification_cancel_failed') {
    await cancelReadingReminder(id, adapter)
    const cancelled = await loadReadingReminderById(id)
    refreshReadingReminderRuntime()
    return cancelled
  }
  await updateReadingReminderState(id, 'pending', { errorCode: null })
  return scheduleReminder(reminder, adapter, true)
}

export async function editReadingReminderTime(
  id: string,
  dueAtUtc: number,
  createdTimezone: string,
  adapter: ReadingReminderNotificationAdapter = readingReminderNotificationAdapter,
): Promise<ReadingReminder> {
  validateFutureTime(dueAtUtc)
  const reminder = await loadReadingReminderById(id)
  if (!reminder || ['cancelled', 'fired'].includes(reminder.status)) {
    throw new Error('reminder_not_editable')
  }
  if (reminder.notificationId && reminder.status === 'scheduled') {
    try {
      await updateReadingReminderState(id, 'cancel_pending', { errorCode: null })
      await adapter.cancel(reminder.notificationId)
    } catch (error) {
      await updateReadingReminderState(id, 'failed', { errorCode: 'notification_cancel_failed' })
      throw error
    }
  }
  await persistReadingReminder({
    id: reminder.id,
    title: reminder.title,
    description: reminder.description,
    dueAtUtc,
    createdTimezone,
    status: 'pending',
    sourceArtifactId: reminder.sourceArtifactId,
    sourceFilePath: reminder.sourceFilePath,
    sourceMessageId: reminder.sourceMessageId,
    notificationId: reminder.notificationId ?? notificationIdForReminder(reminder.id),
    errorCode: null,
  })
  return scheduleReminder({ ...reminder, dueAtUtc }, adapter, true)
}

export interface ReadingReminderReconcileResult {
  scheduled: number
  fired: number
  failed: number
  cancelled: number
}

export async function reconcileReadingReminders(
  adapter: ReadingReminderNotificationAdapter = readingReminderNotificationAdapter,
  now = Date.now(),
): Promise<ReadingReminderReconcileResult> {
  const result: ReadingReminderReconcileResult = { scheduled: 0, fired: 0, failed: 0, cancelled: 0 }
  const reminders = await loadReadingReminders()
  if (reminders.length === 0) return result

  let granted = false
  let pendingIds = new Set<number>()
  try {
    granted = await adapter.ensurePermission(false)
  } catch {
    granted = false
  }
  try {
    pendingIds = await adapter.pendingIds()
  } catch {
    pendingIds = new Set<number>()
  }

  for (const reminder of reminders) {
    if (reminder.status === 'cancel_pending') {
      try {
        if (reminder.notificationId) await adapter.cancel(reminder.notificationId)
        await updateReadingReminderState(reminder.id, 'cancelled', { errorCode: null })
        result.cancelled += 1
      } catch {
        await updateReadingReminderState(reminder.id, 'failed', { errorCode: 'notification_cancel_failed' })
        result.failed += 1
      }
      continue
    }
    if (!['pending', 'scheduled'].includes(reminder.status)) continue
    if (reminder.dueAtUtc <= now) continue
    if (!granted) {
      await updateReadingReminderState(reminder.id, 'failed', {
        errorCode: 'notification_permission_unavailable',
      })
      result.failed += 1
      continue
    }
    if (reminder.notificationId && pendingIds.has(reminder.notificationId)) {
      if (reminder.status === 'pending') {
        await updateReadingReminderState(reminder.id, 'scheduled', { errorCode: null })
      }
      continue
    }
    const notificationId = reminder.notificationId ?? notificationIdForReminder(reminder.id)
    try {
      await adapter.schedule({
        id: notificationId,
        title: reminder.title,
        body: reminder.description || undefined,
        dueAtUtc: reminder.dueAtUtc,
      })
      await updateReadingReminderState(reminder.id, 'scheduled', { notificationId, errorCode: null })
      result.scheduled += 1
    } catch (error) {
      await updateReadingReminderState(reminder.id, 'failed', {
        notificationId,
        errorCode: errorCode(error),
      })
      result.failed += 1
    }
  }
  return result
}
