import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Select } from '@/vendor/animal-island-ui/components/Select/Select'

afterEach(cleanup)

const options = [{ key: 'first', label: '选项一' }, { key: 'second', label: '选项二' }]

describe('Select shared menu', () => {
  it('uses a portal, focuses the selected option, and restores focus after selection', () => {
    const onChange = vi.fn()
    render(<div style={{ overflow: 'hidden' }}><Select options={options} value="second" onChange={onChange} /></div>)
    const trigger = screen.getByRole('button', { name: '选项二' })
    fireEvent.click(trigger)
    expect(screen.getByRole('listbox').parentElement).toBe(document.body)
    expect(screen.getByRole('option', { name: '选项二' })).toHaveFocus()
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' })
    expect(screen.getByRole('option', { name: '选项一' })).toHaveFocus()
    fireEvent.click(screen.getByRole('option', { name: '选项一' }))
    expect(onChange).toHaveBeenCalledWith('first')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
  })

  it('closes on Escape without changing the value', () => {
    const onChange = vi.fn()
    render(<Select options={options} value="first" onChange={onChange} />)
    const trigger = screen.getByRole('button', { name: '选项一' })
    fireEvent.click(trigger)
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    expect(onChange).not.toHaveBeenCalled()
    expect(trigger).toHaveFocus()
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })

  it('closes when disabled and does not reopen when enabled again', () => {
    const props = { options, value: 'first', onChange: vi.fn() }
    const { rerender } = render(<Select {...props} />)
    fireEvent.click(screen.getByRole('button', { name: '选项一' }))
    rerender(<Select {...props} disabled />)
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '选项一' })).toBeDisabled()
    rerender(<Select {...props} />)
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })
})
