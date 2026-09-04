# GuanMo 项目 Review Profile

本文件记录观墨公开版的真实验证命令、风险边界和验收不变量。通用风险判断、P0/P1/P2/P3、Reviewer 输出格式和停止条件由用户级 `ai-code-review` Skill 管理。

## Machine Gate

验证状态只能使用：

- `PASS`：命令已实际执行且通过。
- `FAIL`：命令已实际执行但失败。
- `NOT TESTED`：本次未执行。

不要用代码阅读、推理或“应该可以”代替 `PASS`。

## Review Invocation Policy

- LOW 任务可自动执行相关 Machine Gate 和实现自审，默认不调用独立 Reviewer。
- MEDIUM 任务自动执行相关 Machine Gate，但默认不自动执行模型 Reviewer。
- HIGH 任务自动执行完整的相关 Machine Gate，但默认不自动执行模型 Reviewer。
- 任务结束交接时，Agent 必须同时给出建议验收模型和简短 Skill 调用提示词。模型层级按风险选择，不绑定具体供应商：

| 等级 | 用途 | 推荐模型 |
|---|---|---|
| L1 | 范围、验收项、明显 Bug、工具结果 | 弱/便宜模型 |
| L2 | 普通业务逻辑、状态、跨组件逻辑 | 中等模型 |
| L3 | 数据迁移、并发、复杂状态、安全、跨层调用 | 强模型 |

风险到模型层级的映射为：LOW→L1、MEDIUM→L2、HIGH→L3。

MEDIUM / HIGH 任务应提供以下简短提示词：

  `使用 ai-code-review Skill 执行本次模型 Review；只审查当前任务范围，遵循 AGENTS.md 和本项目 Review Profile。`

- 只有用户明确指明调用 `ai-code-review` Skill 后，才执行对应风险级别的模型 Review、P0/P1 判断和最多一次 Fix → Re-review；Machine Gate 结果优先复用任务流程中已自动执行的结果。

## Blast Radius Analysis（修改前影响分析）

- 按风险信号按需触发，不按风险级别机械执行：修改涉及下方风险信号（共享状态、生命周期、缓存、异步竞态、文件快速切换、文档模型、DB / 文件系统）时，无论风险级别与代码量，写代码前必须完成简短 Blast Radius 分析；未命中信号的普通局部修改不要求模板输出。
- 分析前按涉及状态域读取 `docs/architecture/state-ownership.md` 对应章节（同一会话已读且相关约束未变化时无需重复读取），确认 Source of Truth、Ownership 与 Invariants。
- 分析必须回答：本功能的 Source of Truth 是什么；直接修改哪些模块；谁调用这些模块、这些模块依赖谁；是否读写共享状态；是否涉及 Store / useEffect / mount-unmount / 缓存 / Worker / 异步任务 / race condition / 文件切换 / 文档模型 / Tauri / SQLite / 文件系统；哪些现有功能可能受间接影响；哪些功能明确“不应该受影响”。

输出模板（保持简短）：

```md
### Blast Radius

直接影响：
- <直接修改的模块/文件>

间接依赖：
- <调用方 / 依赖方>

高风险点：
- <共享状态 / 生命周期 / 缓存 / 并发等>

禁止影响：
- <本次明确不应该变化的功能>
```

## Risk Signals（高风险信号，按需触发检查）

风险不按修改行数判断：10 行核心状态代码可能比 500 行独立 UI 更危险。风险信号用于聚焦分析与检查范围（触发 Blast Radius 和 Review 中对应检查项），不机械升级风险级别：

| 风险信号 | 触发的检查 |
|---|---|
| 全局 Store、跨模块共享状态 | Blast Radius + Review 检查状态所有权 |
| useEffect、mount / unmount、cleanup | Blast Radius + Review 检查生命周期 |
| 缓存失效、Worker、Promise / async 生命周期、race condition、stale state / closure | Blast Radius + Review 检查并发与缓存 |
| 文件快速切换、文档全文模型、虚拟化渲染核心逻辑 | Blast Radius + Review 检查文档模型 Invariants |
| Tauri command 边界、SQLite schema / migration、用户数据文件系统写操作 | Blast Radius + 对应安全、兼容与数据风险检查；作为 HIGH 候选，结合实际改动性质判断 |

