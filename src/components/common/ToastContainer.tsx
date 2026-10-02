import { useLayoutEffect, useRef } from 'react'
import { AnimatePresence, motion, useIsPresent, useReducedMotion } from 'motion/react'
import { useToastStore, type ToastItem } from '@/stores/toastStore'

const TYPE_STYLES: Record<ToastItem['type'], string> = {
  success: 'bg-[var(--gm-success)]',
  info: 'bg-[var(--gm-primary)]',
  warning: 'bg-[var(--gm-warning)]',
  error: 'bg-[var(--gm-error)]',
}

function ToastCard({ toast, reducedMotion }: { toast: ToastItem; reducedMotion: boolean }) {
  const isPresent = useIsPresent()
  const cardRef = useRef<HTMLDivElement>(null)
  const removeToast = useToastStore((s) => s.removeToast)
  const pauseToast = useToastStore((s) => s.pauseToast)
  const resumeToast = useToastStore((s) => s.resumeToast)

  useLayoutEffect(() => {
    if (cardRef.current) cardRef.current.inert = !isPresent
  }, [isPresent])

  return (
    <motion.div
      ref={cardRef}
      layout={reducedMotion ? false : 'position'}
      initial={{ x: reducedMotion ? 0 : 24, opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      exit={{ x: reducedMotion ? 0 : 24, opacity: 0 }}
      transition={reducedMotion ? { duration: 0 } : { duration: 0.18, ease: [0.23, 1, 0.32, 1] }}
      onMouseEnter={() => pauseToast(toast.id)}
      onMouseLeave={() => resumeToast(toast.id)}
      aria-hidden={!isPresent}
      className={`flex items-stretch gap-3 px-4 py-3 min-w-[240px] max-w-[380px] bg-gm-surface/95 border border-gm-border rounded-xl shadow-[0_8px_24px_0_rgba(61,52,40,0.14)] backdrop-blur-sm ${isPresent ? 'pointer-events-auto' : 'pointer-events-none'}`}
    >
      <div className={`w-1 h-full min-h-[20px] rounded-full shrink-0 ${TYPE_STYLES[toast.type]}`} />
      <div className="min-w-0 flex-1">
        {toast.title && <div className="mb-0.5 text-[13px] font-bold leading-[1.4] text-gm-text">{toast.title}</div>}
        <div className="text-[13px] leading-[1.4] text-gm-text-secondary break-words">{toast.message}</div>
        {toast.actions.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-2">
            {toast.actions.map((action) => (
              <button
                key={action.label}
                type="button"
                className={`rounded-lg px-2.5 py-1 text-caption font-bold transition-colors ${
                  action.primary
                    ? 'bg-gm-primary text-white hover:bg-gm-primary-hover'
                    : 'border border-gm-border text-gm-text-secondary hover:border-gm-primary/40 hover:text-gm-primary'
                }`}
                onClick={() => {
                  removeToast(toast.id)
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
      {(toast.type === 'error' || toast.title || toast.actions.length > 0) && (
        <button
          type="button"
          onClick={() => removeToast(toast.id)}
          aria-label="关闭提示"
          className="h-fit shrink-0 p-0.5 rounded text-gm-text-tertiary hover:text-gm-text transition-colors"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>
      )}
    </motion.div>
  )
}

export function ToastContainer() {
  const toasts = useToastStore((s) => s.toasts)
  const reducedMotion = useReducedMotion() ?? false

  return (
    <div className="fixed top-20 right-4 z-[1100] flex flex-col gap-2 pointer-events-none">
      <AnimatePresence initial={false}>
        {toasts.map((toast) => (
          <ToastCard key={toast.id} toast={toast} reducedMotion={reducedMotion} />
        ))}
      </AnimatePresence>
    </div>
  )
}
