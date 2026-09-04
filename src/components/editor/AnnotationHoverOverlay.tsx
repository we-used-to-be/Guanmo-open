import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react'
import type { ReadingMark, ReadingMarkColor, UpdateReadingMarkPatch } from '@/services/readingMarks'
import { ReadingMarkToolbarContent } from './ReadingMarkToolbarContent'
import { ReadingMarkToolbarShell, READING_MARK_TOOLBAR_CLOSE_DELAY } from './ReadingMarkToolbarShell'

export interface AnnotationHoverAnchor {
  top: number
  right: number
  bottom: number
  left: number
  triggerPoint?: { x: number; y: number }
}

export interface AnnotationHoverOverlayHandle {
  show: (mark: ReadingMark, anchor: AnnotationHoverAnchor) => void
  open: (mark: ReadingMark, anchor: AnnotationHoverAnchor) => void
  scheduleHide: () => void
  cancelHide: () => void
  hide: () => void
}

interface AnnotationHoverOverlayProps {
  onUpdate: (mark: ReadingMark, patch: UpdateReadingMarkPatch) => Promise<ReadingMark>
  onDelete: (mark: ReadingMark) => Promise<void>
}

interface OverlayState {
  mark: ReadingMark
  anchor: AnnotationHoverAnchor
  mode: 'colors' | 'text'
  expanded: boolean
  textDraft: string
  color: ReadingMarkColor
  deleteConfirm: boolean
}

const HIDE_DELAY = 600

