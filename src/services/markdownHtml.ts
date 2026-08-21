import type { Options } from 'react-markdown'
import type { Element, Root } from 'hast'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize, { defaultSchema, type Options as SanitizeSchema } from 'rehype-sanitize'
import { processSvgStyleElements } from './svgStyle'

const SAFE_SVG_TAGS = [
  'svg',
  'title',
  'desc',
  'defs',
  'style',
  'g',
  'marker',
  'path',
  'rect',
  'circle',
  'ellipse',
  'line',
  'polyline',
  'polygon',
  'text',
  'tspan',
  'clipPath',
  'mask',
  'pattern',
  'linearGradient',
  'radialGradient',
  'stop',
]

const SAFE_SVG_ATTRIBUTES = [
  'className',
  'id',
  'role',
  'viewBox',
  'xmlns',
  'width',
  'height',
  'preserveAspectRatio',
  'transform',
  'd',
  'points',
  'x',
  'y',
  'x1',
  'y1',
  'x2',
  'y2',
  'cx',
  'cy',
  'r',
  'rx',
  'ry',
  'dx',
  'dy',
  'fill',
  'fillOpacity',
  'fillRule',
  'filter',
  'stroke',
  'strokeWidth',
  'strokeLineCap',
  'strokeLineJoin',
  'strokeMiterLimit',
  'strokeDashArray',
  'strokeDashOffset',
  'strokeOpacity',
  'opacity',
  'vectorEffect',
  'color',
  'fontFamily',
  'fontSize',
  'fontStyle',
  'fontWeight',
  'textAnchor',
  'dominantBaseline',
  'paintOrder',
  'clipPath',
  'mask',
  'markerStart',
  'markerMid',
  'markerEnd',
  'refX',
  'refY',
  'markerWidth',
  'markerHeight',
  'markerUnits',
  'orient',
  'offset',
  'stopColor',
  'stopOpacity',
  'gradientUnits',
  'gradientTransform',
  'spreadMethod',
]

const SAFE_SVG_ATTRIBUTE_SCHEMA = Object.fromEntries(
  SAFE_SVG_TAGS.map((tagName) => [tagName, SAFE_SVG_ATTRIBUTES]),
) as NonNullable<SanitizeSchema['attributes']>
const SAFE_SVG_TAG_SET = new Set(SAFE_SVG_TAGS)
const SAFE_SVG_ATTRIBUTE_SET = new Set(SAFE_SVG_ATTRIBUTES)

/**
 * rehype-raw normalizes attributes parsed inside an SVG, but fragments that
 * were split out by a blank line are parsed as HTML paragraphs and keep their
 * source names (`font-size`, `text-anchor`, ...). Normalize only known safe
 * SVG names before reattaching those fragments so the sanitizer does not drop
 * their presentation attributes.
 */
const SVG_ATTRIBUTE_ALIASES = new Map<string, string>([
  ['class', 'className'],
  ['stroke-linecap', 'strokeLineCap'],
  ['stroke-linejoin', 'strokeLineJoin'],
  ['stroke-miterlimit', 'strokeMiterLimit'],
  ['stroke-dasharray', 'strokeDashArray'],
  ['stroke-dashoffset', 'strokeDashOffset'],
])

for (const property of SAFE_SVG_ATTRIBUTES) {
  SVG_ATTRIBUTE_ALIASES.set(property, property)
  SVG_ATTRIBUTE_ALIASES.set(property.toLowerCase(), property)
  SVG_ATTRIBUTE_ALIASES.set(property.replace(/[A-Z]/g, (match) => `-${match.toLowerCase()}`), property)
}

function normalizeSvgFragmentProperties(node: Element): void {
  const properties = node.properties ?? {}
  for (const property of Object.keys(properties)) {
    const canonical = SVG_ATTRIBUTE_ALIASES.get(property) ?? property
    if (canonical === property || !SAFE_SVG_ATTRIBUTE_SET.has(canonical)) continue
    const value = properties[property]
    delete properties[property]
    if (!(canonical in properties)) properties[canonical] = value
  }
  for (const child of node.children) {
    if (isElement(child)) normalizeSvgFragmentProperties(child)
  }
}

