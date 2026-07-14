import type { MarkdownPreviewParseResult } from './markdownPreviewParserCore'

interface WorkerResponse {
  id: number
  result?: MarkdownPreviewParseResult
  error?: string
}

interface PendingRequest {
  resolve: (result: MarkdownPreviewParseResult) => void
  reject: (error: Error) => void
}

let sharedWorker: Worker | null = null
let nextRequestId = 1
const pendingRequests = new Map<number, PendingRequest>()

export function parseMarkdownPreviewInWorker(content: string): Promise<MarkdownPreviewParseResult> {
  return new Promise((resolve, reject) => {
    let worker: Worker
    try {
      worker = getSharedWorker()
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)))
      return
    }

    const id = nextRequestId++
    pendingRequests.set(id, { resolve, reject })
    worker.postMessage({ id, content })
  })
}

function getSharedWorker(): Worker {
  if (sharedWorker) return sharedWorker
  if (typeof Worker === 'undefined') {
    throw new Error('当前环境不支持 Web Worker')
  }

  const worker = new Worker(new URL('./markdownPreview.worker.ts', import.meta.url), { type: 'module' })
  worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
    const response = event.data
    const pending = pendingRequests.get(response.id)
    if (!pending) return
    pendingRequests.delete(response.id)
    if (response.result) {
      pending.resolve(response.result)
    } else {
      pending.reject(new Error(response.error || 'Markdown 预览解析失败'))
    }
  }
  worker.onerror = (event) => {
    failWorker(new Error(event.message || 'Markdown 预览 Worker 运行失败'))
  }
  sharedWorker = worker
  return worker
}

function failWorker(error: Error) {
  sharedWorker?.terminate()
  sharedWorker = null
  for (const pending of pendingRequests.values()) pending.reject(error)
  pendingRequests.clear()
}