export const AnnotationHoverOverlay = forwardRef<AnnotationHoverOverlayHandle, AnnotationHoverOverlayProps>(function AnnotationHoverOverlay({ onUpdate, onDelete }, ref) {
  const [state, setState] = useState<OverlayState | null>(null)
  const stateRef = useRef<OverlayState | null>(null)
  const hideTimerRef = useRef<number | null>(null)
  const closeTimerRef = useRef<number | null>(null)
  const [saving, setSaving] = useState(false)
  const reducedMotionRef = useRef(false)

  stateRef.current = state

  const cancelClose = useCallback(() => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current)
      closeTimerRef.current = null
    }
  }, [])

  const cancelHide = useCallback(() => {
    if (hideTimerRef.current !== null) {
      window.clearTimeout(hideTimerRef.current)
      hideTimerRef.current = null
    }
    cancelClose()
  }, [cancelClose])

  const hide = useCallback(() => {
    cancelHide()
    stateRef.current = null
    setState(null)
  }, [cancelHide])

  const closeAfterSave = useCallback(() => {
    cancelClose()
    if (reducedMotionRef.current) {
      hide()
      return
    }
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = null
      hide()
    }, READING_MARK_TOOLBAR_CLOSE_DELAY)
  }, [cancelClose, hide])

  const show = useCallback((mark: ReadingMark, anchor: AnnotationHoverAnchor) => {
    if (stateRef.current?.mode === 'text') return
    cancelHide()
    const next: OverlayState = {
      mark,
      anchor,
      mode: 'colors',
      expanded: false,
      textDraft: mark.note ?? '',
      color: mark.color,
      deleteConfirm: false,
    }
    stateRef.current = next
    setState(next)
  }, [cancelHide])

  const open = useCallback((mark: ReadingMark, anchor: AnnotationHoverAnchor) => {
    cancelHide()
    const next: OverlayState = {
      mark,
      anchor,
      mode: 'text',
      expanded: true,
      textDraft: mark.note ?? '',
      color: mark.color,
      deleteConfirm: false,
    }
    stateRef.current = next
    setState(next)
  }, [cancelHide])

  const scheduleHide = useCallback(() => {
    cancelHide()
    const current = stateRef.current
    if (current?.mode === 'text') return
    const delay = current?.expanded ? READING_MARK_TOOLBAR_CLOSE_DELAY : HIDE_DELAY
    hideTimerRef.current = window.setTimeout(() => {
      hideTimerRef.current = null
      hide()
    }, delay)
  }, [cancelHide, hide])

  useImperativeHandle(ref, () => ({ show, open, scheduleHide, cancelHide, hide }), [cancelHide, hide, open, scheduleHide, show])

  useEffect(() => () => {
    cancelHide()
    cancelClose()
  }, [cancelClose, cancelHide])

  useEffect(() => {
    if (state?.mode !== 'text') return
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target
      if (target instanceof Element && target.closest('[data-annotation-hover-overlay="true"]')) return
      hide()
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') hide()
    }
    document.addEventListener('pointerdown', handlePointerDown, true)
    document.addEventListener('keydown', handleKeyDown, true)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true)
      document.removeEventListener('keydown', handleKeyDown, true)
    }
  }, [hide, state?.mode])

  const updateState = useCallback((updater: (current: OverlayState) => OverlayState) => {
    const current = stateRef.current
    if (!current) return null
    const next = updater(current)
    stateRef.current = next
    setState(next)
    return next
  }, [])

  const enterText = useCallback(() => {
    updateState((current) => ({ ...current, mode: 'text', expanded: true, deleteConfirm: false }))
  }, [updateState])

  const returnToColors = useCallback(() => {
    updateState((current) => ({ ...current, mode: 'colors', expanded: true, deleteConfirm: false }))
  }, [updateState])

  const save = useCallback(async () => {
    const current = stateRef.current
    if (!current || current.mode !== 'text' || saving) return
    const markId = current.mark.id
    setSaving(true)
    try {
      const mark = await onUpdate(current.mark, { note: current.textDraft, color: current.color })
      if (stateRef.current?.mark.id !== markId) return
      updateState((previous) => previous ? {
        ...previous,
        mark,
        color: mark.color,
        textDraft: mark.note ?? '',
        mode: 'colors',
        expanded: false,
        deleteConfirm: false,
      } : current)
      closeAfterSave()
    } catch {
      // Store 已负责回滚并提示持久化错误，面板保留当前编辑内容。
    } finally {
      setSaving(false)
    }
  }, [closeAfterSave, onUpdate, saving, updateState])

  const selectColor = useCallback(async (color: ReadingMarkColor) => {
    const current = stateRef.current
    if (!current || saving) return
    if (current.color === color) return
    const markId = current.mark.id
    const previousColor = current.color
    updateState((previous) => previous ? { ...previous, color } : current)
    setSaving(true)
    try {
      const mark = await onUpdate(current.mark, { color })
      if (stateRef.current?.mark.id !== markId) return
      // 颜色是局部更新，回调返回值不应清空已有文本批注；保留当前标记上下文，
      // 这样后续编辑仍会以同一条 ReadingMark 和当前草稿提交。
      const nextMark = current.mark.note?.trim() && !mark.note?.trim()
        ? { ...mark, note: current.mark.note, type: 'annotation' as const }
        : mark
      updateState((previous) => previous ? { ...previous, mark: nextMark, color: nextMark.color } : current)
    } catch {
      // Store 已负责回滚并提示持久化错误。
      if (stateRef.current?.mark.id === markId) {
        updateState((previous) => previous ? { ...previous, color: previousColor } : current)
      }
    } finally {
      setSaving(false)
    }
  }, [onUpdate, saving, updateState])

  const remove = useCallback(async () => {
    const current = stateRef.current
    if (!current || saving) return
    const markId = current.mark.id
    setSaving(true)
    try {
      await onDelete(current.mark)
      if (stateRef.current?.mark.id === markId) hide()
    } catch {
      // Store 已负责回滚并提示持久化错误。
    } finally {
      setSaving(false)
    }
  }, [hide, onDelete, saving])

  if (!state) return null

  const hasNote = Boolean(state.mark.note?.trim())

  return (
    <ReadingMarkToolbarShell
      anchor={state.anchor}
      variant="existing"
      mode={state.mode}
      expanded={state.expanded}
      deleteConfirm={state.deleteConfirm}
      annotationHoverOverlay
      expandOnHover={!hasNote}
      expandOnFocus={!hasNote}
      onExpandedChange={(expanded) => updateState((current) => ({ ...current, expanded }))}
      onHoverEnter={cancelHide}
      onHoverLeave={scheduleHide}
      onFocusOutside={scheduleHide}
      onReducedMotionChange={(reducedMotion) => { reducedMotionRef.current = reducedMotion }}
      renderContent={({ textContentMotion, colorContentMotion, triggerMotion, actionsMotion }) => (
        <ReadingMarkToolbarContent
          variant="existing"
          mode={state.mode}
          expanded={state.expanded}
          color={state.color}
          textDraft={state.textDraft}
          saving={saving}
          deleteConfirm={state.deleteConfirm}
          hasNote={hasNote}
          textContentMotion={textContentMotion}
          colorContentMotion={colorContentMotion}
          triggerMotion={triggerMotion}
          actionsMotion={actionsMotion}
          onTriggerClick={() => {
            if (hasNote) enterText()
            else updateState((current) => ({ ...current, expanded: true }))
          }}
          onEnterText={enterText}
          onReturnToColors={returnToColors}
          onSubmitText={() => void save()}
          onTextChange={(value) => updateState((current) => ({ ...current, textDraft: value }))}
          onSelectColor={(color) => void selectColor(color)}
          onDelete={() => updateState((current) => ({ ...current, deleteConfirm: true }))}
          onConfirmDelete={() => void remove()}
          onCancelDelete={() => updateState((current) => ({ ...current, deleteConfirm: false }))}
        />
      )}
    />
  )
})
