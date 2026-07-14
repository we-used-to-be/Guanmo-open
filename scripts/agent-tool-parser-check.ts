import assert from 'node:assert/strict'
import { shouldUseAgent, validateSelectionContextReadLevel } from '../src/services/agent/executor'
import { classifySelectionRequest, detectIntentScores, shouldIncludeFullDocumentContext } from '../src/services/agent/intentDetector'
import { prepareChatHistoryForModel } from '../src/services/aiChatMessages'
import { setAgentScopeContext } from '../src/services/aiScope'
import { useEditorStore } from '../src/stores/editorStore'
import { useChatStore } from '../src/stores/chatStore'
import { registerBuiltinTools } from '../src/services/agent/tools'
import { getTool } from '../src/services/agent/toolRegistry'
import { hideLikelyToolJsonPrefix, parseToolCall, stripToolCallJson } from '../src/services/agent/toolCallParser'
import { resolveAnchoredReplacementRange } from '../src/services/agent/editTarget'
import { buildSelectionContextWindow, serializeSelectionContextWindow } from '../src/services/agent/selectionContext'
import { parseSSEStream } from '../src/services/ai/stream'
import { chunkMarkdown } from '../src/services/rag/chunker'
import { buildSemanticDocumentChunks, estimateSemanticTokens } from '../src/services/rag/semanticChunker'

registerBuiltinTools()

const eventA = `事故发生后，值班人员首先封锁现场并核对监控记录。${'调查记录确认设备温度异常，团队沿着告警时间线逐项复核传感器、控制器和供电链路。'.repeat(5)}最终确认风扇停转是本次故障的直接原因，并完成证据归档。`
const eventB = `客户反馈导出文件缺少表头，支持人员复现后锁定模板版本。${'处理小组重新生成模板、校验字段映射并回归不同格式的导出结果，确认历史数据不受影响。'.repeat(5)}最终发布修复版本并通知客户重新导出。`
const semanticChunks = chunkMarkdown(`# 事件记录\n\n${eventA}\n\n${eventB}`, 'semantic-test')
assert.equal(semanticChunks.length, 2)
assert.equal(semanticChunks.some((chunk) => chunk.content.includes('事故发生后') && chunk.content.includes('客户反馈')), false)
for (const chunk of semanticChunks) {
  assert.ok(estimateSemanticTokens(chunk.content) >= 180)
  assert.ok(estimateSemanticTokens(chunk.content) <= 400)
  assert.deepEqual(chunk.titlePath, ['事件记录'])
  assert.equal(chunk.content.startsWith('#'), false)
}

const reasoningPart = '系统先读取任务状态并校验输入。'.repeat(22)
const solutionPart = '处理器随后按事务边界提交结果并记录审计信息。'.repeat(18)
const longReasoningChunks = chunkMarkdown(
  `# 推理链\n\n${reasoningPart}因此，${solutionPart}`,
  'reasoning-test',
)
assert.equal(longReasoningChunks.length, 2)
assert.match(longReasoningChunks[0].content, /校验输入。$/)
assert.match(longReasoningChunks[1].content, /^因此/)

const reportedFragmentChunks = buildSemanticDocumentChunks([
  '# 系统异常排查记录',
  '',
  '## 四、关键分析点',
  '',
  '当时我们在排查日志时提出一个关键问题：',
  '',
  '为什么在高并发情况下，订单已经支付成功，但库存扣减却会延迟甚至丢失？',
].join('\n'))
assert.equal(reportedFragmentChunks.length, 2)
assert.equal(reportedFragmentChunks[0].content, '当时我们在排查日志时提出一个关键问题：')
assert.match(reportedFragmentChunks[1].content, /库存扣减/)

