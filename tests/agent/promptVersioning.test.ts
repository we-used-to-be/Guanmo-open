/**
 * 路由与 Prompt 版本元数据定向测试（PROMPT-01）。
 *
 * 验收点：
 * - 版本与指纹可追溯：同代码产生同指纹，Prompt 变化反映到指纹。
 * - 版本切换不修改用户数据：版本模块为纯函数，不产生任何存储写入。
 * - A/B 口径：同配置可比较且能检出 Prompt 变化；不同配置拒绝归因。
 * - 回归集匿名：fixture 不含真实路径、邮箱或用户标识。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  ROUTING_RULES_VERSION,
  PROMPT_VERSION,
  OFFLINE_DETERMINISTIC_CONFIG,
  getPromptVersionDescriptor,
  getEvaluationConfigFingerprint,
  comparePromptVariants,
  hashText,
} from '@/services/ai/promptVersions'
import { buildSystemMessages } from '@/services/ai/systemPrompts'

const fixturePath = resolve(process.cwd(), 'tests/agent/fixtures/promptEvaluation.json')
const fixtureRaw = readFileSync(fixturePath, 'utf8')
const fixture = JSON.parse(fixtureRaw) as {
  version: number
  config: unknown
  routingProbes: unknown[]
  cases: Array<Record<string, unknown>>
}

describe('版本元数据', () => {
  it('版本常量为 vN 格式', () => {
    expect(ROUTING_RULES_VERSION).toMatch(/^v\d+$/)
    expect(PROMPT_VERSION).toMatch(/^v\d+$/)
  })

  it('版本描述符包含全部 Prompt 段指纹且可重复计算', () => {
    const first = getPromptVersionDescriptor()
    const second = getPromptVersionDescriptor()
    expect(second).toEqual(first)
    expect(Object.keys(first.segmentFingerprints).sort()).toEqual([
      'baseSystemPrompt',
      'contextSafetyPrompt',
      'customPromptPolicy',
      'fileSummaryAnswerPrompt',
      'localResearchAnswerPrompt',
      'sectionReadingAnswerPrompt',
      'selectionDirectAnswerPrompt',
      'webComparisonAnswerPrompt',
    ])
    for (const fingerprint of Object.values(first.segmentFingerprints)) {
      expect(fingerprint).toMatch(/^[0-9a-f]{8}$/)
    }
    expect(first.combinedFingerprint).toMatch(/^[0-9a-f]{8}$/)
  })

  it('hashText 对内容变化敏感', () => {
    expect(hashText('版本A')).not.toBe(hashText('版本B'))
    expect(hashText('版本A')).toBe(hashText('版本A'))
  })
})

describe('A/B 评测口径', () => {
  it('离线确定性配置指纹稳定', () => {
    expect(getEvaluationConfigFingerprint(OFFLINE_DETERMINISTIC_CONFIG))
      .toBe(getEvaluationConfigFingerprint(OFFLINE_DETERMINISTIC_CONFIG))
  })

  it('不同配置产生不同指纹且被拒绝比较', () => {
    const descriptor = getPromptVersionDescriptor()
    const comparison = comparePromptVariants(
      { label: 'a', config: OFFLINE_DETERMINISTIC_CONFIG, descriptor },
      { label: 'b', config: { ...OFFLINE_DETERMINISTIC_CONFIG, model: 'other-model' }, descriptor },
    )
    expect(comparison.comparable).toBe(false)
  })

  it('同配置同 Prompt 判定为无变化', () => {
    const descriptor = getPromptVersionDescriptor()
    const comparison = comparePromptVariants(
      { label: 'a', config: OFFLINE_DETERMINISTIC_CONFIG, descriptor },
      { label: 'b', config: OFFLINE_DETERMINISTIC_CONFIG, descriptor },
    )
    expect(comparison).toMatchObject({ comparable: true, promptChanged: false, changedSegments: [] })
  })

  it('同配置不同 Prompt 检出变化段', () => {
    const baseline = getPromptVersionDescriptor()
    const variant = {
      ...baseline,
      segmentFingerprints: {
        ...baseline.segmentFingerprints,
        webComparisonAnswerPrompt: hashText('modified-segment'),
      },
    }
    const comparison = comparePromptVariants(
      { label: 'a', config: OFFLINE_DETERMINISTIC_CONFIG, descriptor: baseline },
      { label: 'b', config: OFFLINE_DETERMINISTIC_CONFIG, descriptor: variant },
    )
    expect(comparison).toMatchObject({
      comparable: true,
      promptChanged: true,
      changedSegments: ['webComparisonAnswerPrompt'],
    })
  })

  it('fixture 配置与冻结的离线口径一致', () => {
    expect(getEvaluationConfigFingerprint(fixture.config as never))
      .toBe(getEvaluationConfigFingerprint(OFFLINE_DETERMINISTIC_CONFIG))
  })
})

describe('版本切换不修改用户数据', () => {
  it('buildSystemMessages 为纯组装且结构稳定', () => {
    const first = buildSystemMessages('匿名偏好示例', 'selection_direct')
    const second = buildSystemMessages('匿名偏好示例', 'selection_direct')
    expect(second).toEqual(first)
    expect(first[0].role).toBe('system')
    expect(first[1].role).toBe('system')
    expect(first.some((message) => message.content.includes('用户偏好层'))).toBe(true)
    expect(first.some((message) => message.content.includes('唯一主要对象'))).toBe(true)
    expect(first.some((message) => message.content.includes('信息充分、已经能够回答时不要追加免责声明'))).toBe(true)
    expect(first.filter((message) => message.content.includes('根据已有信息，以上内容仅供参考。'))).toHaveLength(2)
    expect(first.filter((message) => message.content.includes('不加粗、不加标题或其他修饰'))).toHaveLength(2)
    expect(first.some((message) => message.content.includes('短词、术语或代码标识符'))).toBe(true)
  })
})

describe('回归集匿名性与完整性', () => {
  it('fixture 不含真实路径、盘符或邮箱', () => {
    expect(fixtureRaw).not.toMatch(/[A-Za-z]:\\/)
    expect(fixtureRaw).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/)
    expect(fixtureRaw).not.toMatch(/C:\\Users/i)
    expect(fixtureRaw).not.toMatch(/\/home\/|\/Users\//)
  })

  it('fixture 案例与探针数量满足基线规模', () => {
    expect(fixture.cases.length).toBeGreaterThanOrEqual(30)
    expect(fixture.routingProbes.length).toBeGreaterThanOrEqual(10)
  })

  it('每条案例具备路由判定必需字段', () => {
    for (const testCase of fixture.cases) {
      expect(typeof testCase.id).toBe('string')
      expect(typeof testCase.query).toBe('string')
      expect(['direct', 'agent']).toContain(testCase.expectedMode)
      expect(Array.isArray(testCase.forbiddenCapabilities)).toBe(true)
      expect(Array.isArray(testCase.requiredCapabilities)).toBe(true)
    }
    const ids = fixture.cases.map((testCase) => testCase.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})
