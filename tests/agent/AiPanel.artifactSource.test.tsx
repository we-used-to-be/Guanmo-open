import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReadingArtifact } from '@/services/database/readingArtifacts'
import type { ReadingArtifactDocumentRef, ReadingArtifactLocation } from '@/services/readingArtifactCenter'
import { adaptAiReadingArtifact } from '@/services/readingArtifactCenter'

const mocks = vi.hoisted(() => ({ readFile: vi.fn() }))
const artifact: ReadingArtifact = {
  id: 'anonymous', type: 'annotation', title: '匿名解读', content: '解读', status: 'active', createdAt: 1, updatedAt: 1,
  source: { filePath: 'C:/anonymous/A.md', fileName: 'A.md', startLine: 1, endLine: 1 },
  structuredContent: { quote: '第一行', note: '解读', startOffset: 0, endOffset: 3 },
}
const ref: ReadingArtifactDocumentRef = {
  documentId: 'path:c:/anonymous/a.md', filePath: 'C:/anonymous/A.md', fileName: 'A.md',
  locations: [{ startLine: 1, endLine: 1 }, { startLine: 5, endLine: 6 }],
}
const selectionArtifact: ReadingArtifact = { ...artifact, type: 'summary', source: null,
  structuredContent: { references: [{ kind: 'web', title: '匿名网页', url: 'https://example.com' }],
    originalSelections: [{ title: '选区', text: '五\n六', filePath: 'C:/anonymous/A.md', startLine: 5, endLine: 6, truncated: false, previewOnly: false }] },
}
vi.mock('@/hooks/useAiChat', () => ({ useAiChat: () => ({ messages: [], timeline: [], streaming: false, error: null, sendMessage: vi.fn(), cancelStream: vi.fn() }) }))
vi.mock('@/services/markdownFileOpenPolicy', () => ({ readRememberedMarkdownFileForOpen: mocks.readFile }))
vi.mock('@/services/runtimeCapabilities', () => ({ isWebRuntime: () => false, getRuntimeCapabilities: () => ({ database: true }) }))
vi.mock('@/components/reading-artifacts/ReadingArtifactCenter', () => ({
  ReadingArtifactCenter: ({ onOpenAiSource }: { onOpenAiSource: (artifact: ReadingArtifact, ref: ReadingArtifactDocumentRef, location?: ReadingArtifactLocation) => Promise<void> }) => <>
    <button onClick={() => void onOpenAiSource(artifact, ref, ref.locations[1])}>第二区块</button>
    <button onClick={() => void onOpenAiSource({ ...artifact, type: 'summary', source: null }, { ...ref, locations: [] })}>旧文件来源</button>
    <button onClick={() => {
      const selectionRef = adaptAiReadingArtifact(selectionArtifact).documentRefs[0]
      void onOpenAiSource(selectionArtifact, selectionRef, selectionRef.locations[0])
    }}>联网回答的原选区</button>
  </>,
}))
import { AiPanel } from '@/components/ai/AiPanel'
import { OPEN_READING_ARTIFACTS_EVENT } from '@/services/aiPanelNavigation'
import { useEditorStore } from '@/stores/editorStore'
import { useSettingsStore } from '@/stores/settingsStore'

describe('AI artifact selected source navigation', () => {
  beforeEach(() => {
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: vi.fn() })
    useEditorStore.setState({ tabs: [], activeTabId: null, pendingReveal: null })
    useSettingsStore.getState().updateAppearanceSettings({ sendMessageAnimationEnabled: false })
    mocks.readFile.mockReset().mockResolvedValue('第一行\n二\n三\n四\n五\n六')
  })
  it.each([false, true])('reveals the selected block with existing tab=%s without overriding it with annotation source', async (opened) => {
    if (opened) useEditorStore.getState().addTab(ref.filePath!, ref.fileName, '第一行\n二\n三\n四\n五\n六')
    render(<AiPanel />)
    fireEvent(window, new Event(OPEN_READING_ARTIFACTS_EVENT))
    fireEvent.click(screen.getByText('第二区块'))
    await waitFor(() => expect(useEditorStore.getState().pendingReveal).toMatchObject({ startLine: 5, endLine: 6, surface: 'preview' }))
    expect(mocks.readFile).toHaveBeenCalledTimes(opened ? 0 : 1)
    expect(useEditorStore.getState().viewMode).toBe('preview')
  })
  it('opens an old file-only source without creating a reveal request', async () => {
    render(<AiPanel />)
    fireEvent(window, new Event(OPEN_READING_ARTIFACTS_EVENT))
    fireEvent.click(screen.getByText('旧文件来源'))
    await waitFor(() => expect(useEditorStore.getState().tabs).toHaveLength(1))
    expect(useEditorStore.getState().pendingReveal).toBeNull()
  })
  it('locates the original selection of a web-search artifact through its ordinary source entry', async () => {
    render(<AiPanel />)
    fireEvent(window, new Event(OPEN_READING_ARTIFACTS_EVENT))
    fireEvent.click(screen.getByText('联网回答的原选区'))
    await waitFor(() => expect(useEditorStore.getState().pendingReveal).toMatchObject({ startLine: 5, endLine: 6, surface: 'preview' }))
    expect(mocks.readFile).toHaveBeenCalledWith('C:/anonymous/A.md')
    expect(useEditorStore.getState().viewMode).toBe('preview')
  })
})