const interferenceContext = [
  '# 系统异常排查记录',
  '',
  '## 四、关键分析点（测试 selection）',
  '',
  '当时我们在排查日志时提出一个关键问题：',
  '',
  '为什么在高并发情况下，订单已经支付成功，但库存扣减却会延迟甚至丢失？',
  '',
  '## 五、上文引用分析（强干扰区）',
  '',
  '从上文的系统设计可以看出，我们依赖消息队列来保证最终一致性。',
  '',
  '从上文的运行状态可以进一步看出，库存延迟本身已经存在波动趋势。',
].join('\n')
const interferenceSelection = interferenceContext.indexOf('从上文的系统设计')
const interferenceWindow = buildSelectionContextWindow(interferenceContext, {
  from: interferenceSelection,
  to: interferenceSelection + '从上文的系统设计可以看出，我们依赖消息队列来保证最终一致性。'.length,
}, true)
assert.ok(interferenceWindow)
assert.equal(interferenceWindow.chunks.some((chunk) => chunk.role === 'before'), false)
assert.equal(interferenceWindow.chunks.find((chunk) => chunk.role === 'current')?.content, '从上文的系统设计可以看出，我们依赖消息队列来保证最终一致性。')
assert.match(interferenceWindow.chunks.find((chunk) => chunk.role === 'after')?.content || '', /库存延迟本身已经存在波动趋势/)

const bracketMath = '[ \\text{链路上的比特数} = 0.002 \\times 10^7 = 20000bit ]'
const bracketMathAtoms = buildSemanticDocumentChunks(`# 传播时延\n\n${bracketMath}`)
assert.equal(bracketMathAtoms[0].type, 'math')
assert.equal(bracketMathAtoms[0].content, bracketMath)

const formulaBridgeContext = [
  '# 传播时延',
  '',
  '网络答案说明需要结合完整计算链路才能解释最终结果。',
  '',
  bracketMath,
  '',
  '这里记录中间单位。',
  '',
  '这里记录换算过程。',
  '',
  '网络答案说明展示了传播时延的最终结论。',
].join('\n')
const formulaBridgeSelection = formulaBridgeContext.lastIndexOf('网络答案说明')
const formulaBridgeWindow = buildSelectionContextWindow(formulaBridgeContext, {
  from: formulaBridgeSelection,
  to: formulaBridgeSelection + '网络答案说明'.length,
}, true)
assert.ok(formulaBridgeWindow)
assert.equal(formulaBridgeWindow.chunks.some((chunk) => chunk.content === bracketMath), true)
assert.equal(
  formulaBridgeWindow.diagnostics.candidates.find((candidate) => candidate.content === bracketMath)?.reason,
  'bridge-context',
)

const relatedParagraph = (index: number) => `库存延迟分析${index}：${'消息队列消费状态与库存延迟存在直接关系，需要继续核对消费位点和重试记录。'.repeat(7)}`
const budgetContext = ['# 库存延迟分析', ...Array.from({ length: 7 }, (_, index) => ['', relatedParagraph(index)])].flat().join('\n')
const budgetSelection = budgetContext.indexOf('库存延迟分析3：')
const budgetLevelOne = buildSelectionContextWindow(budgetContext, { from: budgetSelection, to: budgetSelection + 7 }, true, 1)
const budgetLevelTwo = buildSelectionContextWindow(budgetContext, { from: budgetSelection, to: budgetSelection + 7 }, true, 2)
assert.ok(budgetLevelOne)
assert.ok(budgetLevelTwo)
assert.ok(budgetLevelOne.diagnostics.totalTokens <= 700)
assert.ok(budgetLevelTwo.chunks.length > 0)
assert.equal(budgetLevelTwo.chunks.some((delta) => budgetLevelOne.chunks.some((initial) => initial.content === delta.content)), false)

assert.equal(validateSelectionContextReadLevel(0, 1), null)
assert.match(validateSelectionContextReadLevel(0, 2) || '', /拒绝跳级读取/)
assert.match(validateSelectionContextReadLevel(1, 1) || '', /拒绝重复读取/)
assert.equal(validateSelectionContextReadLevel(1, 2), null)
assert.match(validateSelectionContextReadLevel(2, 2) || '', /拒绝重复读取/)

const pureJson = parseToolCall('{"tool":"search_knowledge","args":{"query":"RAG"}}')
assert.equal(pureJson?.name, 'search_knowledge')
assert.deepEqual(pureJson?.args, { query: 'RAG' })

const fencedJson = parseToolCall('```json\n{"tool":"search_knowledge","args":{"query":"notes"}}\n```')
assert.equal(fencedJson?.name, 'search_knowledge')
assert.deepEqual(fencedJson?.args, { query: 'notes' })

