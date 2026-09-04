import { DEFAULT_APPEARANCE_CONFIG_V1, isThemeId, type ThemeId } from './appearanceSchema'

export interface ThemeTokens {
  canvas: string
  surface: string
  border: string
  text: string
  placeholder: string
  placeholderStrong: string
}

export interface ThemeDefinition<Id extends string = string> {
  id: Id
  label: string
  description: string
  colorScheme: 'light' | 'dark'
  tokens: ThemeTokens
  startupCanvas: string
}

const BUILT_IN_THEME_DEFINITIONS: readonly ThemeDefinition<ThemeId>[] = [
  {
    id: 'warm',
    label: '暖色',
    description: '观墨经典暖色',
    colorScheme: 'light',
    tokens: {
      canvas: '#f8f4e8',
      surface: '#f7f3df',
      border: '#f0ece2',
      text: '#794f27',
      placeholder: 'rgba(121, 79, 39, 0.08)',
      placeholderStrong: 'rgba(121, 79, 39, 0.12)',
    },
    startupCanvas: '#f8f4e8',
  },
  {
    id: 'light',
    label: '浅色',
    description: '清爽通用浅色',
    colorScheme: 'light',
    tokens: {
      canvas: '#ffffff',
      surface: '#ffffff',
      border: '#f1f3f5',
      text: '#1f2937',
      placeholder: 'rgba(31, 41, 55, 0.06)',
      placeholderStrong: 'rgba(31, 41, 55, 0.1)',
    },
    startupCanvas: '#ffffff',
  },
  {
    id: 'dark',
    label: '深色',
    description: '沉浸夜间写作',
    colorScheme: 'dark',
    tokens: {
      canvas: '#15130f',
      surface: '#1d1a15',
      border: '#2d271f',
      text: '#eee4d2',
      placeholder: 'rgba(224, 190, 132, 0.1)',
      placeholderStrong: 'rgba(224, 190, 132, 0.16)',
    },
    startupCanvas: '#15130f',
  },
  {
    id: 'paper',
    label: 'Paper',
    description: '舒适长文阅读',
    colorScheme: 'light',
    tokens: {
      canvas: '#f1eadc',
      surface: '#f7f0e3',
      border: '#e9dfcf',
      text: '#4e4033',
      placeholder: 'rgba(78, 64, 51, 0.07)',
      placeholderStrong: 'rgba(78, 64, 51, 0.12)',
    },
    startupCanvas: '#f1eadc',
  },
  {
    id: 'github-light',
    label: 'GitHub Light',
    description: '技术文档与代码',
    colorScheme: 'light',
    tokens: {
      canvas: '#f5f7f9',
      surface: '#ffffff',
      border: '#eaeef2',
      text: '#20262d',
      placeholder: 'rgba(32, 38, 45, 0.06)',
      placeholderStrong: 'rgba(32, 38, 45, 0.1)',
    },
    startupCanvas: '#f5f7f9',
  },
]

const THEME_TOKEN_KEYS = ['canvas', 'surface', 'border', 'text', 'placeholder', 'placeholderStrong'] as const

function isThemeTokens(value: unknown): value is ThemeTokens {
  if (!value || typeof value !== 'object') return false
  const tokens = value as Record<string, unknown>
  return THEME_TOKEN_KEYS.every((key) => typeof tokens[key] === 'string' && tokens[key] !== '')
}

export function isThemeDefinition(value: unknown): value is ThemeDefinition {
  if (!value || typeof value !== 'object') return false
  const definition = value as Record<string, unknown>
  return typeof definition.id === 'string'
    && definition.id.length > 0
    && typeof definition.label === 'string'
    && typeof definition.description === 'string'
    && (definition.colorScheme === 'light' || definition.colorScheme === 'dark')
    && isThemeTokens(definition.tokens)
    && typeof definition.startupCanvas === 'string'
    && definition.startupCanvas !== ''
}

export interface AppearanceRegistry {
  readonly builtInThemes: readonly ThemeDefinition<ThemeId>[]
  readonly themes: readonly ThemeDefinition[]
  getTheme: (themeId: unknown) => ThemeDefinition
}

export function createAppearanceRegistry(userThemes: unknown = []): AppearanceRegistry {
  const customThemes = (Array.isArray(userThemes) ? userThemes : [])
    .filter(isThemeDefinition)
  const themesById = new Map<string, ThemeDefinition>(
    [...BUILT_IN_THEME_DEFINITIONS, ...customThemes].map((theme) => [theme.id, theme]),
  )
  const fallback = BUILT_IN_THEME_DEFINITIONS.find(
    (theme) => theme.id === DEFAULT_APPEARANCE_CONFIG_V1.themeId,
  )!

  return {
    builtInThemes: BUILT_IN_THEME_DEFINITIONS,
    themes: [...themesById.values()],
    getTheme: (themeId) => themesById.get(themeId as string) ?? fallback,
  }
}

export const appearanceRegistry = createAppearanceRegistry()
export const builtInThemeDefinitions = appearanceRegistry.builtInThemes

export function isBuiltInThemeId(value: unknown): value is ThemeId {
  return isThemeId(value)
}
