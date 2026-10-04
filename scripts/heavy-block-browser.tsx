import { Profiler, createRef, type ProfilerOnRenderCallback } from 'react'
import { createRoot } from 'react-dom/client'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeHighlight from 'rehype-highlight'
import rehypeKatex from 'rehype-katex'
import { remark } from 'remark'
import { MarkdownPreview } from '@/components/editor/MarkdownPreview'
import type { MarkdownPreviewHandle } from '@/components/editor/markdownPreviewTypes'
import { createMarkdownPreviewModel, MARKDOWN_GFM_OPTIONS } from '@/services/markdownPreviewModel'
import { createSourceOffsetAnnotator, getTextForSourceRange } from '@/services/previewHighlight'
import { createLongDocumentCases } from './long-document-cases'

const host = document.getElementById('root')!
const root = createRoot(host)
const cases = createLongDocumentCases()
const gfmParser = remark().use(remarkGfm, MARKDOWN_GFM_OPTIONS).use(remarkMath)
const plainParser = remark().use(remarkMath)
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
const heapMb = () => {
  const size = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize
  return size === undefined ? null : size / 1048576
}

declare global {
  interface Window {
    runHeavyBlockCase: (name: string, variant: string) => Promise<unknown>
  }
}

window.runHeavyBlockCase = async (name, variant) => {
  let sample = cases.find((item) => item.name === name)
  if (!sample) {
    const match = /^giant-(table|list|code)-(\d+)$/.exec(name)
    if (match) {
      const base = cases.find((item) => item.name === `giant-${match[1]}-${match[1] === 'table' ? '50000' : '300000'}`)!
      const prefix = match[1] === 'table' ? base.markdown.slice(0, base.markdown.indexOf('\n', base.markdown.indexOf('\n') + 1) + 1) : ''
      const body = match[1] === 'code' ? base.markdown.slice(base.markdown.indexOf('\n') + 1, base.markdown.lastIndexOf('\n```')) : base.markdown.slice(prefix.length)
      const safeBody = body.slice(0, Number(match[2]) - prefix.length).replace(/[^\n]*$/, '')
      sample = { name, markdown: match[1] === 'code' ? `\`\`\`typescript\n${safeBody}\n\`\`\`` : prefix + safeBody }
    }
  }
  if (!sample) throw new Error(name)
  if (variant === 'parse') {
    const time = (fn: () => unknown) => { const t = performance.now(); fn(); return performance.now() - t }
    return {
      name, variant,
      gfmParseMs: time(() => gfmParser.parse(sample!.markdown)),
      noGfmParseMs: time(() => plainParser.parse(sample!.markdown)),
      modelMs: time(() => createMarkdownPreviewModel(sample!.markdown)),
    }
  }
  root.render(null)
  await frame()
  await frame()
  const beforeHeapMb = heapMb()
  const handle = createRef<MarkdownPreviewHandle>()
  const modelStart = performance.now()
  const model = variant === 'production' ? null : createMarkdownPreviewModel(sample.markdown)
  const modelBuildMs = performance.now() - modelStart
  const block = model?.blocks[0]
  const source = block ? model!.normalizedContent.slice(block.startOffset, block.endOffset) : ''
  const code = source.replace(/^```[^\n]*\n/, '').replace(/\n```\s*$/, '')
  const items = source.split('\n')
  const listBatch = items.slice(0, 100).join('\n')
  let actualDuration = 0
  let commitAt = 0
  const onRender: ProfilerOnRenderCallback = (_id, _phase, actual, _base, _startTime, commitTime) => {
    actualDuration += actual
    commitAt = commitTime
  }
  let element
  if (variant === 'production') {
    element = <MarkdownPreview ref={handle} content={sample.markdown} documentKey={name} />
  } else if (variant === 'code-plain-pre') {
    element = <pre style={{ whiteSpace: 'pre', fontFamily: 'monospace' }}><code>{code}</code></pre>
  } else if (variant === 'list-batch') {
    element = <ReactMarkdown remarkPlugins={[[remarkGfm, MARKDOWN_GFM_OPTIONS], remarkMath]}>{listBatch}</ReactMarkdown>
  } else {
    const plugins = variant === 'highlight' || variant === 'highlight-annotated'
      ? [rehypeKatex, rehypeHighlight]
      : [rehypeKatex]
    if (variant === 'highlight-annotated' || variant === 'plain-annotated') {
      plugins.push(createSourceOffsetAnnotator(block!.startOffset, source, block!.textSegments))
    }
    element = <ReactMarkdown remarkPlugins={[[remarkGfm, MARKDOWN_GFM_OPTIONS], remarkMath]} rehypePlugins={plugins}>{source}</ReactMarkdown>
  }
  const start = performance.now()
  root.render(<Profiler id="heavy" onRender={onRender}><div style={{ width: 1100, height: 800, overflow: 'auto' }}>{element}</div></Profiler>)
  await frame()
  await frame()
  const firstFrameAt = performance.now()
  const firstFrameMs = firstFrameAt - start
  const nodes = host.querySelectorAll('*').length
  const layoutStart = performance.now()
  const bounds = host.getBoundingClientRect()
  const forcedLayoutMs = performance.now() - layoutStart
  const contentText = host.querySelector('code')?.textContent ?? host.textContent ?? ''
  const selectionStart = performance.now()
  const range = document.createRange()
  const selectTarget = host.querySelector('code') ?? host.firstElementChild!
  range.selectNodeContents(selectTarget)
  const selection = window.getSelection()!
  selection.removeAllRanges()
  selection.addRange(range)
  const selectedText = selection.toString()
  const selectionMs = performance.now() - selectionStart
  selection.removeAllRanges()
  const sourceCopy = model ? getTextForSourceRange(model, block!.startOffset, block!.endOffset) : ''
  const mappedSpans = host.querySelectorAll('[data-gm-src-from][data-gm-src-to]')
  const firstMappedFrom = mappedSpans[0]?.getAttribute('data-gm-src-from') ?? null
  const lastMappedTo = mappedSpans[mappedSpans.length - 1]?.getAttribute('data-gm-src-to') ?? null
  const copyStart = performance.now()
  if (variant === 'code-plain-pre') await navigator.clipboard.writeText(code)
  const copyMs = performance.now() - copyStart
  let clipboardMatchesCode: boolean | null = null
  if (variant === 'code-plain-pre') {
    try { clipboardMatchesCode = (await navigator.clipboard.readText()).replace(/\r\n/g, '\n') === code } catch { clipboardMatchesCode = null }
  }
  return {
    name, variant, chars: sample.markdown.length, nodes,
    firstFrameMs, modelBuildMs, reactActualMs: actualDuration,
    commitMs: commitAt - start, frameAfterCommitMs: firstFrameAt - commitAt,
    forcedLayoutMs,
    boundsHeight: bounds.height, beforeHeapMb, afterHeapMb: heapMb(),
    contentChars: contentText.length, selectedChars: selectedText.length,
    selectionMatchesContent: selectedText === contentText,
    selectionMs, sourceCopyChars: sourceCopy.length, copyMs,
    sourceCopyMatchesCode: name.startsWith('giant-code') ? sourceCopy === code : null,
    mappedSpans: mappedSpans.length, firstMappedFrom, lastMappedTo,
    clipboardMatchesCode,
  }
}

host.textContent = 'Ready'
