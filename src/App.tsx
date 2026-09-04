import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { AppLayout } from './components/layout/AppLayout'
import { ToastContainer } from './components/common/ToastContainer'
import {
  getDatabaseRuntimeState,
  initDatabase,
} from './services/database/db'
import { ensureSettingsSecretsHydrated } from './services/settingsSecrets'
import { initAiClient, initEmbeddingClient, isLocalApi, validateAiStatus } from './services/ai/aiClient'
import { syncDocumentTheme, useSettingsStore } from './stores/settingsStore'
import { useAppStore } from './stores/appStore'
import { useExternalFileOpen } from './hooks/useExternalFileOpen'
import { Cursor } from 'animal-island-ui'
import { invoke } from '@tauri-apps/api/core'
import {
  getRestorablePersistedTabs,
  restorePersistedTabs,
  type PersistedTabRestoreIssue,
} from './services/sessionRestore'
import { useEditorStore } from './stores/editorStore'
import { isTauri, waitForFileAccessRestore } from './hooks/useTauri'
import { useUsageTracking } from './hooks/useUsageTracking'
import { GlobalTooltip } from './components/common/Tooltip'
import { markLegacyFileAccessMigrationDone, migrateLegacyFileAccess } from './services/persistedFileAccess'
import { toast } from './services/toast'
import { detectLegacyData, type LegacyDetectionResult } from './services/database/legacyDetector'
import { scheduleIdleTask } from './services/idleScheduler'
import { singletonManager, SINGLETON_IDS } from './services/singletonPromise'
import { READING_REMINDER_FEATURE_AVAILABLE } from './services/readingReminderFeature'
import { eventMarker } from './services/eventMarker'
import './styles/tokens/official-light.css'
import './styles/startupShell.css'
import { requestProductTour } from './features/productTour/productTourEvents'
import { hasShownProductTourInvite, markProductTourInviteShown } from './features/productTour/productTourStorage'
import { markStartupPoint, waitForStartupPoint } from './services/startupPerformance'
import { hasBootSnapshotContent } from './services/bootSnapshot'

syncDocumentTheme(useSettingsStore.getState().appearance.themeId)

const DevPerfMonitorPanel = import.meta.env.DEV
  ? lazy(() => import('./components/devtools/PerfMonitorPanel').then((module) => ({ default: module.PerfMonitorPanel })))
  : null
const UpdateManager = lazy(() => import('./components/update/UpdateManager').then((module) => ({ default: module.UpdateManager })))
const LegacyDataNoticeModal = lazy(() => import('./components/legacy/LegacyDataNoticeModal').then((module) => ({ default: module.LegacyDataNoticeModal })))

type CursorPhase = 'entering' | 'active' | 'exiting'

function logDuration(label: string, startedAt: number) {
  console.info(`[Perf] ${label}: ${Math.round(performance.now() - startedAt)}ms`)
}

function showRestoreIssues(issues: PersistedTabRestoreIssue[], includeTooLarge = true): void {
  const visibleIssues = includeTooLarge ? issues : issues.filter((issue) => issue.kind !== 'too-large')
  if (visibleIssues.length === 0) return
  void import('./services/sessionRestoreNotifications')
    .then(({ showSessionRestoreIssues }) => showSessionRestoreIssues(visibleIssues))
    .catch((error) => console.warn('[App] Restore issue notification failed:', error))
}

function removeSkippedRestoreTabs(issues: PersistedTabRestoreIssue[]): void {
  const skippedTabIds = issues
    .filter((issue) => issue.kind === 'too-large' && !issue.preservedDraft)
    .map((issue) => issue.tabId)
  for (const tabId of skippedTabIds) {
    useEditorStore.getState().closeTab(tabId)
  }
}

/**
 * 恢复标签页（立即执行）
 */
