import { describe, expect, it, vi } from 'vitest'
import { buildUsageReceipt, chooseReceiptQuote, USAGE_RECEIPT_QUOTES } from '@/features/settings/usageReceipt'

describe('时间小票统计口径', () => {
  it('近十二个月指标排除区间外和零时长，单日最长并列时取最早日期', () => {
    const receipt = buildUsageReceipt(7200, 30, new Map([
      ['2025-01-01', 99999], ['2026-09-29', 3600], ['2026-09-28', 3600], ['2026-09-30', 0],
    ]), { start: '2025-10-15', end: '2026-10-14' }, '2026-10-14', USAGE_RECEIPT_QUOTES[0])
    expect(receipt.total).toBe('2 小时 0 分钟')
    expect(receipt.today).toBe('少于 1 分钟')
    expect(receipt.activeDays).toBe(2)
    expect(receipt.longestDate).toBe('2026.09.28')
    expect(receipt.longest).toBe('1 小时 0 分钟')
  })

  it('没有记录时不虚构最长日期', () => {
    const receipt = buildUsageReceipt(0, 0, new Map(), { start: '2025-10-15', end: '2026-10-14' }, '2026-10-14', USAGE_RECEIPT_QUOTES[0])
    expect(receipt.activeDays).toBe(0)
    expect(receipt.longest).toBe('尚无记录')
    expect(receipt.longestDate).toBe('—')
  })

  it('即使随机结果相同，连续生成也不会重复上一句', () => {
    const random = vi.spyOn(Math, 'random').mockReturnValue(0)
    try {
      const first = chooseReceiptQuote(null)
      expect(chooseReceiptQuote(first)).not.toBe(first)
    } finally { random.mockRestore() }
  })
})
