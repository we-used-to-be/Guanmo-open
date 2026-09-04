export async function join(...parts: string[]): Promise<string> { return parts.join('/').replace(/\/+/g, '/') }
export async function dirname(path: string): Promise<string> { return path.split(/[\\/]/).slice(0, -1).join('/') }
export async function basename(path: string): Promise<string> { return path.split(/[\\/]/).pop() || '' }
