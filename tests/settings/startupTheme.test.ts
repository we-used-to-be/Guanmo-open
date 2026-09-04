import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'

const indexHtml = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8')
const startupShellCss = readFileSync(resolve(process.cwd(), 'src/styles/startupShell.css'), 'utf8')
const startupThemeScript = indexHtml.match(
  /<script id="guanmo-startup-theme">([\s\S]*?)<\/script>/,
)?.[1]

function resolveStartupTheme(
  settings: unknown,
  webTheme?: 'dark' | 'light',
): { themeId: string; theme: string; colorScheme: string; startupCanvas: string } {
  const values = new Map<string, string>()
  if (settings !== undefined) values.set('guanmo-settings', JSON.stringify(settings))
  if (webTheme) values.set('guanmo-web-theme', webTheme)
  const style = {
    colorScheme: '',
    startupCanvas: '',
    values: {} as Record<string, string>,
    setProperty(name: string, value: string) {
      this.values[name] = value
      if (name === '--gmss-canvas') this.startupCanvas = value
    },
  }
  const root = { dataset: {} as Record<string, string>, style }

  runInNewContext(startupThemeScript!, {
    performance: { mark: () => undefined },
    localStorage: { getItem: (key: string) => values.get(key) ?? null },
    document: { documentElement: root },
  })

  return {
    themeId: root.dataset.themeId,
    theme: root.dataset.theme,
    colorScheme: root.style.colorScheme,
    startupCanvas: root.style.startupCanvas,
  }
}

function startupCanvas(themeId: string): string | undefined {
  const selector = themeId === 'warm' ? ':root' : `:root[data-theme-id='${themeId}']`
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return startupShellCss.match(
    new RegExp(`${escapedSelector}\\s*\\{[^}]*--gmss-canvas:\\s*([^;]+);`),
  )?.[1].trim()
}

describe('冷启动主题', () => {
  it.each([
    ['warm', '#f8f4e8', 'light'],
    ['light', '#ffffff', 'light'],
    ['dark', '#15130f', 'dark'],
    ['paper', '#f1eadc', 'light'],
    ['github-light', '#f5f7f9', 'light'],
  ])('在首个模块执行前恢复 %s 主题', (themeId, canvas, colorScheme) => {
    expect(startupThemeScript).toBeTruthy()
    expect(resolveStartupTheme({ state: { appearance: { themeId } } })).toMatchObject({
      themeId,
      theme: colorScheme,
      colorScheme,
      startupCanvas: canvas,
    })
    expect(startupCanvas(themeId)).toBe(canvas)
  })

  it('兼容旧版深浅主题字段与 Web 主题键', () => {
    expect(resolveStartupTheme({ state: { appearance: { theme: 'dark' } } }).themeId).toBe('dark')
    expect(resolveStartupTheme({ state: { appearance: { theme: 'light', lightPalette: 'plain' } } }).themeId).toBe('light')
    expect(resolveStartupTheme(undefined, 'dark').themeId).toBe('dark')
  })

})
