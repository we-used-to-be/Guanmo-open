import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from 'animal-island-ui'
import { MarkdownPreview } from '@/components/editor/MarkdownPreview'
import { toast } from '@/services/toast'
import {
  GITHUB_REPOSITORY_URL,
  LATEST_RELEASE_PAGE_URL,
  openReleaseInSystemBrowser,
} from '@/services/updateService'
import { useUpdateStore } from '@/stores/updateStore'

export function UpdateDetailsModal() {
  const details = useUpdateStore((state) => state.selectedRelease)
  const closeDetails = useUpdateStore((state) => state.closeDetails)
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const closeTimerRef = useRef<number>()
  const closingRef = useRef(false)
  const [closing, setClosing] = useState(false)

  const requestClose = useCallback(() => {
    if (closingRef.current) return
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      closeDetails()
      return
    }
    closingRef.current = true
    setClosing(true)
    closeTimerRef.current = window.setTimeout(closeDetails, 160)
  }, [closeDetails])

  useEffect(() => {
    if (!details) {
      closingRef.current = false
      setClosing(false)
      return
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') requestClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    closeButtonRef.current?.focus()
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      if (closeTimerRef.current) window.clearTimeout(closeTimerRef.current)
    }
  }, [details, requestClose])

  if (!details) return null

  const publishedAt = Number.isNaN(Date.parse(details.release.published_at))
    ? details.release.published_at
    : new Intl.DateTimeFormat('zh-CN', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      }).format(new Date(details.release.published_at))

  const isCurrentRelease = details.mode === 'current'
  const releaseSubtitle = isCurrentRelease
    ? `发布于 ${publishedAt}`
    : `当前版本 v${details.currentVersion} · 发布于 ${publishedAt}`
  const openPage = (url: string, fallbackMessage: string) => {
    void openReleaseInSystemBrowser(url).catch((error) => {
      toast.error(error instanceof Error ? error.message : fallbackMessage)
    })
  }

  return (
    <div
      data-closing={closing || undefined}
      className="gm-release-modal-scrim fixed inset-0 z-[1050] flex items-center justify-center bg-black/45 p-5"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) requestClose()
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="update-details-title"
        className="gm-release-modal-dialog flex max-h-[82vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-gm-border bg-gm-surface shadow-2xl"
      >
        <header className="flex shrink-0 items-start justify-between gap-4 border-b border-gm-border px-5 py-4">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h2 id="update-details-title" className="text-heading font-bold text-gm-text">
                {isCurrentRelease ? '版本速览' : '发现新版本'}
              </h2>
              <span className="rounded-full bg-gm-primary-subtle px-2 py-0.5 text-micro font-bold text-gm-primary">
                v{details.releaseVersion}
              </span>
            </div>
            <p className="mt-1 text-caption text-gm-text-tertiary">
              {releaseSubtitle}
            </p>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            onClick={requestClose}
            aria-label="关闭更新详情"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-gm-text-tertiary transition-colors hover:bg-gm-surface-hover hover:text-gm-text"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <h3 className="mb-3 text-body font-bold text-gm-text">更新说明</h3>
          <MarkdownPreview
            content={details.release.body?.trim() || '本次发布暂无详细说明。'}
            skipHtml
          />
        </div>

        <footer className="flex shrink-0 flex-wrap justify-end gap-2 border-t border-gm-border px-5 py-4">
          <Button
            type="default"
            onClick={() => openPage(GITHUB_REPOSITORY_URL, '打开项目仓库失败')}
          >
            点亮stars
          </Button>
          <Button
            type="default"
            onClick={() => openPage(LATEST_RELEASE_PAGE_URL, '打开下载页面失败')}
          >
            跳转下载
          </Button>
        </footer>
      </section>
    </div>
  )
}
