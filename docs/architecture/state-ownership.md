# 核心状态所有权与不变量（State Ownership & Invariants）

本文记录观墨核心状态的 Source of Truth、派生关系、修改所有权和不可破坏的不变量。

- 读取时机：修改核心状态前按涉及的状态域读取本文对应章节；同一会话已读且相关约束未变化时无需重复读取（见 `AGENTS.md` 按任务强制读取表）。
- 与 `docs/agent-contracts/` 的分工：contracts 描述行为契约（怎么调用才合规），本文描述状态事实（数据在哪里、谁能改、什么不能坏）。
- 修改核心模块前，Blast Radius 分析（见 `docs/AI_REVIEW_PROJECT.md`）必须对照本文确认 Source of Truth 与 Invariants。

## 总原则

1. **DOM 是全文模型的渲染结果，不是业务数据源。** 搜索、选区、复制、AI 上下文等文档级能力一律基于文档模型（源码 offset / DocumentRange），不得依赖“块当前是否挂载”或 DOM 文本长度推测。
2. **派生状态不得升级为第二数据源。** 预览模型、搜索匹配索引、高亮、文件树等都是派生结果；派生数据丢失必须可从 Source of Truth 重建，写入派生数据不得反写 Source of Truth。
3. **Store 边界由机器校验。** `scripts/store-boundary-check.mjs`（`npm run test:store-boundaries`）强制：组件不得直接 `useXStore.setState(...)`（必须走 store action）；store 之间不得互相 import。

## 1. 文档全文模型

### Source of Truth

`src/stores/editorStore.ts` 的 `Tab` 对象（`tabs` 数组内）：`content`（当前编辑内容）、`savedContent`（已保存内容）、`originalContent`（打开时内容，用于 diff）。

### Derived State

- 预览内容：`EditorArea` 的 `useScheduledPreviewContent` 按文档 key/version 防抖调度，是 `content` 的延迟派生。
- 预览模型：`createMarkdownPreviewModel(content)` 的 `MarkdownPreviewModel`（blocks、textSegments、toc、footnotes）。
- `modified` 标志：由 `content !== savedContent` 派生并随写入维护。

### Ownership

- 只有 `editorStore` 的 actions（`updateTabContent`、`markTabSaved`、`replaceTabContentWithSaved`、`saveTabAs`、`restoreTabs`、`mergeRestoredTab` 等）可以修改 Tab 内容字段。
- 磁盘读写只能经 `useTauri.ts` 受 `FsAccessState` 约束的 Rust command（见 `docs/agent-contracts/file-access.md`）。

### Forbidden Dependencies

- 任何组件不得把 CodeMirror EditorView、DOM 或预览模型当作文档数据源回写 Tab。
- 预览内编辑必须按原始切片精确替换后写回 Tab，不得直接改预览模型再“同步回”文档。

### Invariants

- 切换 `viewMode`、开关预览、切换右 pane 不得修改任何 Tab 的 `content` / `savedContent` / `originalContent` / `modified`。
- 预览组件卸载、虚拟块卸载不得导致 Tab 数据丢失或被清空。
- 持久化层的 `compactPersistedTab` 压缩只影响写入介质的内容，不得改动内存中的 Tab 内容。
- 契约测试：`tests/editor/documentModelContract.test.ts`。

## 2. 标签页与当前文件

### Source of Truth

`editorStore`：`tabs`、`activeTabId`、`rightPaneTabId`、`rightPaneUserSelected`。

### Derived State

UI 展示顺序、标签栏渲染、预览切换掩码 `previewSwitchingTabId`。

### Ownership

只有 `editorStore` actions（`openTab` / `closeTab` / `setActiveTab` / `reorderTabs` / `restoreTabs` / `setRightPaneTabId` 等）可修改。

### Invariants

- 移除工作区记录不得关闭或清空 Tab、最近文件与收藏（契约测试：`tests/workspace/multiRootWorkspace.test.tsx`）。
- 恢复会话（bootSnapshot / sessionRestore）合并 Tab 时不得丢失未保存草稿：有草稿时保留草稿 content、仅更新 savedContent 基线；id / filePath 不匹配时安全 no-op（契约测试：`tests/editor/sessionRestoreMergeContract.test.ts`）。

## 3. 视图模式与预览可见性

### Source of Truth

`editorStore`：`viewMode`（`edit` / `preview` / `edit-preview` / `dual-preview` / `diff-preview`）、`previewVisible`、`viewModeUsage`。

### Ownership

只有 `setViewMode` / `togglePreview` / `toggleDiffPreview` 可修改；这些 action 只触碰 viewMode 相关字段。

### Invariants

- 模式切换是纯视图状态变化：不得顺手修改 Tab 内容、阅读位置或搜索状态（见第 1 节 Invariants）。
- 模式切换后旧实例释放遵守 `modePerformancePolicy`；有未提交编辑草稿时不得直接卸载（见 `docs/agent-contracts/markdown-editor.md`）。

## 4. 预览文档模型与 DOM

### Source of Truth

