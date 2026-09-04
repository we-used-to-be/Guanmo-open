# Guanmo 长期维护与外观扩展架构治理计划

> 本文件是本任务唯一状态来源。执行者必须使用 `staged-task-handoff` Skill，完整读取后只执行当前阶段；不得一次性重构全项目，不得提前实施后续阶段。

## 当前状态

- 项目状态：代码实现已完成（壁纸配置已放弃并移除）
- 当前阶段：Phase 3｜外观扩展收口（保留主题与助手形象）
- 阶段状态：进行中；代码与自动门禁已完成，待 Tauri 设置页人工冒烟
- 上次执行结果：已删除壁纸 schema、设置入口、启动恢复、CSS 透明层、Tauri 资产命令及壁纸专用测试；保留主题系统、AI 助手形象和通用文件能力
- 已知验证：定向 Vitest `3 files / 51 passed`；`test:file-access`、`test:runtime-schemas`、Typecheck、Lint（0 errors、45 warnings）、Web/Desktop build 与 bundle gate、Rust fmt/clippy/test/check、`git diff --check` 均通过
- 其他验证：不删除用户目录中已有的 `wallpapers` 文件；所有无关修改和未跟踪文件均保留；未提交、未推送、未打 tag、未创建 Release
- 本阶段剩余：Tauri 设置页人工冒烟；冷启动脚本因测试进程以 exit code 0 提前退出，edit/preview 均未形成有效样本（NOT TESTED）
- 本阶段允许修改：本次壁纸移除涉及的外观、设置、启动、文件权限边界和定向测试文件
- 阻塞问题：当前工具通道无法执行真实 Tauri WebView 交互；不影响代码门禁
- 下一阶段：无（完成上述人工验收后收口；Phase 3A、3C 保留；Phase 3B 已放弃）
- Git 边界：保留所有既有修改和未跟踪文件；未经明确授权不提交、不推送、不打 tag、不创建 Release

## 项目目标

在保持现有功能、持久化格式、文件权限、SQLite 数据和用户体验兼容的前提下，按以下顺序渐进治理：

1. 测试兜底：让核心边界和跨模块流程具备可执行、能真正阻断回归的测试与门禁。
2. 梳理依赖：消除已确认的 Store 越界、运行时双向依赖和 UI 对数据库/Tauri 实现的穿透。
3. 拆核心边界：逐步稳定 `document-model`、`preview-rendering`、`workspace`、`persistence`、`ai`、`settings`、`appearance` 的职责和接口。
4. 建立外观扩展接口：支持内置主题、AI 助手形象及状态动画，避免继续堆叠特判。

本任务不以减少 LOC、统一文件长度或追求形式上的“整洁架构”为目标。成功标准是降低修改影响面、稳定扩展边界并保留现有行为。

## 技术栈

- 运行环境：Tauri 2、Windows、WebView2；Web 裁剪版保留基础阅读能力
- 前端：React 18、TypeScript、Vite、Zustand、CodeMirror 6
- Markdown：ReactMarkdown、remark/rehype、顶层块虚拟化、DocumentRange
- 数据：桌面 SQLite，关键事务由 Rust/SQLx command 持有
- AI：Direct/Agent 路由、RAG、长期记忆、阅读成果、流式聊天
- 测试：Vitest、React Testing Library、Rust tests、现有专项脚本与 Release 冷启动脚本

## 审查基线与已确认事实

以下结论已由当前源码、测试清单和知识图交叉核实；实现时仍须以最新代码为准：

1. 前端现有约 91 个测试文件，编辑器、AI、设置、RAG、数据库、工作区均已有专项测试；问题主要是联合边界和门禁接入，不是完全无测试。
2. `EditorArea.tsx` 同时承担编辑/预览实例生命周期、预热、滚动同步、阅读位置、TOC、搜索/选区桥接、预览内编辑、首屏事件和保存编排，是当前最大 hub/bridge。
3. `MarkdownPreview.tsx`、`AiPanel.tsx`、`SettingsPage.tsx`、`useAiChat.ts`、`agent/executor.ts`、`agent/tools.ts` 是其他高耦合热点；不得仅按文件长度机械拆分。
4. 已确认运行时双向依赖：`settingsStore.ts -> rag/indexer.ts -> settingsStore.ts`。
5. 已确认纯类型环：`services/ai/types.ts <-> services/ai/sourceReferences.ts`；优先级低于运行时环。
6. `workspaceIndex.ts` 同时协调文件系统、SQLite、WebView 向量缓存、Rust RAG 索引和重建流程；现有测试主要 mock 协作者，缺少真实联合一致性验证。
7. UI 直接依赖底层实现的代表：`AiPanel.tsx`、`SettingsPage.tsx` 导入 database persistence；`TabBar.tsx`、`FullscreenControlBar.tsx` 直接调用 Tauri `invoke`。
8. `AssistantState` 的八个状态已是可靠状态协议，应作为未来头像动画的稳定输入，不重建第二套状态机。
9. 当前主题为封闭 `ThemeId` 列表，定义和映射分散在 `settingsStore.ts`、`ThemePicker.tsx`、`index.html`、`startupShell.css` 和主题 CSS。
10. 当前质量 CI 执行 `npm test`，但没有执行独立的 `test:store-boundaries`；数据库契约还引用了 package 中不存在的 legacy migration/recovery 命令。

## 总体成功标准

- 所有新增边界先有能够稳定复现长期 invariant 的测试；不以覆盖率数字代替关键流程测试。
- `npm run test:store-boundaries` 通过并进入适用的本地/CI 主门禁；规则、文档和实际命令一致。
- 不再存在 `settingsStore <-> rag/indexer` 运行时双向依赖；Store 不直接 import 另一个 Store，组件/服务不绕过 action 直接修改 Store。
- UI 不直接依赖 SQL row、数据库连接、任意文件路径或散落的 Tauri command；通过领域 command/repository/adapter 访问。
- `EditorArea` 的拆分不改变 Tab、DocumentRange、搜索、选区、虚拟化、阅读位置、模式预热和首屏打点语义。
- Workspace/RAG 清理在部分失败、Root 不可用和快速切换下有明确、可测试的结果，不静默形成跨层不一致。
- AI 请求从上下文构建到消息/阅读成果保存有联合测试；取消、重试和失败不重复执行副作用。
- 外观配置使用版本化 Schema、稳定 ID 和受控 resolver/registry；新增内置或用户外观不要求修改多个业务组件的特判。
- 自定义主题/头像不接受任意用户 JavaScript 或未验证 CSS；资源访问遵守现有文件授权、asset protocol、CSP 和 reduced-motion 边界。
- Web 基础阅读能力、旧设置、旧数据库和旧文件授权继续兼容；不通过清空数据或重置配置解决迁移。

## 总体约束

- 每次只执行当前阶段；Phase 2 与 Phase 3 的子阶段必须按独立执行窗口推进。
- 修改前重新执行 `git status --short`，已有修改和未跟踪文件全部视为用户内容。
- 命中 Store、生命周期、缓存、异步竞态、文件、DB 或启动链时，先按 `docs/AI_REVIEW_PROJECT.md` 写简短 Blast Radius。
- 修改核心状态前读取 `docs/architecture/state-ownership.md`；涉及 Markdown、AI、文件、数据库、RAG、桌面服务时读取对应 contract。
- 先补 characterization/contract test，再移动职责；测试必须调用生产入口。
- 不新增通用 DI 框架、全局 Event Bus、Redux、插件市场、通用 Repository 基类或任意代码执行系统。
- 不为了消除所有循环依赖而大规模搬文件；优先处理运行时环和高频修改链。
- 不自动更新快照，不放宽 bundle/CSS/性能预算，不用 Skeleton 或提前打点制造性能收益。
- 未经明确授权不提交、推送、打 tag、创建 Release 或 PR。

## 不建议重构的现有设计

- `markdownPreviewModel`、DocumentRange、源码 offset 和 previewHighlight registry：现有边界合理，只在有可复现缺陷或性能证据时修改。
- Zustand 本身：问题是依赖方向与 action 边界，不是状态库选型。
- Rust `FsAccessState` 文件授权模型与 `useTauri.ts` 受限文件入口。
- Rust/SQLx 原子事务命令及 SQLite 作为桌面业务主存储的架构。
- `AssistantState` 状态机、AI 来源引用 registry、现有路由/来源契约。
- 五个现有主题的视觉实现：后续作为内置定义接入 registry，不进行视觉重做。
- 旧设置、旧主题、旧头像及性能策略的兼容迁移逻辑。
- `lib.rs`、`persistence.ts` 等大文件：没有稳定边界和行为任务时，不因行数单独拆分。

## 目标模块边界

### document-model

- 对外：`DocumentSnapshot`、`DocumentRange`、文档内容/保存/标签页 command。
- 内部：Zustand 结构、持久化 compact 格式、CodeMirror View。
- 约束：`Tab.content` 继续是会话内正文 Source of Truth；DOM 不是全文数据源。

### preview-rendering

