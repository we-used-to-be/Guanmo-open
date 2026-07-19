import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeHighlight from 'rehype-highlight'
import rehypeKatex from 'rehype-katex'
import { isValidElement, memo, useEffect, useMemo, useState } from 'react'
import { convertFileSrc } from '@tauri-apps/api/core'
import { isTauri } from '@/hooks/useTauri'
import { createHeadingId, type TocItem } from '@/services/markdownToc'
import { normalizeLatexBlockDelimiters, remarkStandaloneDisplayMath } from '@/services/markdownMath'
import { useSettingsStore } from '@/stores/settingsStore'

const MARKDOWN_REMARK_PLUGINS = [remarkGfm, remarkMath, remarkStandaloneDisplayMath]
const MARKDOWN_REHYPE_PLUGINS = [rehypeKatex, rehypeHighlight]
const NORMALIZED_MARKDOWN_CACHE_LIMIT = 4
const normalizedMarkdownCache = new Map<string, string>()

interface MarkdownPreviewProps {
  content: string
  filePath?: string | null
  fontSize?: number
  lineHeight?: number
  skipHtml?: boolean
  onTaskToggle?: (line: number, checked: boolean) => void
  onHeadingClick?: (line: number) => void
}

function getNormalizedMarkdown(content: string): string {
  const cached = normalizedMarkdownCache.get(content)
  if (cached !== undefined) return cached

  const normalized = normalizeLatexBlockDelimiters(content)
  normalizedMarkdownCache.set(content, normalized)
  if (normalizedMarkdownCache.size > NORMALIZED_MARKDOWN_CACHE_LIMIT) {
    const oldest = normalizedMarkdownCache.keys().next().value
    if (oldest !== undefined) normalizedMarkdownCache.delete(oldest)
  }
  return normalized
}