const embeddedJson = parseToolCall('先搜索：{"tool":"search_knowledge","args":{"query":"scope"}} 然后回答')
assert.equal(embeddedJson?.name, 'search_knowledge')
assert.deepEqual(embeddedJson?.args, { query: 'scope' })

const editConfirmation = parseToolCall('{"needsEditConfirmation":true,"path":"D:/notes/current.md","oldText":"旧","newText":"新"}')
assert.equal(editConfirmation?.name, 'replace_current_tab_text')
assert.deepEqual(editConfirmation?.args, { oldText: '旧', newText: '新', path: 'D:/notes/current.md' })

const targetEditConfirmation = parseToolCall('{"needsEditConfirmation":true,"targetId":"edit-target-1","newText":"新"}')
assert.equal(targetEditConfirmation?.name, 'replace_current_tab_text')
assert.deepEqual(targetEditConfirmation?.args, { targetId: 'edit-target-1', newText: '新' })

const summarizedEditConfirmation = parseToolCall('{"needsEditConfirmation":true,"targetId":"edit-target-1","newText":"新","changeSummary":"润色表达、保留原意"}')
assert.equal(summarizedEditConfirmation?.name, 'replace_current_tab_text')
assert.deepEqual(summarizedEditConfirmation?.args, { targetId: 'edit-target-1', newText: '新', changeSummary: '润色表达、保留原意' })

const fileEditConfirmation = parseToolCall('{"needsEditConfirmation":true,"path":"D:/notes/a.md","oldText":"旧","newText":"新"}')
assert.equal(fileEditConfirmation?.name, 'replace_current_tab_text')
assert.deepEqual(fileEditConfirmation?.args, { oldText: '旧', newText: '新', path: 'D:/notes/a.md' })

const wholeFileEditConfirmation = parseToolCall('{"needsEditConfirmation":true,"path":"D:/notes/a.md","replaceWholeDocument":true,"newText":"整篇新稿"}')
assert.equal(wholeFileEditConfirmation?.name, 'replace_current_tab_text')
assert.deepEqual(wholeFileEditConfirmation?.args, {
  newText: '整篇新稿',
  path: 'D:/notes/a.md',
  replaceWholeDocument: true,
})

assert.equal(parseToolCall('{"tool":'), null)
assert.equal(parseToolCall('普通回答'), null)

assert.equal(
  stripToolCallJson('说明\n```json\n{"tool":"search_knowledge","args":{"query":"RAG"}}\n```\n结束'),
  '说明\n\n结束'
)

assert.equal(hideLikelyToolJsonPrefix('{"tool":"search_knowledge","args":'), '')
assert.equal(hideLikelyToolJsonPrefix('普通流式回答'), '普通流式回答')

const streamResponse = new Response([
  'data: {"choices":[{"delta":{"content":"你好"},"finish_reason":null}]}',
  '',
  'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","function":{"name":"search_knowledge","arguments":"{\\"query\\":\\"R"}}]},"finish_reason":null}]}',
  '',
  'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"AG\\"}"}}]},"finish_reason":"tool_calls"}]}',
  '',
  'data: [DONE]',
  '',
].join('\n'))
const streamChunks = []
for await (const chunk of parseSSEStream(streamResponse)) streamChunks.push(chunk)
assert.equal(streamChunks[0]?.content, '你好')
assert.equal(streamChunks[1]?.toolCallDeltas?.[0]?.name, 'search_knowledge')
assert.equal(streamChunks[2]?.toolCallDeltas?.[0]?.arguments, 'AG"}')
assert.equal(streamChunks[2]?.done, true)

