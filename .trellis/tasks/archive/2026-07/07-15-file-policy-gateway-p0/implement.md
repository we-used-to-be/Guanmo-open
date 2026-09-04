# Implementation Plan

## Stage 1 - Lock policy with tests

- [x] 将授权类别抽成可直接测试的策略判定。
- [x] 增加未授权路径 × 全文件动作矩阵。
- [x] 增加工作区、精确文件和 Markdown assets 授权测试。
- Validation: `cargo test --manifest-path src-tauri/Cargo.toml --lib`

## Stage 2 - Complete Rust gateway

- [x] 新增受控 `path_exists` 与 `remove_file_by_path`。
- [x] 使目录读取必须已有工作区授权。
- [x] 将目录与单文件授权语义分离。
- [x] 注册新增命令，并覆盖系统文件关联与拖放入口。
- Validation: `cargo test --manifest-path src-tauri/Cargo.toml --lib`; `cargo check --manifest-path src-tauri/Cargo.toml`

## Stage 3 - Remove frontend bypasses

- [x] `useTauri.ts` 全部文件动作只调用 Rust 命令。
- [x] 目录选择后显式注册工作区。
- [x] 文件选择与另存为路径显式注册精确文件授权。
- [x] 前端不再导入 `@tauri-apps/plugin-fs`。
- Validation: `npm run build`; source grep audit

## Stage 4 - Tighten capabilities

- [x] 移除 `default.json` 中全部 `fs:*`。
- [x] 将 asset protocol 初始 scope 收紧为空。
- [x] Markdown assets 仅按专用图片目录策略动态授权。
- Validation: JSON parse; source/config grep audit; `cargo check`

## Stage 5 - Full review

- [x] `cargo test --manifest-path src-tauri/Cargo.toml --lib`
- [x] `cargo check --manifest-path src-tauri/Cargo.toml`
- [x] `npm run test:agent-parser`
- [x] `npm run test:memory`
- [x] `npm run test:markdown-math`
- [x] `npm run test:markdown-preview`
- [x] `npm run test:markdown-export`
- [x] `npm run test:selection-context`
- [x] `npm run test:rag-index`
- [x] `npm run build`
- [x] P0 static contract audit
- [x] `git diff --check`
- [x] 核对精准 diff 与工作树边界。

## Risk Points

- Rust 1.97 编译旧版传递依赖 `indexmap 1.9.3` 时需以 `RUSTFLAGS=-A ambiguous-associated-items` 运行验证；未修改依赖或锁文件。
- 本机并行 Rust 编译会触及内存上限，因此验证使用 `CARGO_BUILD_JOBS=1`。
- Vite 构建仍有既有大 chunk / 动态导入提示，属于审计 P1，不阻断本次 P0。
- 不得修改或删除 `.playwright-cli/`。

## Regression Stage - Persisted Entries

- [x] 增加 Rust 授权快照序列化与恢复策略测试。
- [x] 增加前端旧记录授权恢复专项检查。
- [x] Rust 持久化可信工作区与精确文件授权，并在启动时恢复。
- [x] 最近文件、收藏、全屏抽屉、持久化标签页、历史 AI 来源统一移除伪造选择授权。
- [x] 旧文件/工作区通过同路径系统选择器完成一次迁移。
- [x] 审计全部文本、二进制、工作区和外部文件打开入口。
- [x] 运行 Rust、专项脚本、现有前端测试、构建与 diff 检查。

## Bug Analysis - Persisted paths lost native capability after restart

- Root cause: cross-layer contract plus change-propagation gap. Frontend state persisted paths, while Rust authorization was intentionally runtime-only; the first P0 pass audited file actions but not the restart lifecycle of every persisted-path consumer.
- Similar entry points found: recent files, favorites, fullscreen drawer, restored tabs, historical AI sources, and restored workspaces.
- Prevention: Rust-owned trusted grant persistence, same-path legacy recovery, `npm run test:file-access`, source-level call-site assertions, and updated project/cross-layer contracts.
- Existing direct reads were reviewed and retained only where their source is a current workspace, current tab/tag, system dialog, file association, native drag-drop, or Markdown asset scope.

## Seamless upgrade implementation

- Added a pure collector for saved workspace, recent, favorite, tab, and RAG paths with normalized deduplication.
- Added the one-time Rust migration command and persisted backward-compatible marker.
- Runs migration after database initialization and before pending-file/session restoration.
- Added regression checks for source coverage, startup ordering, old grant-file compatibility, and marker persistence.
- [x] Persist temporarily unavailable legacy paths and trusted grants, then retry only that Rust-owned queue on later launches.
- [x] Verify interruption/retry behavior, then rerun the complete quality gate before commit.
