import { eventMarker, type PerfEventType } from '@/services/eventMarker'
import { isTauri } from '@/hooks/useTauri'

export type StartupPerformancePoint =
  | 'frontend-bootstrap'
  | 'first-react-render'
  | 'app-shell-first-visible'
  | 'app-shell-interactive'
  | 'secrets-hydrated'
  | 'database-init-start'
  | 'database-plugin-loaded'
  | 'database-connection-opened'
  | 'database-schema-gate-complete'
  | 'database-ready'
  | 'active-tab-disk-read-complete'
  | 'active-document-first-visible'
  | 'editor-first-visible'
  | 'preview-first-visible'
  | 'preview-render-complete'
  | 'app-ready'
  | 'app-module-ready'
  | 'main-module-evaluated'
  | 'create-root-start'
  | 'react-render-start'
  | 'react-mounted'
  | 'startup-shell-removed'
  | 'first-animation-frame'
  | 'startup-session-restore-complete'
  | 'window-shown'

const MARK_PREFIX = 'guanmo:startup:'
const completedPoints = new Set<StartupPerformancePoint>()
const pointWaiters = new Map<StartupPerformancePoint, Set<() => void>>()

export function waitForStartupPoint(point: StartupPerformancePoint): Promise<void> {
  if (completedPoints.has(point)) return Promise.resolve()
  return new Promise((resolve) => {
    const waiters = pointWaiters.get(point) ?? new Set<() => void>()
    waiters.add(resolve)
    pointWaiters.set(point, waiters)
  })
}

export function markStartupPoint(
  point: StartupPerformancePoint,
  metadata?: Record<string, unknown>,
): void {
  if (completedPoints.has(point)) return
  completedPoints.add(point)
  for (const resolve of pointWaiters.get(point) ?? []) resolve()
  pointWaiters.delete(point)

  // Release 冷启动埋点：满足触发条件后调度一次性冲刷（详见下方 Release 埋点说明）。
  if (
    point === 'startup-session-restore-complete' ||
    point === 'active-document-first-visible' ||
    point === 'app-ready'
  ) {
    scheduleReleaseMetricsFlushWhenSettled()
  }
  if (point === 'app-ready') {
    scheduleReleaseMetricsFlush(METRICS_FLUSH_APP_READY_FALLBACK_MS)
  }
  if (point === 'app-shell-interactive') {
    scheduleReleaseMetricsFlush(METRICS_FLUSH_SAFETY_NET_MS)
  }

  if (typeof performance === 'undefined') return
  const markName = `${MARK_PREFIX}${point}`
  if (performance.getEntriesByName(markName, 'mark').length === 0) {
    performance.mark(markName)
  }
  if (import.meta.env.DEV) {
    // 新增点位不在 PerfEventType 中：Extract 保证仅对既有兼容点位通过类型收窄
    eventMarker.mark(point as Extract<StartupPerformancePoint, PerfEventType>, metadata)
    if (point === 'app-ready') scheduleStartupTimelineReport()
  }
}

// ==================== Release 冷启动埋点 ====================
//
// 前端不做任何运行期主动采样：全部点位复用既有 performance.mark 缓冲与浏览器
// paint timing，启动完成后一次性发送给 Rust（单次 IPC），由 Rust 合并 T0/T1/T2
// 并追加写入 JSONL。时间基准统一为 Unix epoch 毫秒：
// performance.timeOrigin + entry.startTime。
//
// 正式桌面版本记录到有界诊断日志；startup-metrics feature 额外保留原始性能测试文件。
// Web 构建不调度任何定时器。

/** T 点位 → 既有 performance.mark 点名（不含前缀）。T6 由 paint timing 单独提供。 */
const RELEASE_METRIC_MARKS: Readonly<Record<string, string>> = {
  T4_HTML_START: 'html-start',
  T5_DOM_READY: 'startup-shell-dom-ready',
  T7_MAIN_TS_START: 'main-module-evaluated',
  T8_REACT_RENDER_START: 'react-render-start',
  T9_APP_MOUNTED: 'react-mounted',
  T10_MAIN_UI_PAINT: 'app-shell-first-visible',
  T11_WINDOW_SHOW: 'window-shown',
  T12_SESSION_RESTORED: 'startup-session-restore-complete',
  T13_DOCUMENT_VISIBLE: 'active-document-first-visible',
  DATABASE_READY: 'database-ready',
  SECRETS_HYDRATED: 'secrets-hydrated',
  APP_READY: 'app-ready',
  EDITOR_VISIBLE: 'editor-first-visible',
  PREVIEW_VISIBLE: 'preview-first-visible',
  PREVIEW_RENDER_COMPLETE: 'preview-render-complete',
}