- 对外：`PreviewModel`、viewport/anchor/selection adapter、块编辑提交事件。
- 内部：虚拟窗口、实测高度、ReactMarkdown 组件、渲染插件加载。
- 约束：搜索、选区、复制、AI 上下文不依赖块是否挂载。

### workspace / persistence

- Workspace 对外：Root、树快照、文件 command、索引维护结果。
- Persistence 对外：按现有领域拆分的 `ChatRepository`、`DocumentIndexRepository`、`ReadingArtifactRepository`。
- 候选窄接口：`WorkspaceFileGateway`、`DocumentIndexRepository`、`RagIndexGateway`。
- 内部：Database 连接、SQL row、目录枚举和 WebView/Native RAG 清理顺序。
- 约束：不创建通用 CRUD Repository，不允许 UI 直接 import database persistence。

### ai / settings

- AI 对外：`ConversationController`、`ContextProvider`、`AgentExecutor`、`ArtifactCommands`。
- Settings 对外：版本化设置 Schema、normalizer、纯 action。
- 内部：Chat Store 写入顺序、工具 registry、secret 保存、RAG timer、DOM 主题应用。
- 约束：工具依赖窄上下文；Store 不承担跨领域副作用。

### appearance

- 对外：版本化配置、descriptor registry、resolver、DOM applicator。
- 内部：CSS token 映射、受管 asset URL、启动 bootstrap 子集、renderer 实现。
- 约束：Store 只持久化稳定 ID/配置，不持久化 React 组件、任意 CSS 或任意本地路径。

## 阶段计划

### Phase 1｜测试兜底、依赖止血与门禁对齐

- 目标：在不改变产品功能的前提下，让现有边界规则真实通过并进入主门禁，补齐后续拆分必需的 characterization tests。
- 风险：MEDIUM；涉及 Store action、应用启动恢复、AI 状态写入和设置副作用，但不改变领域功能或持久化格式。
- 核心任务：
  1. 为当前 6 个 Store boundary 违规建立最小行为保护，改为已有或新增的领域 action；不得放宽脚本或加 allowlist。
  2. 消除 `editorStore -> settingsStore` 和 `settingsStore <-> rag/indexer` 运行时耦合；副作用移到明确 coordinator/reaction。
  3. 将 `test:store-boundaries` 接入 `check:release` 和质量 CI。
  4. 核对 database contract 中不存在的 legacy migration/recovery 命令：恢复真实入口或修正过时契约，不创建空壳命令。
  5. 补充后续 Phase 2 必需的组合测试，不重复已有单元测试。
- 大致范围：`scripts/store-boundary-check.mjs`、`package.json`、`.github/workflows/quality.yml`、相关架构/数据库契约、当前 6 个违规所在源码及其最少测试。
- 验收：边界门禁真实通过并接入主检查；运行时环消失；Tab 恢复、AI 流式消息、action proposal、secret hydration、perf reset 和自动索引关闭行为兼容。
- 检查：定向 Vitest、boundary gate、typecheck、lint、Desktop build、bundle gate、`git diff --check`。
- 暂不处理：拆分 `EditorArea`、AI controller、Workspace repository、Appearance Schema。

### Phase 2｜核心解耦

> Phase 2 必须按 2A → 2B → 2C 分三个独立执行窗口。一个子阶段完成并更新状态后才能进入下一个。

#### Phase 2A｜Editor / Document Surface

- 目标：让 `EditorArea` 只负责组合 Pane，把生命周期、滚动同步、阅读位置和选区桥接按现有 invariant 渐进抽离。
- 风险：HIGH；涉及 useEffect/cleanup、缓存、快速 Tab/模式切换、虚拟化和首屏性能。
- 候选范围：`src/components/editor/EditorArea.tsx`、新增同目录窄 hooks/services、现有 editor/selection/markdown 测试。
- 验收：Tab/模式切换、左右 Pane、预热、迟到结果、阅读位置、搜索、选区、TOC、首屏事件保持语义；不修改 `markdownPreviewModel` 和 DocumentRange 算法。
- 验证：EditorArea 生命周期、资源泄漏、previewTabSwitch、documentModel、selectionContext、SearchOverlay、MarkdownPreview 定向测试；typecheck、lint、desktop build、bundle gate；新鲜 Tauri 快速切换和真实 surface 验收。

#### Phase 2B｜Workspace / Persistence

- 目标：保留 `workspaceIndex` 作为 application coordinator，但让它依赖窄 gateway/repository；FileTree/UI 不接触数据库和 RAG 实现。
- 风险：HIGH；涉及用户文件、SQLite、索引删除和部分失败一致性。
- 候选范围：`workspaceIndex.ts`、相关 persistence/RAG adapter、FileTree/workspace hooks、workspace/database 测试、必要 Rust command 测试。
- 验收：Root 不可用时不清理索引；单 Root 不影响其他 Root；部分失败可见且可重试；跨 SQLite/vector/Native RAG/job 的处理顺序有联合测试。
- 验证：匿名临时目录 + 临时数据库联合测试、workspace tests、transaction bridge、file-access、rag-index、runtime-schemas、typecheck、lint、desktop build、相关 Rust tests。

#### Phase 2C｜AI / Settings

- 目标：建立 Conversation/Artifact command 边界，拆开聊天 UI、请求编排、Store mutation 与数据库持久化；Settings UI/Store 不直接承担跨领域副作用。
- 风险：HIGH；涉及流式请求、取消、重试、工具副作用、消息和阅读成果持久化。
- 候选范围：`AiPanel.tsx`、`useAiChat.ts`、`services/agent/*`、`chatStore.ts`、reading artifact services/store、`SettingsPage.tsx` 及对应测试。
- 验收：selection/file tag → context → routing/executor → streaming/cancel/error → message persistence → reading artifact 联合流程可测；失败/重试不重复副作用；UI 不直接导入 database persistence。
- 验证：AI orchestration、routing、source references、reading artifacts、action proposal、settings compatibility、AI HTTP、typecheck、lint、desktop build；真实 Tauri AI 与阅读成果人工验收。

### Phase 3｜Appearance Extension / Config

> Phase 3 保留 3A → 3C 的主题与助手形象能力；3B 壁纸方案已放弃，不再作为当前功能执行。

#### Phase 3A｜Appearance Schema、Registry 与内置主题

- 目标：建立版本化 `AppearanceConfigV1`、descriptor registry、resolver 和 DOM applicator；五个现有主题作为内置定义接入，不改变视觉。
- 风险：MEDIUM-HIGH；涉及设置持久化、启动脚本、主题 DOM 属性、CSS token 和首屏颜色。
- 推荐接口：
  - `AppearanceConfigV1 { version, themeId, assistantVisualId, motionPreference }`
  - `ThemeDefinition { id, label, colorScheme, tokens, startupCanvas }`
  - `AppearanceRegistry`：合并内置定义与通过校验的用户配置
- 约束：ThemePicker 从 descriptor 读取；`index.html` 使用可序列化 bootstrap 子集；未知/删除 ID 安全回退。
- 验证：设置迁移、ThemePicker、startupTheme、五主题 Tauri sweep、Web/Desktop build、CSS/bundle gate、冷启动颜色一致性。

#### Phase 3B｜自定义壁纸（已放弃）

- 状态：已放弃并移除实现，不再提供壁纸 schema、设置入口、启动恢复、CSS 渲染或 Tauri 资产命令。
- 兼容边界：旧持久化配置中的壁纸字段被忽略；不删除应用配置目录中可能已经存在的壁纸文件。

#### Phase 3C｜AI 助手形象与状态动画

- 目标：让头像 renderer 由稳定 ID 和 descriptor 选择，并复用现有 `AssistantState` 驱动不同形象/动画。
- 风险：MEDIUM；主要是 UI、资源与动画生命周期，不改变 AI 请求状态机。
- 推荐接口：`AssistantVisualDefinition { id, renderer, stateAssets, animationPolicy, staticFallback }`。
- 约束：不改变八状态；历史消息保持静态；后台页面暂停；支持 reduced-motion；第一版不加载用户 JS/React 组件或任意 CSS。
- 验证：八状态映射、streaming 最新消息、历史静态头像、visibility pause、reduced-motion、损坏资源回退、设置迁移、AI Panel 视觉验收。

## Phase 2B 已完成的历史子步骤

### Phase 2B｜本次执行子步骤：workspaceIndex gateway 与文件授权门禁收口

#### 目标

保留 `workspaceIndex` 的 application coordinator 职责，但将文件可读性、持久化文档/embedding job、内存向量和 Native RAG 的组合操作收拢到同目录窄 gateway；清理按单文件报告失败，保证不可用 root 不误删索引，且失败项可由后续操作重试。同时修正文件授权门禁对当前会话恢复时序的过时断言，不改变应用行为。

#### 开始前必须读取

- `AGENTS.md`
- `docs/AI_REVIEW_PROJECT.md`
- `docs/architecture/state-ownership.md`
- `docs/agent-contracts/file-access.md`
- `docs/agent-contracts/database.md`
- `docs/agent-contracts/rag-memory.md`

