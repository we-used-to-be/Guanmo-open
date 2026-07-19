import assert from 'node:assert/strict'
import { readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

const modeFlagIndex = process.argv.indexOf('--mode')
const mode = modeFlagIndex >= 0 ? process.argv[modeFlagIndex + 1] : 'desktop'
assert.ok(mode === 'web' || mode === 'desktop', '构建模式必须是 web 或 desktop')

const dist = join(process.cwd(), 'dist')
const html = await readFile(join(dist, 'index.html'), 'utf8')
const entryMatch = html.match(/<script[^>]+src="\.\/assets\/([^"]+\.js)"/)
assert.ok(entryMatch, '未找到构建入口脚本')
const buildModeMatch = html.match(/<meta name="guanmo-build-mode" content="([^"]+)"/)
assert.equal(buildModeMatch?.[1], mode, `构建模式不匹配：期望 ${mode}，实际 ${buildModeMatch?.[1] || 'unknown'}`)

const entryPath = join(dist, 'assets', entryMatch[1])
const entryBytes = (await stat(entryPath)).size
const files = await readdir(join(dist, 'assets'))
const jsFiles = files.filter((file) => file.endsWith('.js'))
const cssFiles = files.filter((file) => file.endsWith('.css'))
const fontFiles = files.filter((file) => /\.(?:woff2?|ttf|otf)$/i.test(file))
const fileSizes = new Map(await Promise.all(files.map(async (file) => [file, (await stat(join(dist, 'assets', file))).size])))
const totalBytes = (names) => names.reduce((sum, file) => sum + (fileSizes.get(file) || 0), 0)
const jsBytes = totalBytes(jsFiles)
const cssBytes = totalBytes(cssFiles)

if (mode === 'web') {
  assert.ok(entryBytes <= 180_000, `Web 入口脚本超出 180 KB：${entryBytes} bytes`)
  assert.ok(jsBytes <= 180_000, `Web JS 总量超出 180 KB：${jsBytes} bytes`)
  assert.ok(cssBytes <= 90_000, `Web CSS 总量超出 90 KB：${cssBytes} bytes`)
  assert.ok(jsFiles.length <= 2, `Web JS 分块过多：${jsFiles.length}`)
  assert.equal(fontFiles.length, 0, `Web 构建不应包含字体资源：${fontFiles.join(', ')}`)
  assert.ok(!html.includes('modulepreload'), 'Web 构建不应预加载桌面模块')
  const forbiddenAssets = files.filter((file) => /codemirror|mermaid|markdownPreview|katex|mascot|icon-/i.test(file))
  assert.deepEqual(forbiddenAssets, [], `Web 构建包含桌面资源：${forbiddenAssets.join(', ')}`)
} else {
  const oversized = jsFiles.filter((file) => (fileSizes.get(file) || 0) > 1_300_000)
  const preloadFiles = Array.from(html.matchAll(/rel="modulepreload"[^>]+href="\.\/assets\/([^"]+\.js)"/g), (match) => match[1])
  const initialJsBytes = entryBytes + totalBytes(preloadFiles)

  assert.ok(entryBytes <= 1_300_000, `桌面入口脚本超出 1.3 MB：${entryBytes} bytes`)
  assert.deepEqual(oversized, [], `存在超出 1.3 MB 的桌面脚本：${oversized.join(', ')}`)
  assert.ok(initialJsBytes <= 2_000_000, `桌面首屏 JS 超出 2 MB：${initialJsBytes} bytes`)
  assert.ok(jsBytes <= 7_500_000, `桌面 JS 总量超出 7.5 MB：${jsBytes} bytes`)
}

console.log(`Bundle budget passed (${mode}): entry ${entryBytes} bytes, JS total ${jsBytes} bytes, ${jsFiles.length} chunks`)