export const MarkdownPreview = memo(function MarkdownPreview({
  content,
  filePath,
  fontSize = 14,
  lineHeight = 1.65,
  skipHtml = false,
  onTaskToggle,
  onHeadingClick,
}: MarkdownPreviewProps) {
  const normalizedContent = useMemo(() => getNormalizedMarkdown(content), [content])
  const [zoomImage, setZoomImage] = useState<{ src: string; alt: string } | null>(null)

  const components = useMemo<Partial<Components>>(() => {
    const headingIds = new Map<string, number>()
    const handleAnchorClick = (href?: string) => (event: React.MouseEvent<HTMLAnchorElement>) => {
      if (!href?.startsWith('#')) return
      event.preventDefault()
      const id = href.slice(1)
      const scope = event.currentTarget.closest('.prose')
      const scopedTarget = scope?.querySelector<HTMLElement>(`#${CSS.escape(id)}`)
      const target = scopedTarget ?? document.getElementById(id)
      target?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      if (target instanceof HTMLElement) {
        target.focus({ preventScroll: true })
      }
      if (typeof history !== 'undefined' && history.replaceState) {
        history.replaceState(null, '', href)
      }
    }

    return {
          h1: ({ children, node }) => {
            const line = getNodeStartLine(node)
            const id = line ? `heading-${line}` : createHeadingId(getText(children), headingIds)
            return (
              <h1 id={id} data-heading-id={id} data-md-line={line} onClick={() => handleHeadingClick(line, onHeadingClick)} className="scroll-mt-6 font-bold mt-8 mb-4 text-gm-text border-b border-gm-border pb-3" style={{ fontSize: '2em' }}>
                {children}
              </h1>
            )
          },
          h2: ({ children, node }) => {
            const line = getNodeStartLine(node)
            const id = line ? `heading-${line}` : createHeadingId(getText(children), headingIds)
            return (
              <h2 id={id} data-heading-id={id} data-md-line={line} onClick={() => handleHeadingClick(line, onHeadingClick)} className="scroll-mt-6 font-bold mt-8 mb-4 text-gm-text" style={{ fontSize: '1.5em' }}>
                {children}
              </h2>
            )
          },
          h3: ({ children, node }) => {
            const line = getNodeStartLine(node)
            const id = line ? `heading-${line}` : createHeadingId(getText(children), headingIds)
            return (
              <h3 id={id} data-heading-id={id} data-md-line={line} onClick={() => handleHeadingClick(line, onHeadingClick)} className="scroll-mt-6 font-bold mt-6 mb-3 text-gm-text" style={{ fontSize: '1.25em' }}>
                {children}
              </h3>
            )
          },
          h4: ({ children, node }) => {
            const line = getNodeStartLine(node)
            const id = line ? `heading-${line}` : createHeadingId(getText(children), headingIds)
            return (
              <h4 id={id} data-heading-id={id} data-md-line={line} onClick={() => handleHeadingClick(line, onHeadingClick)} className="scroll-mt-6 font-bold mt-4 mb-2 text-gm-text" style={{ fontSize: '1.1em' }}>
                {children}
              </h4>
            )
          },
          p: ({ children, node }) => (
            <p className="my-3" data-md-line={getNodeStartLine(node)} data-md-end-line={getNodeEndLine(node)}>{children}</p>
          ),
          strong: ({ children }) => (
            <strong className="font-bold text-gm-text">{children}</strong>
          ),
          em: ({ children }) => (
            <em className="text-gm-text italic">{children}</em>
          ),
          code: ({ children, className, node }) => {
            const language = className?.match(/language-([\w-]+)/)?.[1]
            const isBlock = Boolean(language)
            if (isBlock && language === 'mermaid') {
              return <MermaidBlock code={String(children).replace(/\n$/, '')} startLine={getNodeStartLine(node)} endLine={getNodeEndLine(node)} />
            }
            if (isBlock) {
              return (
                <CodeBlock code={String(children).replace(/\n$/, '')} language={language} fontSize={fontSize} startLine={getNodeStartLine(node)} endLine={getNodeEndLine(node)}>
                  {className && (
                    <div className="px-4 py-1.5 border-b border-gm-border text-micro text-gm-text-secondary font-mono">
                      {language}
                    </div>
                  )}
                  <pre className="p-4 overflow-x-auto m-0">
                    <code className={['font-mono', className].filter(Boolean).join(' ')} style={{ fontSize: '0.9em' }}>
                      {children}
                    </code>
                  </pre>
                </CodeBlock>
              )
            }
            return (
              <code className="px-2 py-0.5 rounded-lg bg-gm-surface-elevated text-gm-accent font-mono" style={{ fontSize: '0.9em' }}>
                {children}
              </code>
            )
          },
          blockquote: ({ children, node }) => (
            <blockquote className="pl-4 border-l-4 border-gm-primary rounded-r-lg py-3 text-gm-text-secondary italic my-4" data-md-line={getNodeStartLine(node)} data-md-end-line={getNodeEndLine(node)}>
              {children}
            </blockquote>
          ),
          a: ({ href, children, ...props }) => {
            const isHashLink = href?.startsWith('#')
            const isFootnoteBackref = 'data-footnote-backref' in props
            return (
              <a
                href={href}
                className="text-gm-primary hover:underline font-bold transition-colors hover:text-gm-primary-hover"
                target={isHashLink ? undefined : '_blank'}
                rel={isHashLink ? undefined : 'noopener noreferrer'}
                onClick={handleAnchorClick(href)}
                {...props}
              >
                {isFootnoteBackref ? (children && String(children).trim() ? children : '↩ 返回正文') : children}
              </a>
            )
          },
          ul: ({ children }) => (
            <ul className="my-3 pl-6 space-y-1 list-disc">{children}</ul>
          ),
          ol: ({ children }) => (
            <ol className="my-3 pl-6 space-y-1 list-decimal">{children}</ol>
          ),
          li: ({ children, node, ...liProps }) => {
            const line = node?.position?.start?.line
            return (
              <li data-md-line={typeof line === 'number' ? line : undefined} {...liProps}>
                {children}
              </li>
            )
          },
          hr: ({ node }) => <hr className="my-6 border-gm-border" data-md-line={getNodeStartLine(node)} />,
          table: ({ children, node }) => (
            <div className="my-4 overflow-x-auto rounded-xl border border-gm-border" data-md-line={getNodeStartLine(node)}>
              <table className="w-full border-collapse">
                {children}
              </table>
            </div>
          ),
          thead: ({ children }) => (
            <thead className="bg-gm-surface-elevated">{children}</thead>
          ),
          th: ({ children }) => (
            <th className="px-4 py-2.5 text-left font-bold text-gm-text border-b border-gm-border">
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td className="px-4 py-2 border-b border-gm-border-subtle">
              {children}
            </td>
          ),
          img: ({ src, alt, node }) => {
            const resolvedSrc = resolveImageSrc(src, filePath)
            const altText = alt || ''
            return (
              <button
                type="button"
                className="my-4 block max-w-full cursor-zoom-in rounded-xl border border-gm-border bg-transparent p-0 text-left"
                onClick={() => setZoomImage({ src: resolvedSrc, alt: altText })}
                title="点击放大图片"
                data-md-line={getNodeStartLine(node)}
              >
                <img
                  src={resolvedSrc}
                  alt={altText}
                  className="max-w-full rounded-xl"
                />
              </button>
            )
          },
          del: ({ children }) => (
            <del className="text-gm-text-tertiary line-through">{children}</del>
          ),
          input: ({ checked, node, ...props }) => {
            // 只处理task list的checkbox
            if (props.type !== 'checkbox') {
              return <input {...props} />
            }
            const isChecked = Boolean(checked)
            return (
              <input
                type="checkbox"
                checked={isChecked}
                readOnly={!onTaskToggle}
                disabled={!onTaskToggle}
                onChange={(e) => {
                  e.stopPropagation()
                  if (!onTaskToggle) return
                  // input 节点的 position 在 HAST 中是 undefined，从父级 li 的 data-md-line 获取行号
                  const li = e.currentTarget.closest('[data-md-line]')
                  const lineStr = li?.getAttribute('data-md-line')
                  const line = lineStr ? Number(lineStr) : undefined
                  if (typeof line === 'number' && !Number.isNaN(line)) {
                    onTaskToggle(line, !isChecked)
                  }
                }}
                className={`mr-2 accent-gm-primary ${onTaskToggle ? 'cursor-pointer select-none' : ''}`}
                style={onTaskToggle ? { cursor: 'pointer' } : undefined}
              />
            )
          },
        }
  }, [filePath, fontSize, onHeadingClick, onTaskToggle])

  return (
    <div
      className="prose gm-markdown-preview max-w-none min-w-0 text-gm-text"
      style={{ fontSize: `${fontSize}px`, lineHeight }}
    >
      <ReactMarkdown
        skipHtml={skipHtml}
        remarkPlugins={MARKDOWN_REMARK_PLUGINS}
        rehypePlugins={MARKDOWN_REHYPE_PLUGINS}
        components={components}
      >
        {normalizedContent}
      </ReactMarkdown>
      {zoomImage && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-8"
          onClick={() => setZoomImage(null)}
        >
          <button
            type="button"
            className="absolute right-5 top-5 flex h-9 w-9 items-center justify-center rounded-full bg-gm-surface text-gm-text shadow-lg"
            onClick={() => setZoomImage(null)}
            title="关闭"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
          <img
            src={zoomImage.src}
            alt={zoomImage.alt}
            className="max-h-full max-w-full rounded-xl bg-gm-surface object-contain shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          />
        </div>
      )}
    </div>
  )
})

