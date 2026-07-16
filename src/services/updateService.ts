import { getVersion } from '@tauri-apps/api/app'
import { isTauri } from '@/hooks/useTauri'
import { compareSemVer, normalizeVersion } from '@/services/semver'
import { externalFetch } from '@/services/externalHttp'

export { compareSemVer, normalizeVersion } from '@/services/semver'

export const UPDATE_STORAGE_KEYS = {
  lastCheck: 'guanmo:update:last-check',
  ignoredVersion: 'guanmo:update:ignored-version',
  lastNotifiedVersion: 'guanmo:update:last-notified-version',
  releaseEtag: 'guanmo:update:release-etag',
  cachedRelease: 'guanmo:update:cached-release',
} as const

const LATEST_RELEASE_URL = 'https://api.github.com/repos/we-used-to-be/Guanmo-open/releases/latest'
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000

export interface GitHubRelease {
  tag_name: string
  name: string | null
  body: string | null
  published_at: string
  html_url: string
  draft: boolean
  prerelease: boolean
}

export interface AvailableUpdate {
  currentVersion: string
  latestVersion: string
  release: GitHubRelease
}

export type UpdateCheckResult =
  | { status: 'available'; update: AvailableUpdate }
  | { status: 'up-to-date'; currentVersion: string; latestVersion: string }
  | { status: 'ignored'; latestVersion: string }
  | { status: 'skipped' }

interface CheckOptions {
  manual?: boolean
}

type FetchedUpdateResult =
  | { status: 'available'; update: AvailableUpdate }
  | { status: 'up-to-date'; currentVersion: string; latestVersion: string }

const activeRequests: Record<'automatic' | 'manual', Promise<FetchedUpdateResult> | null> = {
  automatic: null,
  manual: null,
}

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage
  } catch {
    return null
  }
}

export async function getCurrentAppVersion(): Promise<string> {
  if (!isTauri()) throw new Error('仅桌面版支持检查更新')
  return normalizeVersion(await getVersion())
}

function shouldUseCachedCheck(): boolean {
  const lastCheck = Number(storage()?.getItem(UPDATE_STORAGE_KEYS.lastCheck))
  const elapsed = Date.now() - lastCheck
  return Number.isFinite(lastCheck) && elapsed >= 0 && elapsed < CHECK_INTERVAL_MS
}

function isGitHubRelease(value: unknown): value is GitHubRelease {
  if (!value || typeof value !== 'object') return false
  const release = value as Partial<GitHubRelease>
  return typeof release.tag_name === 'string'
    && (release.name === null || typeof release.name === 'string')
    && (release.body === null || typeof release.body === 'string')
    && typeof release.published_at === 'string'
    && typeof release.html_url === 'string'
    && typeof release.draft === 'boolean'
    && typeof release.prerelease === 'boolean'
}

async function requestLatestRelease(manual: boolean): Promise<FetchedUpdateResult> {
  storage()?.setItem(UPDATE_STORAGE_KEYS.lastCheck, String(Date.now()))
  const etag = manual ? null : storage()?.getItem(UPDATE_STORAGE_KEYS.releaseEtag)
  const [currentVersion, response] = await Promise.all([
    getCurrentAppVersion(),
    externalFetch(LATEST_RELEASE_URL, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'Guanmo-Update-Checker',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(etag ? { 'If-None-Match': etag } : {}),
      },
    }),
  ])
  if (response.status === 304) {
    const release = readCachedRelease()
    if (!release) throw new Error('GitHub Release 本地缓存无效')
    return createFetchedUpdateResult(currentVersion, release)
  }
  if (!response.ok) throw new Error(`GitHub Releases 请求失败（${response.status}）`)

  const release: unknown = await response.json()
  if (!isGitHubRelease(release) || release.draft) throw new Error('GitHub Release 数据无效')

  cacheRelease(response, release)
  return createFetchedUpdateResult(currentVersion, release)
}

function createFetchedUpdateResult(
  currentVersion: string,
  release: GitHubRelease,
): FetchedUpdateResult {
  const latestVersion = normalizeVersion(release.tag_name)
  const hasUpdate = compareSemVer(latestVersion, currentVersion) > 0
  if (!hasUpdate) return { status: 'up-to-date', currentVersion, latestVersion }

  return {
    status: 'available',
    update: { currentVersion, latestVersion, release },
  }
}

export async function checkForUpdates(options: CheckOptions = {}): Promise<UpdateCheckResult> {
  const manual = Boolean(options.manual)
  if (!manual && shouldUseCachedCheck()) return { status: 'skipped' }
  const requestKey = manual ? 'manual' : 'automatic'
  let request = activeRequests[requestKey]
  if (!request) {
    request = requestLatestRelease(manual).finally(() => {
      activeRequests[requestKey] = null
    })
    activeRequests[requestKey] = request
  }

  const result = await request
  if (
    !manual
    && result.status === 'available'
    && storage()?.getItem(UPDATE_STORAGE_KEYS.ignoredVersion) === result.update.latestVersion
  ) {
    return { status: 'ignored', latestVersion: result.update.latestVersion }
  }
  return result
}

function readCachedRelease(): GitHubRelease | null {
  const cached = storage()?.getItem(UPDATE_STORAGE_KEYS.cachedRelease)
  if (!cached) return null
  try {
    const release: unknown = JSON.parse(cached)
    return isGitHubRelease(release) && !release.draft ? release : null
  } catch {
    return null
  }
}

function cacheRelease(response: Response, release: GitHubRelease): void {
  const store = storage()
  if (!store) return
  store.setItem(UPDATE_STORAGE_KEYS.cachedRelease, JSON.stringify(release))
  const etag = response.headers.get('ETag')
  if (etag) store.setItem(UPDATE_STORAGE_KEYS.releaseEtag, etag)
  else store.removeItem(UPDATE_STORAGE_KEYS.releaseEtag)
}

export function ignoreUpdateVersion(version: string): void {
  storage()?.setItem(UPDATE_STORAGE_KEYS.ignoredVersion, normalizeVersion(version))
}

export function recordNotifiedVersion(version: string): void {
  storage()?.setItem(UPDATE_STORAGE_KEYS.lastNotifiedVersion, normalizeVersion(version))
}

export async function openReleaseInSystemBrowser(url: string): Promise<void> {
  if (isTauri()) {
    const { open } = await import('@tauri-apps/plugin-shell')
    await open(url)
    return
  }
  window.open(url, '_blank', 'noopener,noreferrer')
}