const METRICS_FLUSH_SETTLED_DELAY_MS = 1500
const METRICS_FLUSH_APP_READY_FALLBACK_MS = 15000
const METRICS_FLUSH_SAFETY_NET_MS = 30000

let releaseMetricsFlushed = false
let releaseMetricsSettledHookArmed = false

function scheduleReleaseMetricsFlush(delayMs: number): void {
  if (releaseMetricsFlushed || !isTauri()) return
  setTimeout(() => {
    void flushReleaseMetrics()
  }, delayMs)
}

/**
 * T12 与 T13 均完成后再冲刷：启动快照可能让 T13 先于 T12 出现，
 * 任一先到时挂等待，避免冲刷过早漏掉后完成的点位。
 * 两个点位均未到达时由 app-ready 兜底与 app-shell-interactive 安全网覆盖。
 */
function scheduleReleaseMetricsFlushWhenSettled(): void {
  if (releaseMetricsSettledHookArmed) return
  releaseMetricsSettledHookArmed = true
  void Promise.all([
    waitForStartupPoint('startup-session-restore-complete'),
    waitForStartupPoint('active-document-first-visible'),
  ]).then(() => scheduleReleaseMetricsFlush(METRICS_FLUSH_SETTLED_DELAY_MS))
}

async function flushReleaseMetrics(): Promise<void> {
  if (releaseMetricsFlushed) return
  releaseMetricsFlushed = true
  if (!isTauri() || typeof performance === 'undefined') return

  const markStarts = new Map<string, number>()
  for (const entry of performance.getEntriesByType('mark')) {
    if (!entry.name.startsWith(MARK_PREFIX)) continue
    const point = entry.name.slice(MARK_PREFIX.length)
    if (!markStarts.has(point)) markStarts.set(point, entry.startTime)
  }

  const points: Record<string, number> = {}
  for (const [metricPoint, markName] of Object.entries(RELEASE_METRIC_MARKS)) {
    const startTime = markStarts.get(markName)
    if (startTime !== undefined) {
      points[metricPoint] = Math.round(performance.timeOrigin + startTime)
    }
  }
  // T6_SKELETON_PAINT：浏览器首帧绘制（此刻唯一可见内容为静态骨架屏）。
  // visible:false 冷启动策略下首帧可能推迟到窗口显示（T11）之后，如实记录。
  const firstPaint = performance
    .getEntriesByType('paint')
    .find((entry) => entry.name === 'first-paint')
  if (firstPaint) {
    points.T6_SKELETON_PAINT = Math.round(performance.timeOrigin + firstPaint.startTime)
  }

  const payload = { points, recordedAt: new Date().toISOString() }
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    await invoke('record_startup_metrics', { payload })
  } catch (error) {
    console.debug('[Startup] record_startup_metrics rejected:', error)
  }
}

