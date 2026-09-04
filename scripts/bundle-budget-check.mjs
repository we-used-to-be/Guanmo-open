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
  // Web 端现在复用桌面编辑器、预览和布局；预算与桌面首屏/总包保持同一量级。
  assert.ok(entryBytes <= 1_350_000, `Web 入口脚本超出 1.35 MB：${entryBytes} bytes`)
  assert.ok(jsBytes <= 7_500_000, `Web JS 总量超出 7.5 MB：${jsBytes} bytes`)
  assert.ok(cssBytes <= 180_000, `Web CSS 总量超出 180 KB：${cssBytes} bytes`)
  assert.ok(!html.includes('modulepreload'), 'Web 构建不应预加载桌面模块')
  const webSources = await Promise.all(jsFiles.map((file) => readFile(join(dist, 'assets', file), 'utf8')))
  const webBundle = webSources.join('\n')
  assert.doesNotMatch(webBundle, /@tauri-apps|tauri:\/\//i, 'Web 构建不得包含 Tauri 运行时')
  assert.doesNotMatch(webBundle, /indexedDB|indexeddb/i, 'Web 构建不得包含 IndexedDB')
  assert.doesNotMatch(webBundle, /sqlite:/i, 'Web 构建不得包含 SQLite 数据库连接')
} else {
  const oversized = jsFiles.filter((file) => (fileSizes.get(file) || 0) > 1_350_000)
  const preloadFiles = Array.from(html.matchAll(/rel="modulepreload"[^>]+href="\.\/assets\/([^"]+\.js)"/g), (match) => match[1])
  const initialJsBytes = entryBytes + totalBytes(preloadFiles)

  const editorChunks = jsFiles.filter((file) => /^EditorArea-.*\.js$/.test(file))
  assert.equal(editorChunks.length, 1, `未找到唯一 EditorArea chunk：${editorChunks.join(', ')}`)
  const editorSource = await readFile(join(dist, 'assets', editorChunks[0]), 'utf8')
  assert.doesNotMatch(
    editorSource,
    /from["']\.\/MarkdownPreview-.*\.js["']/,
    'EditorArea 不得静态 import MarkdownPreview chunk',
  )
  assert.match(
    editorSource,
    /import\(["']\.\/MarkdownPreview-.*\.js["']\)/,
    'EditorArea 必须保留 MarkdownPreview 的动态 import 边界',
  )

  const updateChunks = jsFiles.filter((file) => /^UpdateManager-.*\.js$/.test(file))
  assert.equal(updateChunks.length, 1, `未找到唯一 UpdateManager chunk：${updateChunks.join(', ')}`)
  const updateSource = await readFile(join(dist, 'assets', updateChunks[0]), 'utf8')
  assert.doesNotMatch(
    updateSource,
    /from["']\.\/MarkdownPreview-.*\.js["']/,
    'UpdateManager 不得静态 import MarkdownPreview chunk',
  )
  assert.match(
    updateSource,
    /import\(["']\.\/MarkdownPreview-.*\.js["']\)/,
    'UpdateManager 必须保留 MarkdownPreview 的动态 import 边界',
  )

  const previewChunks = jsFiles.filter((file) => /^MarkdownPreview-.*\.js$/.test(file))
  assert.equal(previewChunks.length, 1, `未找到唯一 MarkdownPreview chunk：${previewChunks.join(', ')}`)
  const previewSource = await readFile(join(dist, 'assets', previewChunks[0]), 'utf8')
  assert.doesNotMatch(
    previewSource,
    /from["']\.\/InlineMarkdownBlockEditor-.*\.js["']/,
    'MarkdownPreview 不得静态 import InlineMarkdownBlockEditor chunk',
  )
  assert.match(
    previewSource,
    /import\(["']\.\/InlineMarkdownBlockEditor-.*\.js["']\)/,
    'MarkdownPreview 必须保留 InlineMarkdownBlockEditor 的动态 import 边界',
  )

  const echartsChunks = jsFiles.filter((file) => /^EChartsBlock-.*\.js$/.test(file))
  assert.equal(echartsChunks.length, 1, `未找到唯一 EChartsBlock chunk：${echartsChunks.join(', ')}`)
  assert.doesNotMatch(
    previewSource,
    /from["']\.\/EChartsBlock-.*\.js["']/,
    'MarkdownPreview 不得静态 import EChartsBlock chunk',
  )
  assert.match(
    previewSource,
    /import\(["']\.\/EChartsBlock-.*\.js["']\)/,
    'MarkdownPreview 必须保留 EChartsBlock 的动态 import 边界',
  )
  assert.equal(
    preloadFiles.includes(echartsChunks[0]),
    false,
    'EChartsBlock 不得进入桌面首屏 modulepreload',
  )

  assert.ok(entryBytes <= 1_350_000, `桌面入口脚本超出 1.35 MB：${entryBytes} bytes`)
  assert.deepEqual(oversized, [], `存在超出 1.3 MB 的桌面脚本：${oversized.join(', ')}`)
  assert.ok(initialJsBytes <= 2_000_000, `桌面首屏 JS 超出 2 MB：${initialJsBytes} bytes`)
  assert.ok(jsBytes <= 7_500_000, `桌面 JS 总量超出 7.5 MB：${jsBytes} bytes`)
  assert.equal(
    jsFiles.some((file) => /^markdownPreview\.worker-.*\.js$/.test(file)),
    false,
    'Markdown 预览必须保持同步 ReactMarkdown 路径，不得重新打包独立 Worker',
  )
}

console.log(`Bundle budget passed (${mode}): entry ${entryBytes} bytes, JS total ${jsBytes} bytes, ${jsFiles.length} chunks`)
