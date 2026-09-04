import { useCallback, useEffect, useState, type MouseEvent, type MutableRefObject, type RefObject } from 'react'
import { addSelectionContextTag, setAiShortcutPrompt } from '@/services/aiContext'
import type { Tab } from '@/stores/editorStore'
import type { MarkdownPreviewHandle } from './markdownPreviewTypes'

export interface PreviewMenuState {
  x: number
  y: number
  selectedText: string
  startLine?: number
  endLine?: number
  pane: 'left' | 'right'
  /** 统一 Range 快照的精确源码 offset（接管选区时存在） */
  selectionFrom?: number
  selectionTo?: number
}

interface PreviewSelectionSource {
  title: string
  filePath?: string | null
  text: string
  startLine?: number
  endLine?: number
  selectionFrom?: number
  selectionTo?: number
}

interface UsePreviewSelectionBridgeOptions {
  activeTab?: Tab
  rightTab?: Tab | null
  leftPreviewRef: RefObject<HTMLDivElement | null>
  rightPreviewRef: RefObject<HTMLDivElement | null>
  leftMarkdownPreviewRef: MutableRefObject<MarkdownPreviewHandle | null>
  rightMarkdownPreviewRef: MutableRefObject<MarkdownPreviewHandle | null>
}

const PREVIEW_CONTEXT_HIGHLIGHT = 'preview-context-selection'