`src/services/markdownPreviewModel.ts` 的 `MarkdownPreviewModel`：`rawContent`（原始源码 + 全局 offset 坐标系）、`blocks`（含 `blockId`、`startOffset` / `endOffset`、`textSegments`）。由 `MarkdownPreview` 对 `displayedContent` `useMemo` 派生，一次解析全文。

### Derived State

- 挂载的可视区顶层块 DOM（虚拟化，仅渲染可见附近块 + overscan）。
- 未挂载块的高度估计占位。
- 块级 DOM Range（高亮用）。

### Forbidden Dependencies

- 业务逻辑不得从 DOM 反推源码 offset；DOM → 源码只能走渲染时注入的 `data-gm-src-from/to` 标注（`createSourceOffsetAnnotator`）。
- KaTeX / 代码高亮 / Mermaid 等无精确 position 的子树不得被标注；该区域选区/高亮降级为原生行为，不得强行推测映射。

### Invariants

- 全文模型不依赖当前 DOM 是否渲染；虚拟化卸载块后，文档级能力（搜索、选区、提取）仍基于完整模型工作。
- 桌面构建不得产出 `markdownPreview.worker-*` 独立脚本；渲染保持同步 ReactMarkdown 契约。

## 5. 搜索状态与搜索高亮

### Source of Truth

- 搜索输入状态（query、active match）：`SearchOverlay` 组件持有。
- 文档级匹配结果：`MarkdownPreview` 的 `searchMatchesByBlockRef`（按 blockId 索引的 `{from, to}` 全局源码 offset 列表），由 `setSearchStateImpl` 基于 `model.rawContent` 全文计算。

### Derived State

- DOM 高亮：`previewHighlightRegistry`（CSS Highlight API）按 `(resource, blockId)` 组织的 DOM Range；只为已挂载块构建，是搜索结果的渲染表现。

### Ownership

- 匹配计算只发生在 `setSearchStateImpl`（输入变化时一次全文扫描）。
- 高亮注册/注销只发生在 `MarkdownPreview` 的块同步逻辑与 `SearchOverlay` 卸载清理。

### Forbidden Dependencies

- 高亮 DOM Range 不得成为匹配数据源；不得通过扫描 DOM 高亮反推匹配列表。
- 匹配结果不得只覆盖已挂载块（虚拟化下不得按可见性截断匹配）。

### Invariants

- 搜索匹配基于完整 `rawContent`，与哪些块当前挂载无关。
- 虚拟块卸载只移除对应 DOM Range（`removeBlock` / `removeBlocksNotIn`），匹配索引与输入状态不丢失；块重新挂载时高亮自动恢复。
- 文档内容变化（key/version 变化）使旧 offset 全部失效：搜索索引与选区状态必须整体清除，不得复用旧 offset。
- 高亮注册表生命周期：虚拟块卸载 / 批量卸载只移除对应 DOM Range，不影响其他块与其他文档实例；重新挂载自动恢复；搜索关闭不破坏选区高亮（契约测试：`tests/services/previewHighlightRegistry.test.ts`）。
- 契约测试：`tests/editor/SearchOverlay.preview.test.tsx`（未挂载内容匹配统计）。

## 6. 文本选区（Selection）

### Source of Truth

`MarkdownPreview` 的 `selectionRangeRef`：归一化后的全局源码 offset 区间 `{from, to}`；`DocumentRange`（`startBlockId` + 块内 offset，见 `src/services/previewHighlight.ts`）为其块定位表示。

### Derived State

- 选区高亮 DOM Range（渲染表现）。
- `selectionAnchorRef`（拖选锚点，交互辅助）。

### Ownership

- 选区写入只经 `applySelection`（拖选 rAF 节流映射为源码 offset 后调用）。

### Forbidden Dependencies

- 选区状态不得存放在 DOM Selection / window.getSelection 中作为持久事实；DOM Selection 只用于获取交互位置。

### Invariants

- 选区状态存活于 ref / 文档模型坐标，DOM 卸载不丢失；重挂载后可恢复高亮。
- `getTextForSourceRange` 基于模型 `textSegments` 提取文本，与 DOM 是否挂载无关，可提取超长选区或全文。
- 契约测试：`tests/services/documentRangeContract.test.ts`、`tests/services/previewHighlight.test.ts`。

## 7. AI 上下文提取

### Source of Truth

选区上下文以本轮 selection 授权 + 源码 offset Range 为输入，经 Rust `read_selection_context` 命令基于 `semanticChunker` AST 语义原子提取（行为契约见 `docs/agent-contracts/ai-selection.md`）。

### Invariants

- AI 上下文提取不得依赖预览 DOM 是否渲染了所选内容；输入是文档路径 + 源码 Range。
- 预览选区（含无精确字符范围的降级选区）添加到 AI 上下文必须保持可用（契约测试：`tests/selection/selectionRange.test.ts`）。
- 模型 offset 坐标系与 Tab.content 一致；跨块选区进入 contextTag 全程模型驱动；超长截断只截 content、保留精确 offset（契约测试：`tests/selection/selectionContextContract.test.ts`）。

## 8. 工作区

