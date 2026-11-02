// Draft labels transcribed from plan v1; do not use before independent review.
import { readFileSync, writeFileSync } from 'node:fs'
import process from 'node:process'

// [identity, value, scope, primary message, supporting messages, allowed state/action]
const f = (identity, value, scope = 'global', primary = 1, support = [], action = 'active_or_candidate') => ({ identity, value, scope, primary, support, action })
const definitions = {
  '01': [f('用户专业', '计算机科学')],
  '02': [f('职业', '工业设计师'), f('长期方向', '无障碍产品')],
  '03': [f('回答顺序', '先结论后依据')],
  '04': [f('阅读代码主题', '深色')],
  '05': [], '06': [],
  '07': [{ ...f('项目数据库', 'PostgreSQL', 'P', 3, [1], 'candidate'), optionalSupport: [2] }],
  '08': [{ ...f('项目发布方式', '流水线', 'P', 3, [1], 'candidate'), optionalSupport: [2] }],
  '09': [f('回答顺序', '结论先行', 'global', 3, [1], 'candidate')],
  '10': [f('笔记格式', '分主题', 'global', 3, [1], 'candidate')],
  '11': [f('技术学习方式', '先最小例子后原理')],
  '12': [f('交流语言', '简体中文')],
  '13': [], '14': [], '15': [], '16': [],
  '17': [f('回答语言', '英文', 'global', 1, [], 'replacement_candidate')],
  '18': [f('称呼', '小周', 'global', 1, [], 'replacement_candidate')],
  '19': [],
  '20': [{ ...f('专业', '电子工程', 'global', 1, [], 'active_or_candidate_deduplicated'), alternatePrimary: [3] }],
  '21': [f('技术栈', 'Vue', 'P', 1, [], 'replacement_candidate')],
  '22': [f('习惯', '晚起', 'global', 1, [], 'conflict_candidate')],
  '23': [], '24': [],
  '25': [f('技术回答顺序', '先结论', 'global', 1, [], 'explicit_confirmation')],
  '26': [f('技术栈', 'Rust', 'P', 1, [], 'explicit_confirmation')],
  '27': [], '28': [],
  '29': [f('数据库', 'SQLite', 'P'), f('数据库', 'PostgreSQL', 'Q', 3)],
  '30': [f('包管理器', 'pnpm', 'P'), f('包管理器', 'npm', 'Q', 2)],
  '31': [], '32': [], '33': [], '34': [],
  '35': [f('学习语言', 'Rust'), f('学习里程碑', '完成所有权章节', 'global', 3, [1], 'candidate')],
  '36': [f('构建工具', 'Vite', 'P'), f('迁移事件', 'Webpack迁移至Vite已完成', 'P')],
  '37': [f('专业', '数学'), f('长期目标', '研究数论', 'global', 3)],
  '38': [f('数据库', 'SQLite', 'P', 5, [1, 2], 'candidate')],
  '39': [], '40': [],
}
const forbidden = {
  '04': ['医学推断'], '07': ['全局所有未来项目'], '12': ['英语水平', '国籍'],
  '13': ['长期字数限制'], '14': ['长期语言偏好'], '16': ['职业医生'],
  '19': ['同义重复'], '20': ['重复记录'], '21': ['直接覆盖手动active'],
  '23': ['敏感内容发送或保存'], '24': ['敏感内容发送或保存', '医学事实'],
  '26': ['全局Rust偏好'], '27': ['语言英文'], '28': ['询问当保存请求'],
  '29': ['跨作用域替代'], '30': ['跨会话拼窗', '全局包管理器'],
  '31': ['待翻译文本当用户事实'], '32': ['文档人物当用户'], '33': ['助手建议当决定'],
  '34': ['工具输出当用户事实'], '38': ['推断为PostgreSQL'],
  '39': ['源删除后写入'], '40': ['可见快照修改后写入'],
}
const input = 'docs/memory/evaluation/extraction-v1/cases.jsonl'
const items = readFileSync(input, 'utf8').trim().split('\n').map(line => JSON.parse(line))
const states = action => action === 'explicit_confirmation'
  ? { discovery: ['proposal'], beforeConfirmation: ['proposal'], afterScriptedConfirmation: ['active'] }
  : action.includes('candidate') && !action.startsWith('active_or_candidate')
    ? { discovery: ['candidate'], beforeConfirmation: ['candidate'], afterScriptedConfirmation: ['candidate'] }
    : { discovery: ['active', 'candidate'], beforeConfirmation: ['active', 'candidate'], afterScriptedConfirmation: ['active', 'candidate'] }
const protectedExisting = { '17': '回答语言/中文', '18': '称呼/小林', '21': '技术栈/React', '22': '习惯/早起' }
const gold = items.map(item => {
  const convert = index => item.messages[index - 1]?.id ?? null
  return { id: item.id, script: item.script, reviewStatus: 'pending_independent_review',
    initialStateDescription: item.initialStateDescription, forbidden: forbidden[item.script] || [],
    protectedExisting: protectedExisting[item.script] ? { identityValue: protectedExisting[item.script], assertion: 'unchanged_before_confirmation' } : null,
    faultAssertion: ['39', '40'].includes(item.script) ? { source: convert(1), mutation: item.script === '39' ? 'delete' : 'metadata_only', requireBarrierAndMutationProof: true, requireNoLateWrite: true } : null,
    facts: definitions[item.script].map(fact => ({ ...fact, primary: convert(fact.primary), support: fact.support.map(convert),
      optionalSupport: (fact.optionalSupport || []).map(convert), expectedStates: states(fact.action), activeRecallDenominator: true,
      ...(fact.alternatePrimary ? { alternatePrimary: fact.alternatePrimary.map(convert) } : {}),
      missingSupport: fact.support.some(index => !convert(index)) })) }
})
if (gold.length !== 200 || Object.keys(definitions).length !== 40 || gold.some(item => item.facts.some(fact => !fact.primary))) throw new Error('Incomplete gold')
writeFileSync('docs/memory/evaluation/extraction-v1/gold-structured-v2.jsonl', gold.map(x => JSON.stringify(x)).join('\n') + '\n', { flag: 'wx' })
process.stdout.write(`Created ${gold.length} unreviewed structured gold records.\n`)
