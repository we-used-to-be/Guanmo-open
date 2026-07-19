import assert from 'node:assert/strict'
import { buildMarkdownHtml } from '../src/services/markdownExport'

const multilineParagraph = ['第一行', '第二行', '第三行'].join('\n')
const html = buildMarkdownHtml(multilineParagraph, '换行导出检查')

assert.match(html, /<p>第一行\n第二行\n第三行<\/p>/)
assert.match(html, /p,\s*li\s*\{[^}]*white-space:\s*pre-wrap;/)

console.log('Markdown 导出换行检查通过')
process.exit(0)
