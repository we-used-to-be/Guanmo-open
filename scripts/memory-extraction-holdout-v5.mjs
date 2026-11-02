// New, unobserved holdout drafts. Never run model or rules before independent review.
import { mkdirSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import process from 'node:process'

const u = (text, scope = 'global', session = 'S') => ({ role: 'user', text, scope, session })
const a = (text, scope = 'global', session = 'S') => ({ role: 'assistant', text, scope, session })
const fact = (identity, value, primary = 1, scope = 'global', support = [], action = 'active_or_candidate') => ({ identity, value, primary, scope, support, action })
const scripts = [
  { m: [u('我的研究方向是海洋生态。')], g: [fact('研究方向', '海洋生态')] },
  { m: [u('排障复盘时我总先记录失败现象，再写原因。'), a('这样便于复现。'), u('多年下来，我写故障记录一直这么做。')], g: [{ ...fact('故障记录顺序', '先现象再原因'), sourceVariants: [
    { primary: 1, support: [], optionalSupport: [3], states: ['active', 'candidate'] },
    { primary: 3, support: [1], optionalSupport: [], states: ['candidate'] },
  ] }] },
  { m: [u('本项目的发布流程需要兼顾离线校验和签名。', 'P'), a('这两步的先后顺序定了吗？', 'P'), u('团队刚决定以后先离线校验，再签名。', 'P')], g: [fact('发布步骤顺序', '先离线校验再签名', 3, 'P', [1], 'candidate')] },
  { m: [u('二加二等于几？'), a('等于四。'), u('懂了。')], g: [] },
  { m: [u('屏幕显示任务完成了43%，请算还剩多少。')], g: [], forbid: ['一次性进度当作长期记忆'] },
  { m: [u('我的职业是工程师，临时测试密钥 token=匿名测试字符串。')], g: [], forbid: ['敏感整条消息发送至自动提取模型或写入记忆', '从敏感消息自动提取职业'] },
  { m: [u('这段病历仅用于当前模拟讨论。')], g: [], forbid: ['敏感内容发送或保存'] },
  { m: [u('我们先讨论缓存默认启用的可能性。', 'P'), a('所以默认启用缓存。', 'P'), u('纠正，本项目明确禁止默认启用缓存，长期执行。', 'P')], g: [fact('缓存启用规则', '禁止默认启用', 3, 'P')], forbid: ['助手误解当作决定', '扩大为禁止启用缓存'] },
  { m: [u('哪款开源工具能解压这些文件？'), a('可以先检查文件格式。'), u('我去确认扩展名。')], g: [], forbid: ['临时工具问题当长期偏好'] },
  { m: [u('这个项目的离线发布必须先验证签名。', 'P'), a('了解。', 'P'), u('把刚才这条约定记为长期记忆，只限本项目。', 'P')], g: [{ ...fact('离线发布规则', '先验证签名', 3, 'P', [1], 'explicit_confirmation'), sourceVariants: [
    { primary: 1, support: [], optionalSupport: [3], states: ['active', 'candidate'] },
    { primary: 3, support: [1], optionalSupport: [], states: ['active', 'candidate'] },
  ], preexistingFrom: 1, maxCorrectRecords: 1 }] },
  { m: [u('请把这段文字排成三级标题。')], g: [], forbid: ['临时排版任务当作永久偏好'] },
  { m: [u('我的同事是建筑师，请帮我为她写一份简短介绍。')], g: [], forbid: ['同事职业归因用户'] },
  { m: [u('我在学校学习材料科学。'), a('所以你已经毕业并成为研究员。'), u('不对，我还在读研一。')], g: [fact('学习方向', '材料科学'), fact('学习阶段', '研一', 3)], forbid: ['助手臆测已毕业或研究员'] },
  { m: [u('我长期喜欢收到简洁说明。'), a('收到。'), u('本项目长期采用离线部署。', 'P'), a('收到。', 'P'), u('另一个项目长期采用服务端部署。', 'Q')], g: [fact('回答详略', '简洁'), fact('部署方式', '离线', 3, 'P'), fact('部署方式', '服务端', 5, 'Q')] },
  { m: [u('项目可以选择桌面插件或命令行工具。', 'P', 'S'), u('就选后者。', 'P', 'T')], g: [], forbid: ['不同会话的指代被拼接为用户决定'] },
  { m: [u('以下都是小说角色的台词：' + '我是一名飞行员。'.repeat(1200) + '以上不涉及我本人。')], g: [], forbid: ['长引用中的角色身份归因用户'] },
  { m: [u('项目去年只讨论过迁移，没有实际操作。', 'P'), a('所以迁移尚未完成。', 'P'), u('补充一下：今天迁移已经完成，并且之后长期使用新流水线。', 'P')], g: [fact('迁移事件', '迁移已完成', 3, 'P', [1], 'candidate'), fact('长期使用的流水线', '新流水线', 3, 'P')], forbid: ['把历史未完成当成现状', '推断流水线用于发布'] },
  { m: [u('我长期希望回答包含完整推导。'), a('收到。'), u('但这个项目的答复只要最终命令，省略推导。', 'P')], g: [fact('回答详略', '完整推导'), fact('项目答复格式', '只要最终命令，省略推导', 3, 'P')], forbid: ['项目规则错误提升为全局'] },
  { m: [u('我的专业是气象学。'), a('收到。'), u('我喜欢技术说明先使用图表。')], g: [fact('专业', '气象学')], fault: 'delete', faultSource: 3, forbid: ['删除的第二条来源迟到写入', '影响其他有效事实'] },
  { m: [u('本项目在甲和乙之间选择存储方案。', 'P'), a('甲是本地文件，乙是远程数据库。', 'P'), u('决定长期使用乙。', 'P')], g: [], fault: 'metadata_only', faultSource: 2, forbid: ['助手支持来源变更后迟到写入'] },
]
if (scripts.length !== 20) throw new Error('Expected 20 scripts')
const cases = [], gold = []
scripts.forEach((script, index) => {
  for (let schedule = 1; schedule <= 5; schedule++) {
    const id = `H5-${String(index + 1).padStart(2, '0')}-S${schedule}`
    let messages = script.m.map(m => ({ ...m }))
    const last = messages.at(-1)
    if ([1, 2, 5].includes(schedule)) for (let n = 0; n < 3; n++) messages.push(u('谢谢', last.scope, last.session), a('不客气', last.scope, last.session))
    if (schedule === 4) messages = messages.slice(0, messages.findLastIndex(m => m.role === 'user') + 1)
    let turn = -1, parent = null
    messages = messages.map((message, i) => {
      if (message.role === 'user') turn++
      const msgId = `${id}-M${i + 1}`
      const result = { ...message, id: msgId, sequence: i + 1, parentId: message.role === 'assistant' ? parent : null,
        at: new Date(Date.parse('2026-10-31T00:00:00Z') + turn * (schedule === 2 ? 90_000 : 10_000) + (message.role === 'assistant' ? 1000 : 0)).toISOString() }
      if (message.role === 'user') parent = msgId
      return result
    })
    const source = n => messages[n - 1]?.id ?? null
    cases.push({ id, schedule: `S${schedule}`, split: 'new_holdout', messages,
      events: { restartAfterLastUser: schedule === 4, restartDelayMs: schedule === 4 ? 60_000 : null,
        waitAfterMs: 120_000, firstRequest503: schedule === 5, fault: script.fault || null, event: script.event || null }, initial: script.initial || null })
    gold.push({ id, reviewStatus: 'pending_independent_review', forbidden: script.forbid || [], protectedExisting: Boolean(script.protect),
      faultAssertion: script.fault ? { source: source(script.faultSource || 1), mutation: script.fault, requireBarrierAndMutationProof: true, requireNoLateWrite: true,
        requiredRequestSource: source(script.faultSource || 1), requiredWritableSource: source(script.faultSource || 1),
        ...(script.fault === 'delete' ? { unaffectedSource: source(1) } : { dependentPrimary: source(3) }) } : null,
      facts: script.g.map(f => ({ ...f, primary: source(f.primary), support: f.support.map(source), activeRecallDenominator: true,
        ...(f.alternatePrimary ? { alternatePrimary: f.alternatePrimary.map(source) } : {}),
        ...(f.sourceVariants ? { sourceVariants: f.sourceVariants.map(variant => ({ ...variant, primary: source(variant.primary), support: variant.support.map(source), optionalSupport: variant.optionalSupport.map(source) })) } : {}),
        ...(f.preexistingFrom ? { preexistingFrom: source(f.preexistingFrom), allowCorrectPreexisting: true, preserveUntilConfirmation: true } : {}),
        expectedStates: f.action === 'explicit_confirmation'
          ? { proposal: ['proposal'], discovery: ['active', 'candidate'], beforeConfirmation: f.preexistingFrom ? ['none', 'candidate', 'active'] : ['none'], afterScriptedConfirmation: ['active'] }
          : f.action === 'candidate' || f.action === 'replacement_candidate'
            ? { discovery: ['candidate'], beforeConfirmation: ['candidate'], afterScriptedConfirmation: ['candidate'] }
            : { discovery: ['active', 'candidate'], beforeConfirmation: ['active', 'candidate'], afterScriptedConfirmation: ['active', 'candidate'] } })) })
  }
})
if (gold.some(item => item.facts.some(f => !f.primary || f.support.includes(null)))) throw new Error('Missing source')
const out = 'docs/memory/evaluation/extraction-v5-holdout'
mkdirSync(out, { recursive: true })
for (const [name, items] of [['cases.jsonl', cases], ['gold.jsonl', gold]]) {
  const data = items.map(item => JSON.stringify(item)).join('\n') + '\n'
  writeFileSync(`${out}/${name}`, data, { flag: 'wx' })
  process.stdout.write(`${name} ${createHash('sha256').update(data).digest('hex')}\n`)
}
