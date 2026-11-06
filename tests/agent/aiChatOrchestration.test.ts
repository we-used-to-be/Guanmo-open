import { describe, expect, it, vi } from 'vitest'
import { buildAgentFinalAnswerMessages } from '@/services/aiChatMessages'
import { makeRoutingDecision } from '@/services/agent/routingService'
import {
  buildAgentRunRequest,
  buildEditTargets,
  buildRoutingAppContext,
} from '@/services/agent/requestBuilder'
import { prepareAgentToolResultForModel } from '@/services/agent/executor'
import { buildAgentResultPresentation, resolveAgentAnswerSources } from '@/services/agent/sourceMetadata'
import { createSourceReferenceRegistry } from '@/services/ai/sourceReferences'
import type { ContextTag } from '@/types/contextTag'

const selectionTag: ContextTag = {
  id: 'selection-1',
  type: 'selection',
  title: '匿名选区',
  filePath: 'C:\\Temp\\anonymous.md',
  content: '匿名文本',
  preview: '匿名文本',
  selectionFrom: 10,
  selectionTo: 14,
}

describe('AI chat orchestration helpers', () => {
  it('registers model-visible memories from tool results and reuses their IDs', () => {
    const memory = { kind: 'memory' as const, memoryId: 'anonymous-memory', content: '偏好简洁回答' }
    const first = prepareAgentToolResultForModel(createSourceReferenceRegistry(), 'search_memory', JSON.stringify({ memories: [memory] }))
    expect(first.registry.entries).toEqual([{ id: 'S1', source: memory }])
    expect(JSON.parse(first.result).memories[0].referenceId).toBe('[S1]')
    const second = prepareAgentToolResultForModel(first.registry, 'search_memory', JSON.stringify({ memories: [memory] }))
    expect(second.registry.entries).toHaveLength(1)
    expect(prepareAgentToolResultForModel(first.registry, 'search_memory', '未找到相关记忆。').registry).toEqual(first.registry)
  })
  it('registers only model-visible Agent sources with stable IDs across tool calls', () => {
    const first = prepareAgentToolResultForModel(
      createSourceReferenceRegistry(),
      'search_knowledge',
      JSON.stringify({
        results: [{
          filePath: 'C:\\Temp\\anonymous.md',
          title: '匿名文档',
          startLine: 2,
          endLine: 4,
        }],
      }),
    )
    const second = prepareAgentToolResultForModel(
      first.registry,
      'web_search',
      JSON.stringify({
        results: [{ title: '匿名网页', url: 'https://example.com/anonymous' }],
      }),
    )
    const duplicate = prepareAgentToolResultForModel(
      second.registry,
      'search_knowledge',
      JSON.stringify({
        results: [{
          filePath: 'c:/TEMP/ANONYMOUS.md',
          title: '重复标题',
          startLine: 2,
          endLine: 4,
        }],
      }),
    )
    const selection = prepareAgentToolResultForModel(
      duplicate.registry,
      'read_selection_context',
      JSON.stringify({
        source: { filePath: 'C:\\Temp\\anonymous.md', fileName: 'anonymous.md' },
        chunks: [{ headingPath: ['章节'], startLine: 8, endLine: 9, content: '选区上下文' }],
      }),
    )
    const file = prepareAgentToolResultForModel(
      selection.registry,
      'read_context_file',
      JSON.stringify({
        source: { filePath: 'C:\\Temp\\anonymous.md', fileName: 'anonymous.md', startLine: 1, endLine: 20 },
      }),
    )

    expect(first.result).toContain('"referenceId": "[S1]"')
    expect(second.result).toContain('"referenceId": "[S2]"')
    expect(duplicate.result).toContain('"referenceId": "[S1]"')
    expect(selection.result).toContain('"referenceId": "[S3]"')
    expect(file.result).toContain('"referenceId": "[S4]"')
    expect(file.registry.entries.map((entry) => entry.id)).toEqual(['S1', 'S2', 'S3', 'S4'])

    const fallbackSources = file.registry.entries.map((entry) => entry.source)
    const resolved = resolveAgentAnswerSources(
      '结论 [S2]，本地依据 [S1]，未知 [S9]。',
      file.registry,
      fallbackSources,
    )
    expect(resolved.referencedIds).toEqual(['S2', 'S1'])
    expect(resolved.sources).toEqual([fallbackSources[1], fallbackSources[0]])
  })

  it('builds routing context and stable edit targets from current tags', () => {
    expect(buildRoutingAppContext([selectionTag], true)).toEqual({
      hasRecentEdit: true,
      hasOpenFile: false,
      hasSelection: true,
      hasContextTags: true,
    })
    expect(buildEditTargets([selectionTag])).toEqual([{
      id: 'edit-target-1',
      type: 'selection',
      title: '匿名选区',
      filePath: 'C:\\Temp\\anonymous.md',
      selectionFrom: 10,
      selectionTo: 14,
    }])
  })

  it('builds one AgentRunRequest from the routing decision without re-routing', () => {
    const routingDecision = makeRoutingDecision(
      '翻译并替换原文',
      buildRoutingAppContext([selectionTag], false),
      { contextTagCount: 1 },
    )
    const onStep = vi.fn()
    const controller = new AbortController()
    const built = buildAgentRunRequest({
      content: '翻译并替换原文',
      messages: [],
      contextTags: [selectionTag],
      tagContext: '【当前上下文】匿名内容',
      memoryContext: '【长期记忆】\n[记忆 1]\n分类：偏好\n内容：简洁回答',
      prefetchedMemory: { query: '翻译并替换原文', result: '简洁回答', topK: 3,
        sources: [{ kind: 'memory', memoryId: 'anonymous', content: '简洁回答' }] },
      routingDecision,
      hasRecentEditContext: false,
      hasPrefetchedMemoryLookup: false,
      signal: controller.signal,
      temperature: 0.2,
      onStep,
      streamEnabled: true,
    })

    expect(built.originalRequest).toBe('翻译并替换原文')
    expect(built.request.routingDecision).toBe(routingDecision)
    expect(built.request.candidateToolNames).toEqual(routingDecision.candidateTools)
    expect(built.request.currentEditTargetCount).toBe(1)
    expect(built.request.hasCurrentEditTarget).toBe(true)
    expect(built.request.untrustedContext).toContain('targetId: edit-target-1')
    expect(built.request.untrustedContext).toContain('[S1]\n分类：偏好\n内容：简洁回答')
  })

  it('maps Agent result sources and final messages without changing user-visible text', () => {
    const result = {
      answer: '{"tool":"ignored"}\n最终回答',
      steps: [{
        type: 'observation' as const,
        content: JSON.stringify({
          results: [{
            filePath: 'C:\\Temp\\anonymous.md',
            title: '匿名文档',
            titlePath: ['章节'],
            heading: '章节',
            startLine: 3,
            endLine: 5,
          }],
        }),
        timestamp: 1,
      }],
      toolCalls: 1,
      reason: 'completed' as const,
    }
    const presentation = buildAgentResultPresentation(result, 1)

    expect(presentation.answer).toBe('最终回答')
    expect(presentation.contextMeta).toEqual({
      tagCount: 1,
      ragSourceCount: 1,
      webSearchUsed: false,
    })
    expect(presentation.sources[0]).toMatchObject({
      kind: 'local',
      fileName: 'anonymous.md',
      startLine: 3,
      endLine: 5,
    })

    expect(buildAgentFinalAnswerMessages([{ role: 'assistant', content: '工具结果' }])).toEqual([
      { role: 'assistant', content: '工具结果' },
      {
        role: 'user',
        content: '仅当工具结果不足以支持当前问题的结论时，才简短指出具体缺口；如果已经能够回答，不要追加范围免责声明。需要说明时最多一句，不要建议用户继续选择、读取或定位其他章节。',
      },
    ])
  })
})