async function restoreTabs(): Promise<void> {
  let openedFromFileAssociation = false
  if (isTauri()) {
    try {
      openedFromFileAssociation = await invoke<boolean>('has_pending_open_files')
    } catch (err) {
      console.warn('[App] Pending open file check failed:', err)
    }
  }

  if (openedFromFileAssociation) {
    useEditorStore.getState().resetTabsForExternalOpen(useSettingsStore.getState().editor.defaultOpenMode)
    markStartupPoint('active-tab-disk-read-complete', { outcome: 'skipped-external-open' })
    markStartupPoint('startup-session-restore-complete', { outcome: 'skipped-external-open' })
    return
  }

  const restoreStartedAt = performance.now()
  const state = useEditorStore.getState()
  console.log('[App] Restoring tabs:', state.tabs.length, 'tabs')
  const restorableTabs = getRestorablePersistedTabs(state.tabs)
  const validIds = new Set(restorableTabs.map((tab) => tab.id))
  const activeTabId = state.activeTabId && validIds.has(state.activeTabId)
    ? state.activeTabId
    : restorableTabs[0]?.id ?? null
  const activeTab = restorableTabs.find((tab) => tab.id === activeTabId)
  state.restoreTabs(
    restorableTabs,
    activeTabId,
    state.rightPaneTabId && validIds.has(state.rightPaneTabId) ? state.rightPaneTabId : null,
  )
  const activeIssues: PersistedTabRestoreIssue[] = []
  let restoredActiveTabs: Awaited<ReturnType<typeof restorePersistedTabs>>
  try {
    restoredActiveTabs = activeTab
      ? await restorePersistedTabs([activeTab], {
          detectExternalChanges: hasBootSnapshotContent(activeTab),
          onTabRestoreIssue: (issue) => activeIssues.push(issue),
        })
      : []
  } catch (error) {
    // 旁路标记：记录失败 outcome 后原样抛出，不改变异常传播
    markStartupPoint('active-tab-disk-read-complete', { outcome: 'failed' })
    markStartupPoint('startup-session-restore-complete', { outcome: 'failed', stage: 'active-restore' })
    throw error
  }
  const [restoredActiveTab] = restoredActiveTabs
  markStartupPoint('active-tab-disk-read-complete', {
    restored: Boolean(restoredActiveTab),
  })
  if (activeTab && restoredActiveTab) {
    useEditorStore.getState().mergeRestoredTab(activeTab, restoredActiveTab)
  }
  removeSkippedRestoreTabs(activeIssues)
  showRestoreIssues(activeIssues, false)
  markStartupPoint('startup-session-restore-complete', {
    outcome: activeTab ? (restoredActiveTab ? 'restored' : 'active-missing') : 'no-active-tab',
    tabs: restorableTabs.length,
  })
  logDuration('active tab restore', restoreStartedAt)

  const backgroundTabs = restorableTabs.filter((tab) => tab.id !== activeTabId)
  const backgroundIssues: PersistedTabRestoreIssue[] = []
  void restorePersistedTabs(backgroundTabs, {
    concurrency: 3,
    onTabRestored(restoredTab, index) {
      const originalTab = backgroundTabs[index]
      useEditorStore.getState().mergeRestoredTab(originalTab, restoredTab)
    },
    onTabRestoreIssue(issue) {
      backgroundIssues.push(issue)
    },
  }).then(() => {
    removeSkippedRestoreTabs(backgroundIssues)
    showRestoreIssues(backgroundIssues, false)
    showRestoreIssues(
      [...activeIssues, ...backgroundIssues].filter((issue) => issue.kind === 'too-large'),
    )
    logDuration('background tab restore', restoreStartedAt)
  }).catch((error) => {
    console.warn('[App] Background tab restore failed:', error)
  })
}

/**
 * 注册闲时预热任务
 */
