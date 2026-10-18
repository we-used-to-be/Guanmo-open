import { useEffect, useLayoutEffect, useMemo, useState, type RefObject } from 'react'
import { Layers2, Move, Scaling } from 'lucide-react'
import { ProductTourOverlay } from '@/features/productTour/ProductTourOverlay'
import type { ProductTourStep } from '@/features/productTour/productTourContent'

export const FULLSCREEN_NAVIGATION_HINT_KEY = 'guanmo-fullscreen-navigation-hint-v1'
let shownWithoutStorage = false

interface Props {
  active: boolean
  suppressed: boolean
  navigationExpanded: boolean
  anchorRef: RefObject<HTMLButtonElement | null>
  databaseEnabled: boolean
  onDismiss: () => void
}

const PANEL = '[data-fullscreen-ai-panel]'
const SWITCHER = `${PANEL} [data-product-tour="fullscreen-page-switcher"]`

export function FullscreenNavigationHint({ active, suppressed, navigationExpanded, anchorRef, databaseEnabled, onDismiss }: Props) {
  const [visible, setVisible] = useState(false)
  const [step, setStep] = useState(0)
  const [panel, setPanel] = useState<HTMLElement | null>(null)
  const steps = useMemo<ProductTourStep[]>(() => [
    {
      id: 'window-pages', target: SWITCHER, title: '更多页面，藏在这里',
      content: databaseEnabled ? '点击顶部三点，可切换 AI 助手、阅读成果和阅读提醒。' : '点击顶部三点，可展开页面导航；阅读成果和阅读提醒仅桌面版可用。',
      placement: 'bottom', surface: 'fullscreen',
    },
    {
      id: 'window-drag', target: `${PANEL} [data-fullscreen-ai-drag-handle]`, targetExclude: SWITCHER,
      title: '拖动小窗，放在顺手的位置', content: '按住小窗顶部除三点按钮外的任意位置拖动，即可移动小窗。',
      placement: 'bottom', surface: 'fullscreen',
    },
    {
      id: 'window-resize', target: `${PANEL} [data-fullscreen-ai-resize-handle]`,
      title: '按需调整小窗大小', content: '按住右下角的缩放手柄拖动，即可调整小窗的宽度和高度。',
      placement: 'left', surface: 'fullscreen',
    },
  ], [databaseEnabled])

  useLayoutEffect(() => {
    setPanel(anchorRef.current?.closest<HTMLElement>(PANEL) ?? null)
  }, [active, anchorRef])

  useEffect(() => {
    if (!active || suppressed || !panel) {
      setVisible(false)
      return
    }
    try {
      if (shownWithoutStorage || localStorage.getItem(FULLSCREEN_NAVIGATION_HINT_KEY) === '1') return
      localStorage.setItem(FULLSCREEN_NAVIGATION_HINT_KEY, '1')
    } catch {
      if (shownWithoutStorage) return
      shownWithoutStorage = true
    }
    setVisible(true)
    setStep(0)
  }, [active, suppressed, panel])

  useEffect(() => {
    if (visible && navigationExpanded && step === 0) setStep(1)
  }, [visible, navigationExpanded, step])

  if (!visible || !active || suppressed || navigationExpanded || !panel) return null
  const Icon = [Layers2, Move, Scaling][step]
  const dismiss = () => { setVisible(false); onDismiss() }
  return <ProductTourOverlay
    open compact topic="fullscreen" steps={steps} stepIndex={step}
    onStepChange={setStep} onTopicChange={dismiss} onClose={dismiss}
    trackingElement={panel} headerIcon={<Icon size={16} strokeWidth={1.7} aria-hidden="true" style={step === 2 ? { transform: 'scaleY(-1)' } : undefined} />}
  />
}
