import {
  UPDATE_STORAGE_KEYS,
  checkForUpdates,
  getCurrentVersionRelease,
} from '../src/services/updateService'

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message)
}

const values = new Map<string, string>()
const localStorageMock = {
  getItem: (key: string) => values.get(key) ?? null,
  setItem: (key: string, value: string) => { values.set(key, value) },
  removeItem: (key: string) => { values.delete(key) },
  clear: () => { values.clear() },
}
Object.defineProperty(globalThis, 'window', {
  value: { localStorage: localStorageMock },
  configurable: true,
})

const release = {
  tag_name: 'v1.3.0',
  name: 'v1.3.0',
  body: '# 更新说明',
  published_at: '2026-07-15T00:00:00Z',
  html_url: 'https://github.com/we-used-to-be/Guanmo-open/releases/tag/v1.3.0',
  draft: false,
  prerelease: false,
}

let fetchCount = 0
let lastRequestInit: RequestInit | undefined
globalThis.fetch = async (_input, init) => {
  fetchCount += 1
  lastRequestInit = init
  return new Response(JSON.stringify(release), {
    status: 200,
    headers: { ETag: '"release-v1.3.0"', 'Content-Type': 'application/json' },
  })
}

values.set(UPDATE_STORAGE_KEYS.lastCheck, String(Date.now()))
const cached = await checkForUpdates()
assert(cached.status === 'skipped' && fetchCount === 0, '自动检查应遵守 24 小时缓存')

const forcedAutomatic = await checkForUpdates({ force: true })
assert(forcedAutomatic.status === 'available' && fetchCount === 1, '开发入口应能绕过 24 小时缓存执行自动检查')

values.delete(UPDATE_STORAGE_KEYS.lastCheck)
values.set(UPDATE_STORAGE_KEYS.ignoredVersion, '1.3.0')
const ignored = await checkForUpdates()
assert(ignored.status === 'ignored' && fetchCount === 2, '自动检查应忽略指定版本')

const requestHeaders = new Headers(lastRequestInit?.headers)
assert(requestHeaders.get('User-Agent') === 'Guanmo-Update-Checker', '桌面请求应提供 GitHub User-Agent')
assert(requestHeaders.get('X-GitHub-Api-Version') === '2022-11-28', '桌面请求应指定 GitHub API 版本')
assert(values.get(UPDATE_STORAGE_KEYS.releaseEtag) === '"release-v1.3.0"', '成功请求后应保存 ETag')
assert(Boolean(values.get(UPDATE_STORAGE_KEYS.cachedRelease)), '成功请求后应缓存 Release 数据')

globalThis.fetch = async (_input, init) => {
  fetchCount += 1
  lastRequestInit = init
  return new Response(JSON.stringify(release), {
    status: 200,
    headers: { ETag: '"release-v1.3.0"', 'Content-Type': 'application/json' },
  })
}
const manual = await checkForUpdates({ manual: true })
assert(manual.status === 'available' && fetchCount === 3, '手动检查应绕过缓存与忽略版本')
assert(new Headers(lastRequestInit?.headers).get('If-None-Match') === null, '手动检查不应发送可能触发 304 的 If-None-Match')

fetchCount = 0
let currentReleaseUrl = ''
globalThis.fetch = async (input) => {
  fetchCount += 1
  currentReleaseUrl = String(input)
  await new Promise((resolve) => setTimeout(resolve, 10))
  return new Response(JSON.stringify({ ...release, tag_name: 'v1.2.1', name: 'v1.2.1' }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}
const [currentReleaseFirst, currentReleaseSecond] = await Promise.all([
  getCurrentVersionRelease(),
  getCurrentVersionRelease(),
])
assert(currentReleaseUrl.endsWith('/releases/tags/v1.2.1'), '版本速览应请求当前安装版本对应的 tag')
assert(currentReleaseFirst.mode === 'current' && currentReleaseFirst.releaseVersion === '1.2.1', '当前版本 Release 应解码为速览详情')
assert(currentReleaseSecond.release.body === '# 更新说明', '并发版本速览应返回同一份 Release 内容')
assert(fetchCount === 1, '并发版本速览只应发起一次网络请求')

let currentReleaseRejected = false
try {
  globalThis.fetch = async () => new Response(null, { status: 404 })
  await getCurrentVersionRelease()
} catch {
  currentReleaseRejected = true
}
assert(currentReleaseRejected, '当前版本 Release 请求失败时应拒绝且不返回空详情')

fetchCount = 0
globalThis.fetch = async (_input, init) => {
  fetchCount += 1
  lastRequestInit = init
  await new Promise((resolve) => setTimeout(resolve, 10))
  return new Response(JSON.stringify(release), {
    status: 200,
    headers: { ETag: '"release-v1.3.0"', 'Content-Type': 'application/json' },
  })
}
const [first, second] = await Promise.all([
  checkForUpdates({ manual: true }),
  checkForUpdates({ manual: true }),
])
assert(first.status === 'available' && second.status === 'available', '并发检查结果应一致')
assert(fetchCount === 1, '并发检查只应发起一次网络请求')

values.delete(UPDATE_STORAGE_KEYS.cachedRelease)
values.delete(UPDATE_STORAGE_KEYS.lastCheck)
let missingCacheRejected = false
try {
  globalThis.fetch = async () => new Response(null, { status: 304 })
  await checkForUpdates()
} catch {
  missingCacheRejected = true
}
assert(missingCacheRejected, '304 缺少有效 Release 缓存时应返回失败')

console.info('Update service checks passed')
