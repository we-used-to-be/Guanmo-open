import { describe, expect, it } from 'vitest'
import { ECHARTS_MAX_SOURCE_LENGTH, parseEChartsOption } from '@/services/echartsOption'

describe('ECharts Markdown 配置解析', () => {
  it('接受严格 JSON 的常用图表配置', () => {
    const result = parseEChartsOption(JSON.stringify({
      title: { text: '示例' },
      xAxis: { type: 'category', data: ['A', 'B'] },
      yAxis: { type: 'value' },
      series: [{ type: 'bar', data: [12, 20] }],
    }))

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.option.series).toEqual([{ type: 'bar', data: [12, 20] }])
  })

  it.each([
    ['非法 JSON', '{"series": [}', '格式无效'],
    ['根节点数组', '[]', '必须是 JSON 对象'],
    ['函数表达式', '{"formatter":"function () {}"}', '脚本表达式'],
    ['模板表达式', '{"title":{"text":"${name}"}}', '脚本表达式'],
    ['危险字段', '{"__proto__":{"polluted":true}}', '危险字段'],
    ['远程资源', '{"graphic":{"style":{"image":"https://example.com/a.png"}}}', '远程资源'],
    ['未支持图表', '{"series":[{"type":"gauge"}]}', '不支持的图表类型'],
  ])('拒绝%s', (_label, source, message) => {
    const result = parseEChartsOption(source)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain(message)
  })

  it('拒绝超过大小限制的配置', () => {
    const result = parseEChartsOption(JSON.stringify({ text: 'x'.repeat(ECHARTS_MAX_SOURCE_LENGTH) }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain('限制')
  })
})
