export function normalizeFilePath(path: string | null | undefined): string {
  if (!path) return ''
  let normalized = path.trim().replace(/\\/g, '/').toLowerCase()
  if (normalized.startsWith('//?/unc/')) normalized = `//${normalized.slice(8)}`
  else if (normalized.startsWith('//?/')) normalized = normalized.slice(4)
  return normalized.replace(/\/+/g, '/')
}

export function isSameFilePath(a: string | null | undefined, b: string | null | undefined): boolean {
  const left = normalizeFilePath(a)
  const right = normalizeFilePath(b)
  return Boolean(left && right && left === right)
}
