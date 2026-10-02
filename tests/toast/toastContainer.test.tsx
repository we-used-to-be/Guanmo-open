import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ToastContainer } from '@/components/common/ToastContainer'
import { useToastStore } from '@/stores/toastStore'

afterEach(() => {
  for (const toast of useToastStore.getState().toasts) {
    useToastStore.getState().removeToast(toast.id)
  }
})

describe('ToastContainer', () => {
  it('disables an exiting action toast immediately and removes it after animation', async () => {
    const onClick = vi.fn()
    render(<ToastContainer />)
    act(() => {
      useToastStore.getState().addToast({
        id: 'action-toast',
        message: 'Operation ready',
        duration: null,
        actions: [{ label: 'Run', onClick }],
      })
    })

    fireEvent.click(screen.getByRole('button', { name: 'Run' }))

    expect(onClick).toHaveBeenCalledOnce()
    expect(useToastStore.getState().toasts).toHaveLength(0)
    const exiting = screen.getByText('Operation ready').closest('[aria-hidden="true"]')
    expect(exiting).toHaveProperty('inert', true)
    expect(exiting).toHaveClass('pointer-events-none')
    await waitFor(() => expect(screen.queryByText('Operation ready')).not.toBeInTheDocument())
  })

  it('keeps remaining messages mounted while a toast exits', async () => {
    render(<ToastContainer />)
    let first = ''
    act(() => {
      first = useToastStore.getState().addToast({ message: 'First', duration: null })
      useToastStore.getState().addToast({ message: 'Second', duration: null })
    })

    act(() => useToastStore.getState().removeToast(first))

    expect(screen.getByText('First').closest('[aria-hidden="true"]')).toHaveProperty('inert', true)
    expect(screen.getByText('Second').closest('[aria-hidden="true"]')).toBeNull()
    await waitFor(() => expect(screen.queryByText('First')).not.toBeInTheDocument())
    expect(screen.getByText('Second')).toBeInTheDocument()
  })
})
