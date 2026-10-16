import { ArtifactFilterMenu } from './ArtifactFilterMenu'
import { ContextMenu, ContextMenuItem, ContextMenuSeparator } from '@/components/common/ContextMenu'
import { MoreHorizontal, Star, Trash2, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  deleteArtifactCategory, loadArtifactOrganization, saveArtifactCategory, setArtifactOrganization,
  type ArtifactCategory, type ArtifactOrganization, type ArtifactOrganizationFilter, type ArtifactOrganizationSnapshot,
} from '@/services/database/artifactOrganization'
import { toast } from '@/services/toast'

export function useArtifactOrganization(enabled = true) {
  const [snapshot, setSnapshot] = useState<ArtifactOrganizationSnapshot>({ categories: [], entries: [] })
  const [revision, setRevision] = useState(0)
  const [busy, setBusy] = useState(false)
  const [ready, setReady] = useState(false)
  const mounted = useRef(false)
  const writing = useRef(false)
  useEffect(() => {
    if (!enabled) return
    mounted.current = true
    let cancelled = false
    void loadArtifactOrganization().then((data) => {
      if (!cancelled) { setSnapshot(data); setReady(true) }
    }).catch(() => { if (!cancelled) toast.error('读取收藏和分类失败，请重新打开阅读成果') })
    return () => { cancelled = true; mounted.current = false }
  }, [enabled])
  const mutate = useCallback(async (write: () => Promise<void>) => {
    if (writing.current) return false
    writing.current = true
    setBusy(true)
    try {
      await write()
      const data = await loadArtifactOrganization()
      if (mounted.current) { setSnapshot(data); setRevision((value) => value + 1) }
      return true
    } catch (error) {
      if (mounted.current) toast.error(error instanceof Error ? error.message : '保存阅读成果整理信息失败')
      return false
    } finally {
      writing.current = false
      if (mounted.current) setBusy(false)
    }
  }, [])
  const update = useCallback((key: string, patch: { favorite?: boolean; categoryIds?: string[] }) => mutate(() => setArtifactOrganization(key, patch)), [mutate])
  const saveCategory = useCallback((category: ArtifactCategory) => mutate(() => saveArtifactCategory(category)), [mutate])
  const removeCategory = useCallback((id: string) => mutate(() => deleteArtifactCategory(id)), [mutate])
  return useMemo(() => ({
    ...snapshot, revision, busy: busy || !ready,
    update, saveCategory, removeCategory,
  }), [snapshot, revision, busy, ready, update, saveCategory, removeCategory])
}

type Organization = ReturnType<typeof useArtifactOrganization>
type PopupAnchor = { trigger: HTMLElement }
function anchorFor(trigger: HTMLElement): PopupAnchor {
  return { trigger }
}
const fieldClass = 'min-w-0 rounded-md border border-gm-border bg-gm-surface px-2 py-1.5 text-micro text-gm-text-secondary outline-none focus:border-gm-primary'
const actionClass = 'rounded-md px-2 py-1.5 text-micro text-gm-text-secondary hover:bg-gm-surface-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-gm-primary disabled:opacity-50'

function OrganizationPopup({ anchor, label, onClose, children, compact = false }: { anchor: PopupAnchor; label: string; onClose: () => void; children: ReactNode; compact?: boolean }) {
  return <ContextMenu anchor={anchor.trigger} placement="bottom-end" role={compact ? 'menu' : 'dialog'} aria-label={label} minWidth={compact ? 176 : 260} maxWidth={compact ? 176 : 260} onClose={onClose}>{children}</ContextMenu>
}

