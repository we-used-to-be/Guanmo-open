import { useEffect, useState } from 'react'

type WebTheme = 'light' | 'dark'
const THEME_KEY = 'guanmo-web-theme'

function readTheme(): WebTheme {
  return localStorage.getItem(THEME_KEY) === 'dark' ? 'dark' : 'light'
}

export default function WebApp() {
  const [theme, setTheme] = useState<WebTheme>(readTheme)

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    localStorage.setItem(THEME_KEY, theme)
  }, [theme])

  return (
    <main className="flex h-full items-center justify-center bg-gm-canvas px-6 text-gm-text">
      <section className="w-full max-w-xl rounded-2xl border border-gm-border bg-gm-surface p-8 text-center shadow-lg">
        <div className="text-sm font-semibold tracking-[0.25em] text-gm-primary">观墨</div>
        <h1 className="mt-4 text-2xl font-bold">完整功能仅在桌面端提供</h1>
        <p className="mt-3 text-sm leading-6 text-gm-text-secondary">
          Web 端不提供本地文件管理、数据库、AI 与知识库能力，避免产生不完整或不安全的兼容行为。
        </p>
        <div className="mt-6 flex items-center justify-center gap-3">
          <a className="rounded-lg bg-gm-primary px-4 py-2 text-sm font-semibold text-white" href="https://github.com/we-used-to-be/Guanmo-open/releases/latest">
            下载桌面版
          </a>
          <button className="rounded-lg border border-gm-border px-4 py-2 text-sm text-gm-text-secondary" onClick={() => setTheme((current) => current === 'dark' ? 'light' : 'dark')}>
            切换{theme === 'dark' ? '浅色' : '深色'}主题
          </button>
        </div>
      </section>
    </main>
  )
}
