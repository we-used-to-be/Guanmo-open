/**
 * Settings page entry for legacy data migration.
 * Simple detection button with result display below.
 */

import { useState } from 'react'
import { Button } from 'animal-island-ui'
import { toast } from '@/services/toast'
import {
  detectLegacyData,
  getSqliteDatabasePath,
  getLegacyIndexedDBPath,
  type LegacyDetectionResult,
} from '@/services/database/legacyDetector'

const MIGRATION_TOOL_URL = 'https://github.com/we-used-to-be/Guanmo-open/releases/tag/v1.0.0-migration-tool'

export function LegacyMigrationEntry() {
  const [detection, setDetection] = useState<LegacyDetectionResult | null>(null)
  const [loading, setLoading] = useState(false)

  const handleDetect = async () => {
    setLoading(true)
    try {
      const result = await detectLegacyData()
      setDetection(result)
    } catch {
      toast.error('检测失败')
    } finally {
      setLoading(false)
    }
  }

  const handleOpenMigrationTool = async () => {
    try {
      const { open } = await import('@tauri-apps/plugin-shell')
      await open(MIGRATION_TOOL_URL)
    } catch {
      window.open(MIGRATION_TOOL_URL, '_blank', 'noopener,noreferrer')
    }
  }

  return (
    <div className="space-y-3">
      {/* Detection button */}
      <div className="rounded-xl border border-gm-border bg-gm-surface-elevated px-3 py-2">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-body text-gm-text">旧版数据迁移</p>
            <p className="text-caption text-gm-text-tertiary mt-0.5">
              此前采用「SQLite 为主、IndexedDB 兜底」双库方案，现已切换为仅 SQLite。迁移工程量较大，请斟酌是否迁移
            </p>
          </div>
          <Button
            type="default"
            size="small"
            loading={loading}
            onClick={handleDetect}
          >
            检测旧数据
          </Button>
        </div>
      </div>

      {/* Result display */}
      {detection && (
        <div className="rounded-xl border border-gm-border bg-gm-surface-elevated px-3 py-3">
          {!detection.legacyDetected ? (
            <p className="text-body text-gm-text">未检测到旧版数据</p>
          ) : (
            <div className="space-y-3">
              <p className="text-body text-gm-text leading-relaxed">
                检测到旧版 IndexedDB 数据。迁移涉及数据库结构转换和数据校验，工程量较大，请斟酌是否迁移。如需迁移，请下载迁移工具按指引操作。感谢配合，如有疑问请反馈至 GitHub。
              </p>

              {/* Paths */}
              <div className="space-y-1">
                <div>
                  <p className="text-micro font-bold text-gm-text-tertiary uppercase tracking-wider">
                    SQLite（当前）
                  </p>
                  <code className="mt-1 block text-caption text-gm-text-secondary bg-gm-surface px-2 py-1 rounded">
                    {getSqliteDatabasePath()}
                  </code>
                </div>
                <div>
                  <p className="text-micro font-bold text-gm-text-tertiary uppercase tracking-wider">
                    IndexedDB（旧版）
                  </p>
                  <code className="mt-1 block text-caption text-gm-text-secondary bg-gm-surface px-2 py-1 rounded">
                    {getLegacyIndexedDBPath()}
                  </code>
                </div>
              </div>

              {/* Actions */}
              <Button
                type="default"
                size="small"
                onClick={handleOpenMigrationTool}
              >
                下载迁移工具
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
