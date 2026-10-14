import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { UsageReceiptDialog } from '@/features/settings/UsageReceiptDialog'
import { buildUsageReceipt } from '@/features/settings/usageReceipt'

const mocks = vi.hoisted(() => ({ save: vi.fn(), write: vi.fn(), reduced: false }))
vi.mock('@/hooks/useTauri', () => ({ saveFileDialog: mocks.save, writeBinaryFile: mocks.write }))
vi.mock('motion/react', () => ({ useReducedMotion: () => mocks.reduced }))
vi.mock('@/services/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const receipt = buildUsageReceipt(7200, 60, new Map(),
  { start: '2025-10-15', end: '2026-10-14' }, '2026-10-14', '认真写下的每一页，都在铺就你的路。')

function drag(end: number) {
  const handle = screen.getByRole('button', { name: /从左向右撕下/ })
  vi.spyOn(handle, 'getBoundingClientRect').mockReturnValue({ left: 0, width: 360 } as DOMRect)
  fireEvent.pointerDown(handle, { pointerId: 1, button: 0, clientX: 8 })
  fireEvent.pointerMove(handle, { pointerId: 1, clientX: end })
  fireEvent.pointerUp(handle, { pointerId: 1, clientX: end })
  return handle
}

describe('回顾撕纸保存', () => {
  beforeEach(() => {
    mocks.reduced = false
    mocks.save.mockReset().mockResolvedValue(null)
    mocks.write.mockReset().mockResolvedValue(undefined)
    vi.stubGlobal('PointerEvent', class extends MouseEvent {
      pointerId: number
      constructor(type: string, init: PointerEventInit) { super(type, init); this.pointerId = init.pointerId ?? 1 }
    })
    vi.stubGlobal('Image', class {
      onload: (() => void) | null = null
      set src(_value: string) { queueMicrotask(() => this.onload?.()) }
    })
    Object.defineProperty(document, 'fonts', { configurable: true, value: { ready: Promise.resolve() } })
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:receipt-test')
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: vi.fn() } as unknown as CanvasRenderingContext2D)
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((callback) => {
      callback({ arrayBuffer: async () => new Uint8Array([137, 80, 78, 71]).buffer } as Blob)
    })
    HTMLElement.prototype.setPointerCapture = vi.fn()
    HTMLElement.prototype.releasePointerCapture = vi.fn()
  })
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

  it('未拖满时回弹，普通点击不保存', () => {
    render(<UsageReceiptDialog receipt={receipt} onClose={vi.fn()} />)
    const handle = drag(150)
    expect(document.querySelector('.gm-receipt-sheet')).toHaveAttribute('data-phase', 'attached')
    expect(document.querySelector('.gm-receipt-sheet')).toHaveAttribute('data-tearing', 'false')
    fireEvent.click(handle, { detail: 1 })
    expect(mocks.save).not.toHaveBeenCalled()
  })

  it('裂口跟随当前鼠标位置，向左移动后不保留历史最大进度', () => {
    render(<UsageReceiptDialog receipt={receipt} onClose={vi.fn()} />)
    const handle = screen.getByRole('button', { name: /从左向右撕下/ })
    vi.spyOn(handle, 'getBoundingClientRect').mockReturnValue({ left: 0, width: 360 } as DOMRect)
    fireEvent.pointerDown(handle, { pointerId: 1, button: 0, clientX: 8 })
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 360 })
    expect(document.querySelector('.gm-receipt-sheet')).toHaveAttribute('data-phase', 'attached')
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 120 })
    const sheet = document.querySelector<HTMLElement>('.gm-receipt-sheet')!
    expect(Number(sheet.style.getPropertyValue('--tear-progress'))).toBeCloseTo(120 / 360)
    fireEvent.pointerUp(handle, { pointerId: 1, clientX: 120 })
    expect(sheet).toHaveAttribute('data-phase', 'attached')
    expect(mocks.save).not.toHaveBeenCalled()
  })

  it('拖满后等待下落结束，只保存一次，取消保存后恢复纸张', async () => {
    render(<UsageReceiptDialog receipt={receipt} onClose={vi.fn()} />)
    drag(360)
    expect(document.querySelector('.gm-receipt-sheet')).toHaveAttribute('data-phase', 'falling')
    expect(mocks.save).not.toHaveBeenCalled()
    fireEvent.animationEnd(document.querySelector('.gm-receipt-detachable')!)
    // jsdom 没有 AnimationEvent 时，React 使用带前缀的动画结束事件。
    fireEvent(document.querySelector('.gm-receipt-detachable')!, new Event('webkitAnimationEnd', { bubbles: true }))
    await waitFor(() => expect(mocks.save).toHaveBeenCalledOnce())
    await waitFor(() => expect(document.querySelector('.gm-receipt-sheet')).toHaveAttribute('data-phase', 'attached'))
    expect(mocks.write).not.toHaveBeenCalled()
  })

  it('减少动画模式下键盘保存无需等待动画，成功写入后自动关闭', async () => {
    mocks.reduced = true
    mocks.save.mockResolvedValue('C:/temporary/receipt.png')
    const onClose = vi.fn()
    render(<UsageReceiptDialog receipt={receipt} onClose={onClose} />)
    fireEvent.click(screen.getByRole('button', { name: /从左向右撕下/ }), { detail: 0 })
    await waitFor(() => expect(mocks.write).toHaveBeenCalledOnce())
    expect(document.querySelector('.gm-receipt-sheet')).toHaveAttribute('data-phase', 'detached')
    expect(document.querySelector('.gm-receipt-printer')).toBeInTheDocument()
    expect(document.querySelector('.gm-receipt-stub')).toBeInTheDocument()
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce())
  })

  it('保存失败时恢复连接状态，不自动关闭', async () => {
    mocks.reduced = true
    mocks.save.mockResolvedValue('C:/temporary/receipt.png')
    mocks.write.mockRejectedValue(new Error('write failed'))
    const onClose = vi.fn()
    render(<UsageReceiptDialog receipt={receipt} onClose={onClose} />)
    fireEvent.click(screen.getByRole('button', { name: /从左向右撕下/ }), { detail: 0 })
    await waitFor(() => expect(mocks.write).toHaveBeenCalledOnce())
    await waitFor(() => expect(document.querySelector('.gm-receipt-sheet')).toHaveAttribute('data-phase', 'attached'))
    expect(onClose).not.toHaveBeenCalled()
  })
})