#### 允许修改

- `AI_IMPLEMENTATION_PLAN.md`
- `src/services/workspaceIndex.ts`
- `src/services/workspaceIndexGateway.ts`
- `tests/workspace/workspaceIndex.test.ts`
- `scripts/file-access-check.ts`

#### 实施任务

1. 新增窄 gateway，集中工作区 root 可读性、已索引路径读取、文件存在性检查、Markdown workspace index 和索引清理协作；`workspaceIndex.ts` 不再直接导入数据库/RAG/文件实现。
2. 索引清理优先使用现有 `remove_knowledge_document_by_path` Rust SQLx 事务；事务完成后只清理 WebView 内存向量，再清理 Native RAG，保留 embedding-only job 的兼容清理路径。
3. cleanup/rebuild 对单文件失败继续处理其他文件，将错误写入结果并保留失败项，确保下一次操作可以重试；不可读 root 仍完全不触碰其索引。
4. 将 `scripts/file-access-check.ts` 的 active-tab restore 断言对齐当前实现顺序，补充 gateway 组合行为的 workspace characterization tests，运行当前子步骤定向检查；未完成 Phase 2B 其他 workspace/persistence 边界，不进入 Phase 2C。

#### 验收标准

- [x] `workspaceIndex.ts` 仅依赖窄 gateway 和路径边界逻辑，Settings/FileTree 不新增数据库或 RAG 依赖。
- [x] 不可用 root 不触发索引清理；多 root 只处理可读 root。
- [x] 清理使用事务删除数据库文档及 embedding job，随后清理内存/Native RAG；不再通过 vectorStore 触发重复非事务数据库删除。
- [x] 单文件失败可见且不阻断其他文件；再次 cleanup/rebuild 可重试失败项。
- [x] workspace 定向测试、file-access、runtime-schemas、rag-index、Typecheck、Lint、Desktop build、bundle gate 与 `git diff --check` 通过；Rust `database_transactions` 定向测试 `11 passed`。

#### 检查命令

```powershell
npx vitest run tests/workspace/workspaceIndex.test.ts tests/workspace/multiRootWorkspace.test.tsx --maxWorkers=1
npm run test:file-access
npm run test:runtime-schemas
npm run test:rag-index
npm run typecheck
npm run lint
npm run build:desktop
npm run check:bundle:desktop
git diff --check
```

#### 禁止事项

- 不修改 Rust schema/迁移、文件授权模型、RAG 分块/Embedding 算法或 FileTree UI。
- 不修改 `workspaceRoots` 的 Source of Truth、Tab/最近文件/收藏，不删除真实文件。
- 不提前实施 Phase 2B 其他边界、Phase 2C 或 Phase 3。
- 不引入新依赖、通用 DI、Event Bus 或新的持久化格式。
- 不清理无关死代码，不格式化无关文件，不覆盖既有用户修改。
- 不提交、推送、打 tag、创建 Release 或 PR。

### Phase 2B｜本次执行子步骤：Workspace UI 的 RAG gateway 边界

#### 目标

让 `WorkspaceRoots` 与 `FileTree` 只调用 workspace 领域 facade，不直接导入 RAG indexer/knowledgeBase 或读取 RAG 实现；保留工作区索引、知识库状态、加入/更新知识库和错误提示的现有行为。

#### 允许修改

- `AI_IMPLEMENTATION_PLAN.md`
- `src/services/workspaceIndex.ts`
- `src/services/workspaceIndexGateway.ts`
- `src/components/file-tree/WorkspaceRoots.tsx`
- `src/components/file-tree/FileTree.tsx`
- `tests/workspace/workspaceRootsUi.test.tsx`
- `tests/workspace/workspaceBoundaryContract.test.ts`

#### 实施任务

1. 在 workspace gateway/facade 暴露工作区索引、Markdown 判断、知识库状态查询和从授权文件读取后入库的窄操作。
2. 替换 `WorkspaceRoots`/`FileTree` 的 RAG 直接导入；不改变 UI 操作顺序、提示文案、Markdown 限制或文件授权边界。
3. 添加 UI 边界契约测试和现有 WorkspaceRoots 行为回归；不触碰 `knowledgeBase`、RAG 分块、SQLite schema 或 FileTree 的其他文件操作。
4. 完成后标记 Phase 2B 完成；本窗口不进入 Phase 2C。

#### 验收标准

- [x] `WorkspaceRoots.tsx`、`FileTree.tsx` 不直接导入 `services/rag/*` 或数据库实现。
- [x] workspace 索引和知识库操作通过 workspace facade 进入，现有 UI 定向测试通过。
- [x] 文件仍通过 `useTauri` 读取，非 Markdown 文件不显示知识库操作。
- [x] 边界契约、workspace、file-access、runtime-schemas、rag-index、Typecheck、Lint、Desktop build、bundle gate 和 `git diff --check` 通过。

#### 禁止事项

- 不修改 `knowledgeBase`、RAG pipeline/indexer 算法、SQLite schema、文件授权 Rust command 或 UI 文案。
- 不把 workspace roots、Tab、最近文件或收藏迁移到新 Store。
- 不提前实施 Phase 2C 或 Phase 3。
- 不提交、推送、打 tag、创建 Release 或 PR。

## 当前阶段详细任务

### Phase 3A｜Appearance Schema、Registry 与内置主题

#### 目标

建立版本化 `AppearanceConfigV1`、内置主题 descriptor registry、兼容 resolver 和 DOM applicator；五个现有主题从 registry 提供设置选项和启动 bootstrap 元数据，保持现有视觉与深浅主题切换语义。

#### Blast Radius

直接影响：

- 新增 `src/services/appearance/appearanceSchema.ts`、`appearanceRegistry.ts`、`appearanceDom.ts`
- `src/stores/settingsStore.ts` 的外观配置迁移与主题同步
- `src/features/settings/ThemePicker.tsx` 的主题 descriptor 来源
- `index.html` 的启动主题可序列化 bootstrap 子集

间接影响：

- `App.tsx`、标题栏、全屏主题控件通过现有 Store action 读取/切换 `themeId`
- `startupShell.css` 与五个主题 CSS token 的选择器匹配

高风险点：

- 旧 `theme/lightPalette` 配置迁移、未知主题 ID 回退、持久化新字段默认值
- 启动脚本与运行时 DOM 的 `data-theme-id`、`color-scheme` 和 startup canvas 一致性

禁止影响：

- 不改变五个现有主题的视觉值、`lastLightThemeId` 行为、Web/Desktop 能力边界、文件/数据库/AI 流程

#### 开始前必须读取

- `AGENTS.md`
- `docs/AI_REVIEW_PROJECT.md`
- `docs/architecture/state-ownership.md`
- `docs/agent-contracts/ui.md`

#### 允许修改

- `AI_IMPLEMENTATION_PLAN.md`
- `src/services/appearance/appearanceSchema.ts`
- `src/services/appearance/appearanceRegistry.ts`
- `src/services/appearance/appearanceDom.ts`
- `src/stores/settingsStore.ts`
- `src/features/settings/ThemePicker.tsx`
- `index.html`
- `tests/settings/appearanceRegistry.test.ts`
- `tests/settings/settingsCompatibility.test.ts`
- `tests/settings/themePicker.test.tsx`
- `tests/settings/startupTheme.test.ts`

#### 实施任务

1. 定义 `AppearanceConfigV1 { version, themeId, assistantVisualId, motionPreference }`，并将旧配置安全解析为版本 1；未知/删除主题和非法新字段回退到安全内置值。
2. 建立五个内置 `ThemeDefinition`，集中保存 id、label、description、colorScheme、startup tokens；registry 仅合并通过校验的 descriptor，不接受任意 CSS 或组件代码。
3. 将 Store 的主题解析、默认值和 DOM 同步接到 Schema/Registry/DOM applicator；保留现有 Store action、旧字段和 `lastLightThemeId`。
4. 将 `ThemePicker` 改为读取 registry descriptor；启动脚本只内嵌可序列化的 `themeId → colorScheme/startupCanvas` 子集。
5. 补充 Schema/registry、设置迁移、ThemePicker 和启动主题定向测试；执行 Typecheck、Lint、Web/Desktop build、bundle gate、定向 Vitest 与 `git diff --check`。

#### 验收标准

- [x] `AppearanceConfigV1` 默认值、旧配置迁移、未知 ID/非法值回退均有测试并通过。
- [x] registry 提供五个内置主题；ThemePicker 不再维护第二份主题选项数组。
- [x] DOM applicator 与启动 bootstrap 对五个主题使用一致的 `colorScheme`/canvas；运行时切换仍立即更新 DOM。
- [x] 现有设置、启动主题和主题选择行为测试通过；Web/Desktop build 与 bundle gate 通过。
- [x] fresh Tauri Release 隔离 WebView2 五主题启动 sweep 通过，未触碰正式用户库。
- [x] 未提交、未推送、未打 tag、未创建 Release。

#### 检查命令

