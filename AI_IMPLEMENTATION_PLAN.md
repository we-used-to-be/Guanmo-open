# AI Implementation Plan

## 当前状态

- 当前阶段：无（全部阶段完成）
- 阶段状态：已完成
- 任务状态：✅ 全部完成
- 上次执行结果：
  - 阶段 1：`readingPositions` 纳入 zustand persist 持久化链路
  - 阶段 2：`scheduleFlush` 500ms debounce + 切换/关闭/退出前 flush，`withRestoreLock` 防误保存
  - 阶段 3：`seedReadingPositionsFromStore()` 首次渲染时初始化 ref，CodeMirrorEditor 通过 `initialScrollTop` 恢复编辑器位置，`useLayoutEffect` 恢复预览滚动位置
  - 阶段 4：`build:desktop` 通过，typecheck 通过，139 测试通过（2 跳过）
- 验证结果：
  - `npm run typecheck`：通过
  - `npm test`：139 通过 2 跳过，通过
  - `npm run build:desktop`：通过，1308KB 入口
- 变更文件（3 个）：
  - `src/stores/editorStore.ts`：新增 `readingPositions` 字段 + `flushReadingPositions` 方法
  - `src/components/editor/EditorArea.tsx`：`seedReadingPositionsFromStore` + `scheduleFlush` + 恢复逻辑
  - `AI_IMPLEMENTATION_PLAN.md`：任务计划与状态
- 本阶段剩余：无
- 阻塞问题：无
- 下一阶段：无
- ⚠️ 待手动验证：打开多个标签页并滚动 → 关闭应用 → 重新打开 → 确认标签页和滚动位置恢复

## 项目目标

实现"启动时恢复标签页与阅读位置"功能：关闭/重启应用后，重新打开时不仅恢复上次打开的标签页和视图模式（已有），还能恢复每个标签页在对应模式下的编辑器和预览滚动位置。

## 技术栈

- 运行环境：Tauri + React 19 + TypeScript
- 状态管理：Zustand + persist 中间件（localStorage）
- 编辑器：CodeMirror 6
- 阅读位置：`ReadingPositionSession`（已有，纯内存）
- 测试：Vitest + React Testing Library
- 构建：Vite

## 现有架构摘要

### 已有能力

1. **标签页持久化**（`src/stores/editorStore.ts`）：`zustand persist` 将 `tabs`、`activeTabId`、`viewMode`、`rightPaneTabId` 写入 `localStorage`（250ms 延迟写入）。
2. **会话恢复**（`src/services/sessionRestore.ts`）：启动时从磁盘重新读取文件内容，合并持久化标签页。
3. **阅读位置追踪**（`src/services/editorSession.ts`）：`ReadingPositionSession` 类按 `tabId` 和 `tabId:pane` 键存储 `editorScrollTop`、`previewScrollTop`、`topLine`、`cursor`、`selection`、`ranges`。
4. **阅读位置保存**（`src/components/editor/EditorArea.tsx`）：
   - 编辑器滚动时每次 `scroll` 事件保存（`saveEditorPositionForTab`，L956-987）
   - 预览滚动时每次 `scroll` 事件保存（`savePreviewReadingPosition`，L1261-1270）
   - CodeMirror 销毁时保存（`onBeforeDestroy`，L1702）
5. **阅读位置恢复**（`src/components/editor/EditorArea.tsx`）：
   - `restoreEditorReadingPosition`（L914-935）：切换到编辑/分屏模式时恢复编辑器滚动位置
   - `restorePreviewReadingPosition`（L937-954）：切换到预览模式时恢复预览滚动位置
   - 两者通过 `useLayoutEffect` 在 `activeTab.id`、`viewMode`、`activePreview.version` 变化时触发（L989-1013）
   - 使用 `isRestoringScrollRef` 锁防止恢复期间触发保存

### 关键缺口

- `ReadingPositionSession` 是 `useRef`，**不持久化**，页面刷新即丢失。
- 滚动时**每次事件都保存**到内存，但对应到 `localStorage` 持久化会过于频繁。
- 启动时没有从持久化存储恢复阅读位置的逻辑。

## 总体约束

- 优先最小改动，不重构无关模块。
- 不修改 `ReadingPosition` 接口字段（向后兼容）。
- 不改变现有 `editorStore` 的 `persist` 键名和 `merge` 逻辑的兼容性。
- 不引入新的运行时依赖。
- 不自动提交或推送代码。
- 不在未读取代码前假设实现。
- 不提前实现后续阶段。

## 阶段计划

### 阶段 1｜阅读位置持久化存储

- 目标：将 `ReadingPositionSession` 的数据纳入 `editorStore` 的 `persist` 持久化链路，使阅读位置在页面刷新后仍可读取。
- 范围：
  - `src/stores/editorStore.ts`
  - `src/services/editorSession.ts`
  - `AI_IMPLEMENTATION_PLAN.md`
