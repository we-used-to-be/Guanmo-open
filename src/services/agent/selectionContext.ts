import {
  buildSemanticDocumentStructure,
  estimateSemanticTokens,
  scoreSemanticRelation,
  type SemanticChunk,
  type SemanticHeading,
} from '@/services/rag/semanticChunker'
import type { TextRange } from './editTarget'

type SelectionContextRole = 'before' | 'current' | 'after'
export const SELECTION_CONTEXT_DIRECTIONS = ['auto', 'before', 'after', 'both'] as const
export type SelectionContextDirection = typeof SELECTION_CONTEXT_DIRECTIONS[number]

export interface SelectionContextChunk {
  role: SelectionContextRole
  headingPath: string[]
  content: string
  startLine: number
  endLine: number
}

export interface SelectionContextWindow {
  chunks: SelectionContextChunk[]
  diagnostics: {
    level: 1 | 2
    totalTokens: number
    candidates: Array<{
      role: Exclude<SelectionContextRole, 'current'>
      content: string
      score: number
      distance: number
      selected: boolean
      reason: string
    }>
    emptyReason?: 'heading-without-content'
  }
}

const LEVEL_1_MAX_TOKENS = 700
const LEVEL_2_MAX_TOKENS = 1400
const MIN_RELEVANCE_SCORE = 3

function overlaps(range: TextRange, start: number, end: number): boolean {
  return start < range.to && end > range.from
}

function distanceToRange(chunk: SemanticChunk, range: TextRange): number {
  if (overlaps(range, chunk.start, chunk.end)) return 0
  if (chunk.end <= range.from) return range.from - chunk.end
  return chunk.start - range.to
}

function nearestChunkIndex(chunks: SemanticChunk[], selectionRange: TextRange): number {
  let nearestIndex = -1
  let nearestDistance = Number.POSITIVE_INFINITY
  chunks.forEach((chunk, index) => {
    const distance = distanceToRange(chunk, selectionRange)
    if (distance < nearestDistance) {
      nearestDistance = distance
      nearestIndex = index
    }
  })
  return nearestIndex
}

function selectedHeadingScope(
  headings: SemanticHeading[],
  selectionRange: TextRange,
  contentLength: number,
): { heading: SemanticHeading; end: number } | null {
  const headingIndex = headings.findIndex((heading) => overlaps(selectionRange, heading.start, heading.end))
  if (headingIndex < 0) return null
  const heading = headings[headingIndex]
  const nextBoundary = headings.slice(headingIndex + 1).find((candidate) => candidate.depth <= heading.depth)
  return { heading, end: nextBoundary?.start ?? contentLength }
}

function toOutputChunk(role: SelectionContextRole, chunk: SemanticChunk): SelectionContextChunk {
  return {
    role,
    headingPath: chunk.headingPath,
    content: chunk.content,
    startLine: chunk.startLine,
    endLine: chunk.endLine,
  }
}

function mergeSelectedChunks(content: string, chunks: SemanticChunk[]): SemanticChunk {
  if (chunks.length === 1) return chunks[0]
  const first = chunks[0]
  const last = chunks[chunks.length - 1]
  return {
    start: first.start,
    end: last.end,
    startLine: first.startLine,
    endLine: last.endLine,
    content: content.slice(first.start, last.end).trim(),
    type: first.type,
    headingPath: first.headingPath,
  }
}

interface ContextCandidate {
  index: number
  role: 'before' | 'after'
  chunk: SemanticChunk
  score: number
  distance: number
  eligible: boolean
}