assert.equal(shouldUseAgent('你好', 0), false)
assert.equal(shouldUseAgent('总结这个文件', 1), true)
assert.equal(shouldUseAgent('总结这几个文件', 3), true)
assert.equal(shouldUseAgent('搜索本地文档里的 RAG 配置', 0), true)
assert.equal(shouldUseAgent('记住我喜欢简洁回答', 0), true)
assert.equal(shouldUseAgent('添加记忆 我偏好中文回答', 0), true)
assert.equal(shouldUseAgent('保存记忆 我喜欢先看结论', 0), true)
assert.equal(shouldUseAgent('我的地址是什么', 0), true)
assert.equal(shouldUseAgent('把这段话润色一下', 1), true)
assert.equal(shouldUseAgent('覆写整个文件为新的版本', 1), true)
assert.equal(shouldUseAgent('请调整这个文件的结构', 1), true)
assert.equal(shouldUseAgent('再简洁些', 0), false)
assert.equal(shouldUseAgent('再简洁些', 0, true), true)
assert.equal(shouldUseAgent('语气柔和一些', 0, true), true)
assert.equal(shouldUseAgent('更详细一点', 0, true), true)
assert.equal(shouldUseAgent('对比这两个文件的差异', 2), true)
assert.equal(shouldIncludeFullDocumentContext('把整篇文章重写一下'), true)
assert.equal(shouldIncludeFullDocumentContext('请对这篇文章整体润色'), true)
assert.equal(shouldIncludeFullDocumentContext('把这段话润色一下'), false)

const selectionContext = {
  hasOpenFile: true,
  hasSelection: true,
  hasContextTags: true,
}
for (const query of ['总结这段', '解释一下这个函数', '说明这里', '整理并提炼格式']) {
  assert.equal(classifySelectionRequest(query, selectionContext), 'fast', query)
  assert.deepEqual(detectIntentScores(query, selectionContext).candidates, [], query)
}
for (const query of ['翻译选中内容', '润色这段', '改写选区']) {
  assert.equal(classifySelectionRequest(query, selectionContext), 'fast', query)
  const result = detectIntentScores(query, selectionContext)
  assert.equal(result.candidates.includes('file_write'), true, query)
  assert.equal(result.candidates.includes('file_read'), false, query)
}
for (const query of ['结合上下文润色这段', '根据前后文改写选区', '优化标题层级']) {
  const result = detectIntentScores(query, selectionContext)
  assert.equal(result.candidates.includes('file_write'), true, query)
  assert.equal(result.candidates.includes('selection_context'), true, query)
}
for (const query of ['为什么这样写', '这个函数为什么报错', '怎么推导', '这里和那个有什么区别', '这段是否正确', '如何改进这段']) {
  const result = detectIntentScores(query, selectionContext)
  assert.equal(result.candidates.includes('selection_context'), true, query)
  assert.equal(result.required.includes('selection_context'), true, query)
  assert.equal(result.candidates.includes('file_write'), false, query)
}
for (const query of ['上下文', '查看前后文', '结合上下文解释', '查看附近内容', '查看周围内容']) {
  const result = detectIntentScores(query, selectionContext)
  assert.equal(result.candidates[0], 'selection_context', query)
  assert.equal(result.required.includes('selection_context'), true, query)
}
for (const query of ['这个', '这里', '那个']) {
  assert.equal(detectIntentScores(query, selectionContext).candidates.includes('selection_context'), false, query)
}
assert.equal(detectIntentScores('查看全文', selectionContext).candidates.includes('file_read'), true)
assert.equal(detectIntentScores('搜索本地文档', selectionContext).candidates.includes('knowledge'), true)