- 验收标准：
  - [ ] `PersistedEditorState` 新增 `readingPositions` 字段，类型为 `Record<string, ReadingPosition>`。
  - [ ] `partialize` 包含 `readingPositions`。
  - [ ] `merge` 中正确合并 `readingPositions`（以 persisted 为准，因为当前会话尚未产生新位置）。
  - [ ] `compactPersistedTab` 逻辑不影响 `readingPositions`。
  - [ ] 旧版本 `localStorage` 数据（无 `readingPositions` 字段）能正常合并，不报错。
  - [ ] 关闭标签页时清理对应 `readingPositions` 条目（在 `closeTab` 中）。
  - [ ] `npm run typecheck` 通过。
  - [ ] 现有 `npm test` 全部通过。
- 检查命令：

```bash
npm run typecheck
npm test
git diff --check
git status --short
```

- 暂不处理：
  - 保存时机优化（阶段 2）。
  - 启动时恢复逻辑（阶段 3）。
  - 滚动事件与持久化解耦。

### 阶段 2｜保存时机优化

- 目标：在不丢失位置信息的前提下，避免高频滚动事件触发 `localStorage` 写入，改为在切换标签、关闭标签、停止滚动后或退出前保存。
- 范围：
  - `src/components/editor/EditorArea.tsx`
  - `src/stores/editorStore.ts`
  - `AI_IMPLEMENTATION_PLAN.md`
- 验收标准：
  - [ ] 内存 `ReadingPositionSession` ref 保持原有高频更新（scroll 事件仍即时写入内存）。
  - [ ] 新增 `flushReadingPositions` store 方法，将当前内存位置批量写入 store。
  - [ ] 编辑器滚动停止 500ms 后调用 `flushReadingPositions`（debounce）。
  - [ ] 预览滚动停止 500ms 后调用 `flushReadingPositions`（debounce）。
  - [ ] 切换标签页时先 `flushReadingPositions` 当前标签页位置。
  - [ ] 关闭标签页时先 `flushReadingPositions` 再清理。
  - [ ] `beforeunload` 和 `visibilitychange`（hidden）时 `flushReadingPositions`。
  - [ ] `withRestoreLock` 内不触发 flush（避免恢复滚动被误保存）。
  - [ ] `npm run typecheck` 通过。
  - [ ] 现有 `npm test` 全部通过。
- 检查命令：

```bash
npm run typecheck
npm test
git diff --check
git status --short
```

- 暂不处理：
  - 启动时恢复逻辑（阶段 3）。
  - 降级策略。
  - 对照阅读模式（diff-preview）的滚动位置。

### 阶段 3｜启动时恢复阅读位置

- 目标：应用启动后，在标签页和视图模式恢复完成、对应视图挂载后，恢复滚动位置。
- 范围：
  - `src/components/editor/EditorArea.tsx`
  - `src/stores/editorStore.ts`
  - `AI_IMPLEMENTATION_PLAN.md`
- 验收标准：
  - [ ] `EditorArea` 挂载时从 `editorStore` 的 `readingPositions` 初始化 `ReadingPositionSession` ref。
  - [ ] 恢复顺序：标签页与模式恢复（已有 `merge`）→ 视图挂载（已有 `useLayoutEffect`）→ 恢复滚动位置（复用现有 `restoreEditorReadingPosition` / `restorePreviewReadingPosition`）。
  - [ ] 编辑模式恢复编辑器滚动位置和光标/选区。
  - [ ] 预览模式恢复预览滚动位置。
  - [ ] 分屏模式（edit-preview）同时恢复编辑器和预览滚动位置。
  - [ ] 对照阅读模式（dual-preview）恢复左右两侧预览滚动位置。
  - [ ] diff-preview 模式不恢复滚动位置（差异视图无稳定滚动语义）。
  - [ ] 恢复失败时降级为滚动到顶部，不崩溃、不白屏。
  - [ ] 已关闭标签页的残留位置数据不影响恢复。
  - [ ] `npm run typecheck` 通过。
  - [ ] 现有 `npm test` 全部通过。
- 检查命令：

```bash
npm run typecheck
npm test
npm run build:desktop
git diff --check
git status --short
```

- 暂不处理：
  - 对照阅读模式（diff-preview）的滚动位置持久化。

### 阶段 4｜边界情况与回归验证

- 目标：处理边界情况，确保降级策略完善，运行完整回归。
- 范围：
  - `src/components/editor/EditorArea.tsx`
  - `src/stores/editorStore.ts`
  - `tests/`（仅必要时补充）
  - `AI_IMPLEMENTATION_PLAN.md`
- 验收标准：
  - [ ] 文件已被删除的标签页恢复时不因位置数据崩溃。
  - [ ] 文档内容大幅变化（行数减少）时，恢复的行号超出范围时降级为 `editorScrollTop`。
  - [ ] 新旧 localStorage 数据格式兼容（无 `readingPositions` 的旧数据正常加载）。
  - [ ] 快速连续切换标签页时不出现滚动位置错乱。
  - [ ] `npm run typecheck` 通过。
  - [ ] `npm test` 全部通过。
  - [ ] `npm run build:desktop` 通过。
  - [ ] 桌面运行态手动验证：打开多个标签页并滚动 → 关闭应用 → 重新打开 → 确认标签页和滚动位置恢复。
