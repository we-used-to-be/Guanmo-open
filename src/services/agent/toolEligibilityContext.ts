import { getAgentScopeContext } from '@/services/aiScope'
import { isTauri } from '@/hooks/useTauri'
import { useSettingsStore } from '@/stores/settingsStore'
import { useEditorStore } from '@/stores/editorStore'
import { normalizeFilePath } from '@/services/pathIdentity'
import { READING_REMINDER_FEATURE_AVAILABLE } from '@/services/readingReminderFeature'
import { shouldAllowMemoryWrite } from './intentDetector'
import type { ToolEligibilityContext } from './toolEligibility'
import type { AgentEditTarget } from '@/services/aiScope'
import type { ContextTag } from '@/types/contextTag'
import { isDatabaseReady } from '@/services/database/db'

/** Read live state both before schema exposure and immediately before execution. */
export function currentToolEligibilityContext(query: string, scope: {
  contextTags: ContextTag[]
  editTargets?: AgentEditTarget[]
} | null = getAgentScopeContext()): ToolEligibilityContext {
  const tags = scope?.contextTags || []
  const tabs = useEditorStore.getState().tabs
  const hasEditTarget = (scope?.editTargets || []).some(target =>
    tags.some(tag => tag.type === target.type && tag.filePath
      && normalizeFilePath(tag.filePath) === normalizeFilePath(target.filePath)
      && (target.type !== 'selection' || (tag.selectionFrom === target.selectionFrom && tag.selectionTo === target.selectionTo)))
    && tabs.some(tab => tab.filePath && normalizeFilePath(tab.filePath) === normalizeFilePath(target.filePath)))
  return {
    desktop: isTauri(),
    databaseAvailable: isDatabaseReady(),
    readAllowed: true,
    writeAllowed: true, // The existing per-tool scope and confirmation remain mandatory.
    hasSelection: tags.some(tag => tag.type === 'selection' && Boolean(tag.filePath)),
    hasReadableContext: tags.some(tag => Boolean(tag.filePath || tag.folderPath)),
    hasEditTarget,
    memoryWriteRequested: shouldAllowMemoryWrite(query),
    webEnabled: useSettingsStore.getState().ai.webSearchEnabled,
    reminderEnabled: READING_REMINDER_FEATURE_AVAILABLE,
  }
}
