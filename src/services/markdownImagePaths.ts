import type { Element, Root } from 'hast'
import { isTauri } from '@/hooks/useTauri'

/**
 * A Windows drive is not a URL scheme. Escape only its colon on Markdown image
 * nodes before HTML sanitation and react-markdown's default URL transform run.
 * MarkdownImage restores the drive before the backend checks the actual file.
 * Keep the default URL filters for links and every other protocol untouched.
 */
export function rehypeWindowsImagePaths() {
  return (tree: Root) => {
    if (!isTauri()) return
    const visit = (parent: Root | Element) => {
      for (const child of parent.children) {
        if (child.type !== 'element') continue
        const src = child.properties.src
        if (child.tagName === 'img' && typeof src === 'string' && /^[a-z]:(?:[/\\]|%5c)/i.test(src)) {
          child.properties.src = `${src[0]}%3A${src.slice(2)}`
        }
        visit(child)
      }
    }
    visit(tree)
  }
}

export function decodePreviewImagePath(src: string): string {
  let decoded = src
  try { decoded = decodeURI(src) } catch { /* Preserve malformed escapes as literal filename characters. */ }
  // decodeURI deliberately keeps reserved colons encoded; restore only a drive
  // colon, never an arbitrary protocol or another encoded part of the filename.
  return decoded.replace(/^([a-z])%3a(?=[/\\])/i, '$1:')
}
