import { createRef } from 'react'
import { createRoot } from 'react-dom/client'
import { MarkdownPreview } from '@/components/editor/MarkdownPreview'
import type { MarkdownPreviewHandle } from '@/components/editor/markdownPreviewTypes'
import { createLongDocumentCases } from './long-document-cases'

const host = document.getElementById('root')!
const root = createRoot(host)
const cases = createLongDocumentCases()
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
const memoryMb = () => {
  const memory = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory
  return memory ? memory.usedJSHeapSize / 1024 / 1024 : null
}

declare global {
  interface Window {
    runLongDocumentCase: (name: string) => Promise<unknown>
    longDocumentCases: string[]
  }
}

window.longDocumentCases = cases.map((item) => item.name)
window.runLongDocumentCase = async (name) => {
  const sample = cases.find((item) => item.name === name)
  if (!sample) throw new Error(`Unknown sample: ${name}`)
  root.render(null)
  await frame()
  await frame()
  const beforeHeapMb = memoryMb()
  const handle = createRef<MarkdownPreviewHandle>()
  let firstVisibleAt = 0
  let renderCompleteAt = 0
  const startedAt = performance.now()
  root.render(
    <div style={{ height: '800px', overflow: 'auto', width: '1100px', margin: 'auto' }}>
      <MarkdownPreview
        ref={handle}
        content={sample.markdown}
        documentKey={name}
        onFirstVisible={() => { firstVisibleAt ||= performance.now() }}
        onRenderComplete={() => { renderCompleteAt ||= performance.now() }}
      />
    </div>,
  )
  await frame()
  await frame()
  const firstFrameMs = performance.now() - startedAt
  const rootElement = host.querySelector('[data-md-render-mode]')
  if (!rootElement) throw new Error('Preview did not mount')
  const firstDomNodes = rootElement.querySelectorAll('*').length
  const firstBlocks = rootElement.querySelectorAll('[data-md-block-index]').length
  const renderMode = rootElement.getAttribute('data-md-render-mode')
  const scrollStartedAt = performance.now()
  handle.current?.scrollToLine(Math.max(1, Math.floor(sample.markdown.split('\n').length / 2)))
  await frame()
  await frame()
  const scrollMs = performance.now() - scrollStartedAt
  const scrollDomNodes = rootElement.querySelectorAll('*').length
  const searchStartedAt = performance.now()
  const hits = handle.current?.searchVisible('基准') ?? []
  const searchMs = performance.now() - searchStartedAt
  const selectionStartedAt = performance.now()
  handle.current?.selectAll()
  const selectedChars = handle.current?.getSelection()?.text.length ?? 0
  const selectionMs = performance.now() - selectionStartedAt
  return {
    name, chars: sample.markdown.length, bytes: new Blob([sample.markdown]).size,
    renderMode, firstVisibleMs: firstVisibleAt ? firstVisibleAt - startedAt : null,
    firstFrameMs,
    renderCompleteMs: renderCompleteAt ? renderCompleteAt - startedAt : null,
    firstDomNodes, firstBlocks, scrollMs, scrollDomNodes,
    searchMs, searchHits: hits.length, selectionMs, selectedChars,
    beforeHeapMb, afterHeapMb: memoryMb(),
  }
}

host.textContent = `Ready: ${window.longDocumentCases.join(', ')}`
