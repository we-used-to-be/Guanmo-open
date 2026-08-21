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
  [rehypeSanitize, MARKDOWN_HTML_SANITIZE_SCHEMA],
  processSvgStyleElements,
  restoreSanitizedSvgReferences,
]