```powershell
npx vitest run tests/settings/appearanceRegistry.test.ts tests/settings/settingsCompatibility.test.ts tests/settings/themePicker.test.tsx tests/settings/startupTheme.test.ts --maxWorkers=1
npm run typecheck
npm run lint
npm run build
npm run build:desktop
npm run check:bundle:web
npm run check:bundle:desktop
git diff --check
```

#### 禁止事项

- 不修改五个主题的 CSS token 数值、视觉设计或启动窗口策略。
- 不实施已放弃的 Phase 3B 壁纸；不提前实施 Phase 3C 头像 renderer/动画或用户脚本/组件加载。
- 不修改 SQLite schema、Tauri command、文件授权、AI/RAG、文档模型或无关 Store。
- 不引入新依赖，不清空/重建用户配置，不覆盖既有工作区修改。
- 不提交、推送、打 tag、创建 Release 或 PR。

### Phase 3B｜自定义壁纸（已放弃）

- 状态：已放弃并移除实现，不再提供壁纸 schema、设置入口、启动恢复、CSS 渲染或 Tauri 资产命令。
- 兼容边界：旧持久化配置中的壁纸字段被忽略；不删除应用配置目录中可能已经存在的壁纸文件。
- 验证：本次移除后的主题、设置兼容、文件边界、TypeScript、构建和 Rust 检查结果以当前状态记录为准。

### Phase 3C｜AI 助手形象与状态动画

#### 目标

在保留既有 AiSprite 视觉、八状态派生和历史消息静态行为的前提下，建立安全的助手 visual descriptor/resolver；AI Panel 与设置预览只通过稳定 `assistantVisualId` 选择内置 renderer，不加载用户 JS/React 组件或任意 CSS。

#### Blast Radius

直接影响：

- `src/services/appearance/appearanceSchema.ts` 的助手 ID 校验与兼容回退
- 新增 `src/services/appearance/assistantRegistry.ts`、`src/components/ai/AssistantVisual.tsx`
- `src/components/ai/AiPanel.tsx`、`src/features/settings/SettingsPage.tsx` 的 renderer 选择入口
- 助手 descriptor、renderer 选择、历史静态头像、visibility pause、reduced-motion 定向测试

间接影响：

- `useAssistantState` → `assistantState` → `chatStore` 的只读状态订阅
- `settingsStore.appearance.assistantVisualId` 的持久化迁移

高风险点：

- 不改变 `AssistantState` 八状态、AI 请求编排、Store 写入和 SQLite 持久化
- 保留 renderer 的 `visibilitychange` cleanup、CSS `prefers-reduced-motion` 和历史消息 `animated=false`

#### 允许修改

- `AI_IMPLEMENTATION_PLAN.md`
- `src/services/appearance/appearanceSchema.ts`
- `src/services/appearance/assistantRegistry.ts`
- `src/components/ai/AssistantVisual.tsx`
- `src/components/ai/AiPanel.tsx`
- `src/features/settings/SettingsPage.tsx`
- `tests/agent/aiSprite.test.tsx`
- `tests/agent/assistantVisual.test.tsx`
- `tests/settings/assistantRegistry.test.ts`

#### 实施任务

1. 将助手 visual ID、八状态 asset descriptor、动画策略和静态 fallback 收拢到内置 registry；未知/损坏 ID 安全回退到 sprite。
2. 新增受控 `AssistantVisual` 适配器，使用固定 renderer map；AI Panel 的空态、最新流式消息和历史消息通过稳定 ID 进入，历史消息继续静态展示。
3. 设置预览复用 resolver/adapter；不增加用户脚本、React 组件、任意 CSS 或新的状态机。
4. 补充 descriptor/fallback、八状态映射和 renderer 接入测试；执行 Typecheck、Lint、Web/Desktop build、bundle gate 和 `git diff --check`。

#### 验收标准

- [x] 八个 `AssistantState` 均有 descriptor 映射，未知 visual ID/renderer 安全回退为 sprite。
- [x] AI Panel 最新流式消息跟随真实助手状态；历史消息不播放动画；空态和设置预览沿用既有渲染路径。
- [x] 页面隐藏暂停动画并在 cleanup 后不残留监听；系统 reduced-motion 继续禁用动画。
- [x] 旧设置、版本化 `assistantVisualId` 和非法值迁移兼容；不改变 AI 请求状态机。
- [x] 相关定向测试、Typecheck、Lint、Web/Desktop build、bundle gate 和 `git diff --check` 通过。
- [x] 新鲜 Tauri/WebView2 中完成 AI Panel 空态、流式、历史静态头像和设置预览视觉验收。
- [x] 未提交、未推送、未打 tag、未创建 Release。

#### 检查命令

```powershell
npx vitest run tests/agent/aiSprite.test.tsx tests/agent/assistantVisual.test.tsx tests/settings/assistantRegistry.test.ts tests/settings/appearanceRegistry.test.ts tests/settings/settingsCompatibility.test.ts --maxWorkers=1
npm run typecheck
npm run lint
npm run build
npm run build:desktop
npm run check:bundle:web
npm run check:bundle:desktop
git diff --check
```

#### 禁止事项

- 不改变 `AssistantState` 八状态、AI 请求/流式/持久化逻辑或现有 AiSprite 视觉 token/keyframes。
- 不加载用户 JS、React 组件、任意 CSS、远程头像或未验证资源，不新增依赖。
- 不修改 SQLite、文件授权、主题视觉或无关 Store，不覆盖既有工作区修改。
- 不提交、推送、打 tag、创建 Release 或 PR。

## Phase 2C 已完成的历史子步骤

### Phase 2C｜本次执行子步骤：Conversation persistence command

#### 目标

将会话 SQLite 写入、历史读取和删除从聊天 UI/Store 的直接实现依赖中收拢到窄 command；保留聊天 Store 的内存状态所有权和现有数据库协议，为后续 Artifact 与请求编排边界建立接缝。

#### Blast Radius

直接影响：

- `src/components/ai/AiPanel.tsx` 的历史会话删除入口
- `src/stores/chatStore.ts` 的会话保存与历史加载
- 新增 `src/services/agent/conversationCommands.ts` 作为持久化命令边界

间接依赖：

- `src/services/database/persistence.ts` 的会话写入、历史读取和删除函数
- 聊天历史与 AI 面板定向测试

高风险点：

- Store 状态更新与异步 SQLite 写入的顺序；`chat_messages.parent_id` 和 metadata 编码不能改变
- 历史加载的分页 offset、去重和 `buildLinkedQaRows` 关联不能改变

禁止影响：

- 流式请求、取消、路由、Agent 工具副作用、阅读成果数据格式、Settings 配置和 Web/Desktop 能力边界

#### 开始前必须读取

- `AGENTS.md`
- `docs/AI_REVIEW_PROJECT.md`
- `docs/architecture/state-ownership.md`
- `docs/agent-contracts/ai-selection.md`
- `docs/agent-contracts/external-http.md`
- `docs/agent-contracts/database.md`
- `docs/agent-contracts/rag-memory.md`

#### 允许修改

- `AI_IMPLEMENTATION_PLAN.md`
- `src/services/agent/conversationCommands.ts`
- `src/components/ai/AiPanel.tsx`
- `src/stores/chatStore.ts`
- `tests/agent/conversationCommands.test.ts`
- `tests/agent/conversationBoundaryContract.test.ts`

#### 实施任务

1. 已完成实际调用链梳理：`AiPanel` 删除历史会话、`chatStore` 保存/加载历史，均直接触达 database persistence；Store 继续作为内存消息 Source of Truth。
2. 通过 `conversationCommands` 收拢会话写入顺序、历史分页读取和删除；不改变 `parentId`、metadata、offset、去重或 `buildLinkedQaRows`。
3. 添加 command 行为测试和 UI/Store 依赖边界契约测试；不触碰流式请求、Agent 工具、Artifact 数据格式或 Settings。
4. 完成当前窄边界定向测试、Typecheck、Lint 和 diff 检查；Phase 2C 继续保持进行中，Artifact command 已在相邻子步骤完成。

#### 验收标准

- [x] 已记录会话删除、保存和历史加载的入口、Source of Truth、持久化和副作用边界。
- [x] command 行为测试证明现有会话写入顺序、历史分页参数和删除参数保持兼容。
- [x] `AiPanel.tsx` 与 `chatStore.ts` 不再直接导入 database persistence；流式请求、Agent 工具和 Artifact 未被本子步骤修改。
- [x] 当前窄边界定向 Vitest `22 passed`、Typecheck、Lint（0 errors、45 warnings）和 `git diff --check` 通过。

#### 禁止事项

- 不修改 provider/HTTP 代理边界、数据库 schema/迁移、RAG 算法或选择区模型。
- 不把聊天、阅读成果或 Settings 状态迁移到新的全局 Store，不引入新依赖或通用事件总线。
- 不提前实施 Phase 3，不扩大到与首个窄边界无关的 AI 文件。
- 不提交、推送、打 tag、创建 Release 或 PR。

### Phase 2C｜本次执行子步骤：Artifact persistence command

#### 目标

