export const GITHUB_REPOSITORY_URL = 'https://github.com/we-used-to-be/Guanmo-open'
export function getCurrentAppVersion(): string { return 'Web' }
export function getCurrentVersionRelease(): null { return null }
export function openReleaseInSystemBrowser(url?: string): void { window.open(url || GITHUB_REPOSITORY_URL, '_blank', 'noopener,noreferrer') }