const progressiveContext = [
  '# 推导题',
  '',
  '更早上文一',
  '',
  '更早上文二',
  '',
  '更早上文三',
  '',
  '更早上文四',
  '',
  '章节导语',
  '',
  '上文零',
  '',
  '上文一',
  '',
  '上文二',
  '',
  '选中的关键内容',
  '',
  '下文一',
  '',
  '下文二',
  '',
  '更远下文',
  '',
  '# 第二节',
  '',
  '不应读取的内容',
].join('\n')
const progressiveSelectionFrom = progressiveContext.indexOf('选中的关键内容')
const levelOneWindow = buildSelectionContextWindow(progressiveContext, {
  from: progressiveSelectionFrom,
  to: progressiveSelectionFrom + '选中的关键内容'.length,
}, true, 1)
const levelTwoWindow = buildSelectionContextWindow(progressiveContext, {
  from: progressiveSelectionFrom,
  to: progressiveSelectionFrom + '选中的关键内容'.length,
}, true, 2)
assert.ok(levelOneWindow)
assert.ok(levelTwoWindow)
const levelOneBefore = levelOneWindow.chunks.filter((chunk) => chunk.role === 'before')
const levelOneCurrent = levelOneWindow.chunks.filter((chunk) => chunk.role === 'current')
const levelOneAfter = levelOneWindow.chunks.filter((chunk) => chunk.role === 'after')
assert.equal(levelOneBefore.length, 1)
assert.equal(levelOneCurrent.length, 1)
assert.equal(levelOneAfter.length, 1)
assert.equal(levelOneCurrent[0].content, '选中的关键内容')
assert.deepEqual(levelOneCurrent[0].headingPath, ['推导题'])
assert.match(levelOneBefore.map((chunk) => chunk.content).join('\n'), /上文二/)
assert.doesNotMatch(levelOneBefore.map((chunk) => chunk.content).join('\n'), /更早上文一/)
assert.match(levelOneAfter[0].content, /下文一/)
const levelTwoBefore = levelTwoWindow.chunks.filter((chunk) => chunk.role === 'before')
const levelTwoAfter = levelTwoWindow.chunks.filter((chunk) => chunk.role === 'after')
assert.equal(levelTwoBefore.length, 0)
assert.equal(levelTwoAfter.length, 0)
assert.equal(levelTwoWindow.chunks.some((chunk) => chunk.role === 'current'), false)
assert.doesNotMatch(levelTwoWindow.chunks.map((chunk) => chunk.content).join('\n'), /不应读取的内容/)
for (const deltaChunk of levelTwoWindow.chunks) {
  assert.equal(levelOneWindow.chunks.some((chunk) => chunk.content === deltaChunk.content), false)
}

