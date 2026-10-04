# RAG 与长期记忆契约

涉及长期记忆、RAG 文档、Embedding、向量缓存、索引刷新或搜索时，修改前必须读取本文件，并同时读取 `database.md`。

## 长期记忆

- `memories` 使用结构化事实模型：`scope_type/scope_key` 区分全局与项目记忆，`subject/fact_key/fact_value/evidence/confidence` 描述事实，`supersedes_id` 表示替代关系，`content_hash/embedding_model/embedding` 用于向量缓存。
- 记忆注入只允许 `status='active'` 且未被其他 active 记忆替代的记录；项目记忆必须按当前工作区作用域过滤，不能跨工作区注入。
- 记忆检索必须在 SQLite 下推 `status/scope/category` 过滤，基础查询不得读取 `embedding`；只允许按词法候选 ID 二次加载向量。
- 兼容索引须在旧列迁移完成后幂等创建。

## 增量索引与缓存

- RAG 文档使用精确 SHA-256 `documents.content_hash` 跳过未变化内容；Embedding 缓存只允许按 `embedding_model/preprocess_version/input_hash` 完整匹配复用。
- RAG 更新必须在事务内增量写入文档、语义块、向量和队列任务；未变化块沿用旧 ID 与向量，已消失块及其向量必须删除，失败时保留旧索引。
- `chunks_fts` 是 `chunks` 的可重建 FTS5 派生索引；schema 升级回填旧分块，增删改由 SQLite 触发器同步。双字中文与 FTS 查询失败时沿用原关键词匹配，不得丢失已有分块召回。
- RAG 增量索引回归检查使用 `npm run test:rag-index`。

## 后台搜索边界

- RAG 全量 JSON Embedding 只能由 Rust 后台索引服务通过只读 SQLx 连接按首次搜索初始化；WebView 不得加载、解析或执行全库向量相似度计算，只接收最终 TopK。
- 索引状态命令为 `get_rag_index_state/initialize_rag_index/search_rag_index`；文档写入或删除后分别调用 `refresh_rag_index_document/remove_rag_index_document`。
- 初始化失败必须降级为关键词检索。
- RAG 自动保存 unchanged 判定、统计和知识库状态必须使用轻量元数据或 SQL 聚合；文档变化与 Embedding 队列只允许按目标文档读取，禁止以 `loadAllDocumentsBulk()` 作为运行时前置步骤。
- 性能与查询边界回归使用 `npm run test:rag-query`、`npm run test:runtime-schemas` 和 `npm run check:bundle`。