const SVG_REFERENCE_PROPERTIES = ['fill', 'stroke', 'filter', 'clipPath', 'mask', 'markerStart', 'markerMid', 'markerEnd']
const SVG_EXTERNAL_RESOURCE_PROPERTIES = ['href', 'xLinkHref', 'src', 'srcSet']

interface SourceRange {
  start: number
  end: number
}

function collectSvgSourceRanges(source: string): SourceRange[] {
  const ranges: SourceRange[] = []
  const openTags: number[] = []
  let index = 0

  while (index < source.length) {
    const start = source.indexOf('<', index)
    if (start < 0) break
    if (source.startsWith('<!--', start)) {
      const commentEnd = source.indexOf('-->', start + 4)
      index = commentEnd < 0 ? source.length : commentEnd + 3
      continue
    }

    let cursor = start + 1
    let quote: string | null = null
    while (cursor < source.length) {
      const char = source[cursor]
      if (quote) {
        if (char === quote) quote = null
      } else if (char === '"' || char === "'") {
        quote = char
      } else if (char === '>') {
        break
      }
      cursor += 1
    }
    if (cursor >= source.length) break

    const tag = source.slice(start, cursor + 1)
    if (/^<svg(?:\s|>)/i.test(tag) && !/\/\s*>$/.test(tag)) {
      openTags.push(start)
    } else if (/^<\/svg(?:\s|>)/i.test(tag)) {
      const svgStart = openTags.pop()
      if (svgStart !== undefined) ranges.push({ start: svgStart, end: cursor + 1 })
    }
    index = cursor + 1
  }

  return ranges
}

const MARKDOWN_HTML_SANITIZE_SCHEMA: SanitizeSchema = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames ?? []), ...SAFE_SVG_TAGS],
  strip: [...(defaultSchema.strip ?? []), 'style', 'foreignObject'],
  ancestors: {
    ...defaultSchema.ancestors,
    style: ['svg'],
  },
  attributes: {
    ...defaultSchema.attributes,
    ...SAFE_SVG_ATTRIBUTE_SCHEMA,
    code: [
      ...(defaultSchema.attributes?.code ?? []),
      ['className', 'math-inline', 'math-display'],
    ],
  },
}

function isElement(node: Root['children'][number]): node is Element {
  return node.type === 'element'
}

function getSvgFragment(node: Root['children'][number]): Element[] | null {
  if (!isElement(node)) return null
  if (node.tagName !== 'p') {
    return SAFE_SVG_TAG_SET.has(node.tagName) ? [node] : null
  }
  const elements = node.children.filter(isElement)
  const hasNonWhitespaceText = node.children.some((child) => child.type === 'text' && child.value.trim().length > 0)
  if (hasNonWhitespaceText || elements.length === 0 || !elements.every((child) => SAFE_SVG_TAG_SET.has(child.tagName))) return null
  return elements
}

/**
 * Blank lines inside an SVG terminate remark's HTML block. rehypeRaw then
 * leaves the trailing SVG elements in adjacent root nodes; merge only
 * source-range-confirmed, SVG-safe fragments back into their opening SVG.
 */
function mergeSplitSvgFragments() {
  return (tree: Root, file?: { toString?: () => string }) => {
    const source = file?.toString?.()
    if (!source) return
    const ranges = collectSvgSourceRanges(source)
    if (ranges.length === 0) return

    const visit = (parent: Root | Element) => {
      for (let index = 0; index < parent.children.length; index += 1) {
        const child = parent.children[index]
        if (!isElement(child)) continue
        if (child.tagName === 'svg') {
          const start = child.position?.start?.offset
          const end = child.position?.end?.offset
          const range = typeof start === 'number' ? ranges.find((candidate) => candidate.start === start) : undefined
          if (range && typeof end === 'number' && end < range.end) {
            const fragments: Element[] = []
            let nextIndex = index + 1
            while (nextIndex < parent.children.length) {
              const next = parent.children[nextIndex]
              if (next.type === 'text' && next.value.trim().length === 0) {
                nextIndex += 1
                continue
              }
              const nextStart = isElement(next) ? next.position?.start?.offset : undefined
              if (typeof nextStart !== 'number' || nextStart >= range.end) break
              const fragment = getSvgFragment(next)
              if (!fragment) break
              for (const element of fragment) {
                normalizeSvgFragmentProperties(element)
                fragments.push(element)
              }
              nextIndex += 1
            }
            if (fragments.length > 0) {
              child.children.push(...fragments)
              parent.children.splice(index + 1, nextIndex - index - 1)
            }
          }
        }
        visit(child)
      }
    }
    visit(tree)
  }
}

