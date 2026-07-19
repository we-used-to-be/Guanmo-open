interface SemVer {
  major: number
  minor: number
  patch: number
  prerelease: string[]
}

function parseSemVer(version: string): SemVer | null {
  const match = version.trim().match(/^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/)
  if (!match) return null
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4]?.split('.') ?? [],
  }
}

export function normalizeVersion(version: string): string {
  return version.trim().replace(/^v/i, '')
}

export function compareSemVer(left: string, right: string): number {
  const a = parseSemVer(left)
  const b = parseSemVer(right)
  if (!a || !b) throw new Error('版本号格式无效')

  for (const key of ['major', 'minor', 'patch'] as const) {
    if (a[key] !== b[key]) return a[key] > b[key] ? 1 : -1
  }
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    if (a.prerelease.length === b.prerelease.length) return 0
    return a.prerelease.length === 0 ? 1 : -1
  }

  const length = Math.max(a.prerelease.length, b.prerelease.length)
  for (let index = 0; index < length; index += 1) {
    const aPart = a.prerelease[index]
    const bPart = b.prerelease[index]
    if (aPart === undefined) return -1
    if (bPart === undefined) return 1
    if (aPart === bPart) continue
    const aNumeric = /^\d+$/.test(aPart)
    const bNumeric = /^\d+$/.test(bPart)
    if (aNumeric && bNumeric) return Number(aPart) > Number(bPart) ? 1 : -1
    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1
    return aPart > bPart ? 1 : -1
  }
  return 0
}
