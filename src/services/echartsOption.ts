import type { EChartsOption } from 'echarts'

export const ECHARTS_MAX_SOURCE_LENGTH = 256 * 1024

export const SUPPORTED_ECHARTS_SERIES = [
  'line',
  'bar',
  'pie',
  'scatter',
  'radar',
  'heatmap',
] as const

type SupportedEChartsSeries = typeof SUPPORTED_ECHARTS_SERIES[number]

const supportedSeries = new Set<string>(SUPPORTED_ECHARTS_SERIES)
const forbiddenKeys = new Set(['__proto__', 'prototype', 'constructor'])

export type EChartsOptionParseResult =
  | { ok: true; option: EChartsOption }
  | { ok: false; message: string }

export function parseEChartsOption(source: string): EChartsOptionParseResult {
  const sourceBytes = new TextEncoder().encode(source).byteLength
  if (sourceBytes > ECHARTS_MAX_SOURCE_LENGTH) {
    return { ok: false, message: `配置超过 ${Math.round(ECHARTS_MAX_SOURCE_LENGTH / 1024)} KiB 限制` }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(source)
  } catch (error) {
    const detail = error instanceof Error ? error.message : '语法错误'
    return { ok: false, message: `JSON 配置格式无效：${detail}` }
  }

  if (!isPlainObject(parsed)) return { ok: false, message: 'ECharts 配置必须是 JSON 对象' }

  const unsafeValue = findUnsafeValue(parsed, 0)
  if (unsafeValue) return { ok: false, message: unsafeValue }

  const remoteValue = findRemoteUrl(parsed, 0)
  if (remoteValue) return { ok: false, message: `不允许加载远程资源：${remoteValue}` }

  const executableString = findExecutableString(parsed, 0)
  if (executableString) return { ok: false, message: `不允许执行脚本表达式：${executableString}` }

  const series = parsed.series
  const seriesItems = Array.isArray(series) ? series : series ? [series] : []
  for (const item of seriesItems) {
    if (!isPlainObject(item) || item.type === undefined) continue
    if (typeof item.type !== 'string' || !supportedSeries.has(item.type)) {
      return { ok: false, message: `不支持的图表类型：${String(item.type)}` }
    }
  }

  return { ok: true, option: parsed as EChartsOption }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function findUnsafeValue(value: unknown, depth: number): string | null {
  if (depth > 64) return '配置嵌套层级过深'
  if (Array.isArray(value)) {
    for (const item of value) {
      const result = findUnsafeValue(item, depth + 1)
      if (result) return result
    }
    return null
  }
  if (!isPlainObject(value)) return null
  for (const [key, child] of Object.entries(value)) {
    if (forbiddenKeys.has(key)) return `配置包含危险字段：${key}`
    const result = findUnsafeValue(child, depth + 1)
    if (result) return result
  }
  return null
}

function findRemoteUrl(value: unknown, depth: number): string | null {
  if (depth > 64) return null
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return /^https?:\/\//i.test(trimmed) ? value : null
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const result = findRemoteUrl(item, depth + 1)
      if (result) return result
    }
    return null
  }
  if (!isPlainObject(value)) return null
  for (const child of Object.values(value)) {
    const result = findRemoteUrl(child, depth + 1)
    if (result) return result
  }
  return null
}

function findExecutableString(value: unknown, depth: number): string | null {
  if (depth > 64) return null
  if (typeof value === 'string') {
    if (
      /^\s*(?:async\s+)?function\b/i.test(value)
      || /^\s*(?:\([^)]*\)|[\w$]+)\s*=>/.test(value)
      || /\$\{[^}]*\}/.test(value)
    ) return value
    return null
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const result = findExecutableString(item, depth + 1)
      if (result) return result
    }
    return null
  }
  if (!isPlainObject(value)) return null
  for (const child of Object.values(value)) {
    const result = findExecutableString(child, depth + 1)
    if (result) return result
  }
  return null
}

export function isSupportedEChartsSeries(value: unknown): value is SupportedEChartsSeries {
  return typeof value === 'string' && supportedSeries.has(value)
}
