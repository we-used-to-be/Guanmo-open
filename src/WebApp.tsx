import { useEffect, useLayoutEffect } from 'react'
import { AppLayout } from '@/components/layout/AppLayout'
import { ToastContainer } from '@/components/common/ToastContainer'
import { GlobalTooltip } from '@/components/common/Tooltip'
import { syncDocumentTheme, useSettingsStore } from '@/stores/settingsStore'
import { useAppStore } from '@/stores/appStore'
import { useEditorStore } from '@/stores/editorStore'
import { useChatStore } from '@/stores/chatStore'
import {
  clearBrowserFileSession,
  registerBrowserDirectoryHandle,
  registerBrowserFile,
  registerBrowserFileHandle,
} from '@/services/browserFileSystem'
import { updateSearchConfig } from '@/services/webSearch'
import { getWebSecretRuntimeState } from '@/web/webSecretRuntime'
import { requestProductTour } from '@/features/productTour/productTourEvents'
import { hasShownProductTourInvite, markProductTourInviteShown } from '@/features/productTour/productTourStorage'
import { toast } from '@/services/toast'

/** Web 端只启动共享桌面壳；文件、标签和聊天状态均为当前页面会话。 */
export default function WebApp() {
  const themeId = useSettingsStore((state) => state.appearance.themeId)

  useLayoutEffect(() => {
    syncDocumentTheme(themeId)
  }, [themeId])

  useLayoutEffect(() => {
    document.documentElement.dataset.gmRuntime = 'web'
    document.getElementById('guanmo-startup-shell')?.remove()
    try {
      // 清理旧版 Web 壳留下的文件/标签快照；设置与 API Key 存储不在此范围。
      localStorage.removeItem('guanmo-app')
      localStorage.removeItem('guanmo-editor')
      localStorage.removeItem('guanmo-boot-snapshot')
    } catch {
      // 隐私模式下 localStorage 可能不可用，内存 Store 仍然满足会话隔离。
    }
    clearBrowserFileSession()
    useAppStore.getState().resetWorkspaceForWebSession()
    useEditorStore.getState().resetTabsForWebSession(useSettingsStore.getState().editor.defaultOpenMode)
    useChatStore.getState().clearMessages()
    useChatStore.getState().setStreaming(false)
    return () => {
      if (document.documentElement.dataset.gmRuntime === 'web') {
        delete document.documentElement.dataset.gmRuntime
      }
    }
  }, [])

  useEffect(() => {
    if (hasShownProductTourInvite()) return
    markProductTourInviteShown()
    toast.show({
      id: 'product-tour-invite',
      title: '欢迎使用观墨',
      message: '用 1 分钟了解文件、阅读模式与 AI 助手',
      type: 'info',
      duration: null,
      actions: [{ label: '开始导览', primary: true, onClick: requestProductTour }],
    })
  }, [])

  useEffect(() => {
    const secretState = getWebSecretRuntimeState()
    if (secretState.unlocked) {
      useSettingsStore.getState().applyWebRuntimeApiKeys({ chatApiKey: secretState.chatApiKey, webSearchApiKey: secretState.webSearchApiKey })
    }
    const { webSearch } = useSettingsStore.getState()
    updateSearchConfig({ ...webSearch, apiKey: secretState.webSearchApiKey })
  }, [])

  useEffect(() => {
    const onDragOver = (event: DragEvent) => event.preventDefault()
    const onDrop = (event: DragEvent) => {
      event.preventDefault()
      const items = Array.from(event.dataTransfer?.items ?? [])
      void (async () => {
        for (const item of items) {
          try {
            const getHandle = (item as DataTransferItem & { getAsFileSystemHandle?: () => Promise<unknown> }).getAsFileSystemHandle
            if (getHandle) {
              const handle = await getHandle.call(item)
              if (handle && typeof handle === 'object' && (handle as { kind?: string }).kind === 'directory') {
                const root = registerBrowserDirectoryHandle(handle as Parameters<typeof registerBrowserDirectoryHandle>[0])
                useAppStore.getState().addWorkspaceRoot(root.path)
                continue
              }
              if (handle && typeof handle === 'object' && (handle as { kind?: string }).kind === 'file' && /\.md$/i.test((handle as { name: string }).name)) {
                const opened = await registerBrowserFileHandle(handle as Parameters<typeof registerBrowserFileHandle>[0])
                useEditorStore.getState().addTab(opened.path, opened.name, opened.content)
                continue
              }
            }
            const file = item.getAsFile()
            if (file && /\.md$/i.test(file.name)) {
              const opened = await registerBrowserFile(file)
              useEditorStore.getState().addTab(opened.path, opened.name, opened.content)
            }
          } catch (error) {
            console.warn('[Web] dropped file could not be opened:', error)
          }
        }
      })()
    }
    window.addEventListener('dragover', onDragOver)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragover', onDragOver)
      window.removeEventListener('drop', onDrop)
    }
  }, [])

  return (
    <>
      <AppLayout />
      <ToastContainer />
      <GlobalTooltip />
    </>
  )
}
