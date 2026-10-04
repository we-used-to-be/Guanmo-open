import { useEffect, useState } from 'react'
import { Button, Switch } from 'animal-island-ui'
import { isTauri } from '@/hooks/useTauri'
import { toast } from '@/services/toast'
import {
  clearDiagnostics,
  exportDiagnostics,
  getDetailedDiagnostics,
  openDiagnosticsDirectory,
  setDetailedDiagnostics,
} from '@/services/productionDiagnostics'

export function DiagnosticsSettings() {
  const [detailed, setDetailed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [confirmClear, setConfirmClear] = useState(false)
  const desktop = isTauri()

  useEffect(() => {
    if (!desktop) return
    let active = true
    void getDetailedDiagnostics().then((value) => {
      if (active) setDetailed(value)
    }).catch(() => {
      if (active) toast.error('无法读取诊断设置')
    })
    return () => { active = false }
  }, [desktop])

  const run = async (operation: () => Promise<void>, failure: string) => {
    setBusy(true)
    try {
      await operation()
    } catch {
      toast.error(failure)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="w-full space-y-4 pb-6">
      <div>
        <h3 className="text-body font-semibold text-gm-text">诊断日志</h3>
        <p className="mt-1 text-caption text-gm-text-secondary">
          记录启动阶段和关键故障的状态与耗时。日志不保存文档正文、AI 对话、密钥或完整文件路径。
        </p>
      </div>
      {!desktop ? (
        <p className="rounded-xl border border-gm-border bg-gm-surface-elevated p-3 text-caption text-gm-text-secondary">
          网页版不提供本地诊断日志。
        </p>
      ) : (
        <>
          <div className="flex items-center justify-between gap-3 rounded-xl border border-gm-border bg-gm-surface-elevated p-3">
            <div>
              <div className="text-body text-gm-text">详细诊断模式</div>
              <p className="text-caption text-gm-text-secondary">额外记录慢路径；关闭后仅保留启动指标和关键失败。设置在下次启动后继续生效。</p>
            </div>
            <Switch checked={detailed} disabled={busy} onChange={(value) => {
              void run(async () => {
                await setDetailedDiagnostics(value)
                setDetailed(value)
              }, '无法切换详细诊断模式')
            }} />
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="default" size="small" disabled={busy} onClick={() => void run(async () => {
              if (await exportDiagnostics()) toast.success('诊断包已导出')
            }, '导出诊断包失败')}>导出 diagnostics zip</Button>
            <Button type="default" size="small" disabled={busy} onClick={() => void run(openDiagnosticsDirectory, '无法打开诊断目录')}>打开日志目录</Button>
            <Button type="text" size="small" className="text-gm-error" disabled={busy} onClick={() => setConfirmClear(true)}>清除日志</Button>
          </div>
          {confirmClear && (
            <div className="rounded-xl border border-gm-border bg-gm-surface-elevated p-3 text-caption text-gm-text-secondary">
              <p>仅清除诊断目录中的 diagnostics-0.jsonl 至 diagnostics-4.jsonl；不会删除性能测试文件、设置或用户数据。确定清除？</p>
              <div className="mt-3 flex gap-2">
                <Button type="text" size="small" className="text-gm-error" disabled={busy} onClick={() => void run(async () => {
                  await clearDiagnostics()
                  setConfirmClear(false)
                  toast.success('诊断日志已清除')
                }, '清除诊断日志失败')}>确定清除</Button>
                <Button type="default" size="small" disabled={busy} onClick={() => setConfirmClear(false)}>取消</Button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}
