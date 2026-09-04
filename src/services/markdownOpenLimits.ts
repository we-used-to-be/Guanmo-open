const FILE_TOO_LARGE_PREFIX = 'FILE_TOO_LARGE|'
export const MAX_OPEN_MARKDOWN_BYTES = 1 * 1024 * 1024
export interface FileTooLargeDetails { actualBytes: number; limitBytes: number }
export class FileTooLargeError extends Error {
  readonly actualBytes: number
  readonly limitBytes: number
  constructor({ actualBytes, limitBytes }: FileTooLargeDetails) {
    super(`${FILE_TOO_LARGE_PREFIX}${actualBytes}|${limitBytes}`)
    this.name = 'FileTooLargeError'
    this.actualBytes = actualBytes
    this.limitBytes = limitBytes
  }
}
export function parseFileTooLargeError(error: unknown): FileTooLargeError | null {
  if (error instanceof FileTooLargeError) return error
  const message = error instanceof Error ? error.message : String(error)
  if (!message.startsWith(FILE_TOO_LARGE_PREFIX)) return null
  const [actual, limit] = message.slice(FILE_TOO_LARGE_PREFIX.length).split('|').map(Number)
  if (!Number.isFinite(actual) || !Number.isFinite(limit) || actual < 0 || limit <= 0) return null
  return new FileTooLargeError({ actualBytes: actual, limitBytes: limit })
}
export function assertMarkdownOpenSize(bytes: number, limitBytes = MAX_OPEN_MARKDOWN_BYTES): void {
  if (bytes > limitBytes) throw new FileTooLargeError({ actualBytes: bytes, limitBytes })
}
