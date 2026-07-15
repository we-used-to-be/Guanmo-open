import {
  buildSemanticDocumentChunks,
  estimateSemanticTokens,
  scoreSemanticRelation,
  type SemanticChunk,
} from '@/services/rag/semanticChunker'
import type { TextRange } from './editTarget'

type SelectionContextRole = 'before' | 'current' | 'after'

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
    return [{ index, role, chunk, distance, score: scoreSemanticRelation(currentChunk, chunk, distance) }]
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

export function buildSelectionContextWindow(
  content: string,
  selectionRange: TextRange,
  isMarkdown: boolean,
  level: 1 | 2 = 1,
): SelectionContextWindow | null {
  if (selectionRange.from < 0 || selectionRange.to <= selectionRange.from || selectionRange.to > content.length) {
    return null
  }

  const chunks = buildSemanticDocumentChunks(content, isMarkdown)
  if (chunks.length === 0) return null

  const matchingIndexes = chunks
    .map((chunk, index) => overlaps(selectionRange, chunk.start, chunk.end) ? index : -1)
    .filter((index) => index >= 0)
  const currentIndex = matchingIndexes[0] ?? nearestChunkIndex(chunks, selectionRange)
  if (currentIndex < 0) return null
  const lastCurrentIndex = matchingIndexes[matchingIndexes.length - 1] ?? currentIndex
  const currentChunk = mergeSelectedChunks(content, chunks.slice(currentIndex, lastCurrentIndex + 1))
  const levelOne = selectContextIndexes(chunks, currentChunk, currentIndex, lastCurrentIndex, LEVEL_1_MAX_TOKENS)
  const cumulative = level === 1
    ? levelOne
    : selectContextIndexes(chunks, currentChunk, currentIndex, lastCurrentIndex, LEVEL_2_MAX_TOKENS, levelOne.selected)
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
      const overBudget = candidate.score >= MIN_RELEVANCE_SCORE
        && !cumulative.selected.has(candidate.index)
      return {
        role: candidate.role,
        content: candidate.chunk.content,
        score: candidate.score,
        distance: candidate.distance,
        selected,
        reason: selected
          ? directlySelected ? 'selected' : 'bridge-context'
          : inLevelOne ? 'already-returned-in-level-1'
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