function handleHeadingClick(line: number | undefined, onHeadingClick?: (line: number) => void) {
  if (!onHeadingClick || typeof line !== 'number') return
  onHeadingClick(line)
}

function CodeBlock({
  code,
  language,
  fontSize,
  startLine,
  endLine,
  children,
}: {
  code: string
  language?: string
  fontSize: number
  startLine?: number
  endLine?: number
  children: React.ReactNode
}) {
  const [copied, setCopied] = useState(false)

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1200)
    } catch {
      setCopied(false)
    }
  }

  return (
    <div className="group gm-code-block relative my-4 rounded-xl border border-gm-border overflow-hidden" data-md-line={startLine} data-md-end-line={endLine}>
      <button
        type="button"
        onClick={() => void handleCopy()}
        className="absolute right-2 top-2 z-10 flex h-7 min-w-7 items-center justify-center rounded-md border border-gm-border bg-gm-surface/90 px-2 text-micro text-gm-text-tertiary opacity-0 shadow-sm transition-opacity hover:text-gm-primary group-hover:opacity-100 focus-visible:opacity-100"
        title={language ? `复制 ${language} 代码` : '复制代码'}
      >
        {copied ? '已复制' : (
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
            <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
          </svg>
        )}
      </button>
      <div style={{ fontSize }}>
        {children}
      </div>
    </div>
  )
}