让 `readingArtifactsStore` 只维护列表、筛选、分页和锚点 UI 状态；阅读成果数据库写入、读取、删除、来源哈希和锚点校验统一经 `artifactCommands`，不改变结构化内容、完整来源快照和过期请求保护。

#### 允许修改

- `AI_IMPLEMENTATION_PLAN.md`
- `src/services/agent/artifactCommands.ts`
- `src/stores/readingArtifactsStore.ts`
- `tests/agent/readingArtifactsStore.test.ts`
- `tests/agent/readingArtifactsPagination.test.ts`
- `tests/agent/artifactBoundaryContract.test.ts`

#### 实施任务

1. 将 reading artifact repository 的读写/删除/来源校验收拢到 `artifactCommands`；纯元数据合并和来源快照构建通过同一窄入口复用。
2. 保留第一个本地来源锚点、完整 Web/本地 references、content hash、服务端分页和 request sequence 保护。
3. 添加 Store 到 command 的边界契约，并运行现有成果保存、分页、来源和 AI 面板回归；不修改数据库 schema、结构化字段格式或原文文件。
4. 完成后保留 Phase 2C 进行中，下一子步骤处理请求编排和 Settings，不进入 Phase 3。

#### 验收标准

- [x] `readingArtifactsStore.ts` 不直接导入 database persistence/readingArtifacts，持久化动作全部通过 `artifactCommands`。
- [x] 来源快照、锚点哈希校验、保存后回读、服务端分页和过期响应保护回归通过。
- [x] Artifact 边界、Conversation、AI 面板和 Action Proposal 定向 Vitest 共 `51 passed`。
- [x] Typecheck、Lint（0 errors、45 warnings）、Desktop build、bundle gate 和 `git diff --check` 通过。

#### 禁止事项

- 不修改 `reading_artifacts` schema/迁移、SQLite 事务、Markdown 原文或来源定位算法。
- 不把 Artifact 列表状态迁移到新的全局 Store，不引入新依赖、DI 或 Event Bus。
- 不提前实施请求流式状态机、Settings 记忆副作用或 Phase 3。
- 不提交、推送、打 tag、创建 Release 或 PR。

### Phase 2C｜本次执行子步骤：Settings persistence command

#### 目标

让 `SettingsPage` 只负责设置界面、确认提示和本地 Store 重置；会话清理、记忆分页、记忆状态变更和记忆写入统一经 `settingsCommands`，不改变 SQLite 参数、状态值或现有兼容行为。

#### Blast Radius

直接影响：`src/features/settings/SettingsPage.tsx`、新增 `src/services/settings/settingsCommands.ts`、Settings 记忆分页测试。

间接影响：数据库 persistence 的记忆查询与写入函数，以及清空会话后的 `chatStore.resetHistoryState` 顺序。

风险：分页 offset、项目 scope 参数、候选记忆确认结果和清空会话后的本地状态必须保持原顺序；测试 mock 需要继续覆盖 repository 代理。

#### 验收结果

- [x] `SettingsPage` 不再直接导入 `@/services/database/persistence`。
- [x] `settingsCommands` 收拢会话清理、记忆分页/计数、删除、锁定、归档、确认、忽略和手动写入。
- [x] 保留现有 `Memory` 类型、分页参数、scope 参数和 SQLite mock 兼容性。
- [x] Settings 定向测试 `45 passed`；AI/Settings 联合基线 `279 passed`；Typecheck、Lint、Desktop build、bundle gate、`git diff --check` 通过。

#### 禁止事项

- 不修改 SQLite schema/迁移、记忆查询语义、Settings 文案或全局 Store 所有权。
- 不提前实施 Stream command 或 Phase 3。
- 不提交、推送、打 tag、创建 Release 或 PR。

### Phase 2C｜本次执行子步骤：Context / Route request preparation

#### 目标

从 `useAiChat` 抽离请求上下文构建和统一路由准备；保持 ContextTag 文件读取、用户消息结构、路由选项和调用顺序不变，不在本子步骤改动 Agent 执行、Memory 检索、RAG 或流式输出。

#### Blast Radius

直接影响：`src/hooks/useAiChat.ts`、新增 `src/services/agent/conversationRequest.ts`、Context/Route 边界与编排测试。

间接影响：`contextBuilder`、`aiChatMessages`、`routingService`、`requestBuilder` 的类型和现有路由矩阵测试。

风险：ContextTag 读取失败回退、完整文档上下文字符上限、最新编辑上下文、forceAgent/manualCapabilities、agentTaskContext 和消息历史必须原样传入；不得提前触发异步副作用。

#### 允许范围

- 新增纯请求准备函数及定向测试。
- `useAiChat` 仅改为调用该边界，保留取消、Store mutation、Memory/RAG/Agent/Stream 生命周期。

#### 验收标准

- [x] Context preparation 保留标签去重/读取/截断和 user message metadata。
- [x] Route preparation 保留 app context、route options 和 RoutingDecision。
- [x] `useAiChat` 不再直接依赖 ContextBuilder/Route service。
- [x] Context/Route 新增定向测试 `5 passed`；相关编排测试 `188 passed`；Typecheck、Lint、Desktop build、bundle gate、`git diff --check` 通过。

#### Stream boundary 结论

- [x] `streamFinalAnswer` 已由 `src/services/aiChatFlow.ts` 作为现有请求边界提供流式/非流式输出、取消检查和 context overflow 单次降级重试。
- [x] `tests/agent/aiChatFlowContext.test.ts` 已覆盖 context overflow retry、重试失败和取消路径；本子步骤不新增无行为的代理层。

#### 禁止事项

- 不改 `streamFinalAnswer`、`runAgent`、Memory/RAG 查询、provider/HTTP 代理或数据库协议。
- 不修改路由规则、阈值、ContextTag 数据格式或用户可见文案。
- 不提交、推送、打 tag、创建 Release 或 PR。

### Phase 2C｜本次执行子步骤：真实 Tauri AI / 阅读成果验收

#### 目标

在当前源码 Release 构建的真实 Windows WebView2 中，验证 AI 流式 Agent、阅读成果行动提案确认、SQLite 持久化与阅读成果面板回读；验收数据必须与正式用户库隔离，并在结束后清理。

#### 验收标准

- [x] 使用当前源码 `npm exec tauri build -- --no-bundle` 产物，并通过临时 identifier `com.guanmo.app.codex.phase2c` 建立独立 Release 产物；未修改跟踪配置。
- [x] 真实 WebView2 通过受限 Rust 外部 HTTP 代理访问本地 11434 mock OpenAI-compatible SSE；对话请求和后续 Agent 请求均记录为 `stream: true`。
- [x] “把这份回答保存为阅读成果”真实生成行动提案；点击“确认执行”后显示“已完成”，阅读成果面板可回读临时 identifier DB 中的标题和正文。
- [x] 后续“现在几点？”真实显示 mock 流式回答“独立 DB 流式通过”，证明 Agent 流式输出链路继续工作。
- [x] 只读 SQLite 查询确认临时 DB 的验收标题记录为 `1`、active 成果为 `1`；临时 identifier 的 Roaming/LocalAppData 目录和临时 Release target 已清理。
- [x] 正式 `com.guanmo.app` DB 只读复核：验收标题记录为 `0`、active 成果数为 `4`；观墨进程和 11434 mock 端口均无残留。

#### 数据安全记录

- 首轮使用 `APPDATA`/`LOCALAPPDATA` 环境变量的探测发现 Windows Tauri Rust `app_config_dir()` 未被可靠重定向；首轮测试标题已通过真实应用删除入口清理，并只读复核正式库为 `0`。
- 后续改用 Tauri `--config` 临时 identifier 完成隔离验收；该临时 identifier 和编译 target 均已删除，不改变正式用户库。

#### 禁止事项

- 不把本地 mock 结果表述为真实第三方模型质量验收；不扩大为全量 E2E 或 Release gate。
- 不修改 AI provider、SQLite schema、Tauri 数据目录策略或用户数据迁移逻辑。
- 不提交、推送、打 tag、创建 Release 或 PR。

## Phase 2A 已完成的历史子步骤

### Phase 2A｜本次执行子步骤：预览调度生命周期窄抽离

#### 目标

在不改变预览内容时序、文档切换、资源预热和首屏语义的前提下，先把 `EditorArea` 内独立的预览防抖调度边界移出，为后续生命周期拆分建立可验证接缝。

#### 开始前必须读取

- `AGENTS.md`
- `docs/AI_REVIEW_PROJECT.md`
- `docs/architecture/state-ownership.md`
- `docs/agent-contracts/markdown-editor.md`

#### 允许修改

- `AI_IMPLEMENTATION_PLAN.md`
- `src/components/editor/EditorArea.tsx`
- `src/components/editor/useScheduledPreviewContent.ts`
- `tests/editor/previewTabSwitchRegression.test.tsx`

#### 实施任务

