import { motion } from 'motion/react'
import { useCallback, useLayoutEffect, useRef, type FocusEvent, type ReactNode } from 'react'
import { createMorphingVisibilityMotion, useMorphingMotion, type MorphingContentMotion, type MorphingVisibilityMotion } from '@/components/common/useMorphingMotion'
import {
  getReadingMarkToolbarLayout,
  getReadingMarkToolbarPosition,
  type ReadingMarkToolbarAnchor,
  type ReadingMarkToolbarMode,
  type ReadingMarkToolbarVariant,
} from './ReadingMarkToolbarContent'

export const READING_MARK_TOOLBAR_CLOSE_DELAY = 320

export interface ReadingMarkToolbarContentMotion {
  textContentMotion: MorphingContentMotion
  colorContentMotion: MorphingContentMotion
  triggerMotion: MorphingVisibilityMotion
  actionsMotion: MorphingVisibilityMotion
}

interface ReadingMarkToolbarShellProps {
  anchor: ReadingMarkToolbarAnchor
  variant: ReadingMarkToolbarVariant
  mode: ReadingMarkToolbarMode
  expanded: boolean
  deleteConfirm?: boolean
  /** 用于保留冲突提示等非标准内容的布局宽度。 */
  layoutDeleteConfirm?: boolean
  className?: string
  annotationHoverOverlay?: boolean
  expandOnHover?: boolean
  expandOnFocus?: boolean
  onExpandedChange: (expanded: boolean) => void
  onHoverEnter?: () => void
  onHoverLeave?: () => void
  onFocusOutside?: () => void
  onReducedMotionChange?: (reducedMotion: boolean) => void
  renderContent: (motion: ReadingMarkToolbarContentMotion) => ReactNode
}

export function ReadingMarkToolbarShell({
  anchor,
  variant,
  mode,
  expanded,
  deleteConfirm = false,
  layoutDeleteConfirm = deleteConfirm,
  className,
  annotationHoverOverlay = false,
  expandOnHover = true,
  expandOnFocus = true,
  onExpandedChange,
  onHoverEnter,
  onHoverLeave,
  onFocusOutside,
  onReducedMotionChange,
  renderContent,
}: ReadingMarkToolbarShellProps) {
  const toolbarRef = useRef<HTMLDivElement | null>(null)
  const pointerLeaveHandledRef = useRef(false)
  const modeRef = useRef(mode)
  modeRef.current = mode
  const layout = getReadingMarkToolbarLayout(mode, expanded, layoutDeleteConfirm, variant)
  const position = getReadingMarkToolbarPosition(anchor, layout)
  const previousLayoutRef = useRef(layout)
  const previousLayout = previousLayoutRef.current
  const { borderRadius, height, padding, width } = layout
  useLayoutEffect(() => {
    previousLayoutRef.current = { borderRadius, height, padding, width }
  }, [borderRadius, height, padding, width])
  const morphingMotion = useMorphingMotion(
    { ...previousLayout, left: position.left, top: position.top },
    { ...layout, left: position.left, top: position.top },
  )
  useLayoutEffect(() => {
    onReducedMotionChange?.(morphingMotion.reducedMotion)
  }, [morphingMotion.reducedMotion, onReducedMotionChange])

  const handleHoverEnter = useCallback(() => {
    pointerLeaveHandledRef.current = false
    onHoverEnter?.()
    if (modeRef.current === 'colors' && expandOnHover && !expanded) onExpandedChange(true)
  }, [expandOnHover, expanded, onExpandedChange, onHoverEnter])

  const handlePointerEnter = useCallback(() => {
    pointerLeaveHandledRef.current = false
    onHoverEnter?.()
  }, [onHoverEnter])

  const handleHoverLeave = useCallback(() => {
    if (modeRef.current === 'text') return
    if (toolbarRef.current?.contains(document.activeElement)) return
    onHoverLeave?.()
    onExpandedChange(false)
  }, [onExpandedChange, onHoverLeave])

  const handlePointerLeave = useCallback(() => {
    pointerLeaveHandledRef.current = true
    handleHoverLeave()
  }, [handleHoverLeave])

  const handleMouseLeave = useCallback(() => {
    if (pointerLeaveHandledRef.current) {
      pointerLeaveHandledRef.current = false
      return
    }
    handleHoverLeave()
  }, [handleHoverLeave])

  const handleFocusCapture = useCallback(() => {
    if (modeRef.current === 'colors' && expandOnFocus && !expanded) onExpandedChange(true)
  }, [expandOnFocus, expanded, onExpandedChange])

  const handleBlurCapture = useCallback((event: FocusEvent<HTMLDivElement>) => {
    if (modeRef.current !== 'colors' || event.currentTarget.contains(event.relatedTarget as Node | null)) return
    onFocusOutside?.()
    onExpandedChange(false)
  }, [onExpandedChange, onFocusOutside])

  const toolbarClassName = [
    'gm-reading-mark-toolbar',
    annotationHoverOverlay ? 'gm-annotation-hover-overlay' : '',
    mode === 'text' ? 'is-text' : '',
    expanded ? 'is-expanded' : '',
    deleteConfirm ? 'is-delete-confirm' : '',
    className ?? '',
  ].filter(Boolean).join(' ')

  return (
    <motion.div
      ref={toolbarRef}
      className={toolbarClassName}
      data-annotation-hover-overlay={annotationHoverOverlay ? 'true' : undefined}
      style={{ left: position.left, top: position.top }}
      {...morphingMotion.surface}
      onPointerEnter={handlePointerEnter}
      onPointerLeave={handlePointerLeave}
      onMouseEnter={handleHoverEnter}
      onMouseLeave={handleMouseLeave}
      onPointerDown={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
      onFocusCapture={handleFocusCapture}
      onBlurCapture={handleBlurCapture}
    >
      {renderContent({
        textContentMotion: morphingMotion.content('delayed'),
        colorContentMotion: morphingMotion.content('standard'),
        triggerMotion: createMorphingVisibilityMotion(!expanded, morphingMotion.reducedMotion),
        actionsMotion: createMorphingVisibilityMotion(expanded, morphingMotion.reducedMotion),
      })}
    </motion.div>
  )
}
