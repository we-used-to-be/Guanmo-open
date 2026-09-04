export class Channel<T = unknown> {
  onmessage: ((value: T) => void) | null = null
}
export async function invoke<T>(_command: string, _args?: unknown): Promise<T> {
  throw new Error('当前浏览器不支持桌面命令')
}
export function convertFileSrc(path: string): string { return path }
