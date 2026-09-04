import { Check, Highlighter, MessageSquareText, Trash2, Undo2 } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { useLayoutEffect, useRef, type Ref } from 'react'
import type { MorphingContentMotion, MorphingVisibilityMotion } from '@/components/common/useMorphingMotion'
import type { ReadingMarkColor } from '@/services/readingMarks'

export type ReadingMarkToolbarVariant = 'create' | 'existing'
export type ReadingMarkToolbarMode = 'colors' | 'text'

export const READING_MARK_COLORS: ReadingMarkColor[] = ['yellow', 'green', 'blue', 'pink']
export const READING_MARK_COLOR_LABELS: Record<ReadingMarkColor, string> = {
  yellow: '黄色',
  green: '绿色',
  blue: '蓝色',
  pink: '粉色',
}
export const READING_MARK_DOT_COLORS: Record<ReadingMarkColor, string> = {
  yellow: '#facc15',
  green: '#4ade80',
  blue: '#60a5fa',
  pink: '#f472b6',
}

export interface ReadingMarkToolbarLayout {
  width: number
  height: number
  borderRadius: number
  padding: number
}

export interface ReadingMarkToolbarAnchor {
  top: number
  right: number
  bottom: number
  left: number
  triggerPoint?: { x: number; y: number }
}

export interface ReadingMarkToolbarPosition {
  left: number
  top: number
}

const READING_MARK_FLOATING_GAP = 8

export function getReadingMarkToolbarLayout(
  mode: ReadingMarkToolbarMode,
  expanded: boolean,
  deleteConfirm = false,
  variant: ReadingMarkToolbarVariant = 'create',
): ReadingMarkToolbarLayout {
  if (mode === 'text') return { width: Math.min(280, Math.max(1, window.innerWidth - 16)), height: 140, borderRadius: 12, padding: 0 }
  if (expanded || deleteConfirm) {
    const width = variant === 'existing'
      ? (deleteConfirm ? 236 : 208)
      : (deleteConfirm ? 208 : 170)
    return { width, height: 32, borderRadius: 10, padding: 0 }
  }
  return { width: 30, height: 30, borderRadius: 10, padding: 0 }
}

export function getReadingMarkToolbarPosition(anchor: ReadingMarkToolbarAnchor, layout: ReadingMarkToolbarLayout): ReadingMarkToolbarPosition {
  const width = Math.max(1, layout.width)
  const height = Math.max(1, layout.height)
  const viewportWidth = Math.max(1, window.innerWidth || 1)
  const viewportHeight = Math.max(1, window.innerHeight || 1)
  const anchorCenter = anchor.triggerPoint?.x ?? (anchor.left + anchor.right) / 2
  const left = Math.max(8 + width / 2, Math.min(anchorCenter, viewportWidth - width / 2 - 8))
  const top = anchor.top - height - READING_MARK_FLOATING_GAP >= 8
    ? anchor.top - height - READING_MARK_FLOATING_GAP
    : Math.max(8, Math.min(anchor.bottom + READING_MARK_FLOATING_GAP, viewportHeight - height - 8))
  return { left, top }
}

export interface ReadingMarkToolbarContentProps {
  variant: ReadingMarkToolbarVariant
  mode: ReadingMarkToolbarMode
  expanded: boolean
  color: ReadingMarkColor
  textDraft: string
  saving: boolean
  deleteConfirm: boolean
  hasNote: boolean
  textInputRef?: Ref<HTMLTextAreaElement>
  colorActionRef?: Ref<HTMLButtonElement>
  textContentMotion: MorphingContentMotion
  colorContentMotion: MorphingContentMotion
  triggerMotion: MorphingVisibilityMotion
  actionsMotion: MorphingVisibilityMotion
  onTriggerClick: () => void
  onEnterText: () => void
  onReturnToColors: () => void
  onSubmitText: () => void
  onTextChange: (value: string) => void
  onSelectColor: (color: ReadingMarkColor) => void
  onDelete: () => void
  onConfirmDelete: () => void
  onCancelDelete: () => void
}

