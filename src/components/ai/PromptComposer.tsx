import { useRef, useCallback, useState, useEffect } from 'react'
import { useChatStore } from '@/stores/chatStore'
import { Button } from 'animal-island-ui'
import { ContextTagChip } from '@/components/common/ContextTagChip'
import { addFileContextTag, addFolderContextTag } from '@/services/aiContext'
import { ManualToolToggle, type ManualCapability } from './ManualToolToggle'

interface PromptComposerProps {
  onSend: () => void
  streaming: boolean
  onCancel: () => void
  onManualCapabilitiesChange?: (capabilities: ManualCapability[]) => void
  resetManualToggle?: number
}

export function PromptComposer({ onSend, streaming, onCancel, onManualCapabilitiesChange, resetManualToggle }: PromptComposerProps) {
  const draftInput = useChatStore((s) => s.draftInput)
  const setDraftInput = useChatStore((s) => s.setDraftInput)
  const contextTags = useChatStore((s) => s.contextTags)
  const removeContextTag = useChatStore((s) => s.removeContextTag)
  const clearContextTags = useChatStore((s) => s.clearContextTags)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [isDragOver, setIsDragOver] = useState(false)
  const previousContextTagCountRef = useRef(contextTags.length)

  useEffect(() => {
    if (!streaming) {
      textareaRef.current?.focus()
    }
  }, [streaming])

  useEffect(() => {
    if (contextTags.length > previousContextTagCountRef.current && !streaming) {
      textareaRef.current?.focus()
    }
    previousContextTagCountRef.current = contextTags.length
  }, [contextTags.length, streaming])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      onSend()
    }
  }

  const handleTextareaInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setDraftInput(e.target.value)
    const el = e.target
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 120) + 'px'
  }

  // 拖拽文件到 AI 输入框
  const handleDragOver = useCallback((e: React.DragEvent) => {
    const hasFile = e.dataTransfer.types.includes('application/x-guanmo-file')
      || e.dataTransfer.types.includes('application/x-guanmo-tab')
      || e.dataTransfer.types.includes('application/x-guanmo-folder')
    if (hasFile) {
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
      setIsDragOver(true)
    }
  }, [])

  const handleDragLeave = useCallback(() => {
    setIsDragOver(false)
  }, [])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setIsDragOver(false)

    // Tab 拖拽
    const tabData = e.dataTransfer.getData('application/x-guanmo-tab')
    if (tabData) {
      try {
        const { title, filePath } = JSON.parse(tabData)
        if (filePath) addFileContextTag({ title, filePath })
      } catch { /* ignore */ }
      return
    }

    // 文件拖拽
    const fileData = e.dataTransfer.getData('application/x-guanmo-file')
    if (fileData) {
      try {
        const { name, path } = JSON.parse(fileData)
        addFileContextTag({ title: name, filePath: path })
      } catch { /* ignore */ }
      return
    }

    // 文件夹拖拽
    const folderData = e.dataTransfer.getData('application/x-guanmo-folder')
    if (folderData) {
      try {
        const { name, path } = JSON.parse(folderData)
        addFolderContextTag({ title: name, folderPath: path })
      } catch { /* ignore */ }
    }
  }, [])

  return (
    <div
      className={`absolute bottom-0 left-0 right-0 p-3 border-t border-gm-border-subtle backdrop-blur-xl bg-gm-surface/70 z-20 ${isDragOver ? 'bg-gm-primary-subtle/30' : ''}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* 拖拽提示 */}
      {isDragOver && (
        <div className="mb-2 text-center text-micro text-gm-primary animate-pulse">
          释放以添加文件到 AI 上下文
        </div>
      )}

      {/* 手动工具开关 */}
      <ManualToolToggle
        onChange={onManualCapabilitiesChange || (() => {})}
        disabled={streaming}
        resetKey={resetManualToggle}
      />

      <div className="gm-instant-color bg-gm-surface-elevated rounded-2xl border-2 border-gm-border focus-within:border-gm-primary">
        {/* Context Tags */}
        {contextTags.length > 0 && (
          <div className="flex flex-wrap items-center gap-1 px-3 pt-2 pb-1 max-h-[80px] overflow-y-auto">
            {contextTags.map((tag) => (
              <ContextTagChip key={tag.id} tag={tag} onRemove={removeContextTag} />
            ))}
            {contextTags.length > 1 && (
              <button
                onClick={clearContextTags}
                className="text-micro text-gm-text-tertiary hover:text-gm-text-secondary px-1"
                title="清除全部"
              >
                全部清除
              </button>
            )}
          </div>
        )}

        {/* Text Input */}
        <div className="flex items-end gap-2 p-2">
          <textarea
            ref={textareaRef}
            value={draftInput}
            onChange={handleTextareaInput}
            onKeyDown={handleKeyDown}
            placeholder="输入消息... (Enter 发送)"
            className={`flex-1 bg-transparent resize-none text-body text-gm-text placeholder-gm-text-disabled focus:outline-none min-h-[20px] max-h-[120px] ${streaming ? 'opacity-60' : ''}`}
            rows={1}
            disabled={streaming}
          />
          {streaming ? (
            <button
              onClick={onCancel}
              className="flex-shrink-0 w-8 h-8 rounded-xl bg-gm-error/10 flex items-center justify-center hover:bg-gm-error/20"
              title="停止生成"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="var(--gm-error)" stroke="none">
                <rect x="6" y="6" width="12" height="12" rx="2" />
              </svg>
            </button>
          ) : (
            <Button
              type="primary"
              size="small"
              onClick={onSend}
              disabled={!draftInput.trim() && contextTags.length === 0}
              icon={
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" />
                </svg>
              }
            />
          )}
        </div>
      </div>
    </div>
  )
}