function resolveImageSrc(src: string | undefined, filePath?: string | null): string {
  if (!src) return ''
  if (/^(https?:|data:|blob:|asset:|file:)/i.test(src) || src.startsWith('#')) return src
  if (!filePath || !isTauri()) return src

  const normalizedSrc = decodeLocalImagePath(src).replace(/\\/g, '/')
  const absolutePath = /^[a-zA-Z]:\//.test(normalizedSrc) || normalizedSrc.startsWith('//')
    ? normalizedSrc
    : joinPreviewPath(dirnamePreviewPath(filePath), normalizedSrc)
  return convertFileSrc(absolutePath)
}

function decodeLocalImagePath(path: string): string {
  try {
    return decodeURI(path)
  } catch {
    return path
  }
}

function dirnamePreviewPath(path: string): string {
  const normalized = path.replace(/\\/g, '/')
  const index = normalized.lastIndexOf('/')
  return index >= 0 ? normalized.slice(0, index) : normalized
}

function joinPreviewPath(baseDir: string, relativePath: string): string {
  const cleanRelative = relativePath.replace(/^\.\//, '')
  return `${baseDir.replace(/\/$/, '')}/${cleanRelative}`
}

function getText(node: React.ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(getText).join('')
  if (isValidElement<{ children?: React.ReactNode }>(node)) return getText(node.props.children)
  return ''
}

function getNodeStartLine(node: unknown): number | undefined {
  return getNodeLine(node, 'start')
}

function getNodeEndLine(node: unknown): number | undefined {
  return getNodeLine(node, 'end')
}

function getNodeLine(node: unknown, edge: 'start' | 'end'): number | undefined {
  if (!node || typeof node !== 'object') return undefined
  const position = (node as { position?: { start?: { line?: unknown }; end?: { line?: unknown } } }).position
  const line = position?.[edge]?.line
  return typeof line === 'number' && Number.isFinite(line) ? line : undefined
}

function MermaidBlock({ code, startLine, endLine }: { code: string; startLine?: number; endLine?: number }) {
  const [svg, setSvg] = useState('')
  const [error, setError] = useState<string | null>(null)
  const theme = useSettingsStore((state) => state.appearance.theme)

  useEffect(() => {
    let cancelled = false
    async function render() {
      try {
        const mermaid = (await import('mermaid')).default
        const isDark = theme === 'dark'
        mermaid.initialize({
          startOnLoad: false,
          theme: 'base',
          securityLevel: 'strict',
          themeVariables: isDark ? {
            background: '#1d1a15',
            primaryColor: '#30291e',
            primaryTextColor: '#eee4d2',
            primaryBorderColor: '#514532',
            secondaryColor: '#1a3a35',
            secondaryTextColor: '#eee4d2',
            secondaryBorderColor: '#38d1c1',
            tertiaryColor: '#252017',
            tertiaryTextColor: '#eee4d2',
            tertiaryBorderColor: '#3b3327',
            lineColor: '#b7aa94',
            textColor: '#eee4d2',
            edgeLabelBackground: '#1d1a15',
          } : undefined,
        })
        const id = `mermaid-${Date.now()}-${Math.random().toString(36).slice(2)}`
        const result = await mermaid.render(id, code)
        if (!cancelled) {
          setSvg(result.svg)
          setError(null)
        }
      } catch (err) {
        if (!cancelled) {
          setSvg('')
          setError(err instanceof Error ? err.message : String(err))
        }
      }
    }
    render()
    return () => { cancelled = true }
  }, [code, theme])

  if (error) {
    return (
      <div className="my-4 rounded-xl border border-gm-error/30 bg-gm-error/5 p-3" data-md-line={startLine} data-md-end-line={endLine}>
        <div className="mb-2 text-caption font-bold text-gm-error">Mermaid 渲染失败</div>
        <pre className="overflow-x-auto text-gm-text-secondary" style={{ fontSize: '0.85em' }}>{code}</pre>
      </div>
    )
  }

  return (
    <div className="my-4 overflow-x-auto rounded-xl border border-gm-border bg-gm-surface-elevated p-4" data-md-line={startLine} data-md-end-line={endLine}>
      {svg ? (
        <div className="mermaid-diagram" dangerouslySetInnerHTML={{ __html: svg }} />
      ) : (
        <div className="text-caption text-gm-text-tertiary">正在渲染 Mermaid...</div>
      )}
    </div>
  )
}

interface MarkdownTocSection {
  key: string
  title: string
  toc: TocItem[]
  onHeadingClick: (item: TocItem) => void
  emptyText?: string
  activeHeading?: string | null
}

export function MarkdownToc({
  toc = [],
  collapsed,
  onToggle,
  onHeadingClick,
  sections,
  activeHeading,
}: {
  toc?: TocItem[]
  collapsed: boolean
  onToggle: () => void
  onHeadingClick?: (item: TocItem) => void
  sections?: MarkdownTocSection[]
  activeHeading?: string | null
}) {
  const explicitSections = sections && sections.length > 0
    ? sections.slice(0, 2)
    : null
  const visibleSections = explicitSections
    ? explicitSections
    : toc.length > 1
      ? [{ key: 'toc', title: '目录', toc, onHeadingClick: onHeadingClick ?? (() => {}) }]
      : []
  const dualColumn = visibleSections.length > 1

  if (visibleSections.length === 0) return null

  return (
    <aside
      className={`gm-markdown-toc relative h-full flex-shrink-0 ${dualColumn ? 'gm-markdown-toc--dual' : ''} ${
        collapsed ? 'w-0' : 'gm-markdown-toc--expanded border-l border-gm-border-subtle bg-gm-surface'
      }`}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-label={collapsed ? '展开目录' : '收起目录'}
        aria-expanded={!collapsed}
        className="absolute left-0 top-1/2 z-10 flex h-12 w-5 -translate-x-full -translate-y-1/2 items-center justify-center rounded-l-2xl border border-r-0 border-gm-border bg-gm-surface text-gm-text-tertiary shadow-sm hover:border-gm-primary/40 hover:bg-gm-surface-hover hover:text-gm-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gm-primary/40"
        title={collapsed ? '展开目录' : '收起目录'}
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d={collapsed ? 'M15 18l-6-6 6-6' : 'M9 18l6-6-6-6'} />
        </svg>
      </button>
      {!collapsed && (
        <nav aria-label="文档目录" className="h-full pl-4 pr-0 py-3 text-micro text-gm-text-tertiary">
          <div className={dualColumn ? 'flex h-full gap-3 overflow-hidden' : 'max-h-full space-y-4 overflow-y-auto'}>
            {visibleSections.map((section) => (
              <section key={section.key} className={dualColumn ? 'flex min-h-0 min-w-0 flex-1 flex-col' : 'pr-4'}>
                <div className="mb-2 truncate font-bold text-gm-text-secondary" title={section.title}>
                  {section.title}
                </div>
                <div className={dualColumn ? 'min-h-0 flex-1 space-y-1 overflow-y-auto' : 'space-y-1'}>
                  {section.toc.length > 1 ? (
                    section.toc.map((item) => {
                      const currentActive = section.activeHeading !== undefined ? section.activeHeading : activeHeading
                      const isActive = currentActive === item.id
                      return (
                        <button
                          key={`${section.key}-${item.id}-${item.line}`}
                          type="button"
                          onClick={() => section.onHeadingClick(item)}
                          className={`block w-full truncate rounded-md py-1 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gm-primary/30 ${
                            isActive
                              ? 'font-bold'
                              : 'hover:bg-gm-surface-hover hover:text-gm-primary'
                          }`}
                          style={{
                            paddingLeft: 6 + Math.max(0, item.level - 1) * 10,
                            ...(isActive ? {
                              backgroundColor: 'color-mix(in srgb, var(--gm-active-indicator) 10%, transparent)',
                              color: 'var(--gm-active-indicator)',
                            } : {}),
                          }}
                          title={`${item.text}（第 ${item.line} 行）`}
                        >
                          {item.text}
                        </button>
                      )
                    })
                  ) : (
                    <div className="rounded-md border border-dashed border-gm-border-subtle px-3 py-2 text-gm-text-muted">
                      {section.emptyText ?? '无目录'}
                    </div>
                  )}
                </div>
              </section>
            ))}
          </div>
        </nav>
      )}
    </aside>
  )
}
