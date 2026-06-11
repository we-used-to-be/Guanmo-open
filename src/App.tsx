import { useEffect, useState } from 'react'
import { AppLayout } from './components/layout/AppLayout'
import { ToastContainer } from './components/common/ToastContainer'
import { initDatabase } from './services/database/db'
import { vectorStore } from './services/rag/vectorStore'
import { hydrateSettingsSecrets } from './services/settingsSecrets'
import { initAiClient, initEmbeddingClient } from './services/ai/aiClient'
import { useSettingsStore } from './stores/settingsStore'
import { useExternalFileOpen } from './hooks/useExternalFileOpen'
import { Cursor } from 'animal-island-ui'

function App() {
  const [dbError, setDbError] = useState<string | null>(null)
  const [appReady, setAppReady] = useState(false)
  const customCursorEnabled = useSettingsStore((s) => s.appearance.customCursorEnabled)
  useExternalFileOpen(appReady)

  // 禁用浏览器默认右键菜单
  useEffect(() => {
    const handler = (e: MouseEvent) => e.preventDefault()
    document.addEventListener('contextmenu', handler)
    return () => document.removeEventListener('contextmenu', handler)
  }, [])
  useEffect(() => {
    let cancelled = false
    async function init() {
      try {
        await hydrateSettingsSecrets().catch((err) =>
          console.warn('[App] Settings secret hydration failed:', err)
        )
        await initDatabase()
        await vectorStore.loadFromDatabase()

        // 初始化 AI 客户端（对话 + Embedding）
        const { ai } = useSettingsStore.getState()
        if (ai.apiKey && ai.baseUrl && ai.chatModel) {
          try { initAiClient(ai) } catch (err) { console.warn('[App] Chat client init failed:', err) }
        }
        if (ai.embedding.apiKey && ai.embedding.baseUrl && ai.embedding.embeddingModel) {
          try { initEmbeddingClient(ai.embedding) } catch (err) { console.warn('[App] Embedding client init failed:', err) }
        }

      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error('[App] Database init failed:', msg)
        if (!cancelled) {
          setDbError(msg)
        }
      } finally {
        if (!cancelled) {
          setAppReady(true)
        }
      }
    }
    init()
    return () => { cancelled = true }
  }, [])

  return (
    <>
      {dbError && (
        <div className="fixed top-0 left-0 right-0 z-50 bg-yellow-100 text-yellow-800 text-caption px-4 py-1 text-center">
          数据库初始化失败: {dbError}（数据不会持久化）
        </div>
      )}
      {customCursorEnabled ? (
        <Cursor className="h-full">
          <AppLayout />
        </Cursor>
      ) : (
        <AppLayout />
      )}
      <ToastContainer />
    </>
  )
}

export default App
