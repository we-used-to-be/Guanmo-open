# 修复文件权限双通道绕过

## Goal

消除桌面端文件操作绕过 Rust 动态授权策略的第二通道，使工作区、用户显式选择文件和 Markdown 资源目录成为唯一授权来源。

## Background

- P0 审计报告：`D:/temp/guanmo-open-refactor-audit-20260715-120423.html`。
- `src/hooks/useTauri.ts` 在自定义 Rust 命令失败时回退到 `@tauri-apps/plugin-fs`，二进制读写、删除等操作还优先或直接调用插件。
- `src-tauri/capabilities/default.json` 向前端开放完整的 `fs:*` 文件能力。
- `src-tauri/tauri.conf.json` 的 asset protocol 使用全局 `**` scope。
- `src-tauri/src/lib.rs` 已维护 `FsAccessState`，但 `read_dir_by_path` 在尚无工作区时会把任意首次读取目录自动注册为工作区。
- 当前工作树存在用户生成的未跟踪目录 `.playwright-cli/`，本任务不得修改、暂存或删除。

## Requirements

### R1. 单一文件策略网关

- 文本读写、二进制读写、创建文件、创建目录、目录读取、存在性检查、删除、重命名和资源管理器定位必须只通过受动态授权约束的 Rust 命令执行。
- Rust 命令失败时必须原样失败，不得回退到 `plugin-fs`。
- 前端不得直接导入 `@tauri-apps/plugin-fs`。

### R2. 显式动态授权

- 工作区只能由用户完成目录选择后显式注册。
- 单文件只能由文件选择、系统打开文件或其他现有显式用户动作注册。
- `read_dir_by_path` 不得隐式创建授权。
- Markdown 同级 `assets` 目录继续服从现有 `prepare_markdown_assets_dir` 契约。

### R3. 收紧静态能力

- 从主窗口 capability 移除前端 `fs:*` 权限。
- asset protocol 初始 scope 不得包含全局通配符；本地预览资源只能由 Rust 动态加入 scope。
- 保留 dialog、SQL、window、shell 等本任务之外的现有能力。

### R4. 权限矩阵回归

- 对未授权路径覆盖文本读写、二进制读写、创建、目录读取、存在性检查、删除、重命名和资源管理器定位。
- 覆盖工作区内路径、精确选择文件、工作区外路径三个授权类别。
- 验证目录读取在未显式授权时被拒绝。

## Acceptance Criteria

- AC1 (R1): `src/**` 不再出现 `@tauri-apps/plugin-fs` 导入，全部文件动作调用 Rust 命令。
- AC2 (R2): 未授权路径的每种文件动作均返回错误；目录选择后可正常读取该工作区。
- AC3 (R3): `default.json` 不含 `fs:*` 权限，`assetProtocol.scope` 不含 `**`。
- AC4 (R4): Rust 权限矩阵测试通过，并能在删除任一关键 guard 时失败。
- AC5: `cargo test`、`cargo check`、`npm run build`、相关现有专项测试和 `git diff --check` 通过。
- AC6: 只修改本任务文件，不触碰 `.playwright-cli/` 或其他用户改动。

## Out of Scope

- P1/P2 审计项。
- Web 能力裁剪、AI 编排、EditorArea、RAG 性能和依赖升级。
- 通用依赖注入框架或与权限修复无关的重构。
- 提交、推送、tag 或 Release。

## Regression Addendum - Persisted File Entries

- 最近文件、收藏、持久化标签页、历史 AI 来源和已选择工作区不得在应用重启后失去访问能力。
- 可信授权必须由 Rust 在显式文件/目录选择、系统文件关联或原生拖放边界持久化；前端 localStorage、聊天记录和数据库路径不得直接扩权。
- 升级前的旧记录没有 Rust 授权凭据时，只允许通过一次系统文件/目录选择完成迁移；迁移后重启无需重复选择。
- 所有持久化路径入口不得直接调用 `authorizeSelectedPath(path)` 冒充本轮用户选择。

## Compatibility Addendum - Seamless Upgrade

- 用户确认兼容性优先于“旧记录逐项重新确认”的严格标准。
- 升级后首次启动不得弹出文件或目录选择器；旧工作区、最近文件、收藏、持久化标签页、RAG 文档路径和历史 AI 本地来源自动迁移。
- Rust 立即迁移真实存在、绝对、扩展名受支持的路径；暂时不存在但格式合法的路径进入持久化待迁移队列，无效路径忽略。
- 迁移完成标记由 Rust 持久化，后续前端持久化数据不得继续扩权；Rust 自有待迁移队列在每次启动时自动重试，直至路径恢复可用。
- 迁移后各入口继续使用统一 Rust 策略网关；未被旧数据覆盖的路径仍需用户显式选择。