function scheduleIdleWarmup(): void {
  console.log('[App] 注册闲时预热任务')

  // 优先级 1: AI 客户端初始化
  scheduleIdleTask(
    SINGLETON_IDS.CHAT_AI,
    async () => {
      await ensureSettingsSecretsHydrated()
      const { ai } = useSettingsStore.getState()
      if ((ai.apiKey || isLocalApi(ai.baseUrl)) && ai.baseUrl && ai.chatModel) {
        await singletonManager.init(SINGLETON_IDS.CHAT_AI, async () => {
          const startTime = performance.now()
          const provider = initAiClient(ai)
          logDuration('AI client init', startTime)
          return provider
        })
      }
    },
    1,
    'AI 客户端初始化'
  )

  // 优先级 2: Embedding 客户端初始化
  scheduleIdleTask(
    SINGLETON_IDS.EMBEDDING_AI,
    async () => {
      await ensureSettingsSecretsHydrated()
      const { ai } = useSettingsStore.getState()
      if ((ai.embedding.apiKey || isLocalApi(ai.embedding.baseUrl)) && ai.embedding.baseUrl && ai.embedding.embeddingModel) {
        await singletonManager.init(SINGLETON_IDS.EMBEDDING_AI, async () => {
          const startTime = performance.now()
          const provider = initEmbeddingClient(ai.embedding)
          logDuration('Embedding client init', startTime)
          return provider
        })
      }
    },
    2,
    'Embedding 客户端初始化'
  )

  // 向量库延迟加载：不在启动时预热，首次使用 RAG 时才加载
  // 性能档位允许时，仅在首屏后闲时预热；用户活动、切文档或内存压力会取消。
  scheduleIdleTask(
    'rag-index-warmup',
    async () => {
      const { warmNativeRagIndexWhileIdle } = await import('./services/rag/warmupScheduler')
      await warmNativeRagIndexWhileIdle()
    },
    3,
    'RAG 索引预热',
  )

  // AI 状态校验：完全异步，不阻塞任何操作
  setTimeout(() => {
    const startTime = performance.now()
    ensureSettingsSecretsHydrated().then(validateAiStatus).then((status) => {
      useAppStore.getState().setAiStatus(status)
      logDuration('AI status validate', startTime)
    }).catch((err) => {
      console.warn('[App] AI status validation failed:', err)
    })
  }, 3000) // 延迟 3 秒，完全不阻塞

  // 优先级 7: 旧版数据检测
  scheduleIdleTask(
    SINGLETON_IDS.LEGACY_DATA_DETECTION,
    async () => {
      if (isTauri()) {
        const startTime = performance.now()
        try {
          const detection = await detectLegacyData()
          if (detection.legacyDetected && !detection.userNoticed) {
            // 这里需要通过事件或回调更新 UI，暂时只记录日志
            console.log('[App] Legacy data detected:', detection)
          }
          logDuration('legacy data detection', startTime)
        } catch (err) {
          console.warn('[App] Legacy detection failed:', err)
        }
      }
    },
    8,
    '旧版数据检测'
  )
}