1. 通过 `EditorArea` 生产入口补充文档切换与旧调度竞态的 characterization test。
2. 将 `useScheduledPreviewContent` 及其尺寸感知延迟常量移到同目录窄 hook，保持文档切换/重新启用立即显示、同文档内容防抖、禁用清空和 timer cleanup 语义不变。
3. 不在本子步骤移动资源预热、实例 TTL、滚动同步、阅读位置、选区、TOC 或 DocumentRange 逻辑。
4. 运行本子步骤定向检查，并按真实结果更新状态；Phase 2A 保持进行中，不进入 Phase 2B。

#### 验收标准

- [x] 文档切换后旧文档的迟到预览更新不会覆盖新文档。
- [x] 预览调度 hook 与 `EditorArea` 解耦，生产调用点保持两个 pane 的原有参数。
- [x] 不改变 `Tab.content`、DocumentRange、资源预热、滚动同步、阅读位置或选区所有权。
- [x] 定向 Vitest、Typecheck、Lint、Desktop Build、bundle gate 和 `git diff --check` 通过。
- [x] Phase 2A 其余生命周期边界和新鲜 Tauri/真实 surface 验收已在后续子步骤及阶段收口中完成。

#### 检查命令

```powershell
npx vitest run tests/editor/EditorArea.resourceLifecycle.test.tsx tests/editor/modeResourceLeak.test.tsx tests/editor/previewTabSwitchRegression.test.tsx tests/editor/documentModelContract.test.ts tests/selection/selectionContextContract.test.ts tests/editor/SearchOverlay.preview.test.tsx tests/markdown/MarkdownPreview.layout.test.tsx tests/markdown/MarkdownPreview.interactiveState.test.tsx --maxWorkers=1
npm run typecheck
npm run lint
npm run build:desktop
npm run check:bundle:desktop
git diff --check
```

#### 禁止事项

- 不提前实施 Phase 2B/2C 或 Phase 3。
- 不移动 `markdownPreviewModel`、DocumentRange、资源预热参数或 Tauri/SQLite 边界。
- 不引入新依赖、状态库、DI、Event Bus、通用 Repository 或任意代码执行系统。
- 不清理无关死代码，不格式化无关文件，不覆盖既有用户修改。
- 不提交、推送、打 tag、创建 Release 或 PR。

### Phase 2A｜本次执行子步骤：资源生命周期与预热窄抽离

#### 目标

在不改变现有 `memory` / `balanced` / `speed` 资源策略、预热参数、文档切换和首屏门槛的前提下，把 `EditorArea` 的资源 mount/TTL/预热调度及其 cleanup 收拢到同目录窄 hook，保留 `EditorArea` 对左右 Pane 的组合职责。

#### 允许修改

- `AI_IMPLEMENTATION_PLAN.md`
- `src/components/editor/EditorArea.tsx`
- `src/components/editor/useEditorResourceLifecycle.ts`
- `tests/editor/EditorArea.resourceLifecycle.test.tsx`

#### 实施任务

1. 通过 `EditorArea` 生产入口补充卸载前存在 pending prewarm 时不创建隐藏资源、且定时器/idle callback 清理的 characterization test。
2. 将资源挂载状态、TTL 释放、策略切换、首屏后预热调度、预热资源创建和对应 cleanup 抽为窄 hook；继续复用 `editorSession` 的既有决策函数和参数。
3. 保留 `EditorArea` 的现有资源 ref/Pane 组合契约；不移动滚动同步、阅读位置、选区桥接、TOC、预览模型或 DocumentRange。
4. 运行当前子步骤定向检查并据实更新交接状态；Phase 2A 继续保持进行中，不进入 Phase 2B。

#### 验收标准

- [x] `EditorArea` 生产入口下，卸载或快速切换不会让旧 TTL/idle prewarm 创建或释放错误文档资源。
- [x] `memory` 不预热且隐藏资源立即释放；`balanced` / `speed` 保持现有预热与 TTL 行为。
- [x] 资源生命周期/预热 hook 与 `EditorArea` 解耦；两个 Pane、编辑器和差异视图的实际 mount/unmount 语义不变。
- [x] 相关定向 Vitest、Typecheck、Lint、Desktop Build、bundle gate 和 `git diff --check` 通过。
- [x] Phase 2A 其余滚动同步、阅读位置、选区桥接和新鲜 Tauri/真实 surface 验收已在后续子步骤及阶段收口中完成。

#### 检查命令

```powershell
npx vitest run tests/editor/EditorArea.resourceLifecycle.test.tsx tests/editor/modeResourceLeak.test.tsx tests/editor/previewTabSwitchRegression.test.tsx tests/editor/documentModelContract.test.ts tests/selection/selectionContextContract.test.ts tests/editor/SearchOverlay.preview.test.tsx tests/markdown/MarkdownPreview.layout.test.tsx tests/markdown/MarkdownPreview.interactiveState.test.tsx --maxWorkers=1
npm run typecheck
npm run lint
npm run build:desktop
npm run check:bundle:desktop
git diff --check
```

#### 禁止事项

- 不重复预览调度 hook 抽离，不修改 `useScheduledPreviewContent.ts`。
- 不修改 `markdownPreviewModel`、DocumentRange、持久化格式、Store 所有权、Tauri/SQLite 边界或预热策略参数。
- 不提前实施滚动同步、阅读位置、选区桥接或 Phase 2B/2C。
- 不引入新依赖、状态库、DI、Event Bus、通用 Repository 或任意代码执行系统。
- 不清理无关死代码，不格式化无关文件，不覆盖既有用户修改。
- 不提交、推送、打 tag、创建 Release 或 PR。

### Phase 2A｜本次执行子步骤：阅读位置与编辑器滚动监听窄抽离

#### 目标

在不改变编辑器↔预览滚动同步、阅读位置持久化、模式/文档切换恢复和目录当前项语义的前提下，把阅读位置会话及编辑器滚动监听的生命周期收拢到同目录窄 hook；保留 `EditorArea` 对 Pane、同步 follower 与选区桥接的组合职责。

#### 允许修改

- `AI_IMPLEMENTATION_PLAN.md`
- `src/components/editor/EditorArea.tsx`
- `src/components/editor/useReadingPositionBridge.ts`
- `tests/editor/previewTabSwitchRegression.test.tsx`

#### 实施任务

1. 通过 `EditorArea` 生产入口补充 Tab 切换时旧文档阅读位置立即 flush 的 characterization test。
2. 将 `ReadingPositionSession` 播种、编辑器滚动监听、位置保存/恢复、debounce flush、可见性 flush 及其 rAF/timer cleanup 抽为窄 hook。
3. 保留双向滚动 follower、`ScrollSyncSession` 所有权、预览模型、DocumentRange 和选区桥接的既有实现与参数。
4. 运行当前子步骤定向检查并据实更新交接状态；Phase 2A 继续保持进行中，不进入 Phase 2B。

#### 验收标准

- [x] Tab 切换时旧文档编辑器阅读位置立即写回，防抖 flush 与 beforeunload/visibility flush 语义保持不变。
- [x] 编辑器/预览位置恢复、左右 Pane 独立位置和目录滚动更新保持现有行为。
- [x] 阅读位置 hook 与 `EditorArea` 解耦；双向滚动 follower、预览模型、DocumentRange、选区所有权未移动。
- [x] 相关定向 Vitest、Typecheck、Lint、Desktop Build、bundle gate 和 `git diff --check` 通过。
- [x] Phase 2A 选区桥接和新鲜 Tauri/真实 surface 验收已完成。

#### 检查命令

```powershell
npx vitest run tests/editor/EditorArea.resourceLifecycle.test.tsx tests/editor/modeResourceLeak.test.tsx tests/editor/previewTabSwitchRegression.test.tsx tests/editor/documentModelContract.test.ts tests/selection/selectionContextContract.test.ts tests/editor/SearchOverlay.preview.test.tsx tests/markdown/MarkdownPreview.layout.test.tsx tests/markdown/MarkdownPreview.interactiveState.test.tsx --maxWorkers=1
npm run typecheck
npm run lint
npm run build:desktop
npm run check:bundle:desktop
git diff --check
```

#### 禁止事项

- 不重复预览调度或资源生命周期 hook 抽离，不修改 `useScheduledPreviewContent.ts`、`useEditorResourceLifecycle.ts`。
- 不移动双向滚动 follower、预览模型、DocumentRange、选区桥接、持久化格式、Store 所有权或 Tauri/SQLite 边界。
- 不提前实施 Phase 2B/2C 或 Phase 3。
- 不引入新依赖、状态库、DI、Event Bus、通用 Repository 或任意代码执行系统。
- 不清理无关死代码，不格式化无关文件，不覆盖既有用户修改。
- 不提交、推送、打 tag、创建 Release 或 PR。

### Phase 2A｜本次执行子步骤：预览选区桥接窄抽离

#### 目标

在不改变原生 DOM 选区、MarkdownPreview 精确句柄、DocumentRange/source offset、复制/全选和 AI 上下文语义的前提下，把预览右键菜单及选区动作桥接收拢到同目录窄 hook；保留 `EditorArea` 对 Pane 与其他编辑器组合逻辑的所有权。

#### 允许修改