function CategoryEditor({ organization, selected, onSave, onClose }: { organization: Organization; selected?: string[]; onSave?: (ids: string[]) => Promise<boolean>; onClose: () => void }) {
  const [draft, setDraft] = useState(() => new Set(selected ?? []))
  const [search, setSearch] = useState('')
  const [renaming, setRenaming] = useState<string | null>(null)
  const [name, setName] = useState('')
  const assigning = !!onSave
  const matches = organization.categories.filter((category) => category.name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()))
  const create = async () => {
    const value = search.trim()
    if (!value || organization.categories.some((category) => category.name === value)) return
    const id = crypto.randomUUID()
    if (await organization.saveCategory({ id, name: value })) {
      if (assigning) setDraft((current) => new Set([...current, id]))
      setSearch('')
    }
  }
  return <>
    <div className="mb-2 flex items-center justify-between px-1"><span className="text-caption font-bold">{assigning ? '设置分类' : '管理分类'}</span><button type="button" aria-label="关闭分类" className={actionClass} onClick={onClose}><X size={14} /></button></div>
    <input autoFocus type="search" aria-label="搜索或新建分类" placeholder="搜索或新建分类" maxLength={40} value={search} onChange={(event) => setSearch(event.target.value)} className={`${fieldClass} mb-2 w-full`} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); void create() } }} />
    <div className="max-h-48 overflow-y-auto">
      {matches.map((category) => assigning ? <label key={category.id} className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-2 text-caption hover:bg-gm-surface-hover"><input type="checkbox" checked={draft.has(category.id)} disabled={organization.busy} onChange={() => setDraft((current) => { const next = new Set(current); if (next.has(category.id)) next.delete(category.id); else next.add(category.id); return next })} className="accent-gm-primary" /><span className="truncate">{category.name}</span></label> : <div key={category.id} className="flex items-center gap-1 py-1">
        {renaming === category.id ? <><input aria-label="分类新名称" maxLength={40} value={name} onChange={(event) => setName(event.target.value)} className={`${fieldClass} flex-1`} /><button type="button" disabled={organization.busy || !name.trim()} className={actionClass} onClick={() => void organization.saveCategory({ id: category.id, name: name.trim() }).then((saved) => { if (saved) setRenaming(null) })}>保存</button><button type="button" aria-label="取消重命名" className={actionClass} onClick={() => setRenaming(null)}><X size={12} /></button></> : <><span className="min-w-0 flex-1 truncate px-2 text-caption">{category.name}</span><button type="button" disabled={organization.busy} className={actionClass} onClick={() => { setRenaming(category.id); setName(category.name) }}>重命名</button><button type="button" disabled={organization.busy} aria-label={`删除分类 ${category.name}`} className={`${actionClass} text-gm-error`} onClick={() => { if (window.confirm(`删除分类“${category.name}”？仅解除分类归属，阅读成果会保留。`)) void organization.removeCategory(category.id) }}><Trash2 size={13} /></button></>}
      </div>)}
      {matches.length === 0 && <p className="px-2 py-3 text-micro text-gm-text-tertiary">{search ? '没有匹配的分类' : '暂无分类，输入名称即可新建'}</p>}
    </div>
    {search.trim() && !organization.categories.some((category) => category.name === search.trim()) && <button type="button" disabled={organization.busy} onClick={() => void create()} className={`${actionClass} mt-1 w-full truncate text-left text-gm-primary`}>+ 新建“{search.trim()}”</button>}
    {assigning && <div className="mt-2 flex justify-end gap-1 border-t border-gm-border-subtle pt-2"><button type="button" className={actionClass} onClick={onClose}>取消</button><button type="button" disabled={organization.busy} className={`${actionClass} font-bold text-gm-primary`} onClick={() => void onSave([...draft].filter((id) => organization.categories.some((category) => category.id === id))).then((saved) => { if (saved) onClose() })}>完成</button></div>}
  </>
}

export function ArtifactOrganizationToolbar({ organization, filter, onFilter, children }: { organization: Organization; filter: ArtifactOrganizationFilter; onFilter: (filter: ArtifactOrganizationFilter) => void; children?: ReactNode }) {
  const [anchor, setAnchor] = useState<PopupAnchor | null>(null)
  const close = useCallback(() => setAnchor(null), [])
  useEffect(() => {
    if (filter.categoryId && !organization.categories.some((category) => category.id === filter.categoryId) && !organization.busy) onFilter({ ...filter, categoryId: undefined })
  }, [filter, onFilter, organization.busy, organization.categories])
  return <div className="mb-3 flex flex-wrap items-center gap-2" aria-label="成果整理筛选">
    <ArtifactFilterMenu value={filter.collection === 'favorites' ? 'favorites' : 'all'}
      label={filter.collection === 'favorites' ? '收藏：仅收藏' : '收藏：不限'} ariaLabel="收藏筛选" menuLabel="收藏范围"
      options={[{ value: 'all', label: '不限收藏状态' }, { value: 'favorites', label: '仅收藏' }]}
      onChange={(value) => onFilter({ ...filter, collection: value as ArtifactOrganizationFilter['collection'] })} />
    <ArtifactFilterMenu value={filter.collection === 'unclassified' ? '__unclassified__' : filter.categoryId ?? ''}
      label={`分类：${filter.collection === 'unclassified' ? '未分类' : organization.categories.find((category) => category.id === filter.categoryId)?.name ?? '不限'}`}
      ariaLabel="分类筛选" menuLabel="分类范围" disabled={organization.busy}
      options={[{ value: '', label: '不限分类' }, { value: '__unclassified__', label: '未分类' }, ...organization.categories.map((category) => ({ value: category.id, label: category.name })), { value: '__manage__', label: '管理分类…' }]}
      onChange={(value, trigger) => {
        if (value === '__manage__') setAnchor(anchorFor(trigger))
        else onFilter({ ...filter, collection: value === '__unclassified__' ? 'unclassified' : filter.collection === 'unclassified' ? 'all' : filter.collection, categoryId: value === '__unclassified__' ? undefined : value || undefined })
      }} />
    {children}
    {anchor && <OrganizationPopup anchor={anchor} label="管理分类" onClose={close}><CategoryEditor organization={organization} onClose={close} /></OrganizationPopup>}
  </div>
}

