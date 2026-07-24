import { useCallback, useEffect, useRef, useState } from 'react'
import type { FeatureIntroItem } from './featureIntroContent'

interface FeatureIntroModalProps {
  open: boolean
  features: FeatureIntroItem[]
  onClose: () => void
}

export function FeatureIntroModal({
  open,
  features,
  onClose,
}: FeatureIntroModalProps) {
  const [step, setStep] = useState(0)
  const [closing, setClosing] = useState(false)
  const [entering, setEntering] = useState(true)
  const [imageLoading, setImageLoading] = useState(true)
  const closingRef = useRef(false)
  const closeTimerRef = useRef<number>()
  const enterTimerRef = useRef<number>()

  const totalSteps = features.length

  // 关闭时重置
  useEffect(() => {
    if (!open) {
      closingRef.current = false
      setClosing(false)
      setEntering(true)
      setStep(0)
    }
  }, [open])

  // 入场动画
  useEffect(() => {
    if (!open) return
    const raf = requestAnimationFrame(() => {
      enterTimerRef.current = window.setTimeout(() => setEntering(false), 0)
    })
    return () => {
      cancelAnimationFrame(raf)
      if (enterTimerRef.current) window.clearTimeout(enterTimerRef.current)
    }
  }, [open])

  const requestClose = useCallback(() => {
    if (closingRef.current) return
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      onClose()
      return
    }
    closingRef.current = true
    setClosing(true)
    closeTimerRef.current = window.setTimeout(onClose, 200)
  }, [onClose])

  const goPrev = useCallback(() => {
    setStep((s) => (s > 0 ? s - 1 : s))
  }, [])

  const goNext = useCallback(() => {
    setStep((s) => (s < totalSteps - 1 ? s + 1 : s))
  }, [totalSteps])

  // 键盘导航
  useEffect(() => {
    if (!open) return
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        requestClose()
      } else if (event.key === 'ArrowLeft') {
        goPrev()
      } else if (event.key === 'ArrowRight') {
        goNext()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      if (closeTimerRef.current) window.clearTimeout(closeTimerRef.current)
    }
  }, [open, requestClose, goPrev, goNext])

  // 切换步骤时重置图片加载状态
  useEffect(() => {
    if (features[step]?.image) {
      setImageLoading(true)
    }
  }, [step, features])

  if (!open) return null

  const currentFeature = features[step]

  return (
    <div
      className={`gm-feature-intro-scrim fixed inset-0 z-[1100] flex items-center justify-center bg-black/45 p-5 transition-opacity duration-200 ${entering || closing ? 'opacity-0' : 'opacity-100'}`}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) requestClose()
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-label="特性介绍"
        className={`gm-feature-intro-dialog relative flex w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-gm-border bg-gm-surface shadow-2xl transition-all duration-200 ${entering || closing ? 'scale-95 opacity-0' : 'scale-100 opacity-100'}`}
        style={{ minHeight: '480px' }}
      >
        {/* 关闭按钮 */}
        <button
          type="button"
          onClick={requestClose}
          aria-label="关闭"
          className="absolute right-4 top-4 z-10 flex h-8 w-8 items-center justify-center rounded-lg text-gm-text-tertiary transition-colors hover:bg-gm-surface-hover hover:text-gm-text"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>

        {/* 内容区 */}
        <div className="flex flex-1 items-center p-2">
          {/* 左箭头 */}
          <button
            type="button"
            onClick={goPrev}
            disabled={step === 0}
            aria-label="上一步"
            className="absolute left-1 top-1/2 z-10 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full text-gm-text-tertiary transition-colors hover:bg-gm-surface-hover hover:text-gm-text disabled:opacity-25 disabled:cursor-default"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M15 18l-6-6 6-6" />
            </svg>
          </button>

          {/* 右箭头 */}
          <button
            type="button"
            onClick={goNext}
            disabled={step === totalSteps - 1}
            aria-label="下一步"
            className="absolute right-1 top-1/2 z-10 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full text-gm-text-tertiary transition-colors hover:bg-gm-surface-hover hover:text-gm-text disabled:opacity-25 disabled:cursor-default"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 18l6-6-6-6" />
            </svg>
          </button>

          <div className="flex w-full flex-1 flex-col">
            {/* 插图区 — 有图时渲染，无图时隐藏 */}
            {currentFeature.image && (
              <div
                className="mx-auto flex w-full max-w-xl flex-[7] items-start justify-center overflow-hidden rounded-lg border border-gm-border/50"
                style={{ maxHeight: '300px' }}
              >
                {imageLoading && (
                  <div className="flex h-full w-full items-center justify-center py-8">
                    <div className="h-8 w-8 animate-spin rounded-full border-2 border-gm-border border-t-gm-primary" />
                  </div>
                )}
                {currentFeature.image.startsWith('<svg') ? (
                  <div
                    className={imageLoading ? 'hidden' : ''}
                    dangerouslySetInnerHTML={{ __html: currentFeature.image }}
                  />
                ) : (
                  <img
                    src={currentFeature.image}
                    alt={currentFeature.title}
                    className={`max-h-full w-full object-contain ${imageLoading ? 'hidden' : ''}`}
                    onLoad={() => setImageLoading(false)}
                  />
                )}
              </div>
            )}

            {/* 文案区 */}
            <div className={`${currentFeature.image ? 'flex-[3]' : 'flex-1'} px-4 pt-4 pb-3 text-center flex flex-col justify-end`}>
              <h3 className="mb-2 text-title font-bold text-gm-text">
                {currentFeature.title}
              </h3>
              <p className="mx-auto max-w-md text-body text-gm-text-secondary leading-relaxed">
                {currentFeature.description}
              </p>
            </div>
          </div>
        </div>

        {/* 步骤指示器 */}
        {totalSteps > 1 && (
          <div className="flex shrink-0 items-center justify-center gap-2.5 border-t border-gm-border px-5 py-4">
            {features.map((_, index) => (
              <button
                key={index}
                type="button"
                aria-label={`第 ${index + 1} 步`}
                aria-current={index === step ? 'step' : undefined}
                onClick={() => setStep(index)}
                className={`h-2.5 rounded-full transition-all ${
                  index === step
                    ? 'w-6 bg-gm-primary'
                    : 'w-2.5 bg-gm-border hover:bg-gm-text-tertiary'
                }`}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  )
}