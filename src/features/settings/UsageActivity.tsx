import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button, Switch } from 'animal-island-ui'
import { Settings2 } from 'lucide-react'
import { isTauri } from '@/hooks/useTauri'
import { useSettingsStore } from '@/stores/settingsStore'
import { toast } from '@/services/toast'
import {
  clearUsageDataWithLifecycle,
  checkpointUsageTracking,
  formatDuration,
  getHeatLevel,
  getLocalDateKey,
  getTwelveMonthRange,
  getUsageSnapshot,
  loadUsageActivity,
  queryUsageToday,
  queryUsageTotal,
  setUsageTrackingEnabled,
  getPendingSnapshot,
  subscribeUsageSnapshot,
} from '@/services/usageTracking'
import type { UsageTrackingError } from '@/services/usageTracking'
import { UsageReceiptDialog } from './UsageReceiptDialog'
import { buildUsageReceipt, chooseReceiptQuote, type UsageReceipt } from './usageReceipt'

// ---------------------------------------------------------------------------
// 热力图数据生成
// ---------------------------------------------------------------------------

interface HeatCell {
  date: string
  level: 0 | 1 | 2 | 3 | 4
  seconds: number
  dayOfWeek: number // 0=Sun, 1=Mon, ..., 6=Sat
  weekIndex: number
  isPadding: boolean
}

interface MonthLabel {
  month: number // 1-12
  year: number
  weekIndex: number
}

function toLocalLabel(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number)
  return `${y}年${m}月${d}日`
}

function buildHeatGrid(
  rangeStart: string,
  rangeEnd: string,
  data: Map<string, number>,
): { cells: HeatCell[]; monthLabels: MonthLabel[]; weekCount: number } {
  const startDate = new Date(rangeStart + 'T00:00:00')
  const endDate = new Date(rangeEnd + 'T00:00:00')

  // 收集所有日期
  const dates: string[] = []
  const cursor = new Date(startDate)
  while (cursor <= endDate) {
    dates.push(getLocalDateKey(cursor))
    cursor.setDate(cursor.getDate() + 1)
  }

  if (dates.length === 0) return { cells: [], monthLabels: [], weekCount: 0 }

  // 第一天是周几（0=Sun, 1=Mon, ..., 6=Sat）
  // 我们希望周一为行首(1)，周日为行尾(0映射为7)
  const firstDay = new Date(dates[0] + 'T00:00:00').getDay() // 0=Sun
  const firstDayAdjusted = firstDay === 0 ? 6 : firstDay - 1 // Mon=0, ..., Sun=6

  // 前置填充空格
  const paddingBefore: string[] = []
  for (let i = 0; i < firstDayAdjusted; i++) {
    paddingBefore.push('')
  }

  const allDates = [...paddingBefore, ...dates]

  // 计算周数
  const weekCount = Math.ceil(allDates.length / 7)

  // 构建 cells（row-major: 每列一周，列内周一至周日）
  const cells: HeatCell[] = []
  for (let weekIndex = 0; weekIndex < weekCount; weekIndex++) {
    for (let dayOfWeek = 0; dayOfWeek < 7; dayOfWeek++) {
      const idx = weekIndex * 7 + dayOfWeek
      const date = idx < allDates.length ? allDates[idx] : ''

      if (!date) {
        cells.push({
          date: '',
          level: 0,
          seconds: 0,
          dayOfWeek,
          weekIndex,
          isPadding: true,
        })
        continue
      }

      const seconds = data.get(date) ?? 0
      const minutes = Math.floor(seconds / 60)
      cells.push({
        date,
        level: getHeatLevel(minutes),
        seconds,
        dayOfWeek,
        weekIndex,
        isPadding: false,
      })
    }
  }

  // 月份标签：每月第一天的 weekIndex
  const monthLabels: MonthLabel[] = []
  let lastMonth = -1
  let lastYear = -1
  for (const date of dates) {
    const [y, m] = date.split('-').map(Number)
    if (m !== lastMonth || y !== lastYear) {
      lastMonth = m
      lastYear = y
      // 该日期在 allDates 中的位置
      const dateIdx = paddingBefore.length + dates.indexOf(date)
      const weekIdx = Math.floor(dateIdx / 7)
      monthLabels.push({ month: m, year: y, weekIndex: weekIdx })
    }
  }

  return { cells, monthLabels, weekCount }
}

