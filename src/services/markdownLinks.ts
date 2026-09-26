import type { Element, Root } from 'hast'
import { isTauri } from '@/hooks/useTauri'

export type MarkdownLinkTarget =
  | { kind: 'anchor'; fragment: string }
  | { kind: 'web'; url: string }
  | { kind: 'markdown' | 'image' | 'unsupported'; path: string; fragment: string }

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0)
    if (code < 32 || code === 127) return true
  }
  return false
}

// Preserve local link addresses through both URL filters without allowing new
// executable schemes. Only desktop click handling interprets these addresses.
export function rehypeLocalLinkPaths() {
  return (tree: Root) => {
    if (!isTauri()) return
    const visit = (parent: Root | Element) => {
      for (const node of parent.children) {
        if (node.type !== 'element') continue
        const href = node.properties.href
        if (node.tagName === 'a' && typeof href === 'string') {
          if (/^[a-z]:(?:[/\\]|%5c)/i.test(href)) {
            node.properties.href = `${href[0]}%3A${href.slice(2)}`
          } else if (/^file:\/\//i.test(href)) {
            node.properties.href = href.replace(/^file:/i, 'file%3A')
          }
        }
        visit(node)
      }
    }
    visit(tree)
  }
}

function sourceFileUrl(path: string): URL {
  const normalized = path.replace(/\\/g, '/').replace(/^\/\/\?\/UNC\//i, '//').replace(/^\/\/\?\//, '')
  const encoded = normalized.split('/').map(encodeURIComponent).join('/').replace(/^([a-z])%3A\//i, '$1:/')
  if (/^[a-z]:\//i.test(normalized)) return new URL(`file:///${encoded}`)
  if (normalized.startsWith('//')) return new URL(`file:${encoded}`)
  if (normalized.startsWith('/')) return new URL(`file://${encoded}`)
  throw new Error('无法确定当前文档的本地位置')
}

export function resolveMarkdownLink(href: string | undefined, filePath?: string | null): MarkdownLinkTarget {
  if (!href?.trim()) throw new Error('链接地址为空或已被安全过滤，无法打开')
  const raw = href.trim()
  if (hasControlCharacters(raw)) throw new Error('链接包含无效控制字符')
  if (raw.startsWith('#')) return { kind: 'anchor', fragment: decodeURIComponent(raw.slice(1)) }
  if (/^mailto:/i.test(raw)) return { kind: 'web', url: new URL(raw).href }
  if (/^https?:\/\//i.test(raw) || raw.startsWith('//')) {
    const url = new URL(raw.startsWith('//') ? `https:${raw}` : raw)
    if (['tauri.localhost', 'asset.localhost'].includes(url.hostname.toLowerCase().replace(/\.$/, ''))) {
      throw new Error('应用内部地址不能交给外部浏览器打开')
    }
    return { kind: 'web', url: url.href }
  }
  const local = raw
    .replace(/^([a-z])%3a(?=\/|\\|%5c)/i, '$1:')
    .replace(/^file%3a(?=\/\/)/i, 'file:')
    .replace(/%5c/gi, '/')
    .replace(/\\/g, '/')
  let url: URL
  if (/^file:\/\//i.test(local)) url = new URL(local)
  else if (/^[a-z]:\//i.test(local)) url = new URL(`file:///${local}`)
  else if (local.startsWith('//')) url = new URL(`file:${local}`)
  else {
    if (/^[a-z][a-z\d+.-]*:/i.test(local)) throw new Error('不支持或不安全的链接协议')
    if (!filePath) throw new Error('请先保存当前文档，再打开相对路径链接')
    const drive = /^([a-z]:)[/\\]/i.exec(filePath)?.[1]
    url = local.startsWith('/') && drive
      ? new URL(`file:///${drive}${local}`)
      : new URL(local, sourceFileUrl(filePath))
  }
  if (url.protocol !== 'file:' || url.search) throw new Error('无效的本地文件链接')
  let path = decodeURIComponent(url.pathname)
  if (url.hostname && url.hostname !== 'localhost') path = `//${url.hostname}${path}`
  else if (/^\/[a-z]:\//i.test(path)) path = path.slice(1)
  if (hasControlCharacters(path) || path.split('/').includes('..')) throw new Error('无效的本地文件路径')
  const fragment = decodeURIComponent(url.hash.slice(1))
  const kind = /\.md$/i.test(path) ? 'markdown'
    : /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(path) ? 'image' : 'unsupported'
  return { kind, path, fragment }
}
