# 技术设计

## 边界与兼容

- `classifyMemoryRetrievalIntent(query)` 的签名和 `none | weak | strong` 返回类型不变；`useAiChat` 的轻量/强检索参数不变。
- `memoryService.ts` 继续承担模型调用和数据库编排，纯策略放入 `memoryPolicy.ts`，供服务和 `test:memory` 共用。
- 不改动 `Memory` 持久化结构、确认/归档事务或设置页展示。

## 阶段 1：检索意图

- 先识别转换型请求；当翻译、总结、改写、解释代码的对象只是包含历史或记忆字样时返回 `none`。
- 再识别明确记忆查询并返回 `strong`。
- 弱触发必须满足惯例续接短语，或“历史指代 + 沿用/继续/按某种方式”的组合；移除宽泛历史词的单独命中。

## 阶段 2：候选决策

- 将候选输入规范化为裁剪空白后的内容和结构化字段，置信度限制到 `[0, 1]`。
- 验证层执行硬边界：正文 6–80 个 Unicode 字符、单句、非临时、非转换请求、非源码/正文摘录、非空泛语气。
- 同一事实身份使用 `category + normalized scope + subject + factKey`；只有结构字段不足时才以同类别、同作用域的词法相似度兜底。
- 对 existing candidate：未锁定且来源为 `auto_extracted` 时复用旧记录。等值采用较短正文，等长保留旧正文；异值采用最新事实。只在字段、证据、置信度或正文实际变化时持久化。
- 对 existing active：同键同值视为重复；同键异值生成 replacement。若已存在指向该 active 且代表同一新值的候选，则合并该候选，避免多个 replacement。
- 正文变化时清空 `embedding/embeddingModel` 并重算 `contentHash`；保留原 ID、`createdAt`、状态和作用域。

## 回滚

- 两阶段分别形成验证检查点；阶段 1 仅修改分类策略与测试，失败时可独立回退。
- 阶段 2 不涉及迁移，回滚只需恢复策略、服务编排和专项测试文件。