- `AI_IMPLEMENTATION_PLAN.md`
- `src/components/editor/EditorArea.tsx`
- `src/components/editor/usePreviewSelectionBridge.ts`
- `tests/editor/previewTabSwitchRegression.test.tsx`

#### 实施任务

1. 通过 `EditorArea` 生产入口补充原生预览选区进入 AI 上下文的 characterization test。
2. 将预览菜单状态、原生/MarkdownPreview 选区读取、CSS 高亮清理、复制/全选、DocumentRange/source offset 回退、AI 上下文和快捷动作抽为窄 hook。
3. 保留 MarkdownPreview handle 快照、选区标题和 `referencedSourceIds`/source offsets 传递语义；不修改 `markdownPreviewModel`、DocumentRange 算法或 selection service。
4. 运行当前子步骤定向检查，并把 Phase 2A 的最终剩余项收敛到新鲜 Tauri/真实 surface 验收。

#### 验收标准

- [x] 原生预览选区可经生产右键菜单添加到 AI 上下文，选中文本和标题保持传递。
- [x] 选区桥接 hook 与 `EditorArea` 解耦；MarkdownPreview 精确句柄优先，DOM/source offset 为原有回退路径。
- [x] 复制、全选、快捷 AI 动作、CSS 高亮 cleanup 和菜单关闭语义保持不变。
- [x] 相关定向 Vitest、Typecheck、Lint、Desktop Build、bundle gate 和 `git diff --check` 通过。
- [x] 新鲜 Tauri 快速切换与真实 surface 验收完成；正常 identifier 受既有 `D:\观墨\guanmo.exe` 单实例进程占用，未结束用户进程，改用临时 identifier 的当前源码 Release 产物在隔离数据目录完成验收。

#### 检查命令

```powershell
npx vitest run tests/editor/EditorArea.resourceLifecycle.test.tsx tests/editor/modeResourceLeak.test.tsx tests/editor/previewTabSwitchRegression.test.tsx tests/editor/documentModelContract.test.ts tests/selection/selectionContextContract.test.ts tests/editor/SearchOverlay.preview.test.tsx tests/markdown/MarkdownPreview.layout.test.tsx tests/markdown/MarkdownPreview.interactiveState.test.tsx --maxWorkers=1
npm run typecheck
npm run lint
npm run build:desktop
npm run check:bundle:desktop
git diff --check
```

#### 禁止事项

- 不重复预览调度、资源生命周期或阅读位置 hook 抽离，不修改对应既有窄 hook。
- 不修改 `markdownPreviewModel`、DocumentRange、持久化格式、Store 所有权或 Tauri/SQLite 边界。
- 不提前实施 Phase 2B/2C 或 Phase 3。
- 不引入新依赖、状态库、DI、Event Bus、通用 Repository 或任意代码执行系统。
- 不清理无关死代码，不格式化无关文件，不覆盖既有用户修改。
- 不提交、推送、打 tag、创建 Release 或 PR。

## 阶段历史

### Phase 1｜测试兜底、依赖止血与门禁对齐

- 状态：已完成
- 完成内容：为产品引导恢复、AI 行动提案、密钥 hydration、性能采样和自动索引关闭补充行为保护；将 5 处直接 Store.setState 改为领域 action，移除 editorStore 与 settingsStore 的 Store 间导入，并将自动索引 timer 取消移到 indexer 的单向 settings reaction；Store boundary 接入 Release 本地 gate 与质量 CI；修正文档中的不存在 legacy DB 脚本。为完成边界迁移，额外修改 `src/stores/chatStore.ts` 和 `src/App.tsx`，原因已记录在允许修改范围。
- 验证结果：`npm run test:store-boundaries`；定向 Vitest `63 passed`；`npm run typecheck`；`npm run lint`（0 errors、43 warnings）；`npm run build:desktop`；`npm run check:bundle:desktop`；数据库迁移/事务 Vitest `8 passed`；`npm run test:runtime-schemas`；`npm run test:session-restore`；`npm run test:rag-index`；`git diff --check` 均通过。
- 遗留问题：无；未提交、未推送、未打 tag、未创建 Release。Phase 2A 尚未实施。

### Phase 2A｜Editor / Document Surface（首个窄边界）

- 状态：进行中
- 完成内容：补充 `EditorArea` 生产入口的文档切换/旧预览调度竞态保护；抽出 `useScheduledPreviewContent`；再抽出 `useEditorResourceLifecycle`，收拢资源 mount/TTL/策略切换/预热调度及 cleanup；新增卸载前 pending prewarm characterization test。实际修改：`AI_IMPLEMENTATION_PLAN.md`、`src/components/editor/EditorArea.tsx`、`src/components/editor/useEditorResourceLifecycle.ts`、`tests/editor/EditorArea.resourceLifecycle.test.tsx`（前一子步骤另含 `useScheduledPreviewContent.ts`、`previewTabSwitchRegression.test.tsx`）。
- 验证结果：八文件定向 Vitest `76 passed、2 skipped`；`npm run typecheck`；`npm run lint`（0 errors、43 warnings）；`npm run build:desktop`；`npm run check:bundle:desktop`；`git diff --check` 均通过。单文件生命周期测试最终 `43 passed`，默认 5 秒首次运行曾因冷转换超时并产生 30 个连带失败，未作为最终验收结果。
- 遗留问题：Phase 2A 的滚动同步、阅读位置、选区桥接和新鲜 Tauri/真实 surface 验收尚未完成；未提交、未推送、未打 tag、未创建 Release。

### Phase 2A｜Editor / Document Surface（阅读位置窄边界）

- 状态：进行中
- 完成内容：补充 Tab 切换时旧文档阅读位置立即 flush 的生产入口 characterization test；抽出 `useReadingPositionBridge`，收拢阅读位置会话播种、编辑器滚动监听、预览/编辑器位置恢复、debounce/可见性 flush 与 rAF/timer cleanup；保留双向滚动 follower、预览模型、DocumentRange 和选区桥接。实际修改：`AI_IMPLEMENTATION_PLAN.md`、`src/components/editor/EditorArea.tsx`、`src/components/editor/useReadingPositionBridge.ts`、`tests/editor/previewTabSwitchRegression.test.tsx`。
- 验证结果：八文件定向 Vitest `77 passed、2 skipped`；`npm run typecheck`；`npm run lint`（0 errors、45 warnings）；`npm run build:desktop`；`npm run check:bundle:desktop`；`git diff --check` 均通过。
- 遗留问题：Phase 2A 选区桥接和新鲜 Tauri/真实 surface 验收尚未完成；未提交、未推送、未打 tag、未创建 Release。

### Phase 2A｜Editor / Document Surface（选区桥接窄边界）

- 状态：已完成
- 完成内容：补充原生预览选区经生产右键菜单添加到 AI 上下文的 characterization test；抽出 `usePreviewSelectionBridge`，收拢菜单状态、原生/MarkdownPreview 选区读取、CSS 高亮清理、复制/全选、DocumentRange/source offset 回退、AI 上下文和快捷动作；保留 `EditorArea` 的 Pane 组合、MarkdownPreview 精确句柄优先和既有回退语义。实际修改：`AI_IMPLEMENTATION_PLAN.md`、`src/components/editor/EditorArea.tsx`、`src/components/editor/usePreviewSelectionBridge.ts`、`tests/editor/previewTabSwitchRegression.test.tsx`。
- 验证结果：八文件定向 Vitest `78 passed、2 skipped`；`npm run typecheck`；`npm run lint`（0 errors、45 warnings）；`npm run build:desktop`；`npm run check:bundle:desktop`；`git diff --check` 均通过。
- 遗留问题：无；未提交、未推送、未打 tag、未创建 Release。

### Phase 2A｜Editor / Document Surface（阶段收口）

- 状态：已完成
- 完成内容：按预览调度、资源生命周期、阅读位置和选区桥接四个窄边界完成 `EditorArea` 渐进解耦；保留 Tab、DocumentRange、预览模型、滚动 follower、预热和 AI 选区语义。
- 验证结果：八文件定向 Vitest `78 passed、2 skipped`；Typecheck、Lint（0 errors、45 warnings）、Desktop build、bundle gate、`git diff --check`；`npm run tauri build`；隔离 identifier 的当前 Release Tauri 编辑/预览 surface、3 轮 Tab/模式快速切换和预览选区菜单真实 WebView2 smoke 均通过。
- 遗留问题：无；未提交、未推送、未打 tag、未创建 Release。下一阶段为 Phase 2B｜Workspace / Persistence。

### Phase 2B｜Workspace / Persistence（已完成）

- 状态：已完成
- 完成内容：新增 `workspaceIndexGateway` 收拢工作区可读性、已索引路径、文件存在性、事务删除、内存向量/Native RAG 清理和 workspace index；`workspaceIndex` 保留路径边界、逐文件结果与多 root 编排；FileTree/WorkspaceRoots 改经 workspace facade；新增 UI 边界、事务顺序、单文件失败重试和 embedding-only job 兼容测试；对齐 `scripts/file-access-check.ts` 的当前会话恢复断言。
- 验证结果：workspace/边界/transaction bridge/knowledge base 联合 Vitest `32 passed`；Rust `database_transactions` `11 passed`；`npm run test:file-access`；runtime schemas；RAG index；Typecheck；Lint（0 errors、45 warnings）；Desktop build；bundle gate；`git diff --check` 均通过。
- 遗留问题：无；未提交、未推送、未打 tag、未创建 Release。下一阶段为 Phase 2C｜AI / Settings。