分级基线：普通局部 UI 修改 → LOW；独立 Feature 行为修改 → MEDIUM 候选；核心文档模型 / DB schema / 文件系统核心逻辑 → HIGH 候选。LOW 保持轻量；MEDIUM 只执行与实际命中信号相关的检查；HIGH 才执行完整架构 / Invariants / 高风险 Review。

## Verification Commands

| Area | Command | When required |
|---|---|---|
| TypeScript typecheck | `npm run typecheck` | 任何 `src/`、`tests/`、Vite 或 TypeScript 配置修改 |
| Lint | `npm run lint` | 任何前端、测试或构建配置修改 |
| Frontend unit/component tests | `npm test` | 共享逻辑、组件交互、服务或测试配置修改；CI 基础质量门禁 |
| Web build | `npm run build` | Web 入口、Web 能力边界、Vite、共享前端或 Web 产物修改 |
| Desktop frontend build | `npm run build:desktop` | Tauri 入口、桌面能力、Markdown 预览、桌面 UI 或体积边界修改 |
| File authorization | `npm run test:file-access` | 文件选择、打开、读写、删除、重命名、工作区、拖放、assets 或路径恢复修改 |
| Session restore | `npm run test:session-restore` | 最近文件、收藏、持久化标签页或启动恢复修改 |
| Database/runtime schemas | `npm run test:runtime-schemas` | SQLite row、备份 JSON、迁移、schema 解码或持久化字段修改 |
| RAG incremental index | `npm run test:rag-index` | 文档索引、chunks、embeddings、队列或增量刷新修改 |
| RAG query boundary | `npm run test:rag-query` | RAG 查询、后台索引、TopK、scope 或性能边界修改 |
| AI HTTP transport | `npm run test:ai-http` | 对话、Embedding、模型、联网搜索、Origin 授权或 Rust HTTP 代理修改 |
| Update behavior | `npm run test:update-version` | 版本比较、Release 响应或更新检查修改 |
| Toast/reminder timing | `npm run test:toast` | Toast 去重、暂停计时或更新提示状态修改 |
| Selection/context routing | `npm run test:selection-context` | 选区、上下文、AI 路由或 Agent 输入边界修改 |
| Bundle budget | `npm run check:bundle:web` / `npm run check:bundle:desktop` | 对应 Web/Desktop 产物或依赖边界修改 |
| Rust format | `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` | Rust 源码或 Cargo 配置修改 |
| Rust lint | `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --all-features --jobs 1 -- -D warnings` | Rust command、数据库事务、HTTP、索引或并发修改 |
| Rust tests | `cargo test --manifest-path src-tauri/Cargo.toml --all-targets --all-features --jobs 1` | Rust 行为或跨前后端契约修改 |
| Rust check | `cargo check --manifest-path src-tauri/Cargo.toml --all-targets --all-features --jobs 1` | Rust 行为或 Cargo 配置修改 |
| Release quality gate | `npm run check:release` | 发布前、共享基础设施或明确要求完整门禁时 |
| Tauri installer | `npm run tauri build` | 安装包、Tauri bundle、版本或发布产物修改 |
| Push safety | `node scripts/pre-push-check.mjs` | 仅在用户明确要求推送时，作为推送前安全校验 |
| Release safety | `node scripts/pre-push-check.mjs --release` | 仅在用户明确要求发布/tag 时，作为发布前安全校验 |

CI 的基础质量门禁由 `.github/workflows/quality.yml` 执行：Lint、TypeScript、前端测试、Web 构建以及 Rust fmt、clippy、test、check。发布工作流还执行安全校验和 `npm run tauri build`。

## HIGH-Risk Areas

