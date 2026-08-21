import type { Element, Root, Text } from 'hast'

/**
 * 安全内联 SVG 的 `<style>` 处理。
 *
 * 现状：rehype-sanitize 默认 strip `style`，导致 AI / Mermaid / 流程图类 SVG
 * 把主要表现样式（fill / stroke / font、CSS 变量）写进 `<style>` + class 时，
 * 预览只剩默认外观甚至只剩描边轮廓（`line`/`path` 无显式 stroke 即不可见）。
 *
 * 目标：在不放开危险能力的前提下支持 SVG 内部展示样式。策略：
 * 1. 只处理位于 `<svg>` 内的 `<style>`（schema 用 ancestors 约束），
 *    顶层 `<style>` 仍按 strip 整体丢弃。
 * 2. 丢弃所有 at-rule（@import / @font-face / @media / @charset / @namespace …），
 *    因此不会引入外部 CSS / 字体。
 * 3. 只保留安全的 `property: value` 声明，过滤脚本向量与外部资源：
 *    - expression() / -moz-binding / behavior / javascript: / vbscript: / @import
 *    - 除本地 `url(#id)` 外的所有 url()（外部图片、data:、字体等）
 *    - 含 `<` `>` 的取值（保守丢弃）
 * 4. 用按 SVG 内容派生的唯一作用域把选择器前缀化（[data-gm-svg-scope="hash"]），
 *    使样式只作用于当前 SVG，避免 `body { display: none }` 之类影响外部 DOM。
 * 5. 本地 `url(#id)` 会重写为 `url(#user-content-id)`，与 rehype-sanitize 的
 *    clobber 前缀保持一致，保证 `<defs>` 内的渐变 / mask 引用仍命中。
 */

