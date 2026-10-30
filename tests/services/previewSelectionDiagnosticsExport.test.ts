import { beforeEach, describe, expect, it, vi } from 'vitest'
const { save, write } = vi.hoisted(() => ({ save: vi.fn(), write: vi.fn() }))
vi.mock('@/hooks/useTauri', () => ({ saveFileDialog: save, writeFile: write }))
import { exportPreviewSelectionDiagnostics } from '@/services/previewSelectionDiagnosticsExport'

describe('selection diagnostic export', () => {
  beforeEach(() => { save.mockReset(); write.mockReset() })
  it('writes only to the explicitly selected Markdown output', async () => {
    save.mockResolvedValue('C:/temp/selection-report.md')
    await expect(exportPreviewSelectionDiagnostics('{"schemaVersion":1}')).resolves.toBe(true)
    expect(save).toHaveBeenCalledWith(expect.stringMatching(/^guanmo-selection-.*\.md$/))
    expect(write).toHaveBeenCalledWith('C:/temp/selection-report.md', expect.stringContaining('```json\n{"schemaVersion":1}\n```'))
  })
  it('cancels without writing and exposes write failures for the retry UI', async () => {
    save.mockResolvedValue(null)
    await expect(exportPreviewSelectionDiagnostics('{}')).resolves.toBe(false)
    expect(write).not.toHaveBeenCalled()
    save.mockResolvedValue('C:/temp/selection-report.md')
    write.mockRejectedValue(new Error('write failed'))
    await expect(exportPreviewSelectionDiagnostics('{}')).rejects.toThrow('write failed')
  })
})
