import { toast } from '@/services/toast'
import {
  checkForUpdates,
  ignoreUpdateVersion,
  recordNotifiedVersion,
  type AvailableUpdate,
  type UpdateCheckResult,
} from '@/services/updateService'
import { useUpdateStore } from '@/stores/updateStore'

const notifiedVersions = new Set<string>()

export async function runAutomaticUpdateCheck(force = false): Promise<UpdateCheckResult> {
  const result = await checkForUpdates({ force })
  if (result.status === 'available') showAvailableUpdate(result.update)
  return result
}

export function showAvailableUpdate(update: AvailableUpdate): boolean {
  if (notifiedVersions.has(update.latestVersion)) return false
  notifiedVersions.add(update.latestVersion)
  recordNotifiedVersion(update.latestVersion)

  toast.show({
    id: `app-update-${update.latestVersion}`,
    title: '发现新版本',
    message: `观墨 v${update.latestVersion} 已发布`,
    type: 'info',
    duration: 11_000,
    actions: [
      {
        label: '查看',
        primary: true,
        onClick: () => useUpdateStore.getState().showDetails({
          mode: 'update',
          currentVersion: update.currentVersion,
          releaseVersion: update.latestVersion,
          release: update.release,
        }),
      },
      {
        label: '忽略',
        onClick: () => ignoreUpdateVersion(update.latestVersion),
      },
    ],
  })
  return true
}

export interface ManualUpdateCheckFeedback {
  tone: 'info' | 'success' | 'error'
  message: string
}

export async function runManualUpdateCheck(): Promise<ManualUpdateCheckFeedback> {
  try {
    const result = await checkForUpdates({ manual: true })
    if (result.status === 'available') {
      if (!showAvailableUpdate(result.update)) {
        useUpdateStore.getState().showDetails({
          mode: 'update',
          currentVersion: result.update.currentVersion,
          releaseVersion: result.update.latestVersion,
          release: result.update.release,
        })
      }
      return {
        tone: 'info',
        message: `发现新版本 v${result.update.latestVersion}，可查看更新详情。`,
      }
    }
    if (result.status === 'up-to-date') {
      return {
        tone: 'success',
        message: `当前已是最新版 v${result.currentVersion}`,
      }
    }
    return {
      tone: 'info',
      message: '本次检查未发现可用更新。',
    }
  } catch {
    return {
      tone: 'error',
      message: '暂时无法检查更新，请稍后重试。',
    }
  }
}
