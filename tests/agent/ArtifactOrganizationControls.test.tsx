import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import type { ArtifactOrganizationFilter, ArtifactOrganizationSnapshot } from '@/services/database/artifactOrganization'

const api = vi.hoisted(() => ({ load: vi.fn(), update: vi.fn(), save: vi.fn(), remove: vi.fn() }))
vi.mock('@/services/database/artifactOrganization', () => ({
  loadArtifactOrganization: api.load, setArtifactOrganization: api.update,
  saveArtifactCategory: api.save, deleteArtifactCategory: api.remove,
}))
import { ArtifactCategoryLabels, ArtifactOrganizationActions, ArtifactOrganizationToolbar, useArtifactOrganization } from '@/components/reading-artifacts/ArtifactOrganizationControls'

let snapshot: ArtifactOrganizationSnapshot
const onDelete = vi.fn()
function Harness() {
  const organization = useArtifactOrganization()
  const [filter, setFilter] = useState<ArtifactOrganizationFilter>({ categoryId: 'c1' })
  const entry = organization.entries[0]
  return <><ArtifactOrganizationToolbar organization={organization} filter={filter} onFilter={setFilter} /><ArtifactOrganizationActions artifactKey="ai:a1" title="匿名成果" organization={organization} entry={entry} categoryId={filter.categoryId} onDelete={onDelete} /><ArtifactCategoryLabels categories={organization.categories} entry={entry} onSelect={(id) => setFilter({ categoryId: id })} /></>
}
beforeEach(() => {
  vi.clearAllMocks()
  snapshot = { categories: [{ id: 'c1', name: '主题一' }, { id: 'c2', name: '主题二' }], entries: [{ artifactKey: 'ai:a1', favorite: false, categoryIds: ['c1'] }] }
  api.load.mockImplementation(async () => structuredClone(snapshot))
  api.update.mockImplementation(async (_key, patch) => Object.assign(snapshot.entries[0], patch))
  api.save.mockImplementation(async (category) => {
    const existing = snapshot.categories.find((item) => item.id === category.id)
    if (existing) existing.name = category.name
    else snapshot.categories.push(category)
  })
  api.remove.mockImplementation(async (id) => { snapshot.categories = snapshot.categories.filter((item) => item.id !== id); snapshot.entries[0].categoryIds = snapshot.entries[0].categoryIds.filter((value) => value !== id) })
})
describe('克制的收藏与分类交互', () => {
  it('未分类与具体分类不会形成互斥的组合筛选', async () => {
    render(<Harness />)
    await screen.findByRole('button', { name: '主题一' })
    const collection = screen.getByRole('button', { name: '收藏筛选' })
    const category = screen.getByRole('button', { name: '分类筛选' })
    fireEvent.click(category)
    fireEvent.click(screen.getByRole('menuitemradio', { name: '未分类' }))
    expect(category).toHaveTextContent('分类：未分类')
    fireEvent.click(category)
    fireEvent.click(screen.getByRole('menuitemradio', { name: '主题二' }))
    expect(collection).toHaveTextContent('收藏：不限')
    expect(category).toHaveTextContent('分类：主题二')
  })
  it('收藏可切换，取消收藏保留分类', async () => {
    render(<Harness />)
    await waitFor(() => expect(screen.getByRole('button', { name: '收藏 匿名成果' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: '收藏 匿名成果' }))
    await screen.findByRole('button', { name: '取消收藏 匿名成果' })
    fireEvent.click(screen.getByRole('button', { name: '取消收藏 匿名成果' }))
    await screen.findByRole('button', { name: '收藏 匿名成果' })
    expect(snapshot.entries[0]).toMatchObject({ favorite: false, categoryIds: ['c1'] })
  })
  it('多选分类需要完成，取消和 Escape 不修改归属', async () => {
    render(<Harness />)
    await screen.findByRole('button', { name: '主题一' })
    fireEvent.click(screen.getByRole('button', { name: '成果操作 匿名成果' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '设置分类' }))
    fireEvent.click(screen.getByRole('checkbox', { name: '主题二' }))
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(api.update).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '成果操作 匿名成果' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '设置分类' }))
    fireEvent.click(screen.getByRole('checkbox', { name: '主题二' }))
    fireEvent.click(screen.getByRole('button', { name: '完成' }))
    await waitFor(() => expect(snapshot.entries[0].categoryIds).toEqual(['c1', 'c2']))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: '成果操作 匿名成果' }))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('menu', { name: '成果操作' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '成果操作 匿名成果' })).toHaveFocus()
  })
  it('移出当前分类保留收藏，删除成果是独立菜单操作', async () => {
    snapshot.entries[0].favorite = true
    render(<Harness />)
    await screen.findByRole('button', { name: '主题一' })
    expect(screen.queryByRole('button', { name: '删除成果' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '成果操作 匿名成果' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '移出当前分类' }))
    await waitFor(() => expect(snapshot.entries[0]).toMatchObject({ favorite: true, categoryIds: [] }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: '成果操作 匿名成果' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '删除成果' }))
    expect(onDelete).toHaveBeenCalledTimes(1)
  })
  it('浮层中创建、重命名和删除分类，删除只解除归属', async () => {
    render(<Harness />)
    await screen.findByRole('button', { name: '主题一' })
    fireEvent.click(screen.getByRole('button', { name: '成果操作 匿名成果' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '设置分类' }))
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: '新主题' } })
    fireEvent.click(screen.getByRole('button', { name: '+ 新建“新主题”' }))
    expect(await screen.findByRole('checkbox', { name: '新主题' })).toBeChecked()
    fireEvent.click(screen.getByRole('button', { name: '完成' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: '分类筛选' }))
    fireEvent.click(screen.getByRole('menuitemradio', { name: '管理分类…' }))
    fireEvent.click(screen.getAllByRole('button', { name: '重命名' })[0])
    fireEvent.change(screen.getByRole('textbox', { name: '分类新名称' }), { target: { value: '主题改名' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await screen.findByRole('button', { name: '删除分类 主题改名' })
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    fireEvent.click(screen.getByRole('button', { name: '删除分类 主题改名' }))
    await waitFor(() => expect(snapshot.categories.some((category) => category.id === 'c1')).toBe(false))
    expect(snapshot.entries).toHaveLength(1)
    expect(snapshot.entries[0].categoryIds).not.toContain('c1')
    confirm.mockRestore()
  })
})