export function ArtifactOrganizationActions({ artifactKey, title, organization, entry, categoryId, onDelete }: { artifactKey: string; title: string; organization: Organization; entry?: ArtifactOrganization; categoryId?: string; onDelete: () => void }) {
  const [popup, setPopup] = useState<{ anchor: PopupAnchor; mode: 'menu' | 'categories' } | null>(null)
  const close = useCallback(() => setPopup(null), [])
  return <div className="flex shrink-0 items-center gap-0.5">
    <button type="button" aria-label={`${entry?.favorite ? '取消收藏' : '收藏'} ${title}`} aria-pressed={entry?.favorite ?? false} disabled={organization.busy} onClick={() => void organization.update(artifactKey, { favorite: !entry?.favorite })} className={`${actionClass} px-1.5 ${entry?.favorite ? 'text-gm-accent' : 'text-gm-text-tertiary'}`}><Star size={14} fill={entry?.favorite ? 'currentColor' : 'none'} strokeWidth={1.7} /></button>
    <button type="button" aria-label={`成果操作 ${title}`} aria-expanded={!!popup} aria-haspopup="menu" onClick={(event) => { const anchor = anchorFor(event.currentTarget); setPopup((current) => current ? null : { anchor, mode: 'menu' }) }} className={`${actionClass} px-1.5 text-gm-text-tertiary`}><MoreHorizontal size={15} /></button>
    {popup && <OrganizationPopup compact={popup.mode === 'menu'} anchor={popup.anchor} label={popup.mode === 'menu' ? '成果操作' : '设置分类'} onClose={close}>{popup.mode === 'categories' ? <CategoryEditor organization={organization} selected={entry?.categoryIds} onSave={(ids) => organization.update(artifactKey, { categoryIds: ids })} onClose={close} /> : <>
      <ContextMenuItem disabled={organization.busy} onClick={() => setPopup({ anchor: anchorFor(popup.anchor.trigger), mode: 'categories' })}>设置分类</ContextMenuItem>
      {categoryId && <ContextMenuItem disabled={organization.busy} onClick={() => void organization.update(artifactKey, { categoryIds: (entry?.categoryIds ?? []).filter((id) => id !== categoryId) }).then((saved) => { if (saved) close() })}>移出当前分类</ContextMenuItem>}
      <ContextMenuSeparator />
      <ContextMenuItem danger onClick={() => { close(); onDelete() }}>删除成果</ContextMenuItem>
    </>}</OrganizationPopup>}
  </div>
}

export function ArtifactCategoryLabels({ categories, entry, onSelect }: { categories: ArtifactCategory[]; entry?: ArtifactOrganization; onSelect: (id: string) => void }) {
  const assigned = categories.filter((category) => entry?.categoryIds.includes(category.id))
  if (!assigned.length) return null
  return <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-micro text-gm-text-tertiary">{assigned.slice(0, 2).map((category) => <button key={category.id} type="button" onClick={() => onSelect(category.id)} className="max-w-[120px] truncate rounded px-1 py-0.5 hover:bg-gm-surface-hover hover:text-gm-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-gm-primary">{category.name}</button>)}{assigned.length > 2 && <span title={assigned.slice(2).map((category) => category.name).join('、')}>+{assigned.length - 2}</span>}</div>
}