// ---------------------------------------------------------------------------
// 确认弹窗
// ---------------------------------------------------------------------------

function ClearConfirmDialog({
  open,
  onCancel,
  onConfirm,
  busy,
}: {
  open: boolean
  onCancel: () => void
  onConfirm: () => void
  busy: boolean
}) {
  if (!open) return null

  return (
    <div className="gm-usage-dialog-scrim" onClick={busy ? undefined : onCancel}>
      <div className="gm-usage-dialog-panel" onClick={(e) => e.stopPropagation()}>
        <div className="gm-usage-dialog-title">清空使用时长记录</div>
        <div className="gm-usage-dialog-body">
          清空全部使用时长记录？此操作不可恢复，清空后将从当前时刻重新统计。
        </div>
        <div className="gm-usage-dialog-actions">
          <Button type="default" size="small" onClick={onCancel} disabled={busy}>
            取消
          </Button>
          <Button type="default" size="small" danger onClick={onConfirm} loading={busy}>
            清空
          </Button>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// 主组件
// ---------------------------------------------------------------------------

type UsageStatusTone = 'active' | 'inactive' | 'error'

function getUsageStatus(
  enabled: boolean,
  isActive: boolean,
  error: UsageTrackingError | null,
): { label: string; tone: UsageStatusTone } {
  if (error?.kind === 'database_write') {
    return { label: '保存失败，待写入时间已保留', tone: 'error' }
  }
  if (error?.kind === 'database_read') {
    return { label: '统计数据加载失败', tone: 'error' }
  }
  if (error?.kind === 'window_state') {
    return { label: '窗口状态暂不可用', tone: 'error' }
  }
  if (error?.kind === 'startup') {
    return { label: '统计启动失败，正在重试', tone: 'error' }
  }
  if (!enabled) {
    return { label: '统计已关闭', tone: 'inactive' }
  }
  return isActive
    ? { label: '正在统计', tone: 'active' }
    : { label: '当前未激活', tone: 'inactive' }
}

export function UsageActivity() {
  const enabled = useSettingsStore((s) => s.usageTracking.enabled)
  const initialSnapshot = useMemo(() => getUsageSnapshot(), [])

  const [todaySeconds, setTodaySeconds] = useState(0)
  const [totalSeconds, setTotalSeconds] = useState(0)
  const [activityData, setActivityData] = useState<Map<string, number>>(new Map())
  const [clearBusy, setClearBusy] = useState(false)
  const [refreshBusy, setRefreshBusy] = useState(false)
  const [showClearDialog, setShowClearDialog] = useState(false)
  const [receipt, setReceipt] = useState<UsageReceipt | null>(null)
  const [receiptBusy, setReceiptBusy] = useState(false)
  const previousQuoteRef = useRef<string | null>(null)
  const receiptRequestRef = useRef(false)
  const [trackingActive, setTrackingActive] = useState(initialSnapshot.isActive)
  const [trackingError, setTrackingError] = useState<UsageTrackingError | null>(initialSnapshot.error)
  const mountedRef = useRef(true)
  const refreshGenerationRef = useRef(0)
  const displayRemainderMsRef = useRef(new Map<string, number>())

  const range = useMemo(() => getTwelveMonthRange(), [])

  // 加载统计数据
  const refreshStats = useCallback(async (): Promise<boolean> => {
    const requestId = ++refreshGenerationRef.current
    try {
      const [today, total, data] = await Promise.all([
        queryUsageToday(),
        queryUsageTotal(),
        loadUsageActivity(range.start, range.end),
      ])
      if (!mountedRef.current || requestId !== refreshGenerationRef.current) return true
      // 合并全部 pending 日期
      const pendingSnapshot = getPendingSnapshot()
      const todayKey = getLocalDateKey()
      const pendingToday = pendingSnapshot.get(todayKey) ?? 0
      let pendingTotal = 0
      for (const seconds of pendingSnapshot.values()) {
        pendingTotal += seconds
      }
      setTodaySeconds(today + pendingToday)
      setTotalSeconds(total + pendingTotal)
      setActivityData(data)
      const snapshot = getUsageSnapshot()
      setTrackingActive(snapshot.isActive)
      setTrackingError(snapshot.error)
      return true
    } catch {
      // 数据库不可用时保持旧值
      if (mountedRef.current && requestId === refreshGenerationRef.current) {
        setTrackingError(getUsageSnapshot().error)
      }
      return false
    }
  }, [range.start, range.end])

  useEffect(() => {
    mountedRef.current = true
    refreshStats()

    // 订阅快照变更
    const unsub = subscribeUsageSnapshot((snapshot) => {
      if (!mountedRef.current) return
      setTrackingActive(snapshot.isActive)
      setTrackingError(snapshot.error)

      if (snapshot.reset) {
        displayRemainderMsRef.current.clear()
        setTodaySeconds(0)
        setTotalSeconds(0)
        setActivityData(new Map())
        return
      }

      if (snapshot.capturedMsByDate.size === 0) return

      const todayKey = getLocalDateKey()
      const increments = new Map<string, number>()
      let todayIncrement = 0
      let totalIncrement = 0

      for (const [date, capturedMs] of snapshot.capturedMsByDate) {
        const totalMs = (displayRemainderMsRef.current.get(date) ?? 0) + capturedMs
        const seconds = Math.floor(totalMs / 1000)
        displayRemainderMsRef.current.set(date, totalMs - seconds * 1000)
        if (seconds <= 0) continue
        increments.set(date, seconds)
        totalIncrement += seconds
        if (date === todayKey) todayIncrement += seconds
      }

      if (totalIncrement <= 0) return
      setTotalSeconds((current) => current + totalIncrement)
      if (todayIncrement > 0) {
        setTodaySeconds((current) => current + todayIncrement)
      }
      setActivityData((current) => {
        const next = new Map(current)
        for (const [date, seconds] of increments) {
          next.set(date, (next.get(date) ?? 0) + seconds)
        }
        return next
      })
    })

    return () => {
      mountedRef.current = false
      refreshGenerationRef.current += 1
      unsub()
    }
  }, [refreshStats])

  // 热力图数据
  const { cells, monthLabels, weekCount } = useMemo(
    () => buildHeatGrid(range.start, range.end, activityData),
    [range.start, range.end, activityData],
  )

  // 切换开关
  const handleToggle = useCallback(async (v: boolean) => {
    try {
      await setUsageTrackingEnabled(v)
    } catch {
      toast.error('切换使用统计失败')
    }
  }, [])

  const handleRefresh = useCallback(async () => {
    setRefreshBusy(true)
    try {
      await checkpointUsageTracking()
      const refreshed = await refreshStats()
      if (!refreshed) toast.error('刷新使用统计失败')
    } catch {
      toast.error('刷新使用统计失败')
    } finally {
      if (mountedRef.current) setRefreshBusy(false)
    }
  }, [refreshStats])

  const handlePrint = useCallback(async () => {
    if (receiptRequestRef.current) return
    receiptRequestRef.current = true
    setReceiptBusy(true)
    try {
      await checkpointUsageTracking()
      const [today, total, activity] = await Promise.all([
        queryUsageToday(), queryUsageTotal(), loadUsageActivity(range.start, range.end),
      ])
      if (!mountedRef.current) return
      const pending = getPendingSnapshot()
      const date = getLocalDateKey()
      const quote = chooseReceiptQuote(previousQuoteRef.current)
      setReceipt(buildUsageReceipt(
        total + [...pending.values()].reduce((sum, seconds) => sum + seconds, 0),
        today + (pending.get(date) ?? 0), activity, range, date, quote,
      ))
      previousQuoteRef.current = quote
    } catch {
      if (mountedRef.current) toast.error('生成时光回顾失败，请重试')
    } finally {
      receiptRequestRef.current = false
      if (mountedRef.current) setReceiptBusy(false)
    }
  }, [range])

  const closeReceipt = useCallback(() => setReceipt(null), [])

  // 清空
  const handleClear = useCallback(async () => {
    setClearBusy(true)
    try {
      await clearUsageDataWithLifecycle()
      setShowClearDialog(false)
      toast.success('使用时长记录已清空')
      await refreshStats()
    } catch {
      toast.error('清空使用时长记录失败')
    } finally {
      if (mountedRef.current) setClearBusy(false)
    }
  }, [refreshStats])

  if (!isTauri()) return null

  const status = getUsageStatus(enabled, trackingActive, trackingError)

  // 一周列标题
  const dayLabels = ['一', '二', '三', '四', '五', '六', '日']

  return (
    <div className="gm-usage">
      <div className="gm-usage-header">
        <div className="gm-usage-heading">
          <span className="gm-usage-header-title">使用统计</span>
        </div>
        <div className="gm-usage-header-actions">
          <span className={`gm-usage-status gm-usage-status--${status.tone}`} role="status" aria-live="polite">
            <span className="gm-usage-status-dot" aria-hidden="true" />{status.label}
          </span>
          <Button type="text" size="small" loading={receiptBusy} disabled={clearBusy || refreshBusy} onClick={handlePrint}>
            生成回顾
          </Button>
          <details className="gm-usage-more"
            onClick={(event) => {
              if ((event.target as HTMLElement).closest('.gm-usage-menu-action')) event.currentTarget.open = false
            }}
            onBlur={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) event.currentTarget.open = false
            }}
            onKeyDown={(event) => {
              if (event.key === 'Escape') event.currentTarget.open = false
            }}>
            <summary aria-label="统计设置" title="统计设置"><Settings2 size={15} /></summary>
            <div className="gm-usage-more-panel">
              <label className="gm-usage-record-setting">
                <span>记录使用时长</span>
                <Switch size="small" checked={enabled} onChange={handleToggle} />
              </label>
              <div className="gm-usage-menu-action"><Button type="text" size="small" loading={refreshBusy} disabled={receiptBusy || clearBusy} onClick={handleRefresh}>刷新统计</Button></div>
              <div className="gm-usage-menu-action"><Button type="text" size="small" disabled={receiptBusy || refreshBusy} onClick={() => setShowClearDialog(true)}>清空使用数据</Button></div>
            </div>
          </details>
        </div>
      </div>

      {/* 统计卡 */}
      <div className="gm-usage-stats">
        <div className="gm-usage-stat">
          <div className="gm-usage-stat-label">累计使用时长</div>
          <div className="gm-usage-stat-value">{formatDuration(totalSeconds)}</div>
        </div>
        <div className="gm-usage-stat">
          <div className="gm-usage-stat-label">今日使用时长</div>
          <div className="gm-usage-stat-value">{formatDuration(todaySeconds)}</div>
        </div>
      </div>

      {/* 使用活动 */}
      <div className="gm-usage-activity">
        <div className="gm-usage-activity-title">使用活动</div>
        <div className="gm-usage-heatmap-wrapper">
          <div className="gm-usage-heatmap">
            <div className="gm-usage-heatmap-body">
              {/* 周标签列（纵向 7 行） */}
              <div className="gm-usage-heatmap-labels">
                {dayLabels.map((label) => (
                  <div key={label} className="gm-usage-heatmap-day-label">
                    {label}
                  </div>
                ))}
              </div>

              {/* 热力格子 */}
              <div
                className="gm-usage-heatmap-grid"
                style={{ gridTemplateColumns: `repeat(${weekCount}, minmax(0, 1fr))` }}
              >
                {cells.map((cell, idx) => (
                  <div
                    key={`${cell.weekIndex}-${cell.dayOfWeek}-${idx}`}
                    className={`gm-usage-heatmap-cell${cell.isPadding ? ' gm-usage-heatmap-cell--pad' : ''}`}
                    data-level={cell.isPadding ? undefined : cell.level}
                    tabIndex={cell.isPadding ? undefined : 0}
                    role={cell.isPadding ? undefined : 'gridcell'}
                    title={
                      cell.isPadding
                        ? undefined
                        : `${toLocalLabel(cell.date)} · ${formatDuration(cell.seconds)}`
                    }
                    aria-label={
                      cell.isPadding
                        ? undefined
                        : `${toLocalLabel(cell.date)}，${formatDuration(cell.seconds)}`
                    }
                  />
                ))}
              </div>
            </div>

            {/* 月份标签 */}
            <div className="gm-usage-heatmap-months">
              {monthLabels.map((ml, idx) => {
                const leftPct = weekCount > 0 ? (ml.weekIndex / weekCount) * 100 : 0
                return (
                  <div
                    key={`${ml.year}-${ml.month}-${idx}`}
                    className="gm-usage-heatmap-month"
                    style={{ left: `${leftPct}%` }}
                  >
                    {ml.month}月
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      </div>

      <ClearConfirmDialog
        open={showClearDialog}
        onCancel={() => setShowClearDialog(false)}
        onConfirm={handleClear}
        busy={clearBusy}
      />
      {receipt && <UsageReceiptDialog receipt={receipt} onClose={closeReceipt} />}
    </div>
  )
}