export function ReadingMarkToolbarContent({
  variant,
  mode,
  expanded,
  color,
  textDraft,
  saving,
  deleteConfirm,
  hasNote,
  textInputRef,
  colorActionRef,
  textContentMotion,
  colorContentMotion,
  triggerMotion,
  actionsMotion,
  onTriggerClick,
  onEnterText,
  onReturnToColors,
  onSubmitText,
  onTextChange,
  onSelectColor,
  onDelete,
  onConfirmDelete,
  onCancelDelete,
}: ReadingMarkToolbarContentProps) {
  const previousModeRef = useRef(mode)
  const modeRef = useRef(mode)
  const delayedFocusRef = useRef<number | null>(null)
  const enteringColors = mode === 'colors' && previousModeRef.current === 'text'
  useLayoutEffect(() => {
    if (enteringColors) {
      const focusColor = () => {
        if (modeRef.current !== 'colors') return
        if (colorActionRef && typeof colorActionRef === 'object') colorActionRef.current?.focus()
      }
      focusColor()
      if (delayedFocusRef.current !== null) window.clearTimeout(delayedFocusRef.current)
      delayedFocusRef.current = window.setTimeout(focusColor, 240)
    }
    previousModeRef.current = mode
    modeRef.current = mode
  }, [colorActionRef, enteringColors, mode])
  useLayoutEffect(() => () => {
    if (delayedFocusRef.current !== null) window.clearTimeout(delayedFocusRef.current)
  }, [])

  const isExisting = variant === 'existing'
  const triggerLabel = isExisting
    ? (hasNote ? '查看文字批注' : '查看高亮批注')
    : '添加批注'
  const colorLabelPrefix = isExisting ? '改为' : '创建'

  return (
    <AnimatePresence mode="sync">
      {mode === 'text' ? (
        <motion.form
          key="text-editor"
          className="gm-reading-mark-toolbar-view gm-reading-mark-text-view"
          {...textContentMotion}
          onSubmit={(event) => {
            event.preventDefault()
            onSubmitText()
          }}
          aria-busy={saving}
        >
          <textarea
            ref={textInputRef}
            autoFocus
            tabIndex={0}
            aria-label="批注内容"
            value={textDraft}
            disabled={saving}
            onChange={(event) => onTextChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault()
                onReturnToColors()
              } else if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault()
                onSubmitText()
              }
            }}
            placeholder="写下这段文字的想法…"
            className="gm-reading-mark-editor-input"
          />
          <div className="gm-reading-mark-text-footer">
            <div className="gm-reading-mark-toolbar-color-buttons">
              {READING_MARK_COLORS.map((nextColor) => (
                <button autoFocus={enteringColors && nextColor === 'yellow'} key={nextColor} type="button" disabled={saving} title={`${colorLabelPrefix}${READING_MARK_COLOR_LABELS[nextColor]}高亮`} aria-label={`${colorLabelPrefix}${READING_MARK_COLOR_LABELS[nextColor]}高亮`} aria-pressed={color === nextColor} onClick={() => onSelectColor(nextColor)}>
                  <span className={`gm-reading-mark-dot ${color === nextColor ? 'is-selected' : ''}`} data-color={nextColor} style={{ background: READING_MARK_DOT_COLORS[nextColor] }} />
                </button>
              ))}
            </div>
            {isExisting && (deleteConfirm ? (
              <>
                <button type="button" className="gm-reading-mark-icon-button" style={{ color: 'var(--gm-error)' }} disabled={saving} title="确认删除批注" aria-label="确认删除批注" onClick={onConfirmDelete}>
                  <Check aria-hidden="true" size={15} strokeWidth={2.2} />
                </button>
                <button type="button" className="gm-reading-mark-icon-button" disabled={saving} title="取消删除" aria-label="取消删除" onClick={onCancelDelete}>
                  <Undo2 aria-hidden="true" size={15} strokeWidth={2} />
                </button>
              </>
            ) : (
              <button type="button" className="gm-reading-mark-icon-button" style={{ color: 'var(--gm-error)' }} disabled={saving} title="删除标记" aria-label="删除标记" onClick={onDelete}>
                <Trash2 aria-hidden="true" size={15} strokeWidth={2} />
              </button>
            ))}
            {!deleteConfirm && (
              <button type="submit" className="gm-reading-mark-icon-button" style={{ color: 'var(--gm-primary)' }} disabled={saving} title={isExisting ? '保存批注' : '提交批注'} aria-label={isExisting ? '保存批注' : '提交批注'}>
                <Check aria-hidden="true" size={15} strokeWidth={2.2} />
              </button>
            )}
          </div>
        </motion.form>
      ) : (
        <motion.div
          key="color-actions"
          className="gm-reading-mark-toolbar-view"
          {...colorContentMotion}
        >
          <motion.button
            type="button"
            className="gm-reading-mark-toolbar-trigger"
            {...triggerMotion}
            style={{ color: 'var(--gm-primary)' }}
            title={triggerLabel}
            aria-label={triggerLabel}
            aria-expanded={expanded}
            aria-hidden={expanded}
            tabIndex={expanded ? -1 : 0}
            onClick={onTriggerClick}
          >
            {isExisting && hasNote
              ? <MessageSquareText aria-hidden="true" size={16} strokeWidth={2} />
              : <Highlighter aria-hidden="true" size={16} strokeWidth={2} />}
          </motion.button>
          <motion.div className={`gm-reading-mark-toolbar-actions ${expanded ? 'is-expanded' : ''}`} {...actionsMotion} aria-hidden={!expanded}>
            <div className="gm-reading-mark-toolbar-color-buttons">
              {READING_MARK_COLORS.map((nextColor) => (
                <button autoFocus={enteringColors && nextColor === 'yellow'} ref={nextColor === 'yellow' ? colorActionRef : undefined} key={nextColor} type="button" tabIndex={expanded ? 0 : -1} title={`${colorLabelPrefix}${READING_MARK_COLOR_LABELS[nextColor]}高亮`} aria-label={`${colorLabelPrefix}${READING_MARK_COLOR_LABELS[nextColor]}高亮`} aria-pressed={color === nextColor} onClick={() => onSelectColor(nextColor)}>
                  <span className={`gm-reading-mark-dot ${color === nextColor ? 'is-selected' : ''}`} data-color={nextColor} style={{ background: READING_MARK_DOT_COLORS[nextColor] }} />
                </button>
              ))}
              <button type="button" tabIndex={expanded ? 0 : -1} title={isExisting ? '编辑文字批注' : '添加文字批注'} aria-label={isExisting ? '编辑文字批注' : '添加文字批注'} onClick={onEnterText}>
                <MessageSquareText aria-hidden="true" size={16} strokeWidth={2} />
              </button>
              {isExisting && (deleteConfirm ? (
                <>
                  <button type="button" className="gm-reading-mark-icon-button" style={{ color: 'var(--gm-error)' }} tabIndex={expanded ? 0 : -1} title="确认删除批注" aria-label="确认删除批注" onClick={onConfirmDelete}>
                    <Check aria-hidden="true" size={15} strokeWidth={2.2} />
                  </button>
                  <button type="button" className="gm-reading-mark-icon-button" tabIndex={expanded ? 0 : -1} title="取消删除" aria-label="取消删除" onClick={onCancelDelete}>
                    <Undo2 aria-hidden="true" size={15} strokeWidth={2} />
                  </button>
                </>
              ) : (
                <button type="button" className="gm-reading-mark-icon-button" style={{ color: 'var(--gm-error)' }} tabIndex={expanded ? 0 : -1} title="删除标记" aria-label="删除标记" onClick={onDelete}>
                  <Trash2 aria-hidden="true" size={15} strokeWidth={2} />
                </button>
              ))}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
