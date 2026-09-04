import { appearanceRegistry, type ThemeDefinition } from './appearanceRegistry'
import type { AppearanceConfigV1, ThemeId } from './appearanceSchema'

export function resolveThemeDefinition(themeId: unknown): ThemeDefinition {
  return appearanceRegistry.getTheme(themeId)
}

export function applyAppearanceToDocument(
  config: Pick<AppearanceConfigV1, 'themeId'>,
  root: HTMLElement | null = typeof document === 'undefined' ? null : document.documentElement,
): ThemeDefinition | null {
  if (!root) return null
  const theme = resolveThemeDefinition(config.themeId)
  root.dataset.themeId = theme.id
  root.dataset.theme = theme.colorScheme
  root.style.colorScheme = theme.colorScheme
  root.style.setProperty('--gmss-canvas', theme.tokens.canvas)
  root.style.setProperty('--gmss-surface', theme.tokens.surface)
  root.style.setProperty('--gmss-border', theme.tokens.border)
  root.style.setProperty('--gmss-text', theme.tokens.text)
  root.style.setProperty('--gmss-placeholder', theme.tokens.placeholder)
  root.style.setProperty('--gmss-placeholder-strong', theme.tokens.placeholderStrong)
  delete root.dataset.lightPalette
  return theme
}

export function syncDocumentTheme(themeId: ThemeId): ThemeDefinition | null {
  return applyAppearanceToDocument({ themeId })
}
