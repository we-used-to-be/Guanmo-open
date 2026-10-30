# 数据库契约

涉及 SQLite、旧 IndexedDB、数据库启动状态、迁移、恢复、备份或聊天历史关联时，修改前必须读取本文件，并同时读取全局兼容指南。

## 原子写入与存储边界

- 桌面 SQLite 事务必须通过 Rust 命令持有同一个 SQLx 事务句柄；前端不得在 `tauri-plugin-sql` 连接池上用多次调用拼接 `BEGIN/COMMIT/ROLLBACK`。
- 文档索引、候选记忆确认与备份导入分别通过 `persist_document_transaction`、`confirm_memory_candidate_transaction`、`import_backup_transaction` 完成原子写入；任一步失败必须整体回滚。
- 桌面端只允许 SQLite 作为业务主读写存储；旧 `guanmo-db` IndexedDB 仅由独立兼容迁移模块后台只读访问，迁移期间不得双写或删除旧库。Web 端不得初始化 SQLite 或 IndexedDB。

## 状态、迁移与恢复

- 数据库状态统一为 `initializing/detecting/migrating/validating/ready/conflict/needs_recovery/failed`；维护状态下正式业务模块不得取得 SQLite 连接。
- `conflict` 只记录双库并继续使用现有 SQLite，迁移器不得写入、覆盖或合并业务数据；无效旧业务数据、孤立关系和源指纹异常进入 `needs_recovery`，运行故障进入 `failed`。
- 启动时仅只读检测旧 IndexedDB，不自动迁移；状态记录使用 `pendingAction=none/migrate/resolve_conflict/recover/retry`，永久完成或遗弃后不得再次打开旧库。
- 迁移只能由设置页手动启动，按 200 条分批；批次写入、实际 SQLite 主键清单与游标使用同一 Rust SQLx 事务。
- 遗弃只永久忽略旧库，并按清单逆序回滚部分迁移，不删除 IndexedDB 或原有 SQLite 数据。
- 每 5 秒心跳，单批 30 秒超时，60 秒无进度判定为 `failed/stalled`；批次与整次恢复均有限重试。
- 完成前必须校验数量、ID、核心字段和关联关系。
- 当前仓库未提供 `test:legacy-db-migration` 或 `test:legacy-db-recovery` 脚本；已实现的数据库迁移与备份事务契约回归使用 `npx vitest run tests/database/databaseMigrations.test.ts tests/database/transactionBridge.test.ts --maxWorkers=1`，运行时 schema 回归使用 `npm run test:runtime-schemas`。

## 数据解码与历史关联

- `chat_messages.parent_id` 持久化回复对应的用户消息 ID；历史记录必须按该关联分页和渲染，不得再按角色、时间戳或相邻顺序猜测问答配对。
- Web 不提供数据库兼容适配器；桌面数据库关键 row 与备份 JSON 必须经运行时 schema 解码。
- 备份导入必须在 SQLite 事务中完成，失败回滚。
- 数据边界回归使用 `npm run test:runtime-schemas`。

## AI 阅读成果消息快照

- 记忆来源使用可选的 `kind='memory'`、`memoryId` 与当轮实际注入的 `content`，沿用聊天 metadata 与成果 references JSON 保存；旧消息和成果缺少记忆来源继续兼容。记忆只展示内容，不建立文件锚点或点击跳转，保存后不回查当前记忆内容。
- 保存回复时仅通过助手 `parentId` 取得对应用户消息的 selection tags，不用相邻消息、当前草稿或当前文件补造历史。
- `reading_artifacts.structured_content` 可选保存 `originalSelections`（文本、文件、有效行号/偏移、截断及仅预览标识）、完整 `sourceCandidates` 与 `referencedSourceIds`；有文件和有效行号的选区追加到成果 `references`，按文件与行号去重，供来源跳转和按文档查询使用；不插入模型候选 `sourceCandidates`，不改变 `[S1…]` 映射。旧成果缺字段继续兼容；已保存选区快照的成果读取时合并定位来源，不写回或猜测缺失坐标。
- 快照在异步补全来源哈希前复制，保存后不依赖聊天记录或来源文件仍存在。备份沿用原结构化 JSON，无新表、迁移或版本升级。

## ReadingMark 持久化

- `reading_marks` 为独立表，SQLite/Rust 命令提供按 ID、按文档、全量分页读取、upsert 与删除；Rust 校验枚举、路径与 offset，并由 Rust 刷新 `updated_at`、保留 `created_at`。
- 备份 v1 的 `readingMarks` 为可选输入、导出始终包含；导入与现有会话、成果和提醒在同一事务中恢复，旧备份缺少该字段必须兼容为空数组。

## 阅读成果收藏与分类

- schema v4 的 `reading_artifact_organization` 按 `mark:<id>` / `ai:<id>` 保存收藏和分类 ID，`reading_artifact_categories` 保存分类名称；不复制成果内容。旧成果没有整理记录时默认未收藏、未分类。
- 收藏与分类分别通过 Rust `set_reading_artifact_organization` 局部更新；Rust 事务校验成果和分类存在性。分类名称经 Rust 校验为 1–40 个字符，重名拒绝。
- 删除分类在 Rust 同一事务中解除所有归属，保留收藏、成果和原文；删除成果通过 SQLite trigger 清理对应整理记录。
- 整理筛选在 SQL 计数和分页之前应用，包含按文档的汇总查询。备份 v1 增加可选的 `artifactCategories` / `artifactOrganization`，导入仍与成果在同一事务中恢复，旧备份缺少字段时兼容。
- 备份分类合并优先复用本地同名分类并映射备份分类 ID；没有同名项但 ID 已存在时保留本地名称。映射后的成果分类引用去重，保留本地分类及其既有归属；新增分类、映射引用与其它备份内容仍在同一 Rust 事务中，非法关联使整包回滚。
