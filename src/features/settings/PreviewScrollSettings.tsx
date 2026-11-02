import { useEffect, useId, useRef, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { MORPHING_MOTION_TOKENS } from '@/components/common/useMorphingMotion'
import { SettingSlider } from '@/components/common/SettingSlider'
import { attachPreviewWheel, PREVIEW_SCROLL_DAMPING } from '@/services/previewWheel'

export function PreviewScrollSettings({ value, onChange }: { value: number; onChange: (value: number) => void }) {
  const [expanded, setExpanded] = useState(false)
  const contentId = useId()
  const sampleRef = useRef<HTMLDivElement>(null)
  const reducedMotion = useReducedMotion()

  useEffect(() => {
    const sample = sampleRef.current
    if (!expanded || !sample) return
    return attachPreviewWheel(sample, value)
  }, [expanded, value])

  return (
    <div>
      <div className="gm-setting-field flex min-h-[42px] items-center justify-between py-1.5">
        <div style={{ width: 260, flexShrink: 0 }}>
          <button type="button" aria-expanded={expanded} aria-controls={contentId} onClick={() => setExpanded((current) => !current)} className="inline-flex items-center gap-1 text-body text-gm-text hover:text-gm-text-secondary">
            预览滚动手感
            <svg viewBox="0 0 20 20" width="14" height="14" aria-hidden="true" className={`transition-transform ${expanded ? 'rotate-180' : ''}`}>
              <path d="m6 8 4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          <p className="mt-0.5 text-caption text-gm-text-tertiary">单栏预览滚轮缓动，点击展开试用</p>
        </div>
        <SettingSlider label="预览滚动缓动" value={value} min={PREVIEW_SCROLL_DAMPING.min} max={PREVIEW_SCROLL_DAMPING.max} step={PREVIEW_SCROLL_DAMPING.step} onChange={onChange} format={(v) => v === 0 ? '原生滚动' : `${v} 毫秒${v === PREVIEW_SCROLL_DAMPING.default ? '（默认）' : ''}`} className="flex-1" valueClassName="w-28 shrink-0" />
      </div>
      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div id={contentId} initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={reducedMotion ? { duration: 0 } : MORPHING_MOTION_TOKENS.surface} style={{ overflow: 'hidden' }}>
            <div className="mt-3 overflow-hidden rounded-lg border border-gm-border bg-gm-surface" style={{ height: 240 }}>
            <div ref={sampleRef} role="region" aria-label="滚动手感试验区" tabIndex={0} style={{ height: 'calc(100% - 12px)', margin: 6, overflowY: 'auto' }} className="px-3 py-2 text-body leading-relaxed text-gm-text-secondary">
              <p className="mb-3 font-medium text-gm-text">在这里滚动，试试阅读的节奏</p>
              <p className="mb-3">把鼠标移到这段文字上，滚动几次，感受页面开始和停止的速度。</p>
              <p className="mb-3">调小数值，滚动会更直接；调大数值，停止时会更柔和。</p>
              <p className="mb-3">阅读时不妨向下翻过几段，再向上滚动，找到自己喜欢的感觉。</p>
              <p className="mb-3">修改会立即生效，也会应用到单栏文档预览。</p>
              <p className="mb-3">清晨的光落在书桌上，窗外的树影随着微风轻轻晃动。</p>
              <p className="mb-3">翻到下一段时，试着放慢滚轮，观察文字在视线中移动的节奏。</p>
              <p className="mb-3">连续滚动几次，再突然反向，看看页面是否跟得上你的动作。</p>
              <p className="mb-3">你可以随时拖动上方滑块，比较不同数值带来的变化。</p>
              <p className="mb-3">找到舒适的速度后，无需额外保存，回到文档即可继续阅读。</p>
              <p className="mb-3">午后的桌面渐渐安静下来，书页上的字迹也显得格外清晰。</p>
              <p className="mb-3">沿着文字慢慢向下，让视线跟随段落，而不必急着翻到结尾。</p>
              <p className="mb-3">一段读完，停下来想一想，再继续寻找下一处感兴趣的内容。</p>
              <p className="mb-3">有时只需要轻轻拨动滚轮，就能让下一行文字进入视野。</p>
              <p className="mb-3">也可以连续滚动，感受较长距离移动时页面的响应。</p>
              <p className="mb-3">回头查看上一段时，试试反方向滚动是否足够自然。</p>
              <p className="mb-3">如果希望页面停得更快，可以把上方的数值调小一些。</p>
              <p className="mb-3">如果喜欢更柔和的收尾，可以把数值调大，再回来比较。</p>
              <p className="mb-3">不同的鼠标和滚轮速度，可能带来不同的阅读感受。</p>
              <p className="mb-3">适合自己的设置，应当让页面移动自然，也方便随时停下。</p>
              <p className="mb-3">不妨再上下滚动几次，确认这个节奏适合日常阅读。</p>
              <p>这里是试验区域的末尾。你可以随时调整后再试一次。</p>
            </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
