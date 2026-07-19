import { useToastStore, type ToastItem } from '@/stores/toastStore'

const TYPE_STYLES: Record<ToastItem['type'], string> = {
  success: 'bg-[var(--gm-success)]',
  info: 'bg-[var(--gm-primary)]',
  warning: 'bg-[var(--gm-warning)]',
  error: 'bg-[var(--gm-error)]',
}

export function ToastContainer() {
  const toasts = useToastStore((s) => s.toasts)
  const removeToast = useToastStore((s) => s.removeToast)
  const pauseToast = useToastStore((s) => s.pauseToast)
  const resumeToast = useToastStore((s) => s.resumeToast)

  if (toasts.length === 0) return null

  return (
    <div className="fixed top-14 right-4 z-[1100] flex flex-col gap-2 pointer-events-none">
      {toasts.map((t) => (
        <div
          key={t.id}
          onMouseEnter={() => pauseToast(t.id)}
          onMouseLeave={() => resumeToast(t.id)}
          className="pointer-events-auto animate-toast-in flex items-stretch gap-3 px-4 py-3 min-w-[240px] max-w-[380px] bg-gm-surface/95 border border-gm-border rounded-xl shadow-[0_8px_24px_0_rgba(61,52,40,0.14)] backdrop-blur-sm"
        >
          <div className={`w-1 h-full min-h-[20px] rounded-full shrink-0 ${TYPE_STYLES[t.type]}`} />
          <div className="min-w-0 flex-1">
            {t.title && <div className="mb-0.5 text-[13px] font-bold leading-[1.4] text-gm-text">{t.title}</div>}
            <div className="text-[13px] leading-[1.4] text-gm-text-secondary break-words">{t.message}</div>
            {t.actions.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-2">
                {t.actions.map((action) => (
                  <button
                    key={action.label}
                    type="button"
                    className={`rounded-lg px-2.5 py-1 text-caption font-bold transition-colors ${
                      action.primary
                        ? 'bg-gm-primary text-white hover:bg-gm-primary-hover'
                        : 'border border-gm-border text-gm-text-secondary hover:border-gm-primary/40 hover:text-gm-primary'
                    }`}
                    onClick={() => {
                      removeToast(t.id)
                      void Promise.resolve(action.onClick()).catch((error) => {
                        console.warn('[Toast] Action failed:', error)
                      })
                    }}
                  >
                    {action.label}
                  </button>
                ))}
              </div>
            )}
          </div>
          {(t.type === 'error' || t.title || t.actions.length > 0) && (
            <button
              type="button"
              onClick={() => removeToast(t.id)}
              aria-label="关闭提示"
              className="h-fit shrink-0 p-0.5 rounded text-gm-text-tertiary hover:text-gm-text transition-colors"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>
      ))}
    </div>
  )
}
