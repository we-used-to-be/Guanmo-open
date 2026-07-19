import { useEffect } from 'react'
import { isTauri } from '@/hooks/useTauri'
import { runAutomaticUpdateCheck } from '@/services/updateNotifications'
import type { UpdateCheckResult } from '@/services/updateService'
import { UpdateDetailsModal } from './UpdateDetailsModal'

const STARTUP_CHECK_DELAY_MS = 7_000

declare global {
  interface Window {
    guanmoDev?: {
      triggerAutomaticUpdateCheck: () => Promise<UpdateCheckResult>
    }
  }
}

export function UpdateManager() {
  useEffect(() => {
    if (!isTauri()) return
    const timer = window.setTimeout(() => {
      void runAutomaticUpdateCheck()
        .catch(() => {
          // 启动检查必须静默失败，不能影响应用初始化。
        })
    }, STARTUP_CHECK_DELAY_MS)

    return () => {
      window.clearTimeout(timer)
    }
  }, [])

  useEffect(() => {
    if (!import.meta.env.DEV || !isTauri()) return

    const triggerAutomaticUpdateCheck = () => runAutomaticUpdateCheck(true)
    window.guanmoDev = { triggerAutomaticUpdateCheck }
    console.info('开发入口已就绪：await window.guanmoDev.triggerAutomaticUpdateCheck()')

    return () => {
      if (window.guanmoDev?.triggerAutomaticUpdateCheck === triggerAutomaticUpdateCheck) {
        delete window.guanmoDev
      }
    }
  }, [])

  return <UpdateDetailsModal />
}
