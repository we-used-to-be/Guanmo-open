import { formatDuration } from '@/services/usageTracking'

export const USAGE_RECEIPT_QUOTES = [
  '认真写下的每一页，都在铺就你的路。',
  '让想法落在纸上，让时间留下回响。',
  '一点点记录，会成为看得见的成长。',
  '今天留下的一行，可能是明天的答案。',
  '给思考一点时间，给灵感一个落点。',
  '不必每次都有答案，愿每次都有发现。',
  '把零散的光，慢慢写成自己的星河。',
  '每一次翻开，都是与新的自己相遇。',
]

export interface UsageReceipt {
  theme: 'light' | 'dark'
  total: string
  today: string
  activeDays: number
  longest: string
  longestDate: string
  range: string
  generatedDate: string
  quote: string
}

export function chooseReceiptQuote(previous: string | null): string {
  const candidates = USAGE_RECEIPT_QUOTES.filter((quote) => quote !== previous)
  return candidates[Math.floor(Math.random() * candidates.length)]
}

export function buildUsageReceipt(
  totalSeconds: number,
  todaySeconds: number,
  activity: Map<string, number>,
  range: { start: string; end: string },
  generatedDate: string,
  quote: string,
  themeId = 'light',
): UsageReceipt {
  const days = [...activity].filter(([date, seconds]) =>
    date >= range.start && date <= range.end && seconds > 0,
  ).sort(([a], [b]) => a.localeCompare(b))
  const longest = days.reduce<[string, number] | null>((best, day) =>
    !best || day[1] > best[1] ? day : best, null,
  )
  return {
    theme: themeId === 'dark' ? 'dark' : 'light',
    total: formatDuration(totalSeconds),
    today: formatDuration(todaySeconds),
    activeDays: days.length,
    longest: longest ? formatDuration(longest[1]) : '尚无记录',
    longestDate: longest ? longest[0].replace(/-/g, '.') : '—',
    range: `${range.start.replace(/-/g, '.')} — ${range.end.replace(/-/g, '.')}`,
    generatedDate,
    quote,
  }
}
