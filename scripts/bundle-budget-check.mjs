import assert from 'node:assert/strict'
import { readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

const dist = join(process.cwd(), 'dist')
const html = await readFile(join(dist, 'index.html'), 'utf8')
const entryMatch = html.match(/<script[^>]+src="\.\/assets\/([^"]+\.js)"/)
assert.ok(entryMatch, '未找到桌面构建入口脚本')

const entryPath = join(dist, 'assets', entryMatch[1])
const entryBytes = (await stat(entryPath)).size
const files = await readdir(join(dist, 'assets'))
const jsFiles = files.filter((file) => file.endsWith('.js'))
const oversized = []
for (const file of jsFiles) {
  const bytes = (await stat(join(dist, 'assets', file))).size
  if (bytes > 1_300_000) oversized.push({ file, bytes })
}

assert.ok(entryBytes <= 1_300_000, `入口脚本超出 1.3 MB：${entryBytes} bytes`)
assert.deepEqual(oversized, [], `存在超出 1.3 MB 的脚本：${JSON.stringify(oversized)}`)
console.log(`Bundle budget passed: entry ${entryBytes} bytes, ${jsFiles.length} JS chunks`)