### Source of Truth

`src/stores/appStore.ts` 的 `workspaceRoots`（持久化；`addWorkspaceRoot` / `removeWorkspaceRoot` 是唯一写入口）。

### Derived State

- `useWorkspaceFileTree` 的 `workspaceTrees`（每个 root 的目录树，异步加载）。
- 索引状态、统计信息。

### Ownership

- root 列表只有 appStore actions 可改；目录树由 hook 加载并按 root id 分桶。

### Forbidden Dependencies

- 目录树/索引结果不得反写 `workspaceRoots`。
- 其他模块不得绕过 `workspaceIdentity` 规范化直接比较路径。

### Invariants

- **移除工作区记录不得删除真实磁盘文件**：`removeWorkspaceRoot` 是纯状态过滤，不触发任何文件系统删除。
- 单个工作区加载失败只污染该 root 的树（记录 error），不得清空或破坏其他 root 状态。
- 契约测试：`tests/workspace/multiRootWorkspace.test.tsx`、`tests/workspace/workspaceIndex.test.ts`。

## 9. 阅读位置

### Source of Truth

`editorStore` 的 `readingPositions`（持久化，按 tab/document key）。

### Derived State

会话内精确滚动位置：`ReadingPositionSession`（最近模式的精确 scrollTop，跨模式只保留最近模式），启动时由 `seedReadingPositionsFromStore` 从 store 播种。

### Invariants

- 阅读位置更新（`flushReadingPositions`）只触碰 `readingPositions`，不得修改 Tab 内容。
- 左右预览 pane 的阅读位置相互独立（契约测试：`tests/editor/modeResourceLeak.test.tsx`）。

## 10. 缓存

### Source of Truth 与派生关系

| 缓存 | 位置 | 性质 | 失效条件 |
|---|---|---|---|
| 预览锚点缓存 | `EditorArea` 的 `previewAnchorCacheRef`（WeakMap） | 派生 | 文档内容 / 可见性变化后必须失效（回归测试：`tests/editor/previewTabSwitchRegression.test.tsx`） |
| 启动快照 | `src/services/bootSnapshot.ts` | 派生（首屏加速） | 大文档体丢弃、损坏/超限拒绝（契约测试：`tests/editor/bootSnapshot.test.ts`） |
| 搜索匹配索引 | `searchMatchesByBlockRef` | 派生 | 文档内容变化整体清除 |

### Invariants

- 所有缓存都是可从 Source of Truth 重建的派生数据；缓存失效不完整属于缺陷，缓存丢失不得导致数据丢失。
- 高性能模式下的实例预热 / 释放缓存遵守 `modePerformancePolicy` 语义（`memory` 策略不预热）。

## 已知风险（仅记录，未在本任务修复）

- `EditorArea.tsx` 是持有大量本地派生状态（搜索、Toc、菜单、预览调度）的巨型组件；进一步拆分是后续重构候选，任何拆分必须先对照本文 Invariants 建立契约测试。
- KaTeX / 代码高亮 / Mermaid 子树无精确源码 position，字符级选区/高亮在该区域降级；这是接受的边界，不是待修复缺陷。

## 契约测试索引

| Invariant 区域 | 测试 |
|---|---|
| 文档模型（模式切换不改内容） | `tests/editor/documentModelContract.test.ts` |
| DocumentRange（offset ↔ 块映射 / 文本提取） | `tests/services/documentRangeContract.test.ts`、`tests/services/previewHighlight.test.ts` |
| 搜索（全文模型驱动、未挂载内容） | `tests/editor/SearchOverlay.preview.test.tsx` |
| 高亮注册表（卸载恢复、实例隔离、kind 隔离） | `tests/services/previewHighlightRegistry.test.ts` |
| 选区 → AI 上下文输入边界（坐标系一致、截断保留 offset） | `tests/selection/selectionContextContract.test.ts`、`tests/selection/selectionRange.test.ts` |
| 会话恢复合并（草稿保留、冲突语义、no-op 守卫） | `tests/editor/sessionRestoreMergeContract.test.ts` |
| 工作区（移除不删文件、root 隔离） | `tests/workspace/multiRootWorkspace.test.tsx`、`tests/workspace/workspaceIndex.test.ts` |
| 阅读位置（左右 pane 独立） | `tests/editor/modeResourceLeak.test.tsx` |
| Store 边界（机器校验） | `npm run test:store-boundaries` |

### ReadingMark 不变量

- `ReadingMark` 以规范化本地 Markdown 路径为文档身份，anchor 同时保存全文 UTF-16 offset 与 `DocumentRange`；数据库是唯一持久化源，Store 维护按文档投影与兼容的全量缓存，阅读成果中心的分页结果是可丢弃的派生查询缓存，两者必须由同一写操作同步更新。
- 预览块挂载/卸载只增删 CSS Highlight 的 DOM Range，不能清除 mark；重挂载必须从完整模型与 mark 索引重建。
- anchor 无法按 DocumentRange、offset 或唯一 quote+上下文可靠恢复时保持 unresolved，不得猜测并贴附到其他文本。