以下路径和领域用于定位重点检查范围，不是风险分级结果；不得仅因目录或文件命中而自动判为 HIGH。应结合实际修改的行为、影响范围与数据风险判断，局部且低耦合的修改仍可按 LOW / MEDIUM 处理。

- 核心状态与生命周期：`src/stores/`（尤其 `editorStore.ts`、`appStore.ts`）、`src/components/editor/EditorArea.tsx` 的 useEffect / 实例生命周期 / 缓存、`src/services/markdownPreviewModel.ts` 与 `src/services/previewHighlight.ts`（文档模型与 DocumentRange 基础设施）。Source of Truth 与 Invariants 见 `docs/architecture/state-ownership.md`。
- SQLite 业务存储、schema/migration、备份导入、聊天历史关联：`src/services/database/`、`src/services/dataBackup.ts`、`src-tauri/src/database_transactions.rs`、`tools/guanmo-idb-exporter/`。
- 文件权限与用户数据：`src/hooks/useTauri.ts`、`src/services/fileSystem.ts`、`src/services/persistedFileAccess.ts`、`src/services/externalFileOpen.ts`、`src/services/sessionRestore.ts` 及 Rust 文件授权命令。
- 外部网络、AI 请求、Origin 授权和更新：`src/services/externalHttp.ts`、`src/services/updateService.ts`、`src-tauri/src/api_http.rs`。
- RAG、Embedding、长期记忆、索引刷新和并发状态：`src/services/rag/`、`src/services/memory/`、`src/services/database/persistence.ts`、`src-tauri/src/rag_index.rs`。
- Markdown 安全渲染、预览内编辑、块 offset、滚动同步和 Web/Desktop 能力边界：`src/services/markdown*`、`src/components/editor/`、`src/WebApp.tsx`、`vite.config.ts`。
- Tauri 启动生命周期、Rust command、权限 capability、更新/安装产物和性能报告：`src-tauri/src/`、`src-tauri/capabilities/`、`src-tauri/tauri.conf.json`。

## High-Risk Review Checklist

diff 涉及 HIGH-Risk Areas 或命中 Risk Signals 时，Review 只额外检查命中的信号对应的项，不全量机械扫描；HIGH 任务执行全部项：

- 状态所有权（命中 Store / 共享状态）：是否破坏 `docs/architecture/state-ownership.md` 声明的 Ownership；是否出现新的双重 Source of Truth；是否产生隐式跨模块耦合。
- 生命周期（命中 useEffect / mount-unmount）：useEffect dependency 是否改变执行时机 / 次数；cleanup 是否完整；mount / unmount 后状态是否正确；旧异步请求是否可能覆盖新状态。
- 并发与陈旧状态（命中 async / race / stale）：race condition、stale closure / stale state。
- 缓存（命中 cache）：cache invalidation 是否完整；文档内容 / 可见性变化后旧 offset、锚点是否失效。
- 文件切换（命中文件快速切换 / 虚拟化）：快速切换文件 / Tab 时的时序与实例释放。
- 兼容（命中 DB / 持久化）：backward compatibility；DB migration / schema 兼容。
- Invariants（HIGH 或命中文档模型）：是否违反 architecture 文档声明的 Invariants 与 `docs/agent-contracts/` 契约。

只有 correctness / regression / safety / architecture contract 相关的真实风险才阻断验收；代码风格、命名偏好、可选重构建议不得阻断。

## Critical Invariants