### Phase 2C｜AI / Settings（Conversation persistence command 子步骤）

- 状态：进行中
- 完成内容：完成聊天入口和状态所有权梳理；新增 `conversationCommands` 收拢会话 SQLite 写入、历史读取和删除；`chatStore` 保留内存消息归一化与 mutation，`AiPanel` 保留确认/提示和本地会话移除。
- 验证结果：Conversation command、边界、Action Proposal、chat metadata、AI 面板定向 Vitest `22 passed`；Typecheck；Lint（0 errors、45 warnings）；Desktop build；bundle gate（entry `926474` bytes、JS total `5733497` bytes、95 chunks）；`git diff --check` 通过。
- 遗留问题：Phase 2C 尚未完成；下一子步骤处理请求编排和 Settings 副作用边界。未提交、未推送、未打 tag、未创建 Release。

### Phase 2C｜AI / Settings（Artifact persistence command 子步骤）

- 状态：进行中
- 完成内容：新增 `artifactCommands`；`readingArtifactsStore` 只保留列表、筛选、分页和锚点状态，数据库读写、来源哈希和锚点校验经 command 进入；保留完整 references、首个本地锚点和 request sequence 保护。
- 验证结果：Artifact Store、分页、边界、Conversation、Action Proposal、chat metadata、AI 面板定向 Vitest `51 passed`；Typecheck；Lint（0 errors、45 warnings）；Desktop build；bundle gate（entry `926474` bytes、JS total `5733695` bytes、95 chunks）；`git diff --check` 通过。
- 遗留问题：Phase 2C 尚未完成；下一子步骤处理 Context/Route/Stream 请求编排和 Settings 跨领域副作用。未提交、未推送、未打 tag、未创建 Release。

### Phase 2C｜AI / Settings（Settings persistence command 子步骤）

- 状态：已完成代码子步骤
- 完成内容：新增 `settingsCommands` 收拢会话清理、记忆分页/计数、记忆状态变更和手动写入；`SettingsPage` 保留 UI、确认提示和 `chatStore.resetHistoryState`，不再直接导入 database persistence；旧 persistence mock 通过部分模块 mock 保持兼容。
- 验证结果：Settings 定向 Vitest `45 passed`；Typecheck；Lint（0 errors、45 warnings）；Desktop build；bundle gate（entry `926474` bytes、JS total `5733978` bytes、95 chunks）；`git diff --check` 通过。
- 遗留问题：Phase 2C 仍需完成真实 Tauri AI/阅读成果人工验收。未提交、未推送、未打 tag、未创建 Release。

### Phase 2C｜AI / Settings（Context / Route request preparation 子步骤）

- 状态：已完成代码子步骤
- 完成内容：新增 `conversationRequest`；`useAiChat` 的 ContextTag 读取、用户消息 metadata 组装和统一 RoutingDecision 通过窄边界进入；保留取消、Store mutation、Memory/RAG、Agent 和 Stream 生命周期；确认现有 `streamFinalAnswer` 已满足 Stream 边界，无新增空代理。
- 验证结果：Context/Route 新增 Vitest `5 passed`；相关编排测试 `188 passed`；Typecheck；Lint（0 errors、45 warnings）；Desktop build；bundle gate（entry `926474` bytes、JS total `5734402` bytes、95 chunks）。
- 遗留问题：Phase 2C 代码子步骤已完成，待真实 Tauri AI/阅读成果人工验收。未提交、未推送、未打 tag、未创建 Release。

### Phase 2C｜AI / Settings（真实 Tauri AI / 阅读成果验收）

- 状态：已完成
- 完成内容：使用当前源码临时 identifier Release 和真实 Windows WebView2，完成本地 SSE Agent 请求、阅读成果行动提案确认、SQLite 写入、阅读成果面板回读和后续流式回答；正式库与临时数据目录已复核并清理。
- 验证结果：临时 identifier `com.guanmo.app.codex.phase2c` 的 DB 只读查询为验收标题 `1`、active `1`；正式 `com.guanmo.app` DB 只读查询为测试标题 `0`、active `4`；mock 请求均为 `stream: true`；进程、端口和临时目录均无残留。
- 遗留问题：Phase 2C 已完成；Phase 3A 尚未开始。未提交、未推送、未打 tag、未创建 Release。

### Phase 3A｜Appearance Schema、Registry 与内置主题

- 状态：已完成
- 完成内容：新增 `appearanceSchema` 的 `AppearanceConfigV1` 与旧主题字段迁移；新增五主题 `appearanceRegistry`、descriptor 校验、未知 ID 回退和 `appearanceDom` applicator；`settingsStore` 保留现有 action/`lastLightThemeId` 并补齐版本化默认字段；ThemePicker 改为读取 registry，`index.html` 使用可序列化启动主题子集。
- 验证结果：定向 Vitest `4 files / 52 passed`；`npm run typecheck`；`npm run lint`（0 errors、45 warnings）；`npm run build`；`npm run build:desktop`；Web/Desktop bundle gate；`git diff --check`；fresh Tauri no-bundle Release 隔离 WebView2 五主题编辑 surface sweep 全部匹配预期 canvas/colorScheme，临时运行目录由脚本清理且正式库未触碰。
- 遗留问题：Phase 3B 壁纸方案已放弃；未提交、未推送、未打 tag、未创建 Release。

### Phase 3B｜自定义壁纸（历史记录，已废弃）

- 状态：历史上已完成，现已按用户决策移除
- 完成内容：扩展版本化外观 schema，增加 `none/color/gradient/image` 壁纸和受控 fit/position/opacity/blur/overlay 参数；新增应用管理 `wallpapers` 目录的导入、解析、删除 Tauri command，沿用已选文件授权并仅动态开放 asset protocol 目录；Settings 增加 Web 安全的颜色/渐变入口和 Desktop 图片入口；App/Layout/index 启动链增加声明式 DOM 壁纸 applicator、资源恢复和缺失资源回退。验收返修为图片导入增加 request ID、类型切换/卸载失效保护和孤立受管资源清理；补充壁纸启用时 canvas/surface 的受控透明层，确保图片背景可见且无壁纸保持原样。
- 验证结果：返修后定向 Vitest `4 files / 54 passed`；`npm run test:file-access`；`npm run test:runtime-schemas`；Typecheck；Lint（0 errors、45 warnings）；Web/Desktop build 与 bundle gate；`git diff --check` 均通过。返修前且 Rust 源码未再变化的 fmt/clippy/test/check 为 PASS（`37 passed、1 ignored`）；既有隔离 Release WebView2 验收记录保留，本次未重跑真实 Tauri 文件选择竞态。
- 遗留问题：壁纸能力已不再保留；未提交、未推送、未打 tag、未创建 Release。

### Phase 3C｜AI 助手形象与状态动画

- 状态：已完成
- 完成内容：新增助手 visual ID 校验、八状态 inline-css descriptor、动画策略和 sprite fallback registry；新增固定 renderer map 的 `AssistantVisual` adapter；AI Panel 空态/流式/历史头像和设置预览改为通过 `assistantVisualId` 选择，保留既有 AssistantState、visibility pause、reduced-motion 和历史静态行为。
- 验证结果：定向 Vitest `5 files / 63 passed`；`npm run typecheck`；`npm run lint`（0 errors、45 warnings）；`npm run build`；`npm run build:desktop`；Web bundle gate；Desktop bundle gate；`git diff --check` 通过。首次单独 Web gate 因 dist 当时为 Desktop 模式失败，重建 Web 后复跑通过；不是代码预算失败。新鲜 Tauri Release 使用临时 identifier `com.guanmo.stage3c.acceptance` 构建，并在隔离 WebView2 中完成 AI Panel 空态、真实本地 SSE 流式状态、历史静态头像和设置八状态预览的 DOM/截图验收；证据保存在 `.tmp-stage3c-acceptance/visual-evidence-isolated-5/`。
- 遗留问题：无；未提交、未推送、未打 tag、未创建 Release。

### 计划初始化｜只读架构审查与交接

- 状态：已完成
- 完成内容：基于当前源码、知识图、测试清单、CI/Release 配置和项目契约完成长期维护与扩展性审查；确定 Phase 1 → Phase 2A/2B/2C → Phase 3A/3C 的渐进路线，3B 壁纸方案后续已废弃。
- 验证结果：`npm run test:store-boundaries` 失败，确认 6 个边界违规；其余 Machine Gate 未执行，因为本次只初始化计划且未修改业务代码。
- 遗留问题：Phase 1 尚未实施；知识图构建点曾落后当前 HEAD，后续执行必须以最新源码和实际测试为准。
