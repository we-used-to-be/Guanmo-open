import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { PreviewScrollSettings } from '@/features/settings/PreviewScrollSettings'

describe('preview scroll settings', () => {
  it('expands the sample and changes the damping immediately', () => {
    const onChange = vi.fn()
    render(<PreviewScrollSettings value={90} onChange={onChange} />)
    const toggle = screen.getByRole('button', { name: '预览滚动手感' })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    const slider = screen.getByRole('slider', { name: '预览滚动缓动' })
    expect(slider).toHaveValue('90')
    expect(screen.queryByRole('region', { name: '滚动手感试验区' })).not.toBeInTheDocument()
    fireEvent.change(slider, { target: { value: '135' } })
    expect(onChange).toHaveBeenCalledWith(135)
    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    const sample = screen.getByRole('region', { name: '滚动手感试验区' })
    expect(sample).toHaveStyle({ height: 'calc(100% - 12px)', overflowY: 'auto' })
    expect(sample.parentElement).toHaveStyle({ height: '240px' })
    expect(sample.parentElement).toHaveClass('overflow-hidden')
    expect(screen.getByRole('slider', { name: '预览滚动缓动' })).toBe(slider)
  })
})