/**
 * Markdown parses a single-line SVG as an HTML-bearing paragraph. Keeping the
 * SVG under <p> makes the sanitizer treat the whole subtree as invalid HTML;
 * promote a paragraph that contains only one SVG before sanitizing it.
 */
function promoteStandaloneSvg() {
  return (tree: Root) => {
    const visit = (parent: Root | Element) => {
      const children = []
      for (const child of parent.children) {
        if (isElement(child) && child.tagName === 'p') {
          const meaningfulChildren = child.children.filter((entry) => (
            entry.type !== 'text' || entry.value.trim().length > 0
          ))
          if (
            meaningfulChildren.length === 1
            && isElement(meaningfulChildren[0])
            && meaningfulChildren[0].tagName === 'svg'
          ) {
            children.push(meaningfulChildren[0])
            continue
          }
        }
        if (isElement(child)) visit(child)
        children.push(child)
      }
      parent.children = children
    }
    visit(tree)
  }
}

function restoreSanitizedSvgReferences() {
  return (tree: Root, file?: { toString?: () => string }) => {
    const svgSourceRanges: SourceRange[] = []
    const svgElementStarts = new Set<number>()
    const collectTreeSvgSourceRanges = (node: Root | Element) => {
      for (const child of node.children) {
        if (!isElement(child)) continue
        const start = child.position?.start.offset
        const end = child.position?.end.offset
        if (child.tagName === 'svg' && typeof start === 'number') {
          svgElementStarts.add(start)
          if (typeof end === 'number') svgSourceRanges.push({ start, end })
        }
        collectTreeSvgSourceRanges(child)
      }
    }
    collectTreeSvgSourceRanges(tree)
    if (file?.toString) {
      for (const range of collectSvgSourceRanges(file.toString())) {
        if (svgElementStarts.has(range.start)) svgSourceRanges.push(range)
      }
    }

    const isInsideSvgSource = (node: Element): boolean => {
      const start = node.position?.start.offset
      return typeof start === 'number' && svgSourceRanges.some((range) => start >= range.start && start < range.end)
    }

    const visit = (node: Root | Element, insideSvg: boolean) => {
      const safeChildren = []
      for (const child of node.children) {
        if (!isElement(child)) {
          safeChildren.push(child)
          continue
        }
        const childInsideSvg = insideSvg || child.tagName === 'svg' || isInsideSvgSource(child)
        // rehype-sanitize 的全局 HTML 白名单仍可能允许 <a>/<img> 等元素，
        // 因此 SVG 子树再做一次纯 SVG 标签边界收紧，避免外部资源或 HTML 混入。
        if (childInsideSvg && !SAFE_SVG_TAG_SET.has(child.tagName)) continue
        if (childInsideSvg) {
          for (const property of SVG_REFERENCE_PROPERTIES) {
            const value = child.properties[property]
            if (typeof value !== 'string' || !value.includes('url(')) continue
            const localReference = /^url\(#([A-Za-z0-9_.:-]+)\)$/.exec(value)
            if (!localReference) {
              delete child.properties[property]
              continue
            }
            child.properties[property] = `url(#user-content-${localReference[1]})`
          }
          for (const property of SVG_EXTERNAL_RESOURCE_PROPERTIES) delete child.properties[property]
        }
        visit(child, childInsideSvg)
        safeChildren.push(child)
      }
      node.children = safeChildren
    }
    visit(tree, false)
  }
}

export const MARKDOWN_HTML_REHYPE_PLUGINS: NonNullable<Options['rehypePlugins']> = [
  rehypeRaw,
  mergeSplitSvgFragments,
  promoteStandaloneSvg,
  [rehypeSanitize, MARKDOWN_HTML_SANITIZE_SCHEMA],
  processSvgStyleElements,
  restoreSanitizedSvgReferences,
]
