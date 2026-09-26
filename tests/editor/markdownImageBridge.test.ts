import { afterEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/core', () => ({ invoke }))

afterEach(() => {
  Reflect.deleteProperty(window, '__TAURI_INTERNALS__')
  vi.resetModules()
})

describe('prepareMarkdownImage bridge', () => {
  it('waits for restored access and sends native paths to the backend', async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true })
    let restored!: (result: unknown) => void
    invoke.mockImplementation((command: string) => {
      if (command === 'wait_for_file_access_restore') return new Promise((resolve) => { restored = resolve })
      if (command === 'prepare_markdown_image') return Promise.resolve('C:\\notes\\模型 图.png')
      throw new Error(`Unexpected command: ${command}`)
    })
    const { prepareMarkdownImage } = await import('@/hooks/useTauri')
    const result = prepareMarkdownImage('C:/notes/test.md', 'C:/notes/模型 图.png')
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('wait_for_file_access_restore'))
    expect(invoke).toHaveBeenCalledTimes(1)
    restored({ restoreSucceeded: true })
    await expect(result).resolves.toBe('C:\\notes\\模型 图.png')
    expect(invoke).toHaveBeenLastCalledWith('prepare_markdown_image', {
      markdownPath: 'C:\\notes\\test.md', imagePath: 'C:\\notes\\模型 图.png',
    })
  })

  it('rejects use outside the desktop runtime', async () => {
    const { prepareMarkdownImage } = await import('@/hooks/useTauri')
    await expect(prepareMarkdownImage('C:/notes/test.md', 'C:/notes/image.png')).rejects.toThrow('Not running in Tauri')
    expect(invoke).not.toHaveBeenCalled()
  })
})
