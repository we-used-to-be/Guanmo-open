export function KnowledgeBaseManager({ open, onClose }: { open: boolean; onClose: () => void }) {
  if (!open) return null
  return (
    <div className="gm-settings-mask fixed inset-0 z-[1000] flex items-center justify-center p-4" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <div className="gm-settings-modal max-w-md rounded-xl border border-gm-border bg-gm-surface p-5 shadow-lg">
        <h3 className="text-body font-semibold text-gm-text">知识库</h3>
        <p className="mt-2 text-caption text-gm-text-tertiary">Web 端不保存 SQLite/RAG 索引，知识库入口已禁用。</p>
        <div className="mt-4 flex justify-end"><button type="button" className="rounded-lg border border-gm-border px-3 py-1 text-caption" onClick={onClose}>关闭</button></div>
      </div>
    </div>
  )
}
