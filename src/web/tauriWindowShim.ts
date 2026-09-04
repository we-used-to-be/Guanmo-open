const unsupported = () => { throw new Error('当前浏览器不支持原生窗口操作') }
const windowShim = {
  minimize: unsupported,
  maximize: unsupported,
  unmaximize: unsupported,
  close: unsupported,
  startDragging: unsupported,
  isMaximized: async () => false,
  setFullscreen: unsupported,
  isFullscreen: async () => false,
  listen: async () => () => undefined,
}
export function getCurrentWindow() { return windowShim }
export function getCurrentWebviewWindow() { return windowShim }
export async function currentMonitor() { return null }
