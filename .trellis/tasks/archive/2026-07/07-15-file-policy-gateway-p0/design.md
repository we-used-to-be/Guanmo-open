# Technical Design

## Boundary

文件系统调用链固定为：

`React/service -> src/hooks/useTauri.ts -> invoke(custom Rust command) -> FsAccessState policy -> std::fs`

`plugin-fs` 仅作为 Rust 内部动态 scope 管理的基础设施存在，不再向 WebView 暴露文件操作权限。

## API Contract

现有命令保持字段名不变：

- `read_text_file_by_path({ path }) -> string`
- `write_text_file_by_path({ path, content }) -> void`
- `read_binary_file_by_path({ path }) -> number[]`
- `write_binary_file_by_path({ path, content: number[] }) -> void`
- `create_text_file_by_path({ path }) -> void`
- `create_dir_by_path({ path }) -> void`
- `rename_text_file_by_path({ oldPath, newPath }) -> void`
- `read_dir_by_path({ path }) -> DirectoryEntry[]`
- `reveal_file_in_folder({ path }) -> void`

新增命令：

- `path_exists({ path }) -> boolean`：仅允许查询已授权工作区内或精确授权文件的文本/图片路径。
- `remove_file_by_path({ path }) -> void`：只删除已授权工作区内或精确授权的受支持文件；目录删除不在本次范围。

授权命令：

- `authorize_workspace_path({ path }) -> void`：只接受真实目录。
- `authorize_selected_path({ path }) -> void`：只接受受支持的真实/待创建文件；不再把目录解释为工作区。
- `prepare_markdown_assets_dir({ markdownPath }) -> void`：保持现有同级 assets 专用契约。

`authorize_workspace_path` 与 `authorize_selected_path` 只接受已由 Tauri dialog 插件加入运行时 fs scope 的路径；前端不能用任意路径直接扩权。由系统文件关联传入的 Markdown 在 Rust `take_pending_open_files` 返回前直接注册，不经过前端授权。

原生拖放路径由 Rust `on_webview_event` 精确注册；Markdown `assets` 只加入专用资产状态和 asset protocol scope，不能通过 `authorize_workspace_path` 提升为通用工作区。

所有错误继续使用 `Result<_, String>`，前端不改造错误文案契约。

## Policy Model

- `Workspace`: 目录本身及其后代可执行受支持文件/目录动作。
- `SelectedFile`: 只授权精确文件，不授权父目录或兄弟文件。
- `SelectedMarkdownAssets`: 只允许该 Markdown 同级 `assets` 目录执行图片读写、存在性检查及资源预览，不升级为通用工作区。
- `Unauthorized`: 所有动作拒绝。

存在性检查必须先验证路径类型/扩展和授权，不能成为任意路径探测通道。删除只处理文件，并复用相同的文本/图片授权判定。

## Asset Protocol

- 初始配置 scope 设为空数组。
- 工作区注册时动态允许该目录；选择文件时动态允许该文件；assets 准备时动态允许该目录。
- Markdown 预览继续使用 `convertFileSrc`，但只有动态 scope 内资源可被协议读取。

## Compatibility

- 保存为路径来自 save dialog，调用侧需在写入前显式 `authorize_selected_path`，否则收紧后会被拒绝。
- 目录选择后由 `pickDirectory` 显式调用 `authorize_workspace_path`，再进入文件树读取。
- 已存在的外部文件打开、会话恢复和图片选择路径继续沿用现有显式授权。

## Trade-offs

- 保留 `tauri-plugin-fs` Rust 插件以支持动态 fs scope API，但不开放前端权限；比移除插件更小且不破坏现有动态授权代码。
- 不引入新的 TypeScript `FilePolicyGateway` 类；`useTauri.ts` 已是唯一适配层，直接收敛其实现即可满足单一网关且避免过度抽象。

## Rollback

改动集中在 `useTauri.ts`、`lib.rs`、两份 Tauri 配置和少量显式授权调用点。若某阶段验证失败，只回退该阶段对应修改，不恢复静态 fs 通配权限。

## Persisted Grant Recovery

- Rust 在应用配置目录维护 `file-access-grants.json`，只记录已经通过系统对话框、文件关联或原生拖放验证的工作区与精确文件。
- 应用启动时由 Rust 读取、规范化并重新注册仍有效的授权；无效记录忽略，不能扩大到父目录。
- 最近文件、收藏、持久化标签页和历史 AI 来源先直接读取。只有明确的授权缺失错误才允许弹出系统选择器，并且用户必须重新选择同一路径。
- 旧工作区恢复同理：首次升级可要求重新选择同一目录，成功后由 Rust 持久化。
- 普通不存在、扩展名非法和系统权限错误不得触发授权恢复对话框。

## Seamless legacy grant migration

- `App` waits for database initialization, then gathers the saved workspace, recent files, favorites, persisted tabs, `documents.file_path` values, and local paths from `chat_messages.metadata.sources` before session restoration.
- `migrate_legacy_file_access` canonicalizes existing paths in Rust, grants at most 16 workspaces and 10,000 supported files, and records ignored entries.
- `legacy_migration_completed` and bounded pending workspace/file sets are stored in `file-access-grants.json`. After completion, frontend arguments are ignored; only the Rust-owned pending sets are retried on later launches.
- Missing absolute paths with valid file types remain pending. Existing paths with the wrong kind, unsupported extensions, relative paths, and traversal paths are rejected instead of retried.
- Persist failure rolls the marker back so the next launch can retry.