function selectContextIndexes(
  chunks: SemanticChunk[],
  currentChunk: SemanticChunk,
  currentIndex: number,
  lastCurrentIndex: number,
  maxTokens: number,
  initialIndexes: Set<number> = new Set(),
): { selected: Set<number>; directlySelected: Set<number>; candidates: ContextCandidate[] } {
  const candidates = chunks.flatMap((chunk, index): ContextCandidate[] => {
    if (index >= currentIndex && index <= lastCurrentIndex) return []
    const role = index < currentIndex ? 'before' : 'after'
    const distance = role === 'before' ? currentIndex - index : index - lastCurrentIndex
    return [{ index, role, chunk, distance, score: scoreSemanticRelation(currentChunk, chunk, distance), eligible: true }]
  })
  const ranked = [...candidates].sort((left, right) => right.score - left.score || left.distance - right.distance)
  const selected = new Set(initialIndexes)
  const directlySelected = new Set<number>()
  let totalTokens = estimateSemanticTokens(currentChunk.content)
    + [...initialIndexes].reduce((sum, index) => sum + estimateSemanticTokens(chunks[index].content), 0)
  for (const candidate of ranked) {
    if (selected.has(candidate.index)) continue
    if (candidate.score < MIN_RELEVANCE_SCORE) continue
    const bridgeStart = candidate.role === 'before' ? candidate.index : lastCurrentIndex + 1
    const bridgeEnd = candidate.role === 'before' ? currentIndex - 1 : candidate.index
    const bridgeIndexes = Array.from(
      { length: bridgeEnd - bridgeStart + 1 },
      (_, offset) => bridgeStart + offset,
    ).filter((index) => !selected.has(index))
    const staysInHeading = bridgeIndexes.every((index) => (
      chunks[index].headingPath.length === currentChunk.headingPath.length
      && chunks[index].headingPath.every((part, partIndex) => part === currentChunk.headingPath[partIndex])
    ))
    if (!staysInHeading) continue
    const bridgeTokens = bridgeIndexes.reduce(
      (sum, index) => sum + estimateSemanticTokens(chunks[index].content),
      0,
    )
    if (totalTokens + bridgeTokens > maxTokens) continue
    bridgeIndexes.forEach((index) => selected.add(index))
    directlySelected.add(candidate.index)
    totalTokens += bridgeTokens
  }
  return { selected, directlySelected, candidates }
}

function takeDirectionalIndexes(
  chunks: SemanticChunk[],
  indexes: number[],
  maxTokens: number,
): Set<number> {
  const selected = new Set<number>()
  let totalTokens = 0
  for (const index of indexes) {
    const chunkTokens = estimateSemanticTokens(chunks[index].content)
    if (totalTokens + chunkTokens > maxTokens) break
    selected.add(index)
    totalTokens += chunkTokens
  }
  return selected
}

function selectDirectionalIndexes(
  chunks: SemanticChunk[],
  currentChunk: SemanticChunk,
  currentIndex: number,
  lastCurrentIndex: number,
  maxTokens: number,
  direction: Exclude<SelectionContextDirection, 'auto'>,
  afterBoundary: number = chunks.length,
): { selected: Set<number>; directlySelected: Set<number>; candidates: ContextCandidate[] } {
  const contextBudget = Math.max(0, maxTokens - estimateSemanticTokens(currentChunk.content))
  const beforeIndexes = Array.from({ length: currentIndex }, (_, offset) => currentIndex - offset - 1)
  const afterIndexes = Array.from(
    { length: Math.max(0, afterBoundary - lastCurrentIndex - 1) },
    (_, offset) => lastCurrentIndex + offset + 1,
  )
  const selected = direction === 'before'
    ? takeDirectionalIndexes(chunks, beforeIndexes, contextBudget)
    : direction === 'after'
      ? takeDirectionalIndexes(chunks, afterIndexes, contextBudget)
      : new Set([
        ...takeDirectionalIndexes(chunks, beforeIndexes, Math.floor(contextBudget / 2)),
        ...takeDirectionalIndexes(chunks, afterIndexes, Math.ceil(contextBudget / 2)),
      ])
  const candidates = chunks.flatMap((chunk, index): ContextCandidate[] => {
    if (index >= currentIndex && index <= lastCurrentIndex) return []
    const role = index < currentIndex ? 'before' : 'after'
    const distance = role === 'before' ? currentIndex - index : index - lastCurrentIndex
    const eligible = role === 'before'
      ? direction !== 'after'
      : direction !== 'before' && index < afterBoundary
    return [{
      index,
      role,
      chunk,
      distance,
      score: scoreSemanticRelation(currentChunk, chunk, distance),
      eligible,
    }]
  })
  return { selected, directlySelected: new Set(selected), candidates }
}

