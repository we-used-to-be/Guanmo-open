import ReactMarkdown from 'react-markdown'
import { renderToStaticMarkup } from 'react-dom/server'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import { isTauri, saveFileDialog, writeFile } from '@/hooks/useTauri'
import { isSameFilePath } from '@/services/pathIdentity'

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function renderBody(markdown: string): string {
  return renderToStaticMarkup(
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkMath]}
      rehypePlugins={[rehypeKatex]}
      components={{
        code: ({ children, className }) => {
          const language = className?.replace('language-', '')
          if (language === 'mermaid') {
            return <pre className="mermaid">{String(children)}</pre>
          }
          return <code className={className}>{children}</code>
        },
      }}
    >
      {markdown}
    </ReactMarkdown>
  )
}

export function buildMarkdownHtml(markdown: string, title: string): string {
  const safeTitle = escapeHtml(title || 'Markdown Export')
  const body = renderBody(markdown)
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${safeTitle}</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.22/dist/katex.min.css" />
  <style>
    body { margin: 0; background: #fbfaf6; color: #4f3520; font: 16px/1.75 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    main { max-width: 860px; margin: 0 auto; padding: 48px 28px; background: #fffdf8; min-height: 100vh; }
    h1, h2, h3, h4 { color: #4f3520; line-height: 1.35; margin-top: 1.8em; }
    h1 { border-bottom: 1px solid #e8e2d6; padding-bottom: 12px; }
    a { color: #128b82; }
    code { background: #f0e8d8; border-radius: 6px; padding: 2px 5px; }
    pre { overflow-x: auto; border: 1px solid #e8e2d6; border-radius: 12px; background: #f8f3e9; padding: 16px; }
    pre code { background: transparent; padding: 0; }
    blockquote { border-left: 4px solid #19c8b9; margin-left: 0; padding: 10px 16px; background: #e6f9f6; color: #6f5d4a; border-radius: 0 10px 10px 0; }
    table { width: 100%; border-collapse: collapse; }
    th, td { border: 1px solid #e8e2d6; padding: 8px 10px; }
    img { max-width: 100%; border-radius: 12px; }
    .mermaid { background: #fff; }
    @media print { body { background: #fff; } main { max-width: none; padding: 0; } }
  </style>
</head>
<body>
  <main>${body}</main>
  <script type="module">
    import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs';
    mermaid.initialize({ startOnLoad: true, theme: 'base', securityLevel: 'strict' });
  </script>
</body>
</html>`
}

function isHtmlPath(path: string): boolean {
  return /\.(html|htm)$/i.test(path)
}

export async function exportMarkdownAsHtml(markdown: string, title: string, sourcePath?: string | null): Promise<string | null> {
  const html = buildMarkdownHtml(markdown, title)
  const fallbackName = `${title.replace(/[\\/:*?"<>|]/g, '_') || 'markdown-export'}.html`

  if (isTauri()) {
    const path = await saveFileDialog(fallbackName, [
      { name: 'HTML', extensions: ['html'] },
      { name: 'All Files', extensions: ['*'] },
    ])
    if (!path) return null
    if (sourcePath && isSameFilePath(path, sourcePath)) {
      throw new Error('导出已取消：不能把 HTML 写回当前 Markdown 原文。请选择 .html 文件。')
    }
    if (!isHtmlPath(path)) {
      throw new Error('导出已取消：HTML 导出只能保存为 .html 或 .htm 文件。')
    }
    await writeFile(path, html)
    return path
  }

  const blob = new Blob([html], { type: 'text/html;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fallbackName
  a.click()
  URL.revokeObjectURL(url)
  return fallbackName
}

export async function exportMarkdownAsWord(markdown: string, title: string, sourcePath?: string | null): Promise<string | null> {
  const html = buildMarkdownHtml(markdown, title)
  const fallbackName = `${title.replace(/[\\/:*?"<>|]/g, '_') || 'markdown-export'}.doc`

  if (isTauri()) {
    const path = await saveFileDialog(fallbackName, [
      { name: 'Word', extensions: ['doc'] },
      { name: 'All Files', extensions: ['*'] },
    ])
    if (!path) return null
    if (sourcePath && isSameFilePath(path, sourcePath)) {
      throw new Error('导出已取消：不能把 Word 写回当前 Markdown 原文。请选择 .doc 文件。')
    }
    if (!/\.(doc|docx)$/i.test(path)) {
      throw new Error('导出已取消：Word 导出只能保存为 .doc 文件。')
    }
    await writeFile(path, html)
    return path
  }

  const blob = new Blob([html], { type: 'application/msword' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fallbackName
  a.click()
  URL.revokeObjectURL(url)
  return fallbackName
}