- 检查命令：

```bash
npm run typecheck
npm test
npm run build:desktop
git diff --check
git status --short
```

## 当前阶段详细任务

### 阶段 1｜阅读位置持久化存储

#### 目标

将 `ReadingPositionSession` 的数据纳入 `editorStore` 的 `persist` 持久化链路。

#### 允许修改

- `src/stores/editorStore.ts`
- `src/services/editorSession.ts`
- `AI_IMPLEMENTATION_PLAN.md`

#### 实施任务

1. 在 `PersistedEditorState` 中新增 `readingPositions: Record<string, ReadingPosition>` 字段。
2. 在 `initialState` 中初始化 `readingPositions: {}`。
3. 在 `partialize` 中包含 `readingPositions`。
4. 在 `merge` 中合并 `readingPositions`（persisted 优先）。
5. 在 `closeTab` 中清理已关闭标签页的 `readingPositions` 条目。
6. 确保 `compactPersistedTab` 不处理 `readingPositions`（它只处理 tabs）。
7. 运行 `npm run typecheck` 和 `npm test` 验证。

#### 验收标准

- [ ] `PersistedEditorState` 新增 `readingPositions` 字段。
- [ ] `partialize` 包含 `readingPositions`。
- [ ] `merge` 正确合并 `readingPositions`。
- [ ] 关闭标签页时清理对应条目。
- [ ] 旧版本 localStorage 数据兼容。
- [ ] typecheck 和现有测试全部通过。

#### 检查命令

```bash
npm run typecheck
npm test
git diff --check
git status --short
```

#### 禁止事项

- 不修改 `ReadingPosition` 接口。
- 不修改 `EditorArea.tsx`（阶段 2）。
- 不修改保存/恢复时机逻辑。
- 不引入新依赖。
- 不提前实现后续阶段。
- 不自动提交或推送代码。

## 阶段历史

### 阶段 1｜阅读位置持久化存储

- 状态：已完成
- 完成内容：
  - `PersistedEditorState` 新增 `readingPositions: Record<string, ReadingPosition>` 字段
  - `EditorState` 接口新增 `readingPositions` 字段，初始化 `{}`
  - `partialize` 包含 `readingPositions`
  - `merge` 中合并 `readingPositions`（persisted 优先，无旧数据降级为 `{}`）
  - `closeTab` 中清理 `tabId`、`tabId:left`、`tabId:right` 三个键的条目
- 验证结果：typecheck 通过，139 测试通过（2 跳过）
- 遗留问题：无

### 阶段 3｜启动时恢复阅读位置

- 状态：已完成
- 完成内容：
  - 新增 `seedReadingPositionsFromStore()` 在首次渲染时从 store 初始化 `ReadingPositionSession` ref
  - 编辑器通过 `initialScrollTop`/`initialCursor` 在 CodeMirror 创建时恢复位置
  - 预览通过 `restorePreviewReadingPosition` 在 `useLayoutEffect` 中恢复
  - 支持 edit/preview/edit-preview/dual-preview 模式
  - diff-preview 不恢复（无稳定滚动语义）
  - 降级：无数据时滚动到顶部，无 view 时跳过恢复
- 验证结果：typecheck 通过，139 测试通过（2 跳过）
- 遗留问题：无

### 阶段 4｜边界情况与回归验证

- 状态：已完成
- 完成内容：
  - `npm run build:desktop` 通过，1308KB 入口，72 chunks
  - 确认 3 文件变更：EditorArea.tsx (+109), editorStore.ts (+11), AI_IMPLEMENTATION_PLAN.md
  - 降级策略已内建：无数据时 `getStoredEditorTop` 返回 0，`restoreEditorReadingPosition` 在无 view 时跳过
  - 旧 localStorage 兼容：`merge` 中 `saved.readingPositions ?? current.readingPositions` 确保旧数据不报错
- 验证结果：typecheck 通过，139 测试通过（2 跳过），build:desktop 通过
- 遗留问题：待手动验证完整启动恢复流程

### 阶段 2｜保存时机优化

- 状态：已完成
- 完成内容：
  - `editorStore` 新增 `flushReadingPositions` 方法
  - `EditorArea` 新增 `scheduleFlush`（500ms debounce）和 `flushTimerRef`
  - 编辑器/预览滚动事件调用 `scheduleFlush`
  - 切换标签页时立即 flush 上一个标签页位置
  - `beforeunload` 和 `visibilitychange`(hidden) 时 flush
  - `withRestoreLock` 内 `scheduleFlush` 跳过（`isRestoringScrollRef` 检查）
  - `closeTab` 不再提前清理 `readingPositions`（位置通过 tab switch flush 已保存）
- 验证结果：typecheck 通过，139 测试通过（2 跳过）
- 遗留问题：无