/**
 * Modal to notify user about legacy IndexedDB data.
 * Shown once when legacy data is first detected.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from 'animal-island-ui'
import {
  markLegacyDetected,
  getSqliteDatabasePath,
  getLegacyIndexedDBPath,
  type LegacyDetectionResult,
} from '@/services/database/legacyDetector'

const MIGRATION_TOOL_URL = 'https://github.com/we-used-to-be/Guanmo-open/releases/tag/v1.0.0-migration-tool'

interface LegacyDataNoticeModalProps {
  detection: LegacyDetectionResult
  onClose: () => void
}

export function LegacyDataNoticeModal({ detection, onClose }: LegacyDataNoticeModalProps) {
  const [closing, setClosing] = useState(false)
  const closingRef = useRef(false)
  const closeTimerRef = useRef<number>()

  const requestClose = useCallback(async () => {
    if (closingRef.current) return

    // Mark as noticed before closing
    try {
      await markLegacyDetected()
    } catch {
      // Continue closing even if persist fails
    }

    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      onClose()
      return
    }

    closingRef.current = true
    setClosing(true)
    closeTimerRef.current = window.setTimeout(onClose, 160)
  }, [onClose])

  useEffect(() => {
    return () => {
      if (closeTimerRef.current) window.clearTimeout(closeTimerRef.current)
    }
  }, [])

  const handleOpenMigrationTool = async () => {
    try {
      const { open } = await import('@tauri-apps/plugin-shell')
      await open(MIGRATION_TOOL_URL)
    } catch {
      window.open(MIGRATION_TOOL_URL, '_blank', 'noopener,noreferrer')
    }
  }

  return (
    <div
      data-closing={closing || undefined}
      className="gm-legacy-modal-scrim fixed inset-0 z-[1100] flex items-center justify-center bg-black/45 p-5"
      role="dialog"
      aria-modal="true"
      aria-labelledby="legacy-notice-title"
    >
      <div
        className="gm-legacy-modal-dialog w-full max-w-md rounded-2xl border border-gm-border bg-gm-surface shadow-2xl"
      >
        {/* Header */}
        <header className="border-b border-gm-border px-5 py-4">
          <h2 id="legacy-notice-title" className="text-heading font-bold text-gm-text">
            检测到旧版数据需要迁移
          </h2>
          <p className="mt-1.5 text-caption text-gm-text-secondary leading-relaxed">
            此前观墨采用「SQLite 为主、IndexedDB 兜底」的双库保障方案。为简化架构、便于后续业务迭代，现已切换为仅 SQLite。
            <br />
            旧版 IndexedDB 中的数据需要迁移到新库。迁移涉及数据库结构转换和数据校验，工程量较大，请斟酌是否迁移。
            <br />
            如需迁移，请下载迁移工具按指引操作。感谢配合，如有疑问请反馈至 GitHub。
          </p>
        </header>

        {/* Content */}
        <div className="px-5 py-4">
          {/* Database paths */}
          <div className="space-y-2">
            <div>
              <p className="text-micro font-bold text-gm-text-tertiary uppercase tracking-wider">
                SQLite（当前）
              </p>
              <code className="mt-1 block text-caption text-gm-text-secondary bg-gm-surface-elevated px-2 py-1 rounded">
                {getSqliteDatabasePath()}
              </code>
            </div>
            <div>
              <p className="text-micro font-bold text-gm-text-tertiary uppercase tracking-wider">
                IndexedDB（旧版）
              </p>
              <code className="mt-1 block text-caption text-gm-text-secondary bg-gm-surface-elevated px-2 py-1 rounded">
                {getLegacyIndexedDBPath()}
              </code>
            </div>
          </div>
        </div>

        {/* Actions */}
        <div className="px-5 pb-5">
          <Button
            type="default"
            block
            onClick={handleOpenMigrationTool}
          >
            下载迁移工具
          </Button>
        </div>

        {/* Close link */}
        <div className="border-t border-gm-border px-5 py-3">
          <Button
            type="text"
            block
            onClick={requestClose}
          >
            我知道了
          </Button>
        </div>
      </div>
    </div>
  )
}
