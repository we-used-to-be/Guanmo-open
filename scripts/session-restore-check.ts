import assert from 'node:assert/strict'
import type { Tab } from '@/stores/editorStore'
import { mergeBackgroundRestoredTab, restorePersistedTabs } from '@/services/sessionRestore'

function tab(id: string, content = ''): Tab {
  return {
    id,
    title: id,
    filePath: `D:\\notes\\${id}.md`,
    content,
    savedContent: content,
    originalContent: content,
    modified: false,
  }
}

async function run() {
  const starts: string[] = []
  let releaseSlow: (() => void) | undefined
  const slow = new Promise<void>((resolve) => { releaseSlow = resolve })

  const restoring = restorePersistedTabs(
    [tab('slow'), tab('active'), tab('third')],
    {
      activeTabId: 'active',
      concurrency: 2,
      readFile: async (path) => {
        const id = path.split('\\').at(-1)?.replace('.md', '') ?? ''
        starts.push(id)
        if (id === 'slow') await slow
        return `${id}-disk`
      },
    }
  )

  await Promise.resolve()
  assert.equal(starts[0], 'active', '活动标签必须最先开始恢复')
  assert.ok(starts.length <= 2, '后台恢复不得超过配置的并发上限')
  releaseSlow?.()
  const restored = await restoring
  assert.deepEqual(restored.map((item) => item.id), ['slow', 'active', 'third'], '恢复后保持标签顺序')

  const draft = tab('draft', 'unsaved draft')
  draft.modified = true
  const [restoredDraft] = await restorePersistedTabs([draft], {
    readFile: async () => 'saved on disk',
  })
  assert.equal(restoredDraft.content, 'unsaved draft', '未保存草稿内容不得被磁盘内容覆盖')
  assert.equal(restoredDraft.savedContent, 'saved on disk')
  assert.equal(restoredDraft.modified, true)

  const changedIssues: string[] = []
  const [changedSnapshot] = await restorePersistedTabs([tab('snapshot', 'cached')], {
    detectExternalChanges: true,
    readFile: async () => 'changed on disk',
    onTabRestoreIssue: (issue) => changedIssues.push(issue.kind),
  })
  assert.equal(changedSnapshot.content, 'changed on disk', '外部修改后仍应刷新为磁盘内容')
  assert.deepEqual(changedIssues, ['external-change'], '活动快照过期时必须返回明确状态')

  const compactedIssues: string[] = []
  await restorePersistedTabs([tab('compacted')], {
    readFile: async () => 'disk content',
    onTabRestoreIssue: (issue) => compactedIssues.push(issue.kind),
  })
  assert.deepEqual(compactedIssues, [], '无可靠基线的后台标签不得误报外部修改')

  const draftIssues: string[] = []
  await restorePersistedTabs([draft], {
    readFile: async () => 'changed again on disk',
    onTabRestoreIssue: (issue) => draftIssues.push(issue.kind),
  })
  assert.deepEqual(draftIssues, ['external-change'], '磁盘基线变化时必须提示并保留草稿')

  const unavailableIssues: string[] = []
  const [unavailable] = await restorePersistedTabs([tab('missing', 'cached')], {
    readFile: async () => { throw new Error('not found') },
    onTabRestoreIssue: (issue) => unavailableIssues.push(issue.kind),
  })
  assert.equal(unavailable.content, 'cached', '文件不可读时必须保留当前内容')
  assert.deepEqual(unavailableIssues, ['unavailable'], '文件不可读时必须返回明确状态')

  const tooLargeIssues: Array<{ kind: string; preservedDraft?: boolean }> = []
  const [skippedTooLarge] = await restorePersistedTabs([tab('too-large')], {
    readFile: async () => { throw new Error('FILE_TOO_LARGE|1048577|1048576') },
    onTabRestoreIssue: (issue) => tooLargeIssues.push({ kind: issue.kind }),
  })
  assert.equal(skippedTooLarge, undefined, '未修改的超限标签不得恢复')
  assert.deepEqual(tooLargeIssues, [{ kind: 'too-large' }], '超限恢复应返回明确状态')

  const oversizedDraft = tab('too-large-draft', 'unsaved oversized draft')
  oversizedDraft.modified = true
  const draftTooLargeIssues: Array<{ kind: string; preservedDraft?: boolean }> = []
  const [preservedOversizedDraft] = await restorePersistedTabs([oversizedDraft], {
    readFile: async () => { throw new Error('FILE_TOO_LARGE|1048577|1048576') },
    onTabRestoreIssue: (issue) => draftTooLargeIssues.push({ kind: issue.kind, preservedDraft: issue.preservedDraft }),
  })
  assert.equal(preservedOversizedDraft.content, 'unsaved oversized draft', '超限草稿必须保留')
  assert.deepEqual(draftTooLargeIssues, [{ kind: 'too-large', preservedDraft: true }], '超限草稿应标记保留')

  const legacy = { ...tab('legacy'), originalContent: undefined } as unknown as Tab
  const [restoredLegacy] = await restorePersistedTabs([legacy], {
    readFile: async () => 'legacy disk',
  })
  assert.equal(restoredLegacy.originalContent, 'legacy disk', '旧版持久化标签应补齐 originalContent')
  const legacyDraft = { ...tab('legacy-draft', 'draft'), filePath: null, originalContent: undefined } as unknown as Tab
  const [restoredLegacyDraft] = await restorePersistedTabs([legacyDraft])
  assert.equal(restoredLegacyDraft.originalContent, 'draft', '旧版无路径草稿也应补齐 originalContent')

  const original = tab('editing', '')
  const current = { ...original, content: 'typed after UI ready', modified: true }
  const diskRestored = { ...original, content: 'disk', savedContent: 'disk', originalContent: 'disk' }
  const merged = mergeBackgroundRestoredTab(current, original, diskRestored)
  assert.equal(merged.content, 'typed after UI ready', '后台恢复不得覆盖 UI 就绪后的输入')
  assert.equal(merged.savedContent, 'disk')
  assert.equal(merged.modified, true)

  console.log('session restore checks passed')
}

await run()
