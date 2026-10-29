/** Anonymous labels fixed before tuning. Adjacent examples are not paraphrase-generated at runtime. */
export interface MemoryEvaluationCase {
  id: string
  query: string
  group: string
  split: 'tune' | 'test'
  needsMemory: boolean
  scope: 'none' | 'global' | 'project' | 'both'
  modelAllowed: boolean
  reason: string
  currentContext?: string
}

const groups: Array<{
  name: string
  needsMemory: boolean
  scope: MemoryEvaluationCase['scope']
  modelAllowed: boolean
  reason: string
  context?: string
  queries: string[]
}> = [
  { name: 'general', needsMemory: false, scope: 'none', modelAllowed: false, reason: '通用知识与用户历史无关', queries: [
    '什么是闭包？', '如何理解数据库事务？', '解释一下 TCP 三次握手', '为什么天空是蓝色的',
    '二分查找的时间复杂度是多少', '给我一个冒泡排序示例', '怎么计算三角形面积', 'HTTP 与 HTTPS 有什么区别',
    '介绍一下光合作用', '翻译 hello world', '把这一句改成被动语态：猫吃鱼', '总结这段话：太阳是恒星',
    '什么是向量数据库', '解释内存和硬盘的区别', 'Python 怎么读取 JSON', 'SQL 如何去重',
    '如何学会番茄炒蛋', '列举三个修辞手法', '写一首关于秋天的诗', '解释代码：const x = 1',
  ] },
  { name: 'explicit-global', needsMemory: true, scope: 'global', modelAllowed: false, reason: '明确查询已告知的个人事实', queries: [
    '我的偏好是什么？', '你还记得我的习惯吗', '查看我的记忆', '搜索记忆里的称呼',
    '我的长期目标是什么', '之前告诉你的我的地址是什么', '你记得我做什么工作吗', '我通常用什么语言交流？',
    '查询我的输出格式偏好', '还记得我喜欢哪种回答方式吗', '我的称呼是什么', '我的身份是什么来着',
    '我对饮食有什么禁忌，之前说过的', '检索我保存过的学习路线', '告诉我已经记住的个人背景', '你还记得我现在学到哪了吗',
    '我上次告诉你的职业是什么', '调取记忆中的个人偏好', '我的记忆里有住址吗', 'remember me: what language do I prefer?',
  ] },
  { name: 'explicit-project', needsMemory: true, scope: 'project', modelAllowed: false, reason: '明确查询当前项目的长期约定或已知决定', queries: [
    '我的项目约定是什么', '查看当前项目已经保存的规则', '检索记忆：本项目技术栈', '项目里之前确定用哪个数据库？',
    '我们之前给这个项目定的发布规则是什么', '当前项目上次定下的接口边界还记得吗', '我保存过哪些工程约定', '调取本项目的目录职责记忆',
    '这个项目当时为什么选 SQLite', '上次记录的架构决定是什么', '查询记忆中这个项目的目标用户', '本项目默认使用什么测试框架，之前说过的',
    '还记得我们约好的分支命名吗', '之前确定的备份策略是什么', '搜索记忆：项目权限边界', '项目里的打包方式当初怎么约定的',
    '我们之前决定放弃了哪个实现方案', '项目已经记住的长期目标有哪些', '回忆一下本项目的命名规范', '上次保存的发布窗口是哪一天',
  ] },
  { name: 'implicit', needsMemory: true, scope: 'both', modelAllowed: true, reason: '含隐含长期依赖，允许规则解决或一次语义兜底', queries: [
    '照旧安排一下学习路线', '老规矩，帮我整理', '还是按原来约好的来', '继续沿用之前的格式',
    '像平时一样帮我写开头', '按常用方式给我答复', '按照之前讨论的方案推进', '之前告诉过你我的情况，给我点建议',
    '沿用上次的约定', '把我们之前选的方案找出来', '接着上次定的长期目标来', '我之前提过的那个技术栈还有印象吗',
    '用我平时喜欢的表达来写', '按我之前的习惯制定计划', '之前那套规则继续执行', '老样子就行，格式你知道',
    '咱们原来定好的那份安排再看一下', '上回那个决定的原因还在吗', '按惯例处理这份材料', '我还是想走原先商量的路线',
  ] },
  { name: 'personalized', needsMemory: true, scope: 'global', modelAllowed: true, reason: '任务依赖既有个人偏好而非泛用建议', queries: [
    '按我的风格润色这段话', '按照我的习惯改写标题', '翻译成我平时用的语气', '沿用我的常用格式重写这段内容',
    '用我喜欢的表达方式改写', '根据我的背景推荐学习方向', '结合我的长期目标安排练习', '考虑我的饮食偏好给个菜单',
    '按照我之前说过的限制推荐运动', '帮我规划适合我的职业路线，参考我的已有经历', '按我的习惯安排明天学习', '依我的偏好选一个写作风格',
    '根据你记住的我的专业安排课程', '用我平时的文风写一段简介', '按我之前的输出偏好给结论', '参考我的学习进度，下一步学什么',
    '按我常用的语言写说明', '结合我的项目经历写个自我介绍', '根据我存过的长期目标排优先级', '沿用我喜欢的表格格式整理',
  ] },
  { name: 'current-context', needsMemory: false, scope: 'none', modelAllowed: false, reason: '近邻用户消息已完整提供答案，不必检索长期记忆', context: '上一条用户消息已完整给出当前任务的格式、背景、选择或偏好。', queries: [
    '就按刚才说的三列格式排一下', '把上一条改短一些', '继续刚刚那道题', '用上面给你的背景写介绍',
    '我刚才选了第二种，按这个做', '刚说了用中文，直接开始', '根据本轮给出的课程表安排', '按上条消息里的约定执行',
    '基于这段已有对话回答，不用查历史', '就用我刚贴的表格模板', '继续翻译下一句', '你刚才那个答案再展开一点',
    '沿用上文中明确给出的标题格式', '按当前这份清单继续', '把刚才的代码变成 TypeScript', '用这轮提供的项目背景概括',
    '按照上一条用户消息里的风格润色', '刚说的第一个方案就好', '之前在本次聊天说过了，照着那个 JSON 示例输出', '就按眼前这份样例来',
  ] },
  { name: 'distractors', needsMemory: false, scope: 'none', modelAllowed: false, reason: '历史/记忆词属于待处理文本或一般概念', queries: [
    '什么是长期记忆', '解释记忆检索的原理', '翻译：你还记得我吗', '改写这句台词：你还记得我的地址吗',
    '总结这篇讨论记忆系统的文章', '虚构一个喜欢记日记的用户', '分析代码：function rememberMe() {}', '解释浏览器 remember me 登录选项',
    '历史数据库是什么', '讲讲人类情景记忆', '请把“我的偏好是安静”翻译成英文', '引用句“按我的风格写”有哪些语病',
    '设计一个保存用户偏好的表结构', '写一个模拟用户历史数据的函数', '解释之前这个词的词性', '翻译 remembered preferences',
    '不要查询我的记忆，直接说量子是什么', '不用翻历史，只需要说明 SQL JOIN', '不要按我的习惯，按行业标准解释', '假设我是一名工程师，写一段小说',
  ] },
  { name: 'corrections', needsMemory: true, scope: 'both', modelAllowed: true, reason: '明确比较或纠正已存事实，需查同作用域旧事实', queries: [
    '我现在改用英文了，之前记的是什么？', '我之前的技术栈是不是还记成 Vue 了？', '我已经换城市了，你还记着旧地址吗', '比较一下我新旧两版项目约定',
    '旧的风格偏好是什么，我想改一下', '还记得我之前的长期目标吗，现在想调整', '之前保存的职业信息需要更新，先看看原来内容', '我的学习进度是不是还停在上次那个章节',
    '查看旧记忆，我的称呼以后改成小林', '项目原来用的数据库记成什么了', '检查已记住的规则里有没有过时的', '我不再喜欢长回答了，旧偏好还有吗',
    '回忆之前的决定，然后我们再改', '查一下原来的部署约定，我想换方案', '你记的语言偏好和我上次修改的一致吗', '我已经毕业了，之前的身份记忆是什么',
    '还记得旧项目边界吗，和新要求对照一下', '把已保存的时间安排找出来，我需要改期', '原来给我记录的目标是不是过时了', '先列出旧习惯，别直接覆盖',
  ] },
  { name: 'mixed-tools', needsMemory: true, scope: 'both', modelAllowed: true, reason: '记忆与资料/网络/编辑协同，仍须独立权限', queries: [
    '按我的项目约定检查知识库里的设计文档', '搜索资料并结合我的背景解释', '参考我的偏好，再查一下最新课程', '用我的风格润色选区并生成修改提案',
    '检索我的长期目标，再总结本地学习笔记', '先查记忆中的技术栈，再搜索相关教程', '根据我之前的约定分析这份文件', '沿用我的输出习惯，搜索知识库给出答案',
    '把我的项目约定和网上的建议对照', '回忆上次的决策，再查本地文档验证', '按已保存的学习路线找相关阅读成果', '查询我的偏好并读取选区上下文',
    '参考我的工程边界，对知识库内容做审查', '基于我的身份给这些搜索结果排序', '用之前约定的格式总结当前文件', '先回忆决定，再给我一个提醒提案',
    '结合我平时的习惯和这份检索结果写建议', '把长期记忆中的旧结论与新资料做比较', '按我常用的方式归纳这些阅读成果', '根据我的项目背景研究一下这个主题',
  ] },
  { name: 'colloquial', needsMemory: true, scope: 'both', modelAllowed: true, reason: '短句口语或错字，明确个人/项目历史依赖', queries: [
    '还记得我不', '俺之前说的习惯还在吗', '老规距来一份', '按我那套来呗',
    '我啥专业来着，之前说过', '咱上回咋定的', '上次那事最后定了啥', '我用啥技术栈你记得吧',
    '我之前的偏好再说一遍', '照咱原先讲好的整', '你还记的我的称呼嘛', '我那个长期目标是啥',
    '我喜欢啥格式你知道的', '按之前约好的弄一下', '我不是说过住哪吗，帮我回忆下', '我平时啥风格',
    '俺的学习进度呢', '咱之前选的那套架构呢', '我上回为啥没选另一方案', '之前那约定，别忘了哈',
  ] },
]

export const memoryEvaluationCases: readonly MemoryEvaluationCase[] = groups.flatMap((group) =>
  group.queries.map((query, index) => ({
    id: `${group.name}-${String(index + 1).padStart(2, '0')}`,
    query, group: group.name, split: index % 4 === 3 ? 'test' as const : 'tune' as const,
    needsMemory: group.needsMemory, scope: group.scope,
    modelAllowed: group.modelAllowed, reason: group.reason, currentContext: group.context,
  })),
)