function CustomCursorFrame({
  enabled,
  children,
}: {
  enabled: boolean
  children: React.ReactNode
}) {
  const [mounted, setMounted] = useState(enabled)
  const [phase, setPhase] = useState<CursorPhase>(enabled ? 'active' : 'exiting')
  const [showGhost, setShowGhost] = useState(false)
  const ghostRef = useRef<HTMLImageElement | null>(null)
  const pointerRef = useRef({ x: -32, y: -32 })
  const pointerFrameRef = useRef<number | null>(null)
  const exitTimer = useRef<number | null>(null)
  const enterTimer = useRef<number | null>(null)

  useEffect(() => {
    const handleMouseMove = (event: MouseEvent) => {
      pointerRef.current = { x: event.clientX, y: event.clientY }
      const target = event.target as HTMLElement | null
      const nextShowGhost = !target?.closest('input, textarea, [contenteditable="true"], .cm-editor, .gm-system-cursor')
      setShowGhost((current) => current === nextShowGhost ? current : nextShowGhost)
      if (pointerFrameRef.current === null) {
        pointerFrameRef.current = window.requestAnimationFrame(() => {
          pointerFrameRef.current = null
          const { x, y } = pointerRef.current
          if (ghostRef.current) ghostRef.current.style.transform = `translate3d(${x}px, ${y}px, 0)`
        })
      }
    }

    window.addEventListener('mousemove', handleMouseMove, { passive: true })
    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      if (pointerFrameRef.current !== null) window.cancelAnimationFrame(pointerFrameRef.current)
    }
  }, [])

  useEffect(() => {
    if (exitTimer.current) {
      window.clearTimeout(exitTimer.current)
      exitTimer.current = null
    }
    if (enterTimer.current) {
      window.clearTimeout(enterTimer.current)
      enterTimer.current = null
    }

    if (enabled) {
      setMounted(true)
      setPhase('entering')
      enterTimer.current = window.setTimeout(() => {
        setPhase('active')
        enterTimer.current = null
      }, 180)
      return
    }

    if (!mounted) return
    setPhase('exiting')
    exitTimer.current = window.setTimeout(() => {
      setMounted(false)
      exitTimer.current = null
    }, 180)
  }, [enabled, mounted])

  useEffect(() => {
    return () => {
      if (exitTimer.current) window.clearTimeout(exitTimer.current)
      if (enterTimer.current) window.clearTimeout(enterTimer.current)
    }
  }, [])

  if (!mounted) {
    return <div className="h-full gm-system-cursor gm-native-cursor-root">{children}</div>
  }

  const useNativeCustomCursor = phase === 'active'

  return (
    <Cursor
      className={`h-full gm-custom-cursor-frame gm-custom-cursor-frame--${phase}`}
      style={useNativeCustomCursor ? undefined : ({ '--animal-cursor': 'none' } as React.CSSProperties)}
    >
      {children}
      {phase !== 'active' && showGhost && (
        <img
          ref={ghostRef}
          className="gm-custom-cursor-ghost"
          src="/cursor-icon.png"
          alt=""
          aria-hidden="true"
          style={{ transform: 'translate3d(-32px, -32px, 0)' }}
        />
      )}
    </Cursor>
  )
}

