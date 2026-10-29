# RAG 与长期记忆契约

涉及长期记忆、RAG 文档、Embedding、向量缓存、索引刷新或搜索时，修改前必须读取本文件，并同时读取 `database.md`。

## 长期记忆

- `memories` 使用结构化事实模型：`scope_type/scope_key` 区分全局与项目记忆，`subject/fact_key/fact_value/evidence/confidence` 描述事实，`supersedes_id` 表示替代关系，`content_hash/embedding_model/embedding` 用于向量缓存。
- 记忆注入只允许 `status='active'` 且未被其他 active 记忆替代的记录；项目记忆必须按当前工作区作用域过滤，不能跨工作区注入。
- 记忆检索必须在 SQLite 下推 `status/scope/category` 过滤，基础查询不得读取 `embedding`；只允许按词法候选 ID 二次加载向量。
- 兼容索引须在旧列迁移完成后幂等创建。
- 自动提取仅使用已持久化的真实用户可见消息；非敏感、结构完整、原文字面支持且无事实冲突的新稳定事实可自动成为 active。敏感信息不进入自动提取，显式保存仍经确认；缺少证据或与既有 active 冲突的事实保持 candidate，确认前不参与召回。
- 自动操作不得覆盖手动、锁定或已确认事实；替代通过候选确认事务完成。同作用域的旧 active 必须仍存在；带版本快照的新候选还须核验旧事实内容及时间，变化后拒绝确认。旧证据格式继续兼容。
- 后台提取任务复用 SQLite settings，绑定来源 ID、会话和作用域；执行与写入时重新核验来源。普通回答不等待提取，重试、租约及批量均有界；Embedding 仅条件更新缓存列，不得恢复被删除或覆盖已修改的事实。

## 增量索引与缓存

- RAG 文档使用精确 SHA-256 `documents.content_hash` 跳过未变化内容；Embedding 缓存只允许按 `embedding_model/preprocess_version/input_hash` 完整匹配复用。
- RAG 更新必须在事务内增量写入文档、语义块、向量和队列任务；未变化块沿用旧 ID 与向量，已消失块及其向量必须删除，失败时保留旧索引。
- `chunks_fts` 是 `chunks` 的可重建 FTS5 派生索引；schema 升级回填旧分块，增删改由 SQLite 触发器同步。双字中文与 FTS 查询失败时沿用原关键词匹配，不得丢失已有分块召回。
- RAG 增量索引回归检查使用 `npm run test:rag-index`。

## 后台搜索边界

- RAG 全量 JSON Embedding 只能由 Rust 后台索引服务通过只读 SQLx 连接在首次搜索或真实首屏后的合格预热中初始化；WebView 不得加载、解析或执行全库向量相似度计算，只接收最终 TopK。
- `speed` 在数据库和真实首屏就绪后，将合格预热加入共享闲时队列；`balanced` 仅在最近 7 天使用过知识库时等待用户连续空闲后加入队列。所有档位的后台和主动初始化均须通过真实系统内存与索引聚合大小的预算检查；Rust 在分配前再次校验，采样/预算不可用或余量不足时使用有界 SQLite 关键词检索。运行中普通交互不得取消共享初始化，单次检索取消只结束该请求的等待。
- 索引状态命令为 `get_rag_index_state/initialize_rag_index/search_rag_index`；文档写入或删除后分别调用 `refresh_rag_index_document/remove_rag_index_document`。
- 初始化预算统一由只读 `estimate_rag_index_memory` 返回 MiB 整数，前端不复制公式、不接收正文或向量。Rust 使用同一 SQL 聚合计算 Float32 元素数（按 2 倍容量计）、字符串（2 倍）、每块 2048 字节/每文档 1024 字节结构开销、最大 64 行原始批次（4 倍），再加 128 MiB 分配器/SQLite 余量；512 MiB 系统保留额度另计。JSON 向量文本只计入单批临时开销，不再把全库 JSON 乘 6 当成常驻大小。预算仍是保守估计，不保证所有数据形态的峰值上界；聚合失败或不可用时关闭可选预热，主动检索保留关键词降级。
- 匿名同规模分批初始化的 Windows 私有内存测量入口：`cargo test --manifest-path src-tauri/Cargo.toml --lib rag_index::tests::anonymous_batched_initialization_memory_profile --jobs 1 -- --ignored --exact --nocapture`。仅在临时目录生成匿名 SQLite，不读取正式库；日常测试默认不执行。
- 初始化失败必须降级为关键词检索。
- 用户主动检索触发初始化，若因内存预算不足或构建期间内存压力而拒绝，使用现有 Toast 显示固定警告并保持关键词降级；重复通知复用同一 Toast ID。后台预热、请求取消、其他失败和已就绪索引不触发该警告，不把原始错误或用户内容放入提示。
- 关键词降级不得加载全库向量或构建全库临时索引；FTS 候选和短词/FTS 失败的扫描逐行消费，仅保留有限候选（最多 3×TopK），去重、文档分散及作用域过滤在截断前执行，最终按命中加载邻接块。已有 ready 索引保留；真实余量不足或采样未知时也采用该路径，避免全量结果临时分配。
- 初始化按最多 64 块分批加载并逐块消费向量 JSON；读取、阻塞解析、全局维度校验、待处理刷新和发布边界均检查取消与真实系统余量（512 MiB 保留额度）。资源压力或未知使未完成构建停止，不发布半成品；必须等待阻塞任务退出后才清理状态并唤醒等待者。待处理变更重放和 ready 发布由同一控制锁衔接；失败后下次请求从 SQLite 重建并重新准入，不卸载已有 ready 索引、不改变持久数据。
- RAG 自动保存 unchanged 判定、统计和知识库状态必须使用轻量元数据或 SQL 聚合；文档变化与 Embedding 队列只允许按目标文档读取，禁止以 `loadAllDocumentsBulk()` 作为运行时前置步骤。
- 性能与查询边界回归使用 `npm run test:rag-query`、`npm run test:runtime-schemas` 和 `npm run check:bundle`。