const formulaContext = [
  '# 公式题',
  '',
  '下面给出编码结果：',
  '',
  '\\[',
  '10011',
  '\\]',
  '',
  '该结果用于后续校验。',
  '',
  '额外说明',
].join('\n')
const formulaSelectionFrom = formulaContext.indexOf('10011')
const formulaWindow = buildSelectionContextWindow(formulaContext, {
  from: formulaSelectionFrom,
  to: formulaSelectionFrom + '10011'.length,
}, true)
assert.ok(formulaWindow)
const formulaCurrent = formulaWindow.chunks.find((chunk) => chunk.role === 'current')
assert.match(formulaCurrent?.content || '', /\\\[/)
assert.match(formulaCurrent?.content || '', /10011/)
assert.doesNotMatch(formulaCurrent?.content || '', /下面给出编码结果/)
assert.match(formulaWindow.chunks.find((chunk) => chunk.role === 'before')?.content || '', /下面给出编码结果/)
assert.match(formulaWindow.chunks.find((chunk) => chunk.role === 'after')?.content || '', /该结果用于后续校验/)

const formulaParagraphFrom = formulaContext.indexOf('下面给出编码结果')
const formulaParagraphTo = formulaContext.indexOf('该结果用于后续校验。') + '该结果用于后续校验。'.length
const formulaParagraphWindow = buildSelectionContextWindow(formulaContext, {
  from: formulaParagraphFrom,
  to: formulaParagraphTo,
}, true)
assert.ok(formulaParagraphWindow)
assert.match(formulaParagraphWindow.chunks.find((chunk) => chunk.role === 'current')?.content || '', /10011/)

const standaloneNumberContext = ['编码说明如下：', '', '10011', '', '它表示最终编码。', '', '无关内容'].join('\n')
const standaloneNumberFrom = standaloneNumberContext.indexOf('10011')
const standaloneNumberWindow = buildSelectionContextWindow(standaloneNumberContext, {
  from: standaloneNumberFrom,
  to: standaloneNumberFrom + '10011'.length,
}, false)
assert.ok(standaloneNumberWindow)
assert.equal(standaloneNumberWindow.chunks.find((chunk) => chunk.role === 'current')?.content, '10011')
assert.match(standaloneNumberWindow.chunks.find((chunk) => chunk.role === 'before')?.content || '', /编码说明如下/)
assert.match(standaloneNumberWindow.chunks.find((chunk) => chunk.role === 'after')?.content || '', /它表示最终编码/)

const codeSelectionContext = [
  '# 代码题',
  '',
  '前置条件：参数均为正数。',
  '',
  '```ts',
  'function add(a: number, b: number) {',
  '  return a + b',
  '}',
  '```',
  '',
  '后续说明',
  '',
  '无关段落',
].join('\n')
const codeSelectionFrom = codeSelectionContext.indexOf('return a + b')
const codeWindow = buildSelectionContextWindow(codeSelectionContext, {
  from: codeSelectionFrom,
  to: codeSelectionFrom + 'return a + b'.length,
}, true)
assert.ok(codeWindow)
const codeCurrent = codeWindow.chunks.find((chunk) => chunk.role === 'current')
assert.match(codeCurrent?.content || '', /return a \+ b/)
assert.doesNotMatch(codeCurrent?.content || '', /前置条件/)
assert.doesNotMatch(codeCurrent?.content || '', /后续说明/)

const logicalContext = ['为什么会得到这个结果？', '', '因为输入满足递推条件。', '', '其他内容'].join('\n')
const logicalSelectionFrom = logicalContext.indexOf('为什么')
const logicalWindow = buildSelectionContextWindow(logicalContext, {
  from: logicalSelectionFrom,
  to: logicalSelectionFrom + '为什么会得到这个结果？'.length,
}, false)
assert.ok(logicalWindow)
assert.equal(logicalWindow.chunks.find((chunk) => chunk.role === 'current')?.content, '为什么会得到这个结果？')
assert.match(logicalWindow.chunks.find((chunk) => chunk.role === 'after')?.content || '', /因为输入满足递推条件/)

const conclusionContext = ['已完成全部推导。', '', '因此结果成立。', '', '后续章节'].join('\n')
const conclusionSelectionFrom = conclusionContext.indexOf('因此')
const conclusionWindow = buildSelectionContextWindow(conclusionContext, {
  from: conclusionSelectionFrom,
  to: conclusionSelectionFrom + '因此结果成立。'.length,
}, false)
assert.ok(conclusionWindow)
assert.equal(conclusionWindow.chunks.find((chunk) => chunk.role === 'current')?.content, '因此结果成立。')
assert.match(conclusionWindow.chunks.find((chunk) => chunk.role === 'before')?.content || '', /已完成全部推导/)

const singleChunkWindow = buildSelectionContextWindow('只有选区', { from: 0, to: 4 }, false)
assert.ok(singleChunkWindow)
assert.equal(singleChunkWindow.chunks.find((chunk) => chunk.role === 'current')?.content, '只有选区')

const reportedContext = `# 我的最近状态

最近我感觉工作压力特别大，每天都在加班，任务也越来越多。

我开始觉得自己可能做不好现在的工作，有点焦虑，也不太想和别人交流。

---

## 为什么

为什么我会变成这样？

---

## 消极想法

也许我本来就不适合这个岗位。

可能别人都比我厉害，只是我一直在硬撑。

有时候我甚至觉得，继续努力也不会有什么改变。

反正我大概就是这样的人吧。

---

## 额外补充

最近睡眠也变差了，经常半夜醒来，然后开始想很多事情。`
const reportedSelectionFrom = reportedContext.indexOf('为什么我会变成这样？')
const reportedWindow = buildSelectionContextWindow(reportedContext, {
  from: reportedSelectionFrom,
  to: reportedSelectionFrom + '为什么我会变成这样？'.length,
}, true)
assert.ok(reportedWindow)
assert.equal(reportedWindow.chunks.filter((chunk) => chunk.role === 'before').length, 0)
const reportedCurrent = reportedWindow.chunks.find((chunk) => chunk.role === 'current')
const reportedAfter = reportedWindow.chunks.find((chunk) => chunk.role === 'after')
assert.deepEqual(reportedCurrent?.headingPath, ['我的最近状态', '为什么'])
assert.equal(reportedAfter, undefined)
assert.equal(reportedCurrent?.content, '为什么我会变成这样？')

const astContext = `# AST 覆盖

前置段落。

> 引用内容

- 列表项目一
- 列表项目二

| 列一 | 列二 |
| --- | --- |
| 表格内容 | 值 |

\`\`\`ts
const covered = true
\`\`\`

$$
x = y + 1
$$

正文脚注[^note]。

[^note]: 脚注定义内容

后置段落。`
for (const selectedText of ['引用内容', '列表项目一', '表格内容', 'const covered', 'x = y + 1', '脚注定义内容']) {
  const from = astContext.indexOf(selectedText)
  const window = buildSelectionContextWindow(astContext, { from, to: from + selectedText.length }, true)
  assert.ok(window, selectedText)
  assert.match(window.chunks.find((chunk) => chunk.role === 'current')?.content || '', new RegExp(selectedText.replace(/[+]/g, '\\+')))
}
const headingSelectionFrom = astContext.indexOf('AST 覆盖')
const headingFallbackWindow = buildSelectionContextWindow(astContext, {
  from: headingSelectionFrom,
  to: headingSelectionFrom + 'AST 覆盖'.length,
}, true)
assert.ok(headingFallbackWindow)
assert.equal(headingFallbackWindow.chunks.some((chunk) => chunk.role === 'current' && chunk.content.length > 0), true)

const longContext = Array.from({ length: 9 }, (_, index) => `## 长段${index}\n\n${`第${index}段长文本。`.repeat(500)}`).join('\n\n')
const longSelectionText = '第4段长文本。'
const longSelectionFrom = longContext.indexOf(longSelectionText, longContext.indexOf('## 长段4'))
const longWindow = buildSelectionContextWindow(longContext, {
  from: longSelectionFrom,
  to: longSelectionFrom + longSelectionText.length,
}, true)
assert.ok(longWindow)
const longJson = serializeSelectionContextWindow(longWindow)
const parsedLongWindow = JSON.parse(longJson)
assert.deepEqual(new Set(parsedLongWindow.chunks.map((chunk: { role: string }) => chunk.role)), new Set(['current']))
assert.match(parsedLongWindow.chunks.find((chunk: { role: string }) => chunk.role === 'current')?.content || '', /第4段长文本/)
assert.equal(parsedLongWindow.chunks[0].content, longWindow.chunks[0].content)

const preparedHistory = prepareChatHistoryForModel([
  {
    role: 'user',
    content: '总结旧文件\n\n【当前文档上下文】\n\n[上下文1: old.md]\n---\n旧文件全文',
    displayContent: '总结旧文件',
  },
  {
    role: 'assistant',
    content: '旧文件摘要',
  },
  {
    role: 'user',
    content: '[系统] 用户确认并应用了文本修改。',
    hidden: true,
  },
])

assert.deepEqual(preparedHistory, [
  { role: 'user', content: '总结旧文件' },
  { role: 'assistant', content: '旧文件摘要' },
  { role: 'user', content: '[系统] 用户确认并应用了文本修改。' },
])

const duplicateText = '这是重点\n中间内容\n这是重点'
assert.deepEqual(resolveAnchoredReplacementRange(duplicateText, '这是重点', { from: 10, to: 14 }), {
  from: 10,
  to: 14,
})
assert.equal(resolveAnchoredReplacementRange(duplicateText, '不存在', { from: 10, to: 14 }), null)
assert.deepEqual(resolveAnchoredReplacementRange('这是重点\n中间内容\n新的更长重点', '新的更长重点', { from: 10, to: 14 }, { from: 10, to: 16 }), {
  from: 10,
  to: 16,
})

const replaceCurrentTabText = getTool('replace_current_tab_text')
assert.ok(replaceCurrentTabText)
const listCurrentEditTargets = getTool('list_current_edit_targets')
assert.ok(listCurrentEditTargets)
const readSelectionContext = getTool('read_selection_context')
assert.ok(readSelectionContext)

const integrationBefore = 'before context '.repeat(60).trim()
const integrationAfter = 'after context '.repeat(60).trim()
const integrationContent = `${integrationBefore}\n\nalpha beta alpha\n\n${integrationAfter}`
const integrationSelectionFrom = integrationContent.indexOf('beta')
useChatStore.setState({ messages: [], pendingEdit: null, contextTags: [] })
useEditorStore.setState({
  tabs: [
    {
      id: 'tab-a',
      title: 'a.md',
      filePath: 'D:/notes/a.md',
      content: integrationContent,
      savedContent: integrationContent,
      modified: false,
    },
    {
      id: 'tab-b',
      title: 'b.md',
      filePath: 'D:/notes/b.md',
      content: 'other file',
      savedContent: 'other file',
      modified: false,
    },
  ],
  activeTabId: 'tab-b',
})

setAgentScopeContext({
  contextTags: [{
    id: 'selection-a',
    type: 'selection',
    title: 'a.md 选区',
    filePath: 'D:/notes/a.md',
    content: 'beta',
    preview: 'beta',
    selectionFrom: integrationSelectionFrom,
    selectionTo: integrationSelectionFrom + 'beta'.length,
  }],
  editTargets: [{
    id: 'edit-target-1',
    type: 'selection',
    title: 'a.md 选区',
    filePath: 'D:/notes/a.md',
    selectionFrom: integrationSelectionFrom,
    selectionTo: integrationSelectionFrom + 'beta'.length,
  }],
})

const selectionContextResult = JSON.parse(await readSelectionContext.execute({ targetId: 'edit-target-1' }))
assert.deepEqual(selectionContextResult.chunks.map((chunk: { role: string }) => chunk.role), ['before', 'current', 'after'])
assert.equal(selectionContextResult.chunks[1].content, 'alpha beta alpha')
assert.deepEqual(Object.keys(selectionContextResult), ['chunks', 'source'])
assert.equal(selectionContextResult.source.filePath, 'D:/notes/a.md')
for (const chunk of selectionContextResult.chunks) {
  assert.deepEqual(Object.keys(chunk), ['role', 'headingPath', 'startLine', 'endLine', 'content'])
}
assert.equal('currentChunk' in selectionContextResult, false)
assert.equal('beforeChunks' in selectionContextResult, false)
assert.equal('afterChunks' in selectionContextResult, false)
assert.equal('before' in selectionContextResult, false)
assert.equal('after' in selectionContextResult, false)

const afterSelectionContextResult = JSON.parse(await readSelectionContext.execute({
  targetId: 'edit-target-1',
  direction: 'after',
}))
assert.deepEqual(afterSelectionContextResult.chunks.map((chunk: { role: string }) => chunk.role), ['current', 'after'])
const invalidSelectionDirection = await readSelectionContext.execute({
  targetId: 'edit-target-1',
  direction: 'sideways',
})
assert.match(invalidSelectionDirection, /direction 只能是/)

const selectionEditResult = JSON.parse(await replaceCurrentTabText.execute({
  targetId: 'edit-target-1',
  newText: 'BETA',
}))
assert.equal(selectionEditResult.__pendingEdit, true)
assert.equal(selectionEditResult.tabId, 'tab-a')
assert.equal(selectionEditResult.oldText, 'beta')
assert.equal(selectionEditResult.replaceFrom, integrationSelectionFrom)
assert.equal(selectionEditResult.replaceTo, integrationSelectionFrom + 'beta'.length)

const selectionWholeDocResult = await replaceCurrentTabText.execute({
  targetId: 'edit-target-1',
  replaceWholeDocument: true,
  newText: 'new doc',
})
assert.match(selectionWholeDocResult, /整文替换被拒绝/)

const invalidTargetResult = await replaceCurrentTabText.execute({
  targetId: 'edit-target-missing',
  newText: 'BETA',
})
assert.match(invalidTargetResult, /targetId 不属于本轮可编辑/)

setAgentScopeContext({
  contextTags: [{
    id: 'file-a',
    type: 'file',
    title: 'a.md',
    filePath: 'D:/notes/a.md',
    content: null,
    preview: 'a.md',
  }],
  editTargets: [{
    id: 'edit-target-1',
    type: 'file',
    title: 'a.md',
    filePath: 'D:/notes/a.md',
  }],
})

const duplicateOldTextResult = await replaceCurrentTabText.execute({
  path: 'D:/notes/a.md',
  oldText: 'alpha',
  newText: 'ALPHA',
})
assert.match(duplicateOldTextResult, /出现多次/)

setAgentScopeContext({ contextTags: [] })
const emptyEditTargets = JSON.parse(await listCurrentEditTargets.execute({}))
assert.equal(emptyEditTargets.status, 'empty')

const missingTagResult = await replaceCurrentTabText.execute({
  path: 'D:/notes/a.md',
  oldText: 'beta',
  newText: 'BETA',
})
assert.match(missingTagResult, /本轮没有新添加/)

const missingPathResult = await replaceCurrentTabText.execute({
  oldText: 'beta',
  newText: 'BETA',
})
assert.match(missingPathResult, /必须提供/)
setAgentScopeContext(null)

console.log('agent tool parser checks passed')