export function usePreviewSelectionBridge({
  activeTab,
  rightTab,
  leftPreviewRef,
  rightPreviewRef,
  leftMarkdownPreviewRef,
  rightMarkdownPreviewRef,
}: UsePreviewSelectionBridgeOptions) {
  const [previewMenu, setPreviewMenu] = useState<PreviewMenuState | null>(null)

  const clearPreviewContextHighlight = useCallback(() => {
    if (typeof CSS !== 'undefined' && CSS.highlights) {
      CSS.highlights.delete(PREVIEW_CONTEXT_HIGHLIGHT)
    }
  }, [])

  const closePreviewMenu = useCallback(() => {
    clearPreviewContextHighlight()
    setPreviewMenu(null)
  }, [clearPreviewContextHighlight])

  useEffect(() => clearPreviewContextHighlight, [clearPreviewContextHighlight])

  const getPreviewSelectionLineRange = useCallback((selection: Selection, container: HTMLElement): { startLine?: number; endLine?: number } => {
    if (!selection || selection.rangeCount === 0) return {}

    const range = selection.getRangeAt(0)

    const findLineElement = (node: Node | null): HTMLElement | null => {
      let current = node instanceof HTMLElement ? node : node?.parentElement
      while (current && current !== container) {
        if (current.hasAttribute?.('data-md-line')) return current
        current = current.parentElement
      }
      return null
    }

    const startEl = findLineElement(range.startContainer)
    const endEl = findLineElement(range.endContainer)
    const readLine = (element: HTMLElement | null, attribute: 'data-md-line' | 'data-md-end-line') => {
      const value = Number(element?.getAttribute(attribute))
      return Number.isFinite(value) && value > 0 ? value : undefined
    }
    const firstLine = readLine(startEl, 'data-md-line')
    const lastLine = readLine(endEl, 'data-md-end-line') ?? readLine(endEl, 'data-md-line')
    if (firstLine === undefined) return { startLine: lastLine, endLine: lastLine }
    if (lastLine === undefined) return { startLine: firstLine, endLine: firstLine }
    return {
      startLine: Math.min(firstLine, lastLine),
      endLine: Math.max(firstLine, lastLine),
    }
  }, [])

  const handlePreviewContextMenu = useCallback((e: MouseEvent<HTMLDivElement>, pane: 'left' | 'right') => {
    e.preventDefault()
    const previewHandle = pane === 'left' ? leftMarkdownPreviewRef.current : rightMarkdownPreviewRef.current
    const snapshot = previewHandle?.getSelection() ?? null
    let selectedText = snapshot?.text ?? ''
    let startLine = snapshot?.startLine
    let endLine = snapshot?.endLine
    const selectionFrom = snapshot?.from
    const selectionTo = snapshot?.to

    if (!selectedText) {
      const container = pane === 'left' ? leftPreviewRef.current : rightPreviewRef.current
      const selection = window.getSelection()
      if (container && selection && selection.rangeCount > 0
        && container.contains(selection.anchorNode) && container.contains(selection.focusNode)) {
        selectedText = selection.toString()
        const lineRange = getPreviewSelectionLineRange(selection, container)
        startLine = lineRange.startLine
        endLine = lineRange.endLine
      }
      clearPreviewContextHighlight()
      if (selectedText && typeof CSS !== 'undefined' && CSS.highlights && selection && selection.rangeCount > 0) {
        CSS.highlights.set(PREVIEW_CONTEXT_HIGHLIGHT, new Highlight(selection.getRangeAt(0).cloneRange()))
      }
    }

    setPreviewMenu({ x: e.clientX, y: e.clientY, selectedText, startLine, endLine, selectionFrom, selectionTo, pane })
  }, [clearPreviewContextHighlight, getPreviewSelectionLineRange, leftMarkdownPreviewRef, leftPreviewRef, rightMarkdownPreviewRef, rightPreviewRef])

  const handleCopyPreviewSelection = useCallback(() => {
    if (previewMenu?.selectedText) {
      void navigator.clipboard.writeText(previewMenu.selectedText)
    }
    clearPreviewContextHighlight()
    setPreviewMenu(null)
  }, [clearPreviewContextHighlight, previewMenu])

  const handleSelectAllPreview = useCallback(() => {
    const previewHandle = previewMenu?.pane === 'right' ? rightMarkdownPreviewRef.current : leftMarkdownPreviewRef.current
    previewHandle?.selectAll()
    clearPreviewContextHighlight()
    setPreviewMenu(null)
  }, [clearPreviewContextHighlight, leftMarkdownPreviewRef, previewMenu, rightMarkdownPreviewRef])

  const getPreviewSourceSelection = useCallback((): PreviewSelectionSource | null => {
    if (!previewMenu?.selectedText) return null

    const tab = previewMenu.pane === 'right' ? rightTab : activeTab
    if (!tab) return null

    const selectedText = previewMenu.selectedText.trim()
    if (!selectedText) return null

    const content = tab.content
    if (
      typeof previewMenu.selectionFrom === 'number'
      && typeof previewMenu.selectionTo === 'number'
      && previewMenu.selectionTo > previewMenu.selectionFrom
      && previewMenu.selectionTo <= content.length
    ) {
      return {
        title: tab.title,
        filePath: tab.filePath,
        text: content.slice(previewMenu.selectionFrom, previewMenu.selectionTo),
        startLine: previewMenu.startLine,
        endLine: previewMenu.endLine,
        selectionFrom: previewMenu.selectionFrom,
        selectionTo: previewMenu.selectionTo,
      }
    }

    const normalizedSelectedText = selectedText.replace(/\r\n/g, '\n')
    const lines = content.split('\n')
    const startLine = previewMenu.startLine
    const endLine = previewMenu.endLine

    const findUniqueRange = (source: string, needle: string, baseOffset = 0) => {
      const variants = [...new Set([needle, needle.replace(/\n/g, '\r\n')])]
      const matches = variants.flatMap((variant) => {
        if (!variant) return []
        const indexes: number[] = []
        let index = source.indexOf(variant)
        while (index >= 0 && indexes.length < 2) {
          indexes.push(index)
          index = source.indexOf(variant, index + variant.length)
        }
        return indexes.map((from) => ({ from, to: from + variant.length }))
      })
      const uniqueMatches = matches.filter((match, index) => (
        matches.findIndex((candidate) => candidate.from === match.from && candidate.to === match.to) === index
      ))
      return uniqueMatches.length === 1
        ? { from: baseOffset + uniqueMatches[0].from, to: baseOffset + uniqueMatches[0].to }
        : null
    }

    const offsetForLine = (line: number) => {
      let offset = 0
      for (let i = 0; i < Math.max(0, line - 1); i++) {
        offset += lines[i].length + 1
      }
      return offset
    }

    let range: { from: number; to: number } | null = null
    let markdownText = ''

    if (startLine && endLine) {
      const safeStart = Math.max(1, Math.min(startLine, lines.length))
      const safeEnd = Math.max(safeStart, Math.min(endLine, lines.length))
      const from = offsetForLine(safeStart)
      const to = offsetForLine(safeEnd) + lines[safeEnd - 1].length
      markdownText = content.slice(from, to)
      range = findUniqueRange(markdownText, normalizedSelectedText, from)
      if (!range) range = { from, to }
    }

    range = range || findUniqueRange(content, normalizedSelectedText)
    const sourceText = range ? content.slice(range.from, range.to) : normalizedSelectedText

    return {
      title: tab.title,
      filePath: tab.filePath,
      text: sourceText || markdownText || normalizedSelectedText,
      startLine,
      endLine,
      selectionFrom: range?.from,
      selectionTo: range?.to,
    }
  }, [activeTab, previewMenu, rightTab])

  const handleAddPreviewSelectionToAi = useCallback(() => {
    if (!previewMenu?.selectedText) return
    const sourceSelection = getPreviewSourceSelection()
    if (!sourceSelection) return
    addSelectionContextTag({
      title: sourceSelection.title,
      filePath: sourceSelection.filePath,
      text: sourceSelection.text,
      startLine: sourceSelection.startLine,
      endLine: sourceSelection.endLine,
      selectionFrom: sourceSelection.selectionFrom,
      selectionTo: sourceSelection.selectionTo,
    })
    clearPreviewContextHighlight()
    setPreviewMenu(null)
  }, [clearPreviewContextHighlight, getPreviewSourceSelection, previewMenu])

  const handlePreviewAiAction = useCallback((prompt: string) => {
    if (!previewMenu?.selectedText) return
    const sourceSelection = getPreviewSourceSelection()
    if (!sourceSelection) return
    addSelectionContextTag({
      title: sourceSelection.title,
      filePath: sourceSelection.filePath,
      text: sourceSelection.text,
      startLine: sourceSelection.startLine,
      endLine: sourceSelection.endLine,
      selectionFrom: sourceSelection.selectionFrom,
      selectionTo: sourceSelection.selectionTo,
    })
    setAiShortcutPrompt(prompt)
    clearPreviewContextHighlight()
    setPreviewMenu(null)
  }, [clearPreviewContextHighlight, getPreviewSourceSelection, previewMenu])

  return {
    previewMenu,
    clearPreviewContextHighlight,
    closePreviewMenu,
    handlePreviewContextMenu,
    handleCopyPreviewSelection,
    handleSelectAllPreview,
    handleAddPreviewSelectionToAi,
    handlePreviewAiAction,
  }
}