- 桌面业务主读写存储只能是 SQLite；Web 端不得初始化 SQLite 或 IndexedDB。
- SQLite 原子写入必须由 Rust command 持有同一个 SQLx 事务句柄；文档索引、候选记忆确认和备份导入失败时整体回滚。
- 旧 IndexedDB 只能只读检测并引导独立迁移工具；不得在主程序中自动迁移、合并、覆盖或删除旧库。迁移必须先备份，并通过完整性/外键检查和冲突报告交付候选库。
- `chat_messages.parent_id` 是回复与用户消息的持久化关联；历史渲染和分页不得按角色、时间或相邻顺序猜测配对。
- 文档文件仅限大小写不敏感的 `.md`；文件操作必须经过 `useTauri.ts` 与 `FsAccessState` 约束的 Rust command，前端参数不得扩权。
- 工作区、最近文件、收藏、会话恢复、系统文件关联和拖放必须遵守同一文件授权边界；Markdown 同级 `assets` 不得升级为通用工作区。
- 对话、Embedding、模型列表、联网搜索和更新检查必须经 `externalHttp.ts` 与 Rust 代理；Web 端误调用必须抛出 `UnsupportedCapabilityError`，不得浏览器直连回退。
- Rust HTTP 代理必须保持方法、Origin、DNS/IP、请求头、重定向和资源限额校验；公网只允许 HTTPS，未经授权的危险地址必须拒绝。
- RAG 更新必须事务化；未变化块复用旧 ID/向量，消失块及向量删除，失败时保留旧索引；初始化失败必须降级为关键词检索。
- 记忆注入只允许 active 且未被其他 active 记忆替代的记录，并按当前工作区作用域过滤；基础检索不得无条件读取全部 embedding。
- 更新检查使用 Tauri 当前版本、GitHub Releases `latest` API 和 24 小时缓存；不接入自动安装，下载链接只能通过系统浏览器打开。
- Web 与 Desktop 构建入口、能力边界和体积预算必须分离；桌面构建不得产出 `markdownPreview.worker-*` 独立脚本。
- 测试 fixture 必须匿名化；文件和 SQLite 测试只能使用临时目录、临时数据库，不得读取真实用户数据。

## Soft Diff Budget

- LOW 任务通常 ≤ 3 个文件；MEDIUM 通常 ≤ 8 个文件；HIGH 按实际需求。
- 明显超出预期时不判失败，但 Agent 必须解释：为什么需要这么多文件、是否存在无关修改、是否可以缩小范围。
- 目的是发现异常扩散，不是追求固定数字；机器统计以 `git diff --stat` 为准（排除用户既有修改）。

## Scope Guard

- 保留所有现有工作区修改；不得覆盖、回退、格式化或顺手处理不属于当前任务的文件。
- 不得以降低门禁、删除测试、清空数据或重建数据库来掩盖失败。
- 未经明确要求，不修改应用源码、依赖、CI、发布配置或 `.trellis/` 运行态文件来完成 Agent 配置任务。
- `docs/agent-contracts/` 是项目规范来源；涉及其内容的修改必须属于明确任务范围。
- Reviewer 只读，最多报告 3 个重要 finding，不执行实现修改。

## Compatibility Requirements

- Node.js 使用 `package.json` 声明的 `>=22`；依赖安装使用 `npm ci` 和现有 lockfile；Rust 使用 stable toolchain。
- SQLite schema 使用 `PRAGMA user_version` 和已有迁移/回填逻辑兼容旧数据；不能用清空正式库解决升级问题。
- 旧 Base URL、模型名和 API Key 保持兼容；首次使用自定义 API 或本地模型仍须经过 Origin 授权。
- `file-access-grants.json`、旧版工作区/最近文件/收藏/标签页/RAG 来源迁移必须保留可恢复路径和一次性迁移边界。
- 性能报告当前 schema 为 v2，读取旧报告必须保留 v1 字段兼容；报告不得包含完整路径、文档/对话内容、凭据或用户名。

## Human Acceptance Hotspots

- 原生 Tauri 中实际验证文件选择、打开/保存、删除/重命名、拖放、系统文件关联、工作区授权、最近文件和会话恢复。
- 使用匿名临时数据验证 SQLite 备份导入、旧库迁移候选库、冲突报告和失败恢复；自动测试不替代真实桌面流程判断。
- 实际验证自定义 API/本地模型授权、流式对话、联网搜索、更新提示和系统浏览器打开链接。
- 实际验证 Markdown 预览、预览内编辑、目录/滚动同步、大文档交互、主题和 Web/Desktop 能力边界。
- 人工检查安装包启动、文件关联、升级后数据可读性和发布产物；自动构建通过不等于安装器验收完成。
