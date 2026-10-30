/** All semantic routing budgets live here. Old settings without this field use these defaults. */
export interface RouterConfig {
  enabled: boolean
  coreToolsEnabled: boolean
  model: string
  timeoutMs: number
  conflictMinScore: number
  conflictMargin: number
  maxCategories: number
  maxQueryChars: number
  maxOutputTokens: number
  diagnostics: boolean
}

export const DEFAULT_ROUTER_CONFIG: Readonly<RouterConfig> = Object.freeze({
  enabled: true,
  coreToolsEnabled: true,
  model: '',
  timeoutMs: 1200,
  conflictMinScore: 2,
  conflictMargin: 1,
  maxCategories: 3,
  maxQueryChars: 600,
  maxOutputTokens: 160,
  diagnostics: false,
})

export function resolveRouterConfig(value?: Partial<RouterConfig>): RouterConfig {
  const bounded = (key: keyof RouterConfig, min: number, max: number) => {
    const n = value?.[key]
    return typeof n === 'number' && Number.isFinite(n)
      ? Math.min(max, Math.max(min, Math.round(n)))
      : DEFAULT_ROUTER_CONFIG[key] as number
  }
  return {
    enabled: typeof value?.enabled === 'boolean' ? value.enabled : DEFAULT_ROUTER_CONFIG.enabled,
    coreToolsEnabled: typeof value?.coreToolsEnabled === 'boolean' ? value.coreToolsEnabled : DEFAULT_ROUTER_CONFIG.coreToolsEnabled,
    model: typeof value?.model === 'string' ? value.model.trim().slice(0, 128) : '',
    timeoutMs: bounded('timeoutMs', 100, 3000),
    conflictMinScore: bounded('conflictMinScore', 1, 10),
    conflictMargin: bounded('conflictMargin', 0, 3),
    maxCategories: bounded('maxCategories', 1, 3),
    maxQueryChars: bounded('maxQueryChars', 100, 1000),
    maxOutputTokens: bounded('maxOutputTokens', 80, 256),
    diagnostics: value?.diagnostics === true,
  }
}
