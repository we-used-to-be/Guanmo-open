# 桌面文件权限契约

涉及文件选择、打开、读写、拖放、工作区、最近文件、收藏、恢复、assets 或 Rust 文件授权时，修改前必须读取本文件。

- 编辑器文档范围仅限扩展名为 `.md` 的文件（大小写不敏感）；文件选择、工作区树、最近文件、收藏、会话恢复、拖放和系统文件关联必须共用该限制，图片等资源选择不作为文档打开。
- Markdown 打开入口统一使用 `MAX_OPEN_MARKDOWN_BYTES`（当前为 `1 * 1024 * 1024`，按 UTF-8 文件字节数判断）的受限读取；等于上限允许，超过上限拒绝，不得进入 Tab、预览或索引。启动恢复只跳过未修改的超限磁盘标签，最近文件、收藏和未保存草稿必须保留。
- 前端文件读写、二进制操作、创建、删除、重命名、存在性检查和目录读取只能通过 `src/hooks/useTauri.ts` 调用受 `FsAccessState` 约束的 Rust 命令，不得直接调用或回退到 `@tauri-apps/plugin-fs`。
- `authorize_selected_path` 与 `authorize_workspace_path` 只能接受已由 Tauri 文件对话框加入运行时 scope 的路径；系统文件关联和原生拖放路径必须在 Rust 事件边界注册，前端传入任意路径不能扩权。
- `read_dir_by_path` 不得隐式注册首个工作区；主窗口 capability 不开放 `fs:*`，asset protocol 初始 scope 不使用全局通配符。
- Markdown 同级 `assets` 只拥有图片读写、存在性检查和预览权限，不得升级为通用工作区。
- Rust 将经文件/目录对话框、系统文件关联或原生拖放确认的工作区与精确文件写入应用配置目录的 `file-access-grants.json`，启动时仅恢复仍有效的规范化路径。
- 版本升级兼容期允许启动时把旧版已保存工作区、最近文件、收藏、持久化标签页、RAG 文档和历史 AI 本地来源提交给一次性迁移命令；Rust 持久化完成标记，之后不得再次用前端持久化路径扩权。
- 格式合法但暂时不可用的路径进入 Rust 自有待迁移队列，后续启动自动重试；迁移遗漏项才通过系统选择器重新选择同一路径恢复。
- 文件授权恢复专项回归使用 `npm run test:file-access`。
- 持久授权恢复与旧路径迁移的 `exists/canonicalize` 等阻塞磁盘操作必须通过 `tauri::async_runtime::spawn_blocking` 执行；`setup` 不得同步探测路径，标签页读取仍须等待后台授权恢复完成。

## Markdown 图片目录

- `prepare_markdown_assets_dir(markdownPath)` 只允许创建并授权真实存在的 Markdown 文件同级 `assets` 目录，用于图片写入和预览。