export function buildSelectionContextWindow(
  content: string,
  selectionRange: TextRange,
  isMarkdown: boolean,
  level: 1 | 2 = 1,
  direction: SelectionContextDirection = 'auto',
): SelectionContextWindow | null {
  if (selectionRange.from < 0 || selectionRange.to <= selectionRange.from || selectionRange.to > content.length) {
    return null
  }

  const structure = buildSemanticDocumentStructure(content, isMarkdown)
  const { chunks } = structure
  if (chunks.length === 0) return null

  const headingScope = selectedHeadingScope(structure.headings, selectionRange, content.length)
  const matchingIndexes = headingScope
    ? chunks
      .map((chunk, index) => chunk.start >= headingScope.heading.end && chunk.end <= headingScope.end ? index : -1)
      .filter((index) => index >= 0)
      .slice(0, 1)
    : chunks
    .map((chunk, index) => overlaps(selectionRange, chunk.start, chunk.end) ? index : -1)
    .filter((index) => index >= 0)
  const currentIndex = matchingIndexes[0] ?? (headingScope ? -1 : nearestChunkIndex(chunks, selectionRange))
  if (currentIndex < 0) {
    return headingScope
      ? { chunks: [], diagnostics: { level, totalTokens: 0, candidates: [], emptyReason: 'heading-without-content' } }
      : null
  }
  const lastCurrentIndex = matchingIndexes[matchingIndexes.length - 1] ?? currentIndex
  const currentChunk = mergeSelectedChunks(content, chunks.slice(currentIndex, lastCurrentIndex + 1))
  let headingScopeLastIndex = -1
  if (headingScope) {
    chunks.forEach((chunk, index) => {
      if (chunk.start >= headingScope.heading.end && chunk.end <= headingScope.end) {
        headingScopeLastIndex = index
      }
    })
  }
  const afterBoundary = headingScope && (direction === 'after' || direction === 'both')
    ? headingScopeLastIndex + 1
    : chunks.length
  const selectIndexes = (maxTokens: number) => direction === 'auto'
    ? selectContextIndexes(chunks, currentChunk, currentIndex, lastCurrentIndex, maxTokens)
    : selectDirectionalIndexes(
      chunks,
      currentChunk,
      currentIndex,
      lastCurrentIndex,
      maxTokens,
      direction,
      afterBoundary,
    )
  const levelOne = selectIndexes(LEVEL_1_MAX_TOKENS)
  const cumulative = level === 1
    ? levelOne
    : selectIndexes(LEVEL_2_MAX_TOKENS)
  const selectedIndexes = level === 1
    ? cumulative.selected
    : new Set([...cumulative.selected].filter((index) => !levelOne.selected.has(index)))
  const outputChunks = chunks.flatMap((chunk, index): SelectionContextChunk[] => {
    if (level === 1 && index === currentIndex) return [toOutputChunk('current', currentChunk)]
    if (!selectedIndexes.has(index)) return []
    return [toOutputChunk(index < currentIndex ? 'before' : 'after', chunk)]
  })
  const totalTokens = estimateSemanticTokens(currentChunk.content)
    + [...cumulative.selected].reduce((sum, index) => sum + estimateSemanticTokens(chunks[index].content), 0)
  const diagnostics = {
    level,
    totalTokens,
    candidates: cumulative.candidates.map((candidate) => {
      const selected = selectedIndexes.has(candidate.index)
      const directlySelected = cumulative.directlySelected.has(candidate.index)
      const inLevelOne = level === 2 && levelOne.selected.has(candidate.index)
      const overBudget = candidate.eligible && !cumulative.selected.has(candidate.index)
      return {
        role: candidate.role,
        content: candidate.chunk.content,
        score: candidate.score,
        distance: candidate.distance,
        selected,
        reason: selected
          ? directlySelected ? 'selected' : 'bridge-context'
          : inLevelOne ? 'already-returned-in-level-1'
          : !candidate.eligible ? 'direction-excluded'
          : direction !== 'auto' ? 'token-budget'
          : candidate.score < MIN_RELEVANCE_SCORE ? 'low-relevance'
          : overBudget ? 'token-budget'
          : 'not-selected',
      }
    }),
  }

  return { chunks: outputChunks, diagnostics }
}

export function serializeSelectionContextWindow(
  window: SelectionContextWindow,
  _maxChars?: number,
): string {
  return JSON.stringify({ chunks: window.chunks.map((chunk) => ({
    role: chunk.role,
    headingPath: chunk.headingPath,
    startLine: chunk.startLine,
    endLine: chunk.endLine,
    content: chunk.content,
  })) })
}
