import { mkdtempSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { remark } from 'remark'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import {
  computeVisibleRange, createMarkdownPreviewModel, findBlockIndexByLine,
  searchVisibleText, MARKDOWN_GFM_OPTIONS, type PreviewBlock,
} from '@/services/markdownPreviewModel'
import { getTextForSourceRange } from '@/services/previewHighlight'
import { MAX_OPEN_MARKDOWN_BYTES } from '@/services/markdownOpenLimits'
import { createLongDocumentCases } from './long-document-cases'

const parser = remark().use(remarkGfm, MARKDOWN_GFM_OPTIONS).use(remarkMath)
const repetitions = Number(process.env.GM_LONG_BENCH_REPEATS || 3)
const median = (values: number[]) => values.slice().sort((a, b) => a - b)[Math.floor(values.length / 2)]
const timed = <T>(fn: () => T): [T, number] => {
  const start = performance.now()
  const result = fn()
  return [result, performance.now() - start]
}
const estimateHeight = (block: PreviewBlock) => Math.max(25, (block.endLine - block.startLine + 1) * 22)

const results = []
const selectedCase = process.argv[2] || process.env.GM_LONG_BENCH_CASE
for (const sample of createLongDocumentCases().filter((item) => !selectedCase || item.name === selectedCase)) {
  const temporary = mkdtempSync(join(tmpdir(), 'guanmo-long-bench-'))
  const path = join(temporary, 'sample.md')
  const bytes = Buffer.byteLength(sample.markdown, 'utf8')
  writeFileSync(path, sample.markdown, 'utf8')
  try {
    const readTimes: number[] = []
    const parseTimes: number[] = []
    const modelTimes: number[] = []
    const geometryTimes: number[] = []
    const searchTimes: number[] = []
    const tocTimes: number[] = []
    const selectionTimes: number[] = []
    let model = createMarkdownPreviewModel(sample.markdown)
    for (let i = 0; i < repetitions; i++) {
      if (global.gc) global.gc()
      const [read] = timed(() => readFileSync(path, 'utf8'))
      readTimes.push(timed(() => readFileSync(path, 'utf8'))[1])
      parseTimes.push(timed(() => parser.parse(read))[1])
      const built = timed(() => createMarkdownPreviewModel(read))
      model = built[0]
      modelTimes.push(built[1])
      const maxTop = model.blocks.length * 25
      const geometry = timed(() => {
        for (let step = 0; step < 30; step++) {
          computeVisibleRange(model, (maxTop * step) / 30, (maxTop * step) / 30 + 800, new Map(), estimateHeight)
        }
      })
      geometryTimes.push(geometry[1] / 30)
      searchTimes.push(timed(() => searchVisibleText(model, '基准'))[1])
      tocTimes.push(timed(() => findBlockIndexByLine(model, Math.max(1, model.blocks.at(-1)?.endLine ?? 1)))[1])
      selectionTimes.push(timed(() => getTextForSourceRange(model, Math.floor(read.length / 3), Math.floor(read.length / 3) + 500))[1])
    }
    if (global.gc) global.gc()
    results.push({
      name: sample.name,
      chars: sample.markdown.length,
      bytes,
      exceedsOpenLimit: bytes > MAX_OPEN_MARKDOWN_BYTES,
      blocks: model.blocks.length,
      largestBlockChars: Math.max(0, ...model.blocks.map((block) => block.endOffset - block.startOffset)),
      fallback: model.requiresWholeDocumentRender,
      readMs: median(readTimes),
      parseMs: median(parseTimes),
      modelMs: median(modelTimes),
      geometryMsPerCall: median(geometryTimes),
      searchMs: median(searchTimes),
      tocMs: median(tocTimes),
      selectionMs: median(selectionTimes),
      heapMbAfterGc: process.memoryUsage().heapUsed / 1024 / 1024,
    })
    process.stdout.write(`${sample.name} complete ${JSON.stringify(results.at(-1))}\n`)
  } finally {
    unlinkSync(path)
    rmdirSync(temporary)
  }
}
console.log(JSON.stringify({ environment: { node: process.version, platform: process.platform, repetitions, openLimitBytes: MAX_OPEN_MARKDOWN_BYTES }, results }, null, 2))