/** FNV-1a 32 位散列，输出 8 位十六进制字符串（仅用于生成稳定的作用域 id）。 */
function hashString(input: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

/** 忽略 position，把 HAST 子树序列化为确定字符串（用于生成稳定作用域）。 */
function serializeHastNode(node: unknown): string {
  if (!node || typeof node !== 'object') return ''
  const record = node as { type?: string; tagName?: string; properties?: Record<string, unknown>; children?: unknown[]; value?: unknown }
  if (record.type === 'text') return JSON.stringify(record.value)
  if (record.type === 'element') {
    const properties = record.properties ?? {}
    const keys = Object.keys(properties).sort()
    let output = `<${record.tagName}`
    for (const key of keys) {
      const value = properties[key]
      if (value === null || value === undefined) continue
      output += ` ${key}=${JSON.stringify(value)}`
    }
    output += '>'
    for (const child of record.children ?? []) output += serializeHastNode(child)
    output += `</${record.tagName}>`
    return output
  }
  return ''
}

function isWhitespace(char: string): boolean {
  return char === ' ' || char === '\t' || char === '\n' || char === '\r' || char === '\f'
}

/** 跳过字符串字面量，start 指向开引号，返回闭引号之后的下标。 */
function skipString(input: string, start: number): number {
  const quote = input[start]
  let i = start + 1
  const length = input.length
  while (i < length) {
    if (input[i] === '\\') {
      i += 2
      continue
    }
    if (input[i] === quote) return i + 1
    i += 1
  }
  return length
}

/** 跳过 at-rule：`@name ...;` 语句或 `@name { ... }` 块，start 指向 `@`。 */
function skipAtRule(input: string, start: number): number {
  let i = start
  const length = input.length
  let braceDepth = 0
  while (i < length) {
    const char = input[i]
    if (char === '"' || char === "'") {
      i = skipString(input, i)
      continue
    }
    if (char === '{') {
      braceDepth += 1
    } else if (char === '}') {
      braceDepth -= 1
      if (braceDepth <= 0) {
        i += 1
        break
      }
    } else if (char === ';' && braceDepth === 0) {
      i += 1
      break
    }
    i += 1
  }
  return i
}

/** 在顶层按分隔符拆分（尊重字符串、括号、方括号），返回非空片段。 */
function splitTopLevel(input: string, delimiter: string): string[] {
  const parts: string[] = []
  let depth = 0
  let buffer = ''
  let i = 0
  const length = input.length
  while (i < length) {
    const char = input[i]
    if (char === '"' || char === "'") {
      const end = skipString(input, i)
      buffer += input.slice(i, end)
      i = end
      continue
    }
    if (char === '(' || char === '[') depth += 1
    else if (char === ')' || char === ']') depth = Math.max(0, depth - 1)
    else if (char === delimiter && depth === 0) {
      parts.push(buffer.trim())
      buffer = ''
      i += 1
      continue
    }
    buffer += char
    i += 1
  }
  if (buffer.trim()) parts.push(buffer.trim())
  return parts.filter(Boolean)
}

/** 顶层规则结构。 */
interface QualifiedRule {
  selector: string
  declarations: string
}

/** 把 CSS 文本解析为顶层规则（丢弃 at-rule 与嵌套规则）。 */
function parseQualifiedRules(css: string): QualifiedRule[] {
  const rules: QualifiedRule[] = []
  let i = 0
  const length = css.length
  while (i < length) {
    while (i < length && isWhitespace(css[i])) i += 1
    if (i >= length) break
    if (css[i] === '@') {
      i = skipAtRule(css, i)
      continue
    }
    const selectorStart = i
    while (i < length) {
      const char = css[i]
      if (char === '{') break
      if (char === '"' || char === "'") {
        i = skipString(css, i)
        continue
      }
      i += 1
    }
    const selector = css.slice(selectorStart, i).trim()
    if (i >= length || css[i] !== '{') break
    i += 1 // 跳过 '{'
    const declarationStart = i
    let braceDepth = 1
    let nested = false
    while (i < length && braceDepth > 0) {
      const char = css[i]
      if (char === '"' || char === "'") {
        i = skipString(css, i)
        continue
      }
      if (char === '{') {
        braceDepth += 1
        nested = true
      } else if (char === '}') {
        braceDepth -= 1
        if (braceDepth === 0) break
      }
      i += 1
    }
    const declarations = css.slice(declarationStart, i).trim()
    if (braceDepth === 0 && i < length) i += 1 // 跳过 '}'
    // 不支持嵌套规则 / 选择器或声明区出现危险字符时，整条规则丢弃。
    if (nested || !selector || /[{}@;<]/.test(selector)) continue
    rules.push({ selector, declarations })
  }
  return rules
}

const DANGEROUS_VALUE_PATTERN = /expression\s*\(|-moz-binding|behavior\s*:|javascript\s*:|vbscript\s*:|@import/i
// CSS escapes can spell `url(` without containing that literal; these
// resource-producing functions can also load URLs without a `url()` token.
const UNSAFE_EXTERNAL_FUNCTION_PATTERN = /(?:^|[^a-z0-9_-])(?:-[\w-]+-)?(?:image|image-set|cross-fade|element|paint|src)\s*\(/i
const LOCAL_FRAGMENT_PATTERN = /^#[A-Za-z0-9_.:-]+$/
const SVG_VARIABLE_FALLBACKS: Record<string, string> = {
  '--font-sans': 'var(--gm-font-family)',
  '--color-text-primary': 'var(--gm-text)',
  '--color-text-secondary': 'var(--gm-text-secondary)',
  '--color-text-tertiary': 'var(--gm-text-tertiary)',
  '--color-border': 'var(--gm-border)',
  '--color-brand': 'var(--gm-primary)',
}
const SVG_VARIABLE_PATTERN = /var\(\s*(--[A-Za-z0-9_-]+)\s*\)/g

/** 为常见外部 SVG 主题变量提供观墨主题 fallback；变量本身仍优先使用。 */
function addSvgVariableFallbacks(value: string): string {
  return value.replace(SVG_VARIABLE_PATTERN, (match, variable: string) => {
    const fallback = SVG_VARIABLE_FALLBACKS[variable]
    return fallback ? `var(${variable}, ${fallback})` : match
  })
}

/** 校验并重写单条声明值；不安全时返回 null。 */
function sanitizeDeclarationValue(value: string): string | null {
  if (DANGEROUS_VALUE_PATTERN.test(value)) return null
  if (value.includes('\\') || UNSAFE_EXTERNAL_FUNCTION_PATTERN.test(value)) return null
  if (/[<>]/.test(value)) return null
  let output = ''
  let i = 0
  const length = value.length
  while (i < length) {
    const lower = value.toLowerCase()
    const urlIndex = lower.indexOf('url(', i)
    if (urlIndex < 0) {
      output += value.slice(i)
      break
    }
    output += value.slice(i, urlIndex)
    let cursor = urlIndex + 4 // 跳过 'url('
    while (cursor < length && isWhitespace(value[cursor])) cursor += 1
    let quote = ''
    if (value[cursor] === '"' || value[cursor] === "'") {
      quote = value[cursor]
      cursor += 1
    }
    let target = ''
    let closed = false
    while (cursor < length) {
      const char = value[cursor]
      if (quote) {
        if (char === quote) {
          cursor += 1
          closed = true
          break
        }
        if (char === '\\') {
          cursor += 2
          continue
        }
        target += char
        cursor += 1
      } else {
        if (char === ')') {
          closed = true
          break
        }
        if (char === '\\') {
          cursor += 2
          continue
        }
        target += char
        cursor += 1
      }
    }
    if (!closed) return null // url( 未闭合
    while (cursor < length && isWhitespace(value[cursor])) cursor += 1
    if (value[cursor] !== ')') return null // 畸形 url(...)
    const trimmed = target.trim()
    if (!LOCAL_FRAGMENT_PATTERN.test(trimmed)) return null // 仅允许安全的本地片段引用
    output += `url(#user-content-${trimmed.slice(1)})`
    i = cursor + 1
  }
  return addSvgVariableFallbacks(output)
}

const SAFE_PROPERTY_PATTERN = /^(?:-{1,2})?[_a-zA-Z][_a-zA-Z0-9-]*$/

/** 校验声明属性名。 */
function isSafeProperty(property: string): boolean {
  if (!SAFE_PROPERTY_PATTERN.test(property)) return false
  const lower = property.toLowerCase()
  return !/expression|-moz-binding|behavior|^@/.test(lower)
}

/** 清洗声明块，返回安全的 `property: value` 列表。 */
function sanitizeDeclarations(declarations: string): string[] {
  const safe: string[] = []
  for (const raw of splitTopLevel(declarations, ';')) {
    const colon = raw.indexOf(':')
    if (colon <= 0) continue
    const property = raw.slice(0, colon).trim()
    const value = raw.slice(colon + 1).trim()
    if (!property || !value) continue
    if (!isSafeProperty(property)) continue
    const safeValue = sanitizeDeclarationValue(value)
    if (safeValue === null || safeValue === '') continue
    safe.push(`${property}: ${safeValue}`)
  }
  return safe
}

/**
 * 把一段 SVG 内部 CSS 清洗并作用域化。
 * @returns 清洗后的 CSS；结果为空时返回空字符串。
 */
export function sanitizeAndScopeSvgCss(css: string, scopeSelector: string): string {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const output: string[] = []
  for (const rule of parseQualifiedRules(withoutComments)) {
    const selectors = splitTopLevel(rule.selector, ',').filter((selector) => !/[{}@;<]/.test(selector))
    if (selectors.length === 0) continue
    const declarations = sanitizeDeclarations(rule.declarations)
    if (declarations.length === 0) continue
    const scopedSelector = selectors.map((selector) => `${scopeSelector} ${selector}`).join(', ')
    output.push(`${scopedSelector} { ${declarations.join('; ')} }`)
  }
  return output.join('\n')
}

function isElement(node: unknown): node is Element {
  return Boolean(node) && typeof node === 'object' && (node as Element).type === 'element'
}

/**
 * rehype transformer：处理 `<svg>` 内的 `<style>`。
 * 必须在 rehype-sanitize 之后运行（此时 `<style>` 文本仍为原始 CSS）。
 */
export function processSvgStyleElements() {
  return (tree: Root) => {
    const svgs: Element[] = []
    const collectSvgs = (node: Element | Root) => {
      for (const child of node.children ?? []) {
        if (!isElement(child)) continue
        if (child.tagName === 'svg') svgs.push(child)
        else collectSvgs(child)
      }
    }
    collectSvgs(tree)

    for (const svg of svgs) {
      const styles: Element[] = []
      const collectStyles = (node: Element) => {
        for (const child of node.children ?? []) {
          if (!isElement(child)) continue
          if (child.tagName === 'style') styles.push(child)
          else collectStyles(child)
        }
      }
      collectStyles(svg)
      if (styles.length === 0) continue

      const scopeId = hashString(serializeHastNode(svg))
      const scopeSelector = `[data-gm-svg-scope="${scopeId}"]`
      svg.properties = svg.properties ?? {}
      svg.properties.dataGmSvgScope = scopeId

      for (const style of styles) {
        const rawCss = (style.children ?? [])
          .filter((child): child is Text => child.type === 'text')
          .map((child) => child.value)
          .join('')
        const scopedCss = sanitizeAndScopeSvgCss(rawCss, scopeSelector)
        style.children = scopedCss ? [{ type: 'text', value: scopedCss }] : []
      }
    }

    // 清理处理后退化为空的 `<style>`（无安全规则时移除节点，避免残留空标签）。
    const removeEmptyStyles = (node: Element | Root) => {
      if (!node.children) return
      node.children = node.children.filter((child) => {
        if (isElement(child)) {
          if (child.tagName === 'style' && (child.children ?? []).length === 0) return false
          removeEmptyStyles(child)
        }
        return true
      })
    }
    removeEmptyStyles(tree)
  }
}