function App() {
  markStartupPoint('first-react-render')
  const [appReady, setAppReady] = useState(false)
  const [legacyDetection, setLegacyDetection] = useState<LegacyDetectionResult | null>(null)
  const customCursorEnabled = useSettingsStore((s) => s.appearance.customCursorEnabled)
  const themeId = useSettingsStore((s) => s.appearance.themeId)
  useExternalFileOpen(appReady)
  useUsageTracking(appReady)

  useEffect(() => {
    if (!appReady || !isTauri() || hasShownProductTourInvite()) return
    markProductTourInviteShown()
    toast.show({
      id: 'product-tour-invite',
      title: '欢迎使用观墨',
      message: '用 1 分钟了解文件、阅读模式与 AI 助手',
      type: 'info',
      duration: null,
      actions: [{ label: '开始导览', primary: true, onClick: requestProductTour }],
    })
  }, [appReady])

  // 调试用：控制台调用 __testLegacyModal() 唤起旧版数据检测弹窗
  useEffect(() => {
    ;(window as unknown as Record<string, unknown>).__testLegacyModal = () => {
      setLegacyDetection({
        legacyDetected: true,
        userNoticed: false,
        detectedAt: Date.now(),
        noticedAt: null,
        detectedCounts: { documents: 3, chat_sessions: 5, chat_messages: 42, memories: 12 },
      })
    }
    return () => {
      delete (window as unknown as Record<string, unknown>).__testLegacyModal
    }
  }, [])

  useLayoutEffect(() => {
    syncDocumentTheme(themeId)
  }, [themeId])

  // 禁用浏览器默认右键菜单
  useEffect(() => {
    const handler = (e: MouseEvent) => e.preventDefault()
    document.addEventListener('contextmenu', handler)
    return () => document.removeEventListener('contextmenu', handler)
  }, [])

  useEffect(() => {
    let cancelled = false
    let stopReadingReminderRuntime: (() => void) | undefined
    async function init() {
      const appInitStartedAt = performance.now()

      try {
        await waitForStartupPoint('app-shell-interactive')
        if (cancelled) return

        // 密钥与 Markdown 首屏无关；AI 消费入口通过统一 Promise 等待水合。
        const secretsStartedAt = performance.now()
        void ensureSettingsSecretsHydrated().then(() => {
          markStartupPoint('secrets-hydrated')
          logDuration('settings secret hydration', secretsStartedAt)
        }).catch((err) => {
          console.warn('[App] Settings secret hydration failed:', err)
        })

        const databaseStartedAt = performance.now()
        const restoreTabsStartedAt = performance.now()
        const databaseReady = initDatabase().then(() => {
          markStartupPoint('database-ready')
          logDuration('database init', databaseStartedAt)
        })
        void databaseReady.catch(() => undefined)
        const fileAccessRestore = await waitForFileAccessRestore()
        if (!fileAccessRestore.restoreSucceeded || !fileAccessRestore.legacyMigrationCompleted) {
          await databaseReady
          const migrationStartedAt = performance.now()
          try {
            await migrateLegacyFileAccess()
            logDuration('legacy file access migration', migrationStartedAt)
          } catch (error) {
            console.warn('[App] Legacy file access migration failed:', error)
          }
        } else if (isTauri()) {
          // Rust 是迁移最终事实；成功状态也要把兼容缓存标记补齐。
          markLegacyFileAccessMigrationDone()
        }
        await Promise.all([
          databaseReady,
          restoreTabs().then(() => {
            logDuration('tabs restored', restoreTabsStartedAt)
          }),
        ])

        if (getDatabaseRuntimeState().status !== 'ready') {
          throw new Error('Database not ready after init')
        }

        // ==================== UI 就绪：立即显示界面 ====================
        if (!cancelled) {
          setAppReady(true)
          eventMarker.mark('app-ready')
          markStartupPoint('app-ready')
        }
        logDuration('ui ready', appInitStartedAt)

        // ==================== 首屏后：注册闲时预热任务 ====================
        if (READING_REMINDER_FEATURE_AVAILABLE) {
          void import('@/services/readingReminders')
            .then(({ reconcileReadingReminders }) => reconcileReadingReminders())
            .then(() => import('@/services/readingReminderRuntime'))
            .then(({ startReadingReminderRuntime, stopReadingReminderRuntime: stopRuntime }) => {
              if (cancelled) return
              stopReadingReminderRuntime = stopRuntime
              startReadingReminderRuntime()
            })
            .catch((error) => console.warn('[Reminder] startup reconciliation failed:', error))
        }

        scheduleIdleWarmup()

      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error('[App] Database init failed:', msg)
        if (!cancelled) {
          toast.show({
            id: 'database-init-failed',
            title: '数据库初始化失败',
            message: '数据库初始化失败，部分数据可能无法保存',
            type: 'error',
            duration: null,
          })
        }
        logDuration('app init failed', appInitStartedAt)
      }
    }

    void init()
    return () => {
      cancelled = true
      stopReadingReminderRuntime?.()
    }
  }, [])

  return (
    <>
      <CustomCursorFrame enabled={customCursorEnabled}>
        <AppLayout />
      </CustomCursorFrame>
      <ToastContainer />
      {DevPerfMonitorPanel && <Suspense fallback={null}><DevPerfMonitorPanel /></Suspense>}
      <Suspense fallback={null}><UpdateManager /></Suspense>
      <GlobalTooltip />
      {legacyDetection && (
        <Suspense fallback={null}><LegacyDataNoticeModal
          detection={legacyDetection}
          onClose={() => setLegacyDetection(null)}
        /></Suspense>
      )}
    </>
  )
}

export default App
