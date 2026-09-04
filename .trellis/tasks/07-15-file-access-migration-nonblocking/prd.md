# 避免文件授权迁移阻塞主进程

## Goal

文件授权恢复与旧路径迁移不得在 Tauri 启动主线程执行阻塞磁盘 I/O；离线磁盘或网络路径不能冻结应用窗口。

## Requirements

- Rust `setup` 必须立即返回，持久授权恢复在后台阻塞线程执行。
- `migrate_legacy_file_access` 必须是异步命令，路径存在性检查、规范化和 scope 注册不得占用 IPC/主线程。
- 后台授权恢复与首次迁移必须串行，不能因竞态覆盖完成标记、授权或待迁移队列。
- 前端仍需在标签页读取前等待授权迁移完成，但界面渲染和事件循环必须保持响应。
- RAG 文档路径与历史 AI 来源路径并行读取，减少迁移等待时间。
- 不改变一次性迁移、离线路径重试和禁止二次前端扩权契约。

## Acceptance Criteria

- Rust `setup` 中不直接调用阻塞恢复函数，而是通过 `tauri::async_runtime::spawn_blocking` 调度。
- 迁移 Tauri 命令为 `async fn`，阻塞实现只在 `spawn_blocking` 内执行。
- 恢复与迁移共用 `legacy_migration` 锁。
- 专项静态回归能在移除任一后台调度或启动顺序约束时失败。
- `npm run test:file-access`、`npm run build`、`cargo check`、`cargo test`、`git diff --check` 通过。
- 不修改或暂存 `.playwright-cli/`。

## Out of Scope

- 修改授权范围、迁移数据来源或 UI 样式。
- 推送、tag 或 Release。
