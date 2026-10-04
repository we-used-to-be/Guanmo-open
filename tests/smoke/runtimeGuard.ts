import { vi } from 'vitest'

/** 收集异步错误；不吞异常，Vitest 自身的未捕获错误检测仍保持开启。 */
export function createRuntimeGuard(root: HTMLElement) {
  const failures: string[] = []
  let shell: HTMLElement | null = null
  const record = (value: unknown) => failures.push(value instanceof Error ? value.message : String(value))
  const onError = (event: ErrorEvent) => record(event.error ?? event.message)
  const onRejection = (event: PromiseRejectionEvent) => record(event.reason)
  const errorSpy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    const message = args.map(String).join(' ')
    // React 的测试调度警告不是运行时异常；其他 console.error 一律失败。
    if (message.startsWith('Warning: An update to ') && message.includes('not wrapped in act')) return
    record(message)
  })
  window.addEventListener('error', onError)
  window.addEventListener('unhandledrejection', onRejection)
  const checkTree = () => {
    if (!shell) return
    if (!root.isConnected || !root.contains(shell) || !shell.hasChildNodes()) record('主应用根节点或壳层消失')
  }
  const observer = new MutationObserver(checkTree)
  observer.observe(document.body, { childList: true, subtree: true })
  return {
    record,
    armShell(element: HTMLElement) { shell = element },
    disarmShell() { shell = null },
    assertHealthy() {
      checkTree()
      if (failures.length) throw new Error(`Core Smoke runtime failure:\n${failures.join('\n')}`)
    },
    stop() {
      observer.disconnect()
      window.removeEventListener('error', onError)
      window.removeEventListener('unhandledrejection', onRejection)
      errorSpy.mockRestore()
    },
  }
}
