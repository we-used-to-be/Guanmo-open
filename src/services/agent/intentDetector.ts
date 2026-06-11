/**
 * 意图检测器 - 基于打分机制的智能意图识别
 *
 * 设计原则：
 * 1. 不再通过正则直接进入 Agent
 * 2. 使用关键词 + 组合规则 + AppContext + 打分机制
 * 3. 读类工具宽松命中
 * 4. 强依赖问题进入 required
 * 5. 写类工具严格命中
 */

import { classifyMemoryRetrievalIntent } from '@/services/memory/memoryService'

// 能力类型
export type Capability =
  | 'memory'
  | 'knowledge'
  | 'file_read'
  | 'file_write'
  | 'web'
  | 'time'

// 意图分数
export interface IntentScore {
  capability: Capability
  score: number
  signals: string[]
  isRequired: boolean
}

// 意图检测结果
export interface IntentDetectionResult {
  candidates: Capability[]
  required: Capability[]
  scores: IntentScore[]
}

// 应用上下文
export interface AppContext {
  hasOpenFile?: boolean
  hasSelection?: boolean
  hasContextTags?: boolean
  hasRecentEdit?: boolean
  currentFilePath?: string
}

// 关键词配置
const KEYWORD_CONFIG: Record<Capability, { weak: string[]; strong: string[] }> = {
  memory: {
    weak: ['记忆', '城市', '偏好', '习惯', '地址', '喜欢', '记得', '之前说过', '告诉过你'],
    strong: ['查询记忆', '搜索记忆', '我的记忆', '记住', '保存记忆', '添加记忆', 'remember'],
  },
  knowledge: {
    weak: ['知识', '文档', '笔记', '资料', '索引', 'rag', '文件内容', '文章', '这篇', '提到', '总结', '解释', '分析', '概述', '归纳'],
    strong: ['知识库', '本地知识', '本地文档', '文档库', '资料库', '笔记库', 'search_knowledge', '查找文档', '搜索文档'],
  },
  file_read: {
    weak: ['文件', '文档', '内容', '看看', '查看', '读取', '打开'],
    strong: ['读取文件', '查看文件', '打开文件', '文件内容', 'read_context_file'],
  },
  file_write: {
    weak: ['修改', '改写', '润色', '优化', '重写', '调整', '更新'],
    strong: ['修改文件', '改写文档', '替换内容', 'replace_current_tab_text', '编辑文件'],
  },
  web: {
    weak: ['搜索', '查找', '网上', '联网', '最新', '新闻', '查一下', '搜一下'],
    strong: ['网络搜索', '联网搜索', '网上搜索', 'web_search', '搜索信息', '查找信息'],
  },
  time: {
    weak: ['时间', '日期', '几点', '今天', '现在', '当前', '星期', '周几'],
    strong: ['当前时间', '今天日期', '现在几点', 'get_current_time', '今天星期几'],
  },
}

// 正则模式配置
const REGEX_PATTERNS: Record<Capability, RegExp[]> = {
  memory: [
    /(查询|搜索|查看|找找).*(记忆|我的记忆|长期记忆)/i,
    /(记住|记下来|保存|添加).*(记忆|到记忆|进记忆)/i,
    /remember/i,
  ],
  knowledge: [
    /(查|查找|查询|搜索|检索|找找|看看).*(文档|文件|笔记|资料|知识库|索引|rag)/i,
    /(文档|文件|笔记|资料|知识库|索引|rag).*(有没有|是否有|哪些|哪里|提到|相关|包含)/i,
    /(根据|基于).*(知识库|本地文档|笔记|资料|rag|文件|文档).*(回答|总结|分析|归纳)/i,
    /(总结|解释|分析|概述|归纳).*(文件|文档|笔记|内容|这篇)/i,
    /(这个文件|这篇).*(什么|说|讲|内容)/i,
    /(什么|说|讲|内容).*(这个文件|这篇)/i,
    /(?:[\w\u4e00-\u9fff ._-]+\.(?:md|markdown|mdx|txt)).*(?:总结|解释|分析|概述|归纳|说了什么|讲了什么|提到|内容)/i,
    /(?:总结|解释|分析|概述|归纳|看看|查询|检索).*(?:[\w\u4e00-\u9fff ._-]+\.(?:md|markdown|mdx|txt))/i,
  ],
  file_read: [
    /(读取|查看|打开|看看).*(文件|文档)/i,
    /(文件|文档).*(内容|里面|说了什么)/i,
  ],
  file_write: [
    /^(修改|改写|润色|优化|重写|覆写|重构|调整|更新|扩写|缩写|续写|替换|改成|改为|加粗|斜体|删掉|删除|插入|补充|撤销|恢复|还原|改回|取消)/,
    /^(算了|不改了|还是不改了|别改了|不用改了|先不改了|先别改了)/,
    /(算了|不改了|别改了|不用改了|先不改了|先别改了)[\s\S]*(刚才|上次|前面|之前|修改|改动)/,
    /(修改|改写|润色|优化|重写|覆写|重构|调整|更新|替换|改成|改为|加粗|斜体|删掉|删除|插入|补充|撤销|恢复|还原|改回|取消)[\s\S]*(文本|内容|文件|文档|段落|句子|选中|选择|tag|标签|上下文|这段|上面|前面|刚才)/,
    /(文本|内容|文件|文档|段落|句子|选中|选择|tag|标签|上下文|这段|上面|前面|刚才)[\s\S]*(修改|改写|润色|优化|重写|覆写|重构|调整|更新|替换|改成|改为|加粗|斜体|删掉|删除|插入|补充|撤销|恢复|还原|改回|取消)/,
    /^(帮我|请|把|将).*(修改|改写|润色|优化|重写|覆写|重构|调整|更新|替换|改成|改为|加粗|斜体|删掉|删除|插入|补充|撤销|恢复|还原|改回|取消)/,
  ],
  web: [
    /^(搜索|查找|帮我搜|网上搜|联网搜)/,
    /(?:网上|联网|互联网|最新|新闻|实时|今天).*(?:搜索|查找|搜|查询|资料|信息)/,
    /(?:搜索|查找|查询|搜).*(?:网上|联网|互联网|最新|新闻|实时)/,
    /(帮我|请|能不能).*(查一下|搜一下|搜索|查找|查询)/,
    /(查一下|搜一下|搜索一下|查找一下).*(信息|资料|新闻|内容|话题)/,
    /(最新|最近|今日|今天).*(新闻|资讯|消息|动态)/,
  ],
  time: [
    /(现在|当前|此刻|今天).*(几点|时间|日期|几号|星期)/,
    /(几点了|当前时间|当前日期|今天几号|今天星期)/,
    /(今天|今日).*(是|几号|星期|周几)/,
    /(现在|当前).*(是|几点|时间)/,
    /(星期|周).*(几|几号)/,
    /(时间|日期|几点).*(现在|当前|今天)/,
  ],
}

