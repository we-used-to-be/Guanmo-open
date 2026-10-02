import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { Collapse } from 'animal-island-ui'

describe('Collapse', () => {
  it('supports controlled expansion without changing other callers', () => {
    const onExpandedChange = vi.fn()
    const { rerender } = render(
      <Collapse
        question="最近文件"
        answer={<div>内容</div>}
        expanded={false}
        onExpandedChange={onExpandedChange}
      />,
    )

    const trigger = screen.getByRole('button', { name: /最近文件/ })
    expect(trigger).toHaveAttribute('aria-expanded', 'false')

    fireEvent.click(trigger)
    expect(onExpandedChange).toHaveBeenCalledWith(true)
    expect(trigger).toHaveAttribute('aria-expanded', 'false')

    rerender(
      <Collapse
        question="最近文件"
        answer={<div>内容</div>}
        expanded
        onExpandedChange={onExpandedChange}
      />,
    )
    expect(screen.getByRole('button', { name: /最近文件/ })).toHaveAttribute('aria-expanded', 'true')
  })
})
