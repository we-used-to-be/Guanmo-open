import { describe, expect, it, vi } from 'vitest'
import { describeFileOperationError } from '@/services/fileOperationErrors'
import {
  MAX_OPEN_MARKDOWN_BYTES,
  FileTooLargeError,
  assertMarkdownOpenSize,
  formatFileSize,
  parseFileTooLargeError,
  readBrowserMarkdownFileForOpen,
} from '@/services/markdownFileOpenPolicy'

describe('Markdown file open policy', () => {
  it('allows the exact limit and rejects the next byte', () => {
    expect(() => assertMarkdownOpenSize(MAX_OPEN_MARKDOWN_BYTES)).not.toThrow()
    expect(() => assertMarkdownOpenSize(MAX_OPEN_MARKDOWN_BYTES + 1)).toThrow(FileTooLargeError)

    const parsed = parseFileTooLargeError(`FILE_TOO_LARGE|${MAX_OPEN_MARKDOWN_BYTES + 1}|${MAX_OPEN_MARKDOWN_BYTES}`)
    expect(parsed).toMatchObject({
      actualBytes: MAX_OPEN_MARKDOWN_BYTES + 1,
      limitBytes: MAX_OPEN_MARKDOWN_BYTES,
    })
    expect(describeFileOperationError(parsed, '打开失败')).toBe('文件过大，当前最多支持 1.0 MiB')
  })

  it('checks browser file size before reading its content', async () => {
    const text = vi.fn().mockResolvedValue('should not be read')
    const file = new File(['12345'], 'large.md', { type: 'text/markdown' })
    Object.defineProperty(file, 'text', { value: text })

    await expect(readBrowserMarkdownFileForOpen(file)).resolves.toBe('should not be read')
    expect(text).toHaveBeenCalledOnce()

    const oversized = new File(['12345'], 'large.md', { type: 'text/markdown' })
    Object.defineProperty(oversized, 'size', { value: MAX_OPEN_MARKDOWN_BYTES + 1 })
    const oversizedText = vi.fn()
    Object.defineProperty(oversized, 'text', { value: oversizedText })
    await expect(readBrowserMarkdownFileForOpen(oversized)).rejects.toMatchObject({
      actualBytes: MAX_OPEN_MARKDOWN_BYTES + 1,
      limitBytes: MAX_OPEN_MARKDOWN_BYTES,
    })
    expect(oversizedText).not.toHaveBeenCalled()
  })

  it('formats the stable size units used by user-facing errors', () => {
    expect(formatFileSize(MAX_OPEN_MARKDOWN_BYTES)).toBe('1.0 MiB')
    expect(formatFileSize(1025)).toBe('2 KiB')
    expect(formatFileSize(42)).toBe('42 B')
  })
})
