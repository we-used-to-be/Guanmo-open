import { Component, type ReactNode } from 'react'
import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { createRuntimeGuard } from './runtimeGuard'

class Boundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  render() { return this.state.failed ? <p>fallback</p> : this.props.children }
}

describe('Core Smoke 异常守卫故障注入', () => {
  it.each(['window.error', 'unhandledrejection', 'console.error', 'root removal', 'shell removal'])('%s 必须失败', (kind) => {
    const root = document.createElement('div')
    const shell = document.createElement('main')
    shell.textContent = 'ready'
    root.append(shell)
    document.body.append(root)
    const guard = createRuntimeGuard(root)
    guard.armShell(shell)
    try {
      guard.assertHealthy()
      if (kind === 'window.error') window.dispatchEvent(new ErrorEvent('error', { error: new Error('injected') }))
      if (kind === 'unhandledrejection') {
        const event = new Event('unhandledrejection')
        Object.defineProperty(event, 'reason', { value: new Error('injected') })
        window.dispatchEvent(event)
      }
      if (kind === 'console.error') console.error(new Error('injected render error'))
      if (kind === 'root removal') root.remove()
      if (kind === 'shell removal') shell.replaceChildren()
      expect(() => guard.assertHealthy()).toThrow('Core Smoke runtime failure')
    } finally { guard.stop(); root.remove() }
  })

  it('被 ErrorBoundary 接住的真实 render throw 也必须失败', () => {
    function Broken(): ReactNode { throw new Error('injected render throw') }
    const root = document.createElement('div')
    document.body.append(root)
    const guard = createRuntimeGuard(root)
    const silenceInjectedError = (event: ErrorEvent) => { if (event.error?.message === 'injected render throw') event.preventDefault() }
    window.addEventListener('error', silenceInjectedError)
    try {
      render(<Boundary><Broken /></Boundary>, { container: root })
      expect(() => guard.assertHealthy()).toThrow('injected render throw')
    } finally { guard.stop(); window.removeEventListener('error', silenceInjectedError) }
  })
})