const STARTUP_TIMELINE_SEMANTICS: ReadonlyArray<{ point: string; semantic: string }> = [
  { point: 'html-start', semantic: 'HTML 解析开始（head 内首个同步 mark，导航零点为 timeOrigin）' },
  { point: 'startup-shell-dom-ready', semantic: '静态 Startup Shell DOM 已提交给解析器（未绘制）' },
  { point: 'html-parsed', semantic: 'HTML 解析到达文档尾部' },
  { point: 'main-module-requested', semantic: '开始请求/解析 main.tsx 静态依赖图' },
  { point: 'app-module-ready', semantic: '@app-entry 及静态依赖完成加载求值（与下一行同边界）' },
  { point: 'main-module-evaluated', semantic: 'main.tsx 模块体开始执行' },
  { point: 'frontend-bootstrap', semantic: '前端引导（历史点位）' },
  { point: 'create-root-start', semantic: '调用 ReactDOM.createRoot 之前' },
  { point: 'react-render-start', semantic: '调用 root.render 之前' },
  { point: 'react-mounted', semantic: 'React 首次真实 DOM commit 完成' },
  { point: 'startup-shell-removed', semantic: '静态 Shell 已被 React 接管移除' },
  { point: 'window-shown', semantic: '主窗口 show() 完成（visible:false 冷启动的显示点）' },
  { point: 'first-react-render', semantic: 'App 组件首次渲染执行' },
  { point: 'first-animation-frame', semantic: '首个 RAF callback 到达（不代表交互就绪）' },
  { point: 'app-shell-first-visible', semantic: '真实 AppShell 首次可见' },
  { point: 'app-shell-interactive', semantic: '真实 AppShell passive 交互就绪' },
  { point: 'database-init-start', semantic: '数据库初始化开始' },
  { point: 'database-plugin-loaded', semantic: '数据库插件加载完成' },
  { point: 'database-connection-opened', semantic: '数据库连接打开' },
  { point: 'database-schema-gate-complete', semantic: '数据库 schema 门禁完成' },
  { point: 'database-ready', semantic: '数据库就绪' },
  { point: 'active-tab-disk-read-complete', semantic: '活动标签磁盘读取/校验完成' },
  { point: 'startup-session-restore-complete', semantic: '启动关键路径会话恢复完成（不含后台标签）' },
  { point: 'secrets-hydrated', semantic: '设置密钥水合完成' },
  { point: 'active-document-first-visible', semantic: '活动文档首次真实可见' },
  { point: 'editor-first-visible', semantic: '编辑器 surface 首次可见' },
  { point: 'preview-first-visible', semantic: '预览 surface 首次可见' },
  { point: 'preview-render-complete', semantic: '预览渲染完成' },
  { point: 'app-ready', semantic: '后台就绪（数据库与启动关键路径恢复完成）' },
]

let startupTimelineReportScheduled = false

/** DEV 专用：app-ready 到达后延迟输出一次启动时间线，等待后续 surface 点位落盘。 */
function scheduleStartupTimelineReport(): void {
  if (startupTimelineReportScheduled) return
  startupTimelineReportScheduled = true
  setTimeout(() => printStartupTimeline(), 300)
}

function printStartupTimeline(): void {
  if (typeof performance === 'undefined') return
  const semantics = new Map(STARTUP_TIMELINE_SEMANTICS.map((item) => [item.point, item.semantic]))
  const startTimes = new Map<string, number>()
  for (const entry of performance.getEntriesByType('mark')) {
    if (!entry.name.startsWith(MARK_PREFIX)) continue
    const point = entry.name.slice(MARK_PREFIX.length)
    if (semantics.has(point) && !startTimes.has(point)) startTimes.set(point, entry.startTime)
  }

  const boundary = (point: string): string => {
    const startTime = startTimes.get(point)
    return startTime === undefined ? 'missing' : `${Math.round(startTime)}ms`
  }
  console.info(
    `[Startup] 静态ShellDOM ${boundary('startup-shell-dom-ready')}｜AppShell可见 ${boundary('app-shell-first-visible')}｜AppShell可交互 ${boundary('app-shell-interactive')}｜活动文档可见 ${boundary('active-document-first-visible')}｜后台appReady ${boundary('app-ready')}`,
  )

  const ordered = [...startTimes.entries()].sort((a, b) => a[1] - b[1])
  const rows = ordered.map(([point, startTime], index) => ({
    '点位': point,
    '距timeOrigin': `${Math.round(startTime)}ms`,
    '距上一点位': index === 0 ? '-' : `${Math.round(startTime - ordered[index - 1][1])}ms`,
    '语义': semantics.get(point) ?? '',
  }))
  for (const { point, semantic } of STARTUP_TIMELINE_SEMANTICS) {
    if (!startTimes.has(point)) {
      rows.push({ '点位': point, '距timeOrigin': 'missing', '距上一点位': 'missing', '语义': semantic })
    }
  }
  console.table(rows)
}
