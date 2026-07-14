import { parseMarkdownPreview } from './markdownPreviewParserCore'

interface ParseRequest {
  id: number
  content: string
}

const workerScope = self as unknown as {
  onmessage: ((event: MessageEvent<ParseRequest>) => void) | null
  postMessage: (message: unknown) => void
}

workerScope.onmessage = (event) => {
  const { id, content } = event.data
  void parseMarkdownPreview(content).then(
    (result) => workerScope.postMessage({ id, result }),
    (error) => workerScope.postMessage({
      id,
      error: error instanceof Error ? error.message : String(error),
    }),
  )
}
