import { describe, expect, it } from 'vitest'
import { getAgentProgressText, getAgentToolLabel } from '@/hooks/useAiChat'

describe('Agent 阶段展示文案', () => {
  it('为上下文读取显示开始阶段文案', () => {
    expect(getAgentProgressText({
      type: 'action',
      content: '调用工具: read_context_file',
      toolName: 'read_context_file',
      timestamp: 0,
    })).toBe('正在读取上下文...')
    expect(getAgentToolLabel('read_context_file')).toBe('上下文读取')
  })

  it('为文档修改工具显示开始阶段文案', () => {
    expect(getAgentProgressText({
      type: 'action',
      content: '调用工具: replace_current_tab_text',
      toolName: 'replace_current_tab_text',
      timestamp: 0,
    })).toBe('正在调用文档修改工具...')
    expect(getAgentToolLabel('replace_current_tab_text')).toBe('文档修改工具调用')
  })

  it('优先展示模型提供的行动说明', () => {
    expect(getAgentProgressText({
      type: 'action',
      content: '调用工具: web_search',
      toolName: 'web_search',
      actionMessage: '我会先搜索相关资料',
      timestamp: 0,
    })).toBe('我会先搜索相关资料')
  })

  it('知识库索引进度保留当前检索行动说明', () => {
    for (const progressStage of ['rag_initializing', 'rag_ready', 'rag_searching', 'rag_fallback'] as const) {
      expect(getAgentProgressText({
        type: 'progress',
        content: progressStage,
        progressStage,
        timestamp: 0,
      }, '我会检索知识库中关于 Markdown 的内容')).toBe('我会检索知识库中关于 Markdown 的内容')
    }
  })

  it('没有行动说明时索引进度继续展示现有兜底文案', () => {
    expect(getAgentProgressText({
      type: 'progress',
      content: 'rag_ready',
      progressStage: 'rag_ready',
      timestamp: 0,
    })).toBe('索引库已就绪，正在检索…')
  })

  it('工具结果返回后进入整理阶段，行动说明不覆盖结果状态', () => {
    expect(getAgentProgressText({
      type: 'observation',
      content: '匿名检索结果',
      toolName: 'search_knowledge',
      timestamp: 0,
    }, '我会检索知识库中关于 Markdown 的内容')).toBe('本地知识库检索已完成，正在整理下一步...')
  })
})
