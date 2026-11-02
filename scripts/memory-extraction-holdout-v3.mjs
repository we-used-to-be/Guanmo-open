// New, unobserved holdout drafts. Never run model or rules before independent review.
import { mkdirSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import process from 'node:process'

const u = (text, scope = 'global', session = 'S') => ({ role: 'user', text, scope, session })
const a = (text, scope = 'global', session = 'S') => ({ role: 'assistant', text, scope, session })
const fact = (identity, value, primary = 1, scope = 'global', support = [], action = 'active_or_candidate') => ({ identity, value, primary, scope, support, action })
const scripts = [
  { m: [u('我的研究方向是海洋生态。')], g: [fact('研究方向', '海洋生态')] },
  { m: [u('解释可以先讲实例，也可以先列术语。'), a('这两种都可以。'), u('长期以来我更容易从第一种理解。')], g: [fact('解释顺序', '先实例', 3, 'global', [1], 'candidate')] },
  { m: [u('这个项目可以部署到甲方案或乙方案。', 'P'), a('甲方案是离线包，乙方案需要服务器。', 'P'), u('那就长期固定甲方案。', 'P')], g: [fact('部署方式', '离线包', 3, 'P', [1, 2], 'candidate')] },
  { m: [u('窗外下雨了。'), a('注意带伞。'), u('好的，谢谢。')], g: [] },
  { m: [u('只在这次示例中用法语回答。')], g: [], forbid: ['长期语言偏好'] },
  { m: [u('匿名口令是测试字符串，请不要记录。')], g: [], forbid: ['敏感内容发送或保存'] },
  { m: [u('这段病历仅用于当前模拟讨论。')], g: [], forbid: ['敏感内容发送或保存'] },
  { m: [u('我们先讨论缓存默认启用的可能性。', 'P'), a('所以默认启用缓存。', 'P'), u('纠正，本项目明确禁止默认启用缓存，长期执行。', 'P')], g: [fact('默认缓存', '禁止启用', 3, 'P')], forbid: ['助手误解当作决定'] },
  { m: [u('我原来习惯简短回答，以后长期改成详细回答。')], g: [fact('回答详略', '详细', 1, 'global', [], 'replacement_candidate')], initial: { identity: '回答详略', value: '简短', status: 'active', source: 'automatic' }, protect: true },
  { m: [u('记住：以后回复优先列出关键步骤。')], g: [fact('回复格式', '优先关键步骤', 1, 'global', [], 'explicit_confirmation')] },
  { m: [u('请不要记住我临时想喝咖啡。')], g: [], forbid: ['临时饮品偏好'] },
  { m: [u('书中写：我是一位建筑师，我喜欢清晨工作。')], g: [], forbid: ['书中人物归因用户'] },
  { m: [u('项目需要在A和B中选择。', 'P'), a('我建议选择A。', 'P'), u('我们还没有做决定。', 'P')], g: [], forbid: ['助手建议当用户决定'] },
  { m: [u('本项目约定发布时保留日志。', 'P'), a('收到。', 'P'), u('本项目约定发布时不保留日志。', 'Q')], g: [fact('发布日志', '保留', 1, 'P'), fact('发布日志', '不保留', 3, 'Q')] },
  { m: [u('项目长期使用Mercurial。', 'P', 'S'), u('项目长期使用Fossil。', 'Q', 'T')], g: [fact('版本工具', 'Mercurial', 1, 'P'), fact('版本工具', 'Fossil', 2, 'Q')] },
  { m: [u('我的长期目标是保护珊瑚礁。'), a('了解。'), u('普通文本。'.repeat(2300) + '我的专业是环境科学。')], g: [fact('长期目标', '保护珊瑚礁'), fact('专业', '环境科学', 3)] },
  { m: [u('团队要不要把构建工具换成Parcel？', 'P'), a('可以进一步比较。', 'P'), u('先比较，尚未确定。', 'P')], g: [], forbid: ['未决定的工具切换'] },
  { m: [u('我长期希望回答包含完整推导。'), a('收到。'), u('但这个项目的答复只要最终命令，省略推导。', 'P')], g: [fact('回答详略', '完整推导'), fact('项目答复格式', '只要最终命令，省略推导', 3, 'P')], forbid: ['项目规则错误提升为全局'] },
  { m: [u('我的专业是气象学。'), a('收到。')], g: [], fault: 'delete', forbid: ['源删除后迟到写入'] },
  { m: [u('我喜欢技术回答使用表格。'), a('收到。')], g: [], fault: 'metadata_only', forbid: ['可见快照修改后迟到写入'] },
]
if (scripts.length !== 20) throw new Error('Expected 20 scripts')
const cases = [], gold = []
scripts.forEach((script, index) => {
  for (let schedule = 1; schedule <= 5; schedule++) {
    const id = `H3-${String(index + 1).padStart(2, '0')}-S${schedule}`
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
        waitAfterMs: 120_000, firstRequest503: schedule === 5, fault: script.fault || null }, initial: script.initial || null })
    gold.push({ id, reviewStatus: 'pending_independent_review', forbidden: script.forbid || [], protectedExisting: Boolean(script.protect),
      faultAssertion: script.fault ? { source: source(1), mutation: script.fault, requireBarrierAndMutationProof: true, requireNoLateWrite: true } : null,
      facts: script.g.map(f => ({ ...f, primary: source(f.primary), support: f.support.map(source), activeRecallDenominator: true,
        ...(f.alternatePrimary ? { alternatePrimary: f.alternatePrimary.map(source) } : {}),
        expectedStates: f.action === 'explicit_confirmation'
          ? { proposal: ['proposal'], discovery: ['active', 'candidate'], beforeConfirmation: ['none'], afterScriptedConfirmation: ['active'] }
          : f.action === 'candidate' || f.action === 'replacement_candidate'
            ? { discovery: ['candidate'], beforeConfirmation: ['candidate'], afterScriptedConfirmation: ['candidate'] }
            : { discovery: ['active', 'candidate'], beforeConfirmation: ['active', 'candidate'], afterScriptedConfirmation: ['active', 'candidate'] } })) })
  }
})
if (gold.some(item => item.facts.some(f => !f.primary || f.support.includes(null)))) throw new Error('Missing source')
const out = 'docs/memory/evaluation/extraction-v3-holdout'
mkdirSync(out, { recursive: true })
for (const [name, items] of [['cases.jsonl', cases], ['gold.jsonl', gold]]) {
  const data = items.map(item => JSON.stringify(item)).join('\n') + '\n'
  writeFileSync(`${out}/${name}`, data, { flag: 'wx' })
  process.stdout.write(`${name} ${createHash('sha256').update(data).digest('hex')}\n`)
}
