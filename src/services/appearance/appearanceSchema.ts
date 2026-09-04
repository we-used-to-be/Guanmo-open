export const THEME_IDS = ['warm', 'light', 'dark', 'paper', 'github-light'] as const
export type ThemeId = typeof THEME_IDS[number]
export type NonDarkThemeId = Exclude<ThemeId, 'dark'>

export const APPEARANCE_CONFIG_VERSION = 1 as const
export type MotionPreference = 'system' | 'reduced' | 'full'
export const ASSISTANT_VISUAL_IDS = ['sprite'] as const
export type AssistantVisualId = typeof ASSISTANT_VISUAL_IDS[number]

export interface AppearanceConfigV1 {
  version: typeof APPEARANCE_CONFIG_VERSION
  themeId: ThemeId
  assistantVisualId: AssistantVisualId
  motionPreference: MotionPreference
}

export const DEFAULT_APPEARANCE_CONFIG_V1: AppearanceConfigV1 = {
  version: APPEARANCE_CONFIG_VERSION,
  themeId: 'warm',
  assistantVisualId: 'sprite',
  motionPreference: 'system',
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null
}

export function isThemeId(value: unknown): value is ThemeId {
  return typeof value === 'string' && THEME_IDS.includes(value as ThemeId)
}

export function resolveThemeId(appearance: unknown): ThemeId {
  const saved = asRecord(appearance)
  if (saved && isThemeId(saved.themeId)) return saved.themeId
  if (saved?.theme === 'dark') return 'dark'
  if (saved?.theme === 'light' && saved.lightPalette === 'plain') return 'light'
  return DEFAULT_APPEARANCE_CONFIG_V1.themeId
}

export function resolveLastLightThemeId(appearance: unknown): NonDarkThemeId {
  const saved = asRecord(appearance)
  if (
    saved
    && isThemeId(saved.lastLightThemeId)
    && saved.lastLightThemeId !== 'dark'
  ) {
    return saved.lastLightThemeId
  }
  const themeId = resolveThemeId(saved)
  if (themeId !== 'dark') return themeId
  return saved?.lightPalette === 'plain' ? 'light' : 'warm'
}

export function resolveMotionPreference(value: unknown): MotionPreference {
  return value === 'reduced' || value === 'full' || value === 'system'
    ? value
    : DEFAULT_APPEARANCE_CONFIG_V1.motionPreference
}

export function isAssistantVisualId(value: unknown): value is AssistantVisualId {
  return typeof value === 'string' && ASSISTANT_VISUAL_IDS.includes(value as AssistantVisualId)
}

export function resolveAssistantVisualId(value: unknown): AssistantVisualId {
  return isAssistantVisualId(value)
    ? value
    : DEFAULT_APPEARANCE_CONFIG_V1.assistantVisualId
}

export function resolveAppearanceConfig(appearance: unknown): AppearanceConfigV1 {
  const saved = asRecord(appearance)
  return {
    ...DEFAULT_APPEARANCE_CONFIG_V1,
    themeId: resolveThemeId(saved),
    assistantVisualId: resolveAssistantVisualId(saved?.assistantVisualId),
    motionPreference: resolveMotionPreference(saved?.motionPreference),
  }
}