/**
 * 计算单个能力的意图分数
 */
function scoreCapability(
  capability: Capability,
  query: string,
  context: AppContext
): IntentScore {
  const text = query.trim().toLowerCase()
  const config = KEYWORD_CONFIG[capability]
  const patterns = REGEX_PATTERNS[capability]
  const signals: string[] = []
  let score = 0

  // 弱信号匹配（宽松）
  for (const keyword of config.weak) {
    if (text.includes(keyword.toLowerCase())) {
      score += 1
      signals.push(`weak:${keyword}`)
    }
  }

  // 强信号匹配（严格）
  for (const keyword of config.strong) {
    if (text.includes(keyword.toLowerCase())) {
      score += 3
      signals.push(`strong:${keyword}`)
    }
  }

  // 正则模式匹配
  for (const pattern of patterns) {
    if (pattern.test(text)) {
      score += 2
      signals.push(`regex:${pattern.source.slice(0, 30)}`)
    }
  }

  // 上下文加成
  if (capability === 'file_write' && context.hasRecentEdit) {
    score += 2
    signals.push('context:recent_edit')
  }
  if (capability === 'file_read' && context.hasOpenFile) {
    score += 1
    signals.push('context:open_file')
  }
  if (capability === 'file_read' && context.hasContextTags && /(总结|解释|分析|概述|归纳|这篇|这个文件|文章|全文|内容)/.test(query)) {
    score += 2
    signals.push('context:tagged_file_read')
  }
  if (capability === 'memory' && context.hasContextTags) {
    score += 1
    signals.push('context:context_tags')
  }

  // 特殊处理：记忆意图使用统一分类器
  if (capability === 'memory') {
    const memoryIntent = classifyMemoryRetrievalIntent(query)
    if (memoryIntent === 'strong') {
      score += 4
      signals.push('classifier:strong')
    } else if (memoryIntent === 'weak') {
      score += 2
      signals.push('classifier:weak')
    }
  }

  // 判断是否为强依赖
  const isRequired = score >= 4 || (capability === 'memory' && classifyMemoryRetrievalIntent(query) === 'strong')

  return {
    capability,
    score,
    signals,
    isRequired,
  }
}

/**
 * 检测用户意图
 *
 * @param query 用户查询
 * @param context 应用上下文
 * @returns 意图检测结果
 */
export function detectIntentScores(
  query: string,
  context: AppContext = {}
): IntentDetectionResult {
  const capabilities: Capability[] = ['memory', 'knowledge', 'file_read', 'file_write', 'web', 'time']

  const scores = capabilities.map(cap => scoreCapability(cap, query, context))

  // 候选能力：分数 > 0
  const candidates = scores
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .map(s => s.capability)

  // 强依赖能力：isRequired = true
  const required = scores
    .filter(s => s.isRequired)
    .map(s => s.capability)

  return {
    candidates,
    required,
    scores,
  }
}

/**
 * 判断是否应该使用 Agent 模式
 */
export function shouldUseAgentMode(
  query: string,
  context: AppContext = {}
): boolean {
  const result = detectIntentScores(query, context)
  return result.candidates.length > 0
}

/**
 * 判断是否允许记忆写入
 */
export function shouldAllowMemoryWrite(query: string): boolean {
  return /(记住|记下来|添加(?:到|进|为)?(?:长期)?记忆|保存(?:到|进|为)?(?:长期)?记忆|以后记得|remember\s)/i.test(query.trim())
}

/**
 * 判断是否为隐式编辑继续
 */
export function isImplicitEditContinuation(query: string): boolean {
  const text = query.trim()
  return [
    /^(再|继续|接着|然后|请再|帮我再).*(简洁|精简|改|修改|优化|润色|重写|调整|更新|扩写|缩写|补充|删|删除|翻译|格式|详细|正式|口语|柔和|自然|生动)/,
    /^(更|稍微|语气|措辞|风格|表达|把它|将它|这个|这段|刚才的).*(简洁|精简|详细|正式|口语|柔和|自然|生动|清晰|学术|轻松|严谨|优化|润色|调整|改)/,
    /^(更|稍微).+(些|一点|一些)$/,
  ].some((pattern) => pattern.test(text))
}

/**
 * 判断是否需要全文件上下文
 */
export function shouldIncludeFullDocumentContext(query: string): boolean {
  const result = detectIntentScores(query)
  const hasWriteIntent = result.candidates.includes('file_write')
  return hasWriteIntent && /(整篇|整份|整个|全文|全文档|全部内容|全部文章|完整文章|完整文档|整体(?:改写|重写|润色|修改|优化))/.test(query)
}
