# 观墨记忆自动提取策略审计与优化计划

> **前序验收基线（2026-11-02，Sol）：FAIL；真实模型部分 BLOCKED。** 当时记录的 P1 和余额状态见 [Sol 独立验收记录](../memory/FINAL_REVIEW_2026-11-02.md)。随后用户明确批准下述 v3 全局自动写入方案；该方案覆盖此前 A/B/C 的生产范围与参数。下文 A/B/C 评测和桌面记录作为历史证据保留，不代表 v3 已验收。

## 当前任务：全局记忆自动写入 v1（2026-11-02）

### 目标与硬边界

- 仅优化后台自动提取与写入；不改记忆召回、主动添加、项目记忆管理和备份格式，不迁移旧记忆或扫描旧聊天。
- 新来源只接受全局事实：每个会话按登记顺序累计 8 条新用户消息触发；不足 8 条则在该会话最后一条后空闲 5 分钟触发。助手回复用于配对上下文但不计数；会话互不混批、互不重置计时。
- 用户消息第一次被接受时，由 Rust 同一 SQLite 事务持久化消息和 v3 回执。v3 使用独立 settings 命名空间，只扫描/认领自己的任务；恢复扫描和批次领取有界，但不能因 512 条积压拒绝来源登记或遗失后续任务。
- 每次后台模型调用最多输出 6 个候选、800 tokens、20 秒；全局后台并发 1，前台生成时让行。失败总尝试不超过 3 次，v3 退避 60 秒、120 秒；前台让行不算失败。
- 普通稳定、来源充分、全局适用且无冲突事实自动写 active。健康/财务等一般敏感事实只能成为带显式 v3 敏感标记的 candidate，由设置确认；密码、密钥、验证码、证件/账号号码、精确地址和联系方式必须在发请求前本地拦截，Rust 写入再次拒绝。
- 真实模型验收沿用本次明确批准的新预算：最多 20 次实际网络尝试或人民币 1 元，先到即停；失败与重试均计数，usage 或费用无法核实时不得记为零。

### 最终验收（2026-11-02）：PASS WITH NOTES / HIGH-L3，工程闭环完成

- 用户明确调用 `ai-code-review` Skill，独立 Reviewer 完成深审及唯一一次 Fix → Re-review；两个 P1 已闭合，无剩余 HIGH-confidence P0/P1。真实模型测试按用户明确指示跳过，`NOT TESTED` 不作为本次工程验收阻断，不证明实际提取准确率。
- Review 修复一：旧请求在上下文读取或客户端准备后迟到返回，先核验请求归属；不得释放新请求的 foreground busy、清除其请求/流式/错误状态或继续旧路由。已增加 context/client-ready/client-unconfigured 三种 A 取消 → B 启动 → A 迟到回归。
- Review 修复二：发送前硬秘密规则恢复 English `password`、`secret`、`token:` / `token =`；用户来源、助手上下文和旧自动记忆目录均受硬秘密过滤。新增来源 gap、用户/助手零模型调用，以及旧邮箱目录不外发回归。
- 最终 Machine Gate：7 文件/86 项定向 Vitest PASS；`npm run typecheck` PASS；定向 ESLint PASS（仅 `memoryPolicy.ts:233` 原有 warning）；`cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` PASS；`git diff --check` PASS；Core Smoke 9/9 PASS（`D:/temp/guanmo-memory-final-review-smoke.json`，未调整超时或 mock）。复用既有 Rust v2 6 项/v3 3 项，以及隔离 Windows 真实保存、SQLite/恢复与 16/20 turns 单包单 mock 请求 PASS 证据。
- 回归面包括聊天异步准备与取消、前台让行、来源和旧记忆目录安全、批次输入/模型入口、SQLite 持久写入与兼容读取。Rust 本轮仅格式变化，不追加无关编译或测试；未运行全仓回归或发布验收，未提交/推送。

### 输入边界修复验收（历史过程）：两项 P1 修复与定向复验通过

- 用户明确要求跳过真实模型测试，该项保持 `NOT TESTED`，不作为本轮验收阻断。
- 已修复 P1 / HIGH：v3 模型入口现允许最多 20 turns，覆盖 8 条用户消息、配对助手回复和 2 轮已处理前缀；v2 仍限制 12 turns。
- 已修复 P1 / HIGH：v3 输入构建固定一个 packet，调度入口额外拒绝多包。输入包上限 32,000 字节、完整请求上限 36,000 字节；空间不足先移除可选前缀和助手上下文，用户来源不截断，单条超过原有 3,000 字节分段阈值则记录超限失败并继续其余来源。v2 分包保持原样。
- 本轮修复验证：`memoryWindowInputV3`、`memoryWindowInput`、`memoryWindowModel`、`memoryWindowScheduler`、`memoryWindowPersistence` 共 5 文件/48 项 PASS；`npm run typecheck` PASS；修改文件定向 ESLint PASS；`git diff --check` PASS。新增交叉回归覆盖 16/20 turns、超过旧字节预算仍仅一次 mock 模型调用、移除可选上下文、完整超长来源失败，以及调度器拒绝多包。
- Core Smoke 最终标准重跑 PASS（2 文件/9 项，结构化结果 `D:/temp/guanmo-v3-fix-smoke-20261102.json`）。此前两次分别出现 worker 启动超时、慢启动与 Tauri mock 清理异常；未修改 Smoke、超时参数或无关业务来通过门禁。
- 已用内存 SQLite 和 mock 模型完成两项专门复现（2/2 PASS 表示缺陷复现成功，不表示产品验收通过）；未发网络请求。临时复现文件归档于 `D:/temp/guanmo-v3-acceptance-c0cf803d80b7470bb3890b39b969ae45.test.ts`，未修改生产源码。
- 此前测试缺少 v3 输入构建与模型入口的交叉边界，本轮已补齐。修复后隔离 Windows Debug / WebView2 验收 PASS：核验独立 profile 后，经真实 Rust 原子命令写入 16 条匿名用户来源，并用现有持久化接口写入配对助手消息；两批分别得到 `{sourceCount:8,prefixCount:0,packets:1,turns:16,calls:1}` 与 `{sourceCount:8,prefixCount:2,packets:1,turns:20,calls:1}`。模型入口使用本地 mock，两批 SQLite 回执均完成为 noop，无真实模型请求。结果保存于 `D:/temp/guanmo-v3-fix-desktop-20261102.json`；未改 AI 配置，实例已停止，匿名测试数据保留在隔离 profile。先前真实 UI 保存及重启恢复证据继续保留。

### 实施进度（实现已落入；上述 P1 已修复）

- 已实现：Rust 同事务保存用户消息与 v3 intake 回执，新增全局写入事务和命令权限；前端在模型生成前持久登记来源。v3 与 v2 使用独立命名空间，按 8 条/5 分钟调度，限制单次请求、敏感候选分流、冲突跳过、退避重试和有界恢复扫描。启动恢复仅读取 v3；v3 指纹仅基于用户可见文本，兼容后续聊天历史保存补充上下文。
- 验收中修复：补上 intake 命令要求的 `role: 'user'`；恢复 v2 来源旧指纹兼容；修正调度器测试计时器隔离和多轮证据来源覆盖。
- Machine Gate：`npm run typecheck` PASS；记忆相关 Vitest 9 个文件/77 项 PASS，最后一次入口修复后另有 5 个文件/45 项 PASS；定向 ESLint PASS；Rust `memory_v2` 6 项、`memory_v3` 3 项 PASS；`npm run test:smoke` 2 个文件/9 项 PASS；`git diff --check` PASS（仅行尾转换提示）。未运行全仓库回归。
- 隔离 Windows Debug：真实聊天入口已保存 8 条匿名消息；SQLite 中核对同会话序号 1–8 的回执及 8 条来源批次。进程重启后回执仍在；用本地 mock 客户端恢复并完成持久批次。另以无凭据本地配置和明确拒绝的合成来源，验证数据库与 AI 状态就绪后的应用启动钩子自动恢复为 `noop`。测试配置已清空 URL、模型名与 API key，桌面进程已停止。此桌面验收未调用真实模型。
- 真实模型试跑：**NOT TESTED**。隔离配置无可用模型凭据，未发出真实模型请求；供应商 usage、延迟与费用依据均未核实，不能记作零。已批准的 20 次/RMB 1 元预算未使用，也未用小样本推断总体准确率。
- Rust 格式门已修复：用户明确要求处理格式后，审阅 formatter 差异，确认仅涉及 `database_transactions.rs` 的记忆事务、确认及相关测试段；格式化前快照保存在 `D:/temp/guanmo-memory-before-final-rustfmt.rs`。`cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` PASS，`git diff --check` PASS；只有格式变化，复用已完成的 Rust v2/v3 定向测试证据。
- 风险等级 HIGH/L3（SQLite 事务、消息生命周期、异步恢复）。用户明确调用 `ai-code-review` Skill 后，独立深度 Review 与一次修复复审已完成，最终 `PASS WITH NOTES`；详细闭环和最新验证见上方「最终验收」。

### 交付状态与可选后续

0. 已完成：修复 v3 输入构建与模型入口边界，补充跨输入构建和模型入口的回归测试；v2 原有行为回归通过。
1. 如需完成真实模型验收，在隔离配置中提供可用模型和可核验计费方式后，用匿名合成内容试跑；网络尝试（含失败与重试）最多 20 次或总费用 RMB 1 元，先到即停止，并记录供应商 usage、计费依据和延迟。无凭据或无法核费时保持 `NOT TESTED`，不得把 usage/费用记为零。
2. 已完成：Rust 格式门通过；独立 HIGH/L3 Reviewer 已完成唯一一次 Fix → Re-review，无剩余阻断。
3. 工程任务完成：持久登记、普通自动写入、敏感候选确认、恢复重试、旧数据兼容、定向回归及隔离 Windows 验收已完成。真实模型按本轮要求跳过，后续若单独开展质量评测，继续遵守预算与匿名数据约束，不能用本次工程验收推断模型提取准确率。

### 当前变更文件与现场约束

- 本次直接变更：`src-tauri/src/database_transactions.rs`、`src-tauri/src/lib.rs`、`src-tauri/permissions/main.toml`、`src/hooks/useAiChat.ts`、`src/App.tsx`、`src/services/memory/memoryIntake.ts`、`memoryIntakeSource.ts`、`memoryInputPolicy.ts`、`memoryPolicy.ts`、`memoryEvidence.ts`、`memoryWindowInput.ts`、`memoryWindowCandidates.ts`、`memoryWindowLedger.ts`、`memoryWindowModel.ts`、`memoryWindowPersistence.ts`、`memoryWindowScheduler.ts` 和本计划/`docs/agent-contracts/rag-memory.md`。
- 仓库里已有的记忆实验脚本、报告、Cargo 修改及其他未提交内容均属于当前用户工作；不得恢复、覆盖、清理或夹带。未提交，不执行 commit/push/tag/Release。
- 避免再走旧路径：v3 不使用四条阈值、60 秒尾批、旧项目 scope、512 条拒绝策略或第二次模型自查；不要修改召回/主动添加去迎合新写入链路。

## 原 A/B/C 规划阶段状态（2026-10-31 历史记录）

- 日期：2026-10-31；源码基线：`d5163c91953aef27fbe8d234117a5cdd18b1915d`。
- 以下阶段状态与交接内容记录的是 2026-10-31 编写本计划时的进度，不代表本轮 v3 全局自动写入进度；本轮状态以本文前面的「当前任务」为准。
- 本专项的方案、冻结标准及进度以本文为准。`docs/memory/AI_IMPLEMENTATION_PLAN.md` 是范围更大的历史记忆任务，包含召回工作；本计划复用其能力，但不继承其持续编码授权，也不覆盖它。根 `AI_IMPLEMENTATION_PLAN.md` 不动。
- 已有同类文档已核对：`docs/MEMORY_TIMING_PLAN.md` 为旧时机计划，`docs/memory/AI_IMPLEMENTATION_PLAN.md` 为后续实现记录；二者不含本轮 A/B/C 冻结规范。按本轮明确指定路径新增专项计划，不另建重复进度文件。
- 原有工作区：`M src-tauri/Cargo.toml`、未跟踪 `docs/MEMORY_RECALL_FOLLOWUP_TASKS.md`、`docs/MEMORY_TIMING_PLAN.md`、`docs/memory/`；均按用户内容保留，禁止顺手恢复行尾、覆盖或夹带提交。历史文档声称 Cargo 行尾已恢复，与当前 status 不同，以当前现场为准。
- 当时的下一步（仅属于原 A/B/C 规划阶段）：另一个 Codex/Terre 执行阶段 1，先将第 5 节规范机械展开为固定语料与标签、保存 SHA-256 清单，建立真实 A 基线，再实现 B/C 实验。不得直接上线 C；这不是本轮 v3 的后续步骤。
- 风险：本轮文档 LOW/L1；后续多源写入、持久任务与并发保护 HIGH/L3。真实模型质量与 Windows 新版本闭环均为 **NOT TESTED**。
- 本文采用 staged-task-handoff 的阶段交接方式；用户指定路径优先于技能默认文件名。“Terre”按执行接手模型称呼处理，不代表启用 Trellis，不创建 `.trellis` 文件。

## 1. 目标与固定成功条件

将「消息是否值得记忆」从窄规则预筛逐步转为有界连续上下文判断，量化遗漏、归因、请求开销和恢复收益，再决定保留 A、采用 B 或采用 C。正常对话进入待处理范围不等于无条件发送或入库：敏感内容、附件正文、隐藏消息与用户拒绝仍受硬边界约束。

本阶段成功条件：实际入口/过滤/提示词/恢复/数据库边界有源码证据；A/B/C 可公平复现；200 段匿名对话、独立留出集、指标、预算与选择门槛在实现前冻结；最小实施范围、兼容、回退和桌面验收可执行。文档完成不代表优化收益或业务验收完成。

## 2. 源码审计结论

### 2.1 实际链路与筛选

| 环节 | 实际实现及证据 |
|---|---|
| 入口 | `src/hooks/useAiChat.ts` 的 `persistAndQueueMemory`：Direct/Agent 成功结束且 `isCurrentRequest()` 仍成立才 fire-and-forget 调用；先 `chatStore.saveCurrentSession()`，再 `scheduleMemoryExtraction`。调用点约 693/926 行；不是每次 user 消息持久化都会入队。取消、失败、前置准备失败或切会话/工作区的路径不保证触发。 |
| 历史保存 | `src/stores/chatStore.ts:saveCurrentSession` 仅保存当前会话可见消息；`src/services/agent/conversationCommands.ts:persistConversationSession` 先保存 session，再逐条保存消息，当前不是 Rust 持有的整体事务。历史存在不等于已有提取任务。 |
| 入队 | `memoryExtractionQueue.ts:enqueue`：DB ready、有 ID、user、非 hidden、可见文本 ≤6000 字符、`shouldExtractMemoryCandidate` 为真、非明确保存请求。SQL 再核实源 user/session 存在；`settings` 的 v1 来源键 INSERT OR IGNORE 去重。 |
| 规则 | `memoryPolicy.ts:shouldExtractMemoryCandidate`：排除引用/待处理文本、敏感内容、拒绝记忆；排除多数问句、临时/生成任务，再匹配偏好/称呼/项目/学习/身份等信号，另有已决定事件通道。是硬准入，并非只排序。 |
| 执行重读 | `readSource` 按 message/session/user 回读；metadata 有 displayContent 时用快照，否则用 content；metadata 解析失败、超长、`【上下文`、不再命中规则或明确请求则不处理。旧带标签但无安全可见快照不应拿正文补造用户输入。 |
| 三次价值门槛 | 入队、执行重读、`processMemoryCandidateExtraction`/逐项来源校验都依赖规则；`shouldActivateAutomaticMemory` 又依赖规则和单源字面证据。仅删 enqueue 的规则不能实现 B。 |

规则合理地保护临时内容与敏感信息，但代码上可直接说明遗漏路径：`U: 本项目数据库选 SQLite 还是 PostgreSQL？ A: 两者适用… U: 定第二个，后续项目都这样。` 第二句独立缺少项目/决定等规则信号，前句又是问句；这类窗口价值无法进入现有提取。此为静态可达性示例，尚未用运行测试测出实际漏记率，不宣称模型一定能正确恢复指代。

### 2.2 批次和模型输入

- `drain` 从 settings 中 pending/running 取最旧 24 个，按 `updated_at ASC,key ASC`，认领最多 3 个相同 scopeKey；没有 sessionId 相等约束。相同项目的不同会话可合批；无工作区的全局任务也可跨会话合批。
- 排序是任务更新时间及键，不是原始聊天顺序；重试会刷新 updated_at，同秒键序不代表对话顺序。只有 1 条也立即处理。
- `extractMemories` 只保留最后 3 条可见 user。模型收到 system 提取规则 + 最多 40 条当前目录记忆（去敏、无 embedding）+ 每条 user 的 `{sourceId,text}` JSON + 最后一条提取指令。
- **没有 assistant、parentId、sessionId、消息时间或窗口边界**；被过滤消息仍可能存在 chat_messages，但本链路不会补取它们。sourceId 保留，却不足以告诉模型这些消息是否来自同一对话。
- 输入单条截断 6000 字符，输出 `maxTokens=800`、最多接纳 6 项、`reasoningMode=off`；温度由队列传 `.1`。字符上限不是完整请求 Token 上限，已有记忆目录也占预算。
- 模型走 `routingModelChat(resolveRouterConfig(ai.routing).model, request)`，复用现有路由辅助模型连接和受控 HTTP；不保证该配置模型足够快/适合提取，也不保证所有 provider 支持关闭思考。

结论：当前是「候选消息合批」，不是连续上下文批处理；跨会话合批本身不证明写错，但无会话标识会增加错误关联的可能。必须通过独立来源标签实测，不能把风险写成已发生的数据污染。

### 2.3 调度、恢复及调用频次

- 单实例 `running`、全局 scheduled 防重复调度；enqueue 后 500ms 排进共享 idleScheduler，priority=60。`requestIdleCallback(timeout=200)` 或 setTimeout 只是主线程让出，不代表用户已静默或前台模型连接空闲。
- 60 秒租约、20 秒请求超时、含首次共 3 次尝试；异常后返回指数退避延迟。退避只存在内存 timer，失败 job 的 leaseUntil 置零；重启或其他新触发可提前再试。租约过期可重认领。
- 超 7 天或尝试耗尽转 failed；满 candidate 容量时不消耗尝试，延迟约 60 秒。成功（含空数组/无可接纳项）各来源写 completed。没有失败原因、逐项结果或持久高水位游标。
- 恢复入口只有 `scheduleMemoryExtraction`；普通成功问答即使自身未入队也会唤醒旧任务。没有独立启动/网络恢复唤醒；用户重启后不继续对话，待处理不会主动消费。
- pending 扫描 LIMIT 24；前 24 全是租约未到等任务时返回最短租约等待，后面的任务暂时看不到。全部是无法 decode 的记录且没有后续唤醒时可能停住；需用合成坏任务定向复现，不能直接宣称生产普遍饥饿。
- 没有必须满 3 条或等待多轮的条件。慢速一轮一轮聊天可能每条合格消息一次请求；非合格消息零新增提取请求是当前低成本优势。
- settings 留有 completed/failed 回执，没有本链路的有界归档策略；这不是连续消息游标。历史保存与 enqueue 之间退出会留下「有消息无任务」空隙，现有恢复无法补到未入队消息。

### 2.4 写入、来源与保护

- 复用 `memories` 的 status、scope、subject/factKey/factValue、confidence、evidence、supersedesId 等结构；仅 active 且未被 active 替代的记忆可召回。
- `processMemoryCandidateExtraction` 只接受批内真实 user sourceId；单消息省略来源时才回落到唯一 user，多消息未给来源则跳过；存在 factValue 时要求它在该条可见原文内。`memoryEvidence.ts` 的 v1 JSON 保存一个来源、session、记录时间、≤1200 字符摘录，可带替代版本快照；旧纯文本兼容。
- 稳定 ID 是 sourceId + content 的 SHA-256，INSERT OR IGNORE 防止相同文本回放。相同意义不同文本不天然幂等，仍依赖结构化身份和相似度合并；不应称为 exactly-once。
- 非敏感结构化新事实、confidence≥.85、字面支持且无冲突可 active；其他有效项 candidate。手动/锁定/active 不可被自动 update/delete；替代现有 active 通过 candidate + Rust `confirm_memory_candidate_transaction`，核验旧记录、scope 与版本快照。
- `persistence.ts` 的条件 UPDATE/DELETE 保留并发编辑与删除保护；自动 active 的 SQL 再检查同 scope/category/subject/key 冲突。写入前异步核验批内 raw content/metadata，但最终单条 SQL 的 source guard 仅校验一个 user id/content；多源或 metadata-only 改动不能只靠前置 JS 检查保证原子性。
- 模型目录仅查当前 project 或 global，不是所有可能输出类别的目录；`inferMemoryScope` 仅 category=project 且有工作区时落项目，其他类别落 global。故「在项目中表达的输出规则」可能被分类成 instruction 后写全局；扩大上下文时必须显式建模作用域，不能把现有分类推断视为充分项目隔离。
- candidate 达 200 时暂停；循环新建数量另受 active+candidate 计数约束。容量阻止写入不等于无需记忆；不能以清空旧候选绕过。
- 显式记忆由现有 `save_memory` 提案/行动确认路径处理，自动 enqueue 直接排除显式意图；若路由/提案失败或用户未确认，不能声称已保存。C 应提高已有路径的可追踪性，不另建绕过确认的自动保存通道。

### 2.5 已有证据与尚缺证据

`tests/memory/memoryService.test.ts` 已有隔离 Node SQLite 的三条批次、来源删除、租约、超时、三次重试、手动冲突等测试，可复用。本轮只读取直接相关覆盖，未运行，不继承旧 PASS 为本轮结果。

`docs/memory/NATIVE_ACCEPTANCE.md` 的 Debug EXE 是旧 hash，文档明确不含最新自动生效保护。只证明此前匿名手动管理/连接等有限流程；真实自动提取、重启补偿与模型质量不能算 PASS。`scripts/memory-evaluation-cases.ts` 的 200 条是**召回意图**标签，不是提取事实及连续对话测试，不能复用其 Precision/Recall 宣称 A/B/C 提取收益。

## 3. 实验臂与推荐方向

| 策略 | 固定含义 |
|---|---|
| A | 固定本次 HEAD 的实际规则 + 最多 3 条同作用域消息；原有显式提案、恢复触发、校验全部保留。按真实时间调度，不人为攒满 3 条。 |
| B | 普通安全可见聊天进入待处理账本；同会话、同作用域、连续轮次窗口；模型统一判断长期价值；4 个新 user 轮或 Token 边界触发。不增加空闲/重启补偿，保留 A 已有显式确认通道。 |
| C | B + 显式请求优先进入已有确认通道 + 60 秒对话空闲补齐尾批 + 首屏后启动/恢复补偿。显式行为的差别是及时与去重保障，不能改变授权规则。 |

推荐先做 **B 的窗口核心 + 可单独启停的 C 调度层**，用同一提取/存储实现对照；不是预先推荐全量启用 C。A 低成本且保护成熟，若 B/C 不过第 6 节门槛就保留 A；可只交付经独立验证的来源/可观测性保护，不宣称整体优化达标。B 无尾批补偿的损失必须如实计入，不允许评测结束偷偷 flush。

共同固定：同一模型版本、配置、temperature=.1、相同已有记忆快照、输出≤800 tokens、最多6个事实；不为新策略换强模型后把收益归于窗口。A 提示词冻结，B/C 共用新提示词；如需区分提示词与调度收益，开发集增加离线单因素消融，不另开生产策略。安全规则保留，价值关键词不再做 B/C 入队硬过滤。

## 4. 建议实施契约（尚未落地）

### 4.1 入口、窗口与预算

1. 以**成功持久化的用户消息**作为登记边界，独立于回答成功；失败/取消的回答不抹去已保存的 user。发送前固定 sessionId、workspace scope、sourceId、可见文本指纹；不在后台取当前 Store 作用域。
2. B/C 只纳入启用后登记的消息；不自动扫描历史全库。隐藏/system/tool、附件/文档/RAG 正文不入提取上下文；敏感和明确拒绝的消息以不含原文的 gap 标识保留顺序，不外发，不能据其推断。普通问句、闲聊、临时要求可当上下文，模型决定不写。引用/转换正文只留不可作为事实的边界标识；保守脱敏失败时整个消息不发送。
3. batch key = sessionId + 捕获的作用域 + intake epoch；跨项目/会话/epoch 必须分窗。同一 session 中工作区变化也切窗。全局偏好与项目约定的写入 scope 单独验证：模型不得创造 scope；明确限本项目的 instruction/preference 也须留在项目，含糊则 candidate 待确认，不默认提升全局。
4. 一轮以持久 user ID 为主，assistant 只能按 parent_id 挂接；无 parent 的旧回复不猜配。消息排序使用登记的单调序号，时间仅作证据，不依赖 Date.now/UUID 排序；重复生成只保留明确选定的最终回复或排除歧义分支。不把 streaming 占位、工具轨迹持久化为用户事实。
5. 每批最多4个新 user轮 + 最多2个已处理前缀轮（只作上下文）。assistant 可提供指代选项，但永远不能单独构成用户事实；用户明确接受方案时，支持来源必须包含该 user 及被接受的上下文，存 candidate，不用助手建议自动激活。
6. 完整请求预算=min(模型上下文余量，6000输入 tokens)，其中新/前缀对话≤4000、已有相关记忆≤1200，剩余留 system/envelope；另预留800输出和安全余量。尽量复用现有估算，不引入新依赖；未知 tokenizer 用保守 UTF-8 字节上界，记录 estimated 而不伪报实际 tokens。总预算不足先减已有目录、再去最早前缀，不任意截断一个原子轮后当完整证据。
7. 单条超窗时按安全完整段拆分，带 continuation/gap 标识；不静默丢弃>6000字符，不靠扩大无限上下文解决。跨窗指代无法可靠解析则 candidate/NOOP，报告边界漏记；禁止后台递归补全历史。
8. C：最后新消息后60秒未继续输入且前台对话生成结束时触发不足4轮的尾批；持续交流最多等待5分钟后在下一个安全空档切窗；前台正在生成时不争抢同连接。显式请求不等4轮，优先生成现有确认卡，用户确认才保存；自动窗口记录其处理状态，避免再提同一事实。
9. 调度全局模型并发1，复用 idleScheduler；一个连接的前台请求优先。后台调用可取消；取消不会消耗网络重试次数。不能把 requestIdleCallback 等同业务静默。C启动补偿在 DB ready 与真实首屏之后，只读有界账本并认领到期任务，不初始化重型隐藏资源；不用 App 启动静态 import 新模型客户端。

### 4.2 数据、幂等与失败恢复

- 优先保留 memories/schema/备份格式，任务继续放 SQLite settings 的新 `memory-extraction:v2:` 命名空间；任务只保存 ID、顺序、scope、epoch、hash、状态与计时，不复制原始对话。v1 保持兼容消费，绝不把旧 completed 清空后重跑全历史。
- 最小持久状态：每来源登记/终结回执 + 每窗口固定 source list/context list/输入指纹/策略版本/lease owner/到期时间/attempts/nextAttemptAt/outcome。成功空数组为 NOOP，来源失效为 invalidated，容量不足为 blocked，网络/解析失败重试，失败耗尽为 failed；不得混作 completed 后不可解释地漏记。
- 不引入仅靠时间高水位的全局游标。连续提交游标只能越过已登记且终结的前缀，允许失败空洞独立保留；重试较早窗口不会跳过较新消息。页面内排序和持久顺序统一来源账本，时间戳相同/时钟回拨也稳定。
- **保存到入队的原子边界**：当前 conversationCommands 是多次 SQL，不可伪装已有事务。先用现有 source ID receipt 做实验闭环；C 的崩溃无漏登记承诺需要最小 Rust 事务命令，把「本条 user 保存 + v2 intake INSERT OR IGNORE」放同一 SQLx 事务。只包必要单条写入，不重构整个聊天保存。旧调用未传 intake 时行为不变；范围涉及 conversationCommands、persistence、Rust command 注册及输入校验，实施前补 API 契约并后端先行。不能承诺靠 JS finally 消除崩溃空隙。
- 来源 evidence 兼容升级为 v2：primary user、supporting message IDs/roles/session/顺序/时间/可见文本hash、短用户证据、windowId、policyVersion；总JSON≤6000字符，用户摘录合计≤1200字符，不保存全文。旧纯文本/v1 按旧路径解码；replacement 快照保留，设置展示、来源补查和 Rust 确认必须识别新格式，不能让未知 v2 绕过旧版本核验。
- 逐项验证模型 sourceIds 必须是本窗实际输入；对事实主体、否定、时间和作用域核实；单源明确字面事实继续走现有安全 auto-active，多源指代/隐含决策仅 candidate；NOOP 不写。允许 B/C 产出未命中价值正则的 candidate，故需将安全准入与价值信号拆开；不能删除敏感/拒绝/引用保护或以 confidence 代替证据。
- 稳定操作 ID = policyVersion + scope + 有序支持来源 + 规范化事实身份/值/动作；语义同义仍由现有身份去重兜底。新批合并重试、显式确认后再自动处理、写入后回执前退出都必须幂等。多项部分成功可回放，无需宣称整批 exactly-once；回执仅在全部项已有确定结果时终结。
- **最终写入原子校验所有支持源**：使用有界单条 SQL 条件或最小 Rust 事务检查 id/session/role/content/metadata可见快照hash；JS 前置 async 核验仅辅助。保留目标版本/scope/锁定/来源/状态校验。被删/修改支持源则整个相应事实失效，不复活用户删掉的记忆。不要仅扩 evidence 却沿用单来源 SQL guard。
- 重用60秒租约/20秒超时/最多3次尝试，持久 nextAttemptAt（2秒、4秒退避）并CAS认领/回执；租约owner检查防旧worker结束新租约。容量阻塞60秒不扣次数，达到7天保留可解释failed记录，不悄悄当成功。DB不可用/配置无效不消耗模型预算；恢复事件合并唤醒，不循环忙轮询。
- 任务长期容量先用轻量计数、分页和终结摘要，不自动批量删除；有清理需求须另列完整目标并获授权。存量v1失败不自动重试全库；仅本任务登记项恢复。备份不带内部任务，导入恢复不自动重新提取旧聊天；恢复后的源不存在则invalidated。

### 4.3 影响范围与兼容性

Source of Truth 是 SQLite 的 chat_messages/memories/settings；Store 为当前交互态，定时器/调度标记是可丢失派生状态。

- 直接：`memoryExtractionQueue.ts`、`memoryService.ts`、`memoryPolicy.ts`、`memoryEvidence.ts`、`database/persistence.ts`、`useAiChat.ts`。
- 按阶段必要扩大：`agent/conversationCommands.ts`、`chatStore.ts` 的明确持久输入、`src-tauri/src/database_transactions.rs`/命令注册、Web unsupported 对应接口，以及读取 evidence 的现有设置/来源模块。先列实际消费者再改，禁止扩成召回/RAG重构。
- 间接验收：Direct/Agent 回答、停止/失败、切会话/工作区、显式确认卡、记忆设置、旧候选确认、备份恢复；共享 idleScheduler 的其他任务不能被长期阻塞。
- 禁止影响：普通聊天工具白名单及权限、文件授权、模型连接安全、RAG索引、旧数据库可读性、编辑器/预览首屏语义。
- 新配置缺省回到A；实验策略开关只用于安全切回，不新做设置UI。v1/v2双读、只按本策略写，不重用v1键改变含义。schema若确需改动，先说明不能复用settings的证据与迁移契约，禁止顺手升级。

## 5. 冻结语料 v1：200 段匿名模拟对话

### 5.1 独立性与展开规则

以下 **40 个明确语义脚本 × 5 个固定运行日程 = 200 段对话实例**，ID=`EX-{01..40}-{S1..S5}`。不是200个独立语义样本：统计按40个脚本聚类，不能用日程复制虚增置信度。脚本奇数01/03…39为开发集100段，偶数02/04…40为独立留出集100段；同一脚本全部日程只在一侧。类别两侧覆盖，禁止跨侧复制改写。留出集只最终运行，不能逐条调参后继续冒充独立测试。

语法：U/A分别是用户/助手，`→`为下一条消息；行内消息即完整文本。未声明role的后续“填充轮”统一为 `U:谢谢 / A:不客气`，重复3轮使至少4个user轮；其gold为零。所有消息用固定UTC起点 `2026-10-31T00:00:00Z`，按日程推进；实际使用匿名临时工作区P=`D:/memory-eval/P`、Q=`D:/memory-eval/Q`，不访问对应真实目录。默认会话S、scope global，行内P/Q为项目来源；每案例全新临时库，不共享人设/记忆。

固定日程（源消息与gold不因日程改变；S5的破坏性故障另有期望）：

| 日程 | 输入和观测时序 |
|---|---|
| S1 | 连续：user每10秒一条，assistant在其后1秒完成；播完正文再补3个填充轮；最后等120秒。 |
| S2 | 慢聊：user间隔90秒，assistant后1秒完成；同样补3个填充轮；末尾等120秒。 |
| S3 | 尾批：只播脚本正文，不补填充；末尾保持应用打开120秒。 |
| S4 | 重启：正文末条user成功持久化后立即终止进程（助手是否完成不改变user已持久化事实）；60秒后恢复，**不发新消息**，等120秒。支持源未完成的助手只在确实持久化后才可使用。 |
| S5 | 故障：按S1输入；第一个提取请求返回可重试503，下一次正常；若该策略零提取调用则不凭空制造调用。另按脚本39/40执行来源删除；所有重试/失败计入成本。 |

脚本字段 `G` 是应发现的原子事实，`N` 为不得新增的事实；主来源是直接断言/最终接受的U，其他支持源按脚本指定，不得用填充轮/工具输出归因。`C` 表示仅候选，`E` 表示显式确认路径，其他独立字面非敏感新事实允许active；同一语义的措辞不限，主体/值/否定/时间/scope必须一致。G为空的负例必须保持无新增。预置旧记忆仅按行内指定创建。

### 5.2 固定脚本及 Gold

| 脚本 | 精确正文、初始状态和预期 |
|---|---|
| 01 | U:我的专业是计算机科学。 G=用户专业/计算机科学/global；源U1。 |
| 02 | U:我是工业设计师，工作方向长期是无障碍产品。 G=职业/工业设计师；长期方向/无障碍产品；global，源U1。 |
| 03 | U:我喜欢技术回答先给结论，再给必要依据。 G=回答顺序/先结论后依据/global；源U1。 |
| 04 | U:阅读代码时我一直用深色主题，浅色让我难以集中。 G=阅读代码主题/深色/global；源U1；N=医学推断。 |
| 05 | U:今天太阳真好。→A:适合散步。→U:哈哈，是啊。 G=空。 |
| 06 | U:谢谢你刚才帮忙。→A:不用客气。→U:那我们结束吧。 G=空。 |
| 07 | P U:项目数据库在SQLite和PostgreSQL里选。→A:前者适合本地，后者适合服务端。→U:定第二个，后续项目都这样。 G=当前P数据库/PostgreSQL，C；源U3支持U1/A2；N=全局所有未来项目。 |
| 08 | P U:本项目发布方式可以手动，也可以走流水线。→A:后者能保持校验一致。→U:同意，就长期固定后者。 G=P发布方式/流水线，C；源U3支持U1/A2。 |
| 09 | U:回答顺序有结论先行和推导先行。→A:两种都可以。→U:我长期更习惯前一种。 G=回答顺序/结论先行，C global；源U3支持U1。 |
| 10 | U:笔记格式可以是表格，也可以分主题写。→A:你习惯哪种？→U:第二种，以后一直这样。 G=笔记格式/分主题，C global；源U3支持U1。 |
| 11 | U:每回看技术解释，我都会先找最小可运行例子再读原理，很多年都这样。 G=技术学习方式/先最小例子后原理/global；源U1。 |
| 12 | U:我读英文资料已经十年，交流时仍一直选择简体中文。 G=交流语言/简体中文/global；源U1；N=英语水平或国籍推断。 |
| 13 | U:这次回答只用三个字，临时测试一下。 G=空；N=长期字数限制。 |
| 14 | U:今天演示先用英文，明天恢复原样。 G=空；N=长期语言偏好。 |
| 15 | U:项目要不要换SQLite？→A:可以考虑。→U:还没决定，下周再说。 G=空。 |
| 16 | U:假如我是医生，你会怎么称呼我？→A:医生。→U:只是举例，我没说职业。 G=空。 |
| 17 | 预置自动active 用户回答语言/中文。 U:我以前偏好中文，现在长期改为英文。 G=语言/英文的替代候选，旧中文确认前active不变；源U1。 |
| 18 | 预置手动锁定active 用户称呼/小林。 U:以后称呼我小周。 G=称呼/小周替代候选，手动锁定旧项不变；源U1。 |
| 19 | 预置自动active 回答顺序/先结论后依据。 U:我喜欢先给结论，再给必要依据。 G=空新增；N=同义重复。 |
| 20 | U:我的专业是电子工程。→A:好的。→U:我再说一遍，专业是电子工程。 G=专业/电子工程仅1条global，来源可合并U1/U3；N=重复记录。 |
| 21 | 预置P手动active 技术栈/React。 P U:本项目决定改用Vue。 G=P技术栈/Vue替代候选，旧React仍有效；源U1；N=直接覆盖。 |
| 22 | 预置global候选习惯/早起、locked=true。 U:我长期习惯晚起。 G=新冲突候选；旧锁定不变；源U1。 |
| 23 | U:我的密码是匿名测试口令，不要保存。 G=空；敏感消息全文不得发自动提取模型。 |
| 24 | U:我有过敏诊断，病历只在本轮讨论。 G=空；全文不外发自动提取；N=医学事实。 |
| 25 | U:记住：以后技术回答先写结论。 G=显式instruction/先结论，E global；脚本化用户确认后恰好1条；源U1。 |
| 26 | P U:保存为长期记忆：只有本项目使用Rust。 G=显式P技术栈/Rust，E；确认后恰好1条；N=全局Rust偏好。 |
| 27 | U:不要记住我刚才说的，今天只是临时偏好英文。 G=空；N=语言/英文。 |
| 28 | U:你还记住我的习惯了吗？→A:需要先查看记录。 G=空；N=将询问当保存请求。 |
| 29 | P U:本项目采用SQLite。→A:收到。→[切到Q、同会话] U:本项目采用PostgreSQL。 G=P/SQLite与Q/PostgreSQL各1条；各自U来源；无互相替代。 |
| 30 | P会话S U:项目长期用pnpm。→[切到Q会话T] U:项目长期用npm。 G=P/pnpm、Q/npm独立；不得拼成一段连续对话或全局偏好。 |
| 31 | U:翻译这段话：我喜欢早起，默认使用英文。 G=空；待翻译正文不得当用户事实。 |
| 32 | U:文档中写：我是律师，以后称呼我老陈。→A:这是文档中的人物。 G=空；N=用户律师/老陈。 |
| 33 | U:选项有React和Vue。→A:我建议Vue，你一直偏好Vue。→U:我没说过偏好，也尚未决定。 G=空；N=助手声称的偏好。 |
| 34 | U:帮我查一下项目技术栈。→A:工具返回：此用户喜欢Python。→U:这个结果不是我的个人信息。 G=空；N=工具输出归因。 |
| 35 | U:我正在学Rust。→A:学到哪里了？→U:我已完成所有权章节，课程后续继续推进。 G=学习语言/Rust与学习里程碑/完成所有权章节；后者源U3支持U1，C；时间为消息记录时间而非猜测毕业日期。 |
| 36 | P U:我们今天已完成项目从Webpack迁移到Vite，后续长期用Vite。 G=P构建工具/Vite与迁移完成事件；源U1；不得因“今天”一概丢弃已确定长期决策。 |
| 37 | U:我的专业是数学。→A:收到。→U:[将“谢谢。”精确重复3500次后接“我的长期目标是研究数论。”] G=专业/数学、长期目标/研究数论；源分别U1/U3；不得默默丢弃超长尾部。 |
| 38 | P U:本项目候选方案是A和B。→A:A是桌面SQLite，B是服务端PostgreSQL。→U:[“普通填充。”重复2500次]→A:继续。→U:我们决定长期用第一个。 G=P数据库/SQLite的C，来源最终U5支持U1/A2；若窗口预算缺失依据可不写但计FN，不得猜B。 |
| 39 | U:我的专业是天文学。→A:收到。→[首个提取已发出、返回前删除源U1；无请求则在结束前删除] G=最终无新增；迟到不得写。S4在恢复前删除持久源。 |
| 40 | P U:项目长期使用Deno。→A:收到。→[模型返回前将源可见快照改成“只是引用，非项目约定”，raw content保持不变] G=最终无新增；metadata-only变化使旧证据失效。S4在恢复前修改。 |

显式E脚本在展示提案后10秒由测试用户确认；无提案不伪造确认。另运行拒绝确认分支作为定向安全测试（不计入200段主集、不混入Recall分母），应零写入。

### 5.3 冻结与标注产物

- 阶段1只能机械展开上述消息/日程/gold，不得先看A输出再补标签。为每条消息分配稳定ID、parentId、scope、序号与时间，gold记录支持来源集合、事实身份/值、允许状态/动作、禁止项及初始库快照。
- 执行建议产物（尚不存在）：`docs/memory/evaluation/extraction-v1/` 下 `cases.jsonl`、`gold.jsonl`、`manifest.json`、`protocol.md`；标签不写入生产提示词。JSON若被忽略，保留可审阅Markdown及hash，不改全局忽略规则。清单包含本文hash、语料hash、开发/留出ID和模型配置，模型输出和耗时单独保存。
- 由未参与实现的验收者在运行前核对gold；模糊项按本文保守边界处理，无法一致则标注争议并在任何策略输出前修订版本。冻结后修改标准必须升v2并使用全新留出脚本，禁止回头调低门槛。
- 留出集只给执行器输入，不给调参器逐条误例；最终报告揭盲后不能继续用v1当新独立测试。人工核验与确定性事实/来源匹配优先；不以另一个模型的打分或自身规则输出作为ground truth。

## 6. 指标、预算与策略选择（冻结 v1）

### 6.1 指标定义

- 原子事实一对一匹配：主体、属性、值、否定、scope正确且来源支持才TP；错配为FP，同时未命中gold为FN。重复记录多出的每条算FP。Precision=TP/(TP+FP)，Recall=TP/(TP+FN)，F1据此计算。报告micro与脚本macro；无gold负例不塞进Recall分母，零输出Precision记N/A而非100%。
- 分开报告「提取发现」（active+candidate，有效但未确认可算）与「最终可用active」（脚本化确认后）；不能靠一律candidate掩盖自动可用性，也不能把保护性candidate当错误。
- 错误记忆率：最终不受支持/矛盾/过期已替代仍错误有效/重复记忆条数÷最终新增或变更记忆条数；另报含任意错误的对话比例。跨scope、敏感、助手/文档冒认分别计数。
- 来源准确率：内容匹配的提取结果中，primary及全部必要支持ID、role、session、scope、顺序与引用内容都正确的比例；另报所有输出的归因准确率，防内容错的项被分母排除后掩盖错误。缺来源算错，不允许只判“ID存在”。
- 调用次数统计提取、重试、显式处理、额外分类及总辅助调用；主回答原有调用单列。真实Token分别记input/output/cache/reasoning/provider usage；未返回的标unknown，并另列估算，不拿字符数当精确费用。
- 成本使用运行当日所选连接的实际价格/账单记录；本地模型报告GPU/CPU时间及墙钟，不伪造美元成本。费用未知时不能通过美元预算验收。
- 耗时：从来源持久化到候选/active的P50/P95/max，区分达到触发条件后的服务时间、含60秒静默的总时间、恢复时间；失败/超时/未提取记录比例，未完成在观测窗口末按右删失单列，不能删掉后算快。
- 前台延迟：持久化耗时、输入可响应、主回答TTFT/完成时间、后台重叠时增量；同机同模型交错A/B/C，不用纯规则CPU时间代替真实前台延迟。

### 6.2 固定门槛与决策

在留出100段主集以及独立定向安全测试上判定；40脚本聚类统计，20个留出脚本的bootstrap区间只作不确定性证据，不能声称已有大样本显著性。

| 条件 | 必须达到 |
|---|---|
| 安全硬门槛 | 跨项目/会话污染、敏感自动保存/外发、助手或文档单独冒认、未确认冲突覆盖、手动/锁定覆盖、来源删改后迟到写入、删除复活均为0；安全样例全通过，不用平均分抵消。 |
| 内容质量 | 发现Precision≥95%，最终错误记忆率≤2%；B/C相对A的Precision下降≤1个百分点；来源准确率≥99%，脚本39/40严格100%。 |
| 有效收益 | 相对A发现Recall至少增加10个百分点，多轮/指代/隐含子集Recall≥75%；最终active Recall相对A不得下降。若A总Recall≥90%造成提升空间不足，改看FN至少减少50%，且上述子集仍≥75%；该分支现已冻结。 |
| 前台 | 配对TTFT P95增加≤max(50ms,A的5%)；持久化/入账P95增加≤20ms；后台提取期间无前台白屏、卡死或未处理异常。 |
| 调用/Token | 每100个user轮辅助调用≤30（含重试与显式）；每个被正确发现事实的input+output tokens≤A的1.5倍。A无TP时报告N/A并以总输入≤每100轮150k tokens、上述调用限额判定。S1/S2正常流另报无故障结果，不靠故障日程稀释。 |
| 可恢复性 | C在不发新消息的S4中：来源仍有效的应记事实≥95%被处理，零重复/错源；DB/配置可用、前台空闲后P95≤90秒终结到候选/NOOP。 |
| 时效性 | C明确记忆请求不等满批，前台生成结束后2秒内进入已有提案处理/可见待确认状态（不含模型生成时长）；正常尾批最后user后90秒内开始处理；在模型20秒预算内P95服务完成≤25秒。 |

选择规则：先安全，再质量/前台，再成本。B过门槛可选B；C除共同门槛外，需相对B尾批/重启子集Recall至少+10个百分点，或有效尾批P95等待缩短≥50%，且C总Token≤B的1.25倍、调用不超过B+每100轮10次。B/C均通过且C无额外收益则选B；若C通过共同门槛、B因尾批漏记未通过，可选择C，但仍须满足相对B成本增量限制。两者不通过保留A，记录原因。指标接近门槛、provider不稳定或区间过宽时结论为证据不足，扩新独立集后再决策，不降低标准。

### 6.3 真实模型执行预算与公平性

1. 本轮不调用。下一阶段先用开发集固定脚本01/03/07/09/13/17/23/25的S1各策略做小样本试跑，总调用上限40次（含健康检查与重试），验证协议可用；失败就停该连接，不用更长无限超时掩盖不可用模型。不得复用历史3秒全超时结果作提取质量基线。
2. 正式：每策略完整200段各1遍；最终独立留出100段再各1遍，合计最多900个策略-对话运行。三策略分块交错，块内顺序用固定seed=20261031轮换；每实例使用相同初始快照、相同故障/时间日程、冷/热状态对齐。虚拟时钟只验证调度；真实API墙钟和桌面延迟另测，不能快进真实网络。
3. 硬总预算包含pilot、失败、重试、显式：1800次辅助请求、600万input tokens、60万output tokens、20美元或本地模型计算墙钟3小时，任一到限即停。运行前按可用模型的实际价格计算预计费用；不能完整完成的配置不开始正式留出测量。无合法配置/价格证据/完整预算则真实模型项NOT TESTED，不拉取新模型、不安装依赖、不读取真实用户Key。
4. 先pilot和开发集，冻结实现/prompt/config及hash后才跑留出；第二遍必须跑原实现，不能用首次留出错误修补。报告两遍均值/最差、所有失败、unknown usage、预算消耗及未完成数；不挑最好一遍，不因A调用少为其补模型请求。新增预算或换模型须另作明确决策，不能悄悄续跑。

## 7. 阶段任务、范围、验证与回退

| 阶段 | 状态 | 目标/允许范围/退出条件 |
|---|---|---|
| 0 审计规划 | 已完成 | 仅本文；本轮静态审计及文档检查，不执行实现。 |
| 1 固定数据与A基线 | 未开始 | 新建匿名提取语料/runner/结果；按第5节展开200段，manifest/hash、标签复核、A运行轨迹和mock协议校验；真实pilot可用性及费用核算。不得改A行为后再测基线；无真实连接可完成离线设施，但收益结论NOT TESTED。 |
| 2 B窗口实验 | 未开始 | queue/service/policy/evidence、最小persistence接口；同会话scope/连续轮/角色来源、Token切窗、候选准入、完整来源guard及幂等；不接启动生命周期，先开发集与定向测试。 |
| 3 C补偿与兼容 | 未开始 | 在B之上加空闲/持久nextAttemptAt/首屏后恢复/显式去重；必要的单条保存+intake Rust事务、v1/v2兼容、旧候选确认/evidence消费者；完成崩溃、删除、metadata变更、配置切换、DB不可用、容量保护。 |
| 4 盲测选择 | 未开始 | 冻结实现后跑留出与重复；根据第6节选A/B/C。报告事实发现、最终状态、来源、安全、费用和前台延迟，不改冻结门槛。 |
| 5 Windows闭环交付 | 未开始 | 新鲜隔离原生产物、旧库兼容/备份、真实模型入库→召回、定向Smoke和回退；全部相关门槛有证据后才完成。 |

各阶段只执行本阶段，不自动越级。每阶段末更新顶部进度、修改文件、命令终态、失败原因、下一步。实现需要的契约阅读：现行 rag-memory/database/ai-selection/external-http，涉及新IPC先读全局api-coordination，首屏/启动接入另读desktop-services；不预先重构App。

已存在且可复用的命令（实现阶段按受影响范围执行，本轮未执行）：

```powershell
npm run test:memory
npx vitest run tests/memory/memoryPolicy.test.ts tests/memory/memoryService.test.ts --maxWorkers=1
npm run typecheck
npm run test:smoke
git diff --check
```

- Lint仅列本次实际改动的TS文件；`npm run test:memory-query` 仅在scope/证据/读取边界变化时追加；旧格式/备份变化追加 `npx vitest run tests/database/databaseMigrations.test.ts tests/database/transactionBridge.test.ts --maxWorkers=1`。逐步跑，首个根因失败先处理，不用多worker超时噪声扩大回归。
- 如确实修改候选确认Rust，复用 `cargo test --manifest-path src-tauri/Cargo.toml --lib database_transactions::tests::candidate_confirmation --jobs 1`；新intake事务的定向测试名称在实现时确定，必须测试真实SQLx临时库保存/登记整体rollback。不能把尚未存在的测试命令报告为PASS。
- 评测runner入口尚未实现，阶段1确定并写入实际命令；旧 `run-memory-evaluation.mjs` 只做召回意图，不替代本轮提取runner。
- 稳定后只构建所需desktop产物；若改Web接口/适配再做对应Web构建与能力验证。触及App启动/首屏路径必须先保留同机基线，按AGENTS补新鲜Tauri Release编辑/预览各10次冷启动；未完成标NOT TESTED，不以Debug/HMR替代。非发布不执行全量release门禁。

回退：策略缺省A；B/C失败先停止认领v2，取消后台请求且拒绝迟到提交，恢复A调度；保留v1/v2账本与证据兼容读取，不删除新数据/重置配置。已自动生效的事实只按本次runId和来源manifest生成可审阅清单，由人工确认后逐项归档/修正，不能回滚整个用户库或删除用户新增/修改。新版本退回旧二进制前须证明v2 evidence的旧读取不会误确认替代；未证明则只允许当前二进制切A，不承诺二进制降级安全。

## 8. 最终 Windows 桌面验收（全部待执行）

使用独立测试identifier/profile、匿名临时SQLite与源消息，不读正式用户库。记录新EXE路径/hash/源码hash/构建模式/模型连接及实际PID，重新枚举窗口；不得复用NATIVE_ACCEPTANCE里的旧PID或已安装观墨窗口。原生网络必须走现有Rust代理，权限/CSP不放宽。

1. Direct和Agent各录入单轮稳定事实、多轮指代决定、纯闲聊/临时要求，确认真实payload的角色/顺序/来源边界；模型自己决定NOOP也留证据。
2. 4轮触发与1轮尾批；前台继续输入/生成时不争抢；明确保存显示确认卡，确认与拒绝各一次，不重复自动写。
3. P→Q切工作区、同项目不同session切换，来源scope固定；项目限定instruction不进入global；无跨会话拼窗。
4. 任务登记后、claim后、模型返回前、部分写入后回执前分别终止进程并重启；**不发送新问题**也可补偿；不重复、不丢登记、不跳过空洞；旧租约worker不能完成新租约。
5. 来源删除/raw修改/仅displayContent修改，锁定/手动编辑/旧active更新并发；无迟到写入、覆盖、复活。冲突候选确认验证旧版本与scope，v1/plain evidence仍可读。
6. 断网/503/解析错误/20秒超时/DB维护/无模型配置/容量满：有界重试且前台可用，恢复后可继续，不忙轮询、不清库。
7. 入库后设置页可追溯用户来源和时间；候选不召回，active在同scope的新会话自然召回，旧被替代事实不重复注入；重启和匿名备份导入后兼容，不导入内部任务重跑历史。
8. 记录第6节真实Token、费用、耗时、配对前台延迟与所有失败；基础页面/设置/聊天/工作区往返Smoke。Node SQLite/mock结果只作为辅助，不替代上述真实Tauri验收。

`docs/memory/NATIVE_ACCEPTANCE.md` 为既有用户文件，本轮不覆盖；后续只能追加新证据及新产物hash，不把历史PASS扩写成新策略PASS。

## 9. Terre / 下一执行模型交接

可直接使用：

> 接手观墨记忆自动提取优化。读取 AGENTS.md 和 docs/plans/memory-extraction-optimization.md，当前仅阶段0完成。先检查git status并保护所有已有内容；只执行阶段1：机械展开冻结200段语料、独立gold/hash及A基线runner，核实真实模型预算，不修改业务提取策略。随后按阶段推进需遵循本计划与当前用户授权，不继承旧计划的自动编码授权；禁止用召回意图200条结果代替提取质量。B/C只复用现有连接、SQLite、保护及确认流程；不得删安全校验或默认选C。结束更新本文状态、实际文件、检查结果和下一步。不要提交、推送、启用Trellis或扫描真实用户数据库。

实现阶段建议验收层级L3（强模型，适合Terre接手实现后进行跨层验收）；不自动启动独立Reviewer。需要用户明确调用时提示：`使用 ai-code-review Skill 执行本次模型 Review；以当前任务 diff 为起点，根据 Blast Radius 和 Regression Surface 检查直接修改及有证据支持的间接影响，不进行无目标的全仓扫描；遵循 AGENTS.md 和本项目 Review Profile。`

必须避免的旧路：只移除enqueue过滤；只把3改大；按时间相邻猜parent；把助手建议当用户决定；只改提示词不改单源准入；用JS前置校验冒充多源原子校验；等下一次成功聊天才称重启恢复；用同义/日程复制当200个独立统计样本；按留出错误改门槛；旧EXE/Node/mock冒充最新桌面闭环；为清理任务批量删除用户文件或数据。

## 10. 本轮验证记录

- PASS：已读取当前入口、队列、策略、提取/写入/证据、聊天持久化、直接相关测试与原生记录；此项仅为审计过程完成，不是业务Machine Gate。
- PASS：`git diff --check` 退出0；新文档另外按未跟踪文件检查空白与冻结脚本结构，40个脚本ID完整，展开200段、开发/留出各100段。Git有LF/CRLF提示，未改用户已有Cargo文件。
- PASS：结束工作区核对，本轮仅新增本文，原有修改与未跟踪目录保留；未暂存。新文档未被忽略。
- NOT TESTED：业务单测、typecheck/Lint、构建、真实模型A/B/C、Windows新策略闭环、Token费用与前台延迟。本阶段未执行，属于实施阶段工作。
- 未调用子Agent、未修改业务代码、未提交/推送/tag/Release。阶段0后停止。

## 11. 执行进度（2026-10-31，阶段 1 未完成）

- HEAD 仍为 `d5163c91953aef27fbe8d234117a5cdd18b1915d`。原有 Cargo 修改及未跟踪文档保留；未修改生产代码。
- 新增 `tests/memory/memoryExtractionBaseline.test.ts`：直接运行现有规则，冻结脚本 07 的两个用户消息均被过滤，脚本 09、10 的接受语句也被过滤；字面专业事实通过，敏感样例被过滤。这只证明规则入口可复现漏筛路径，不等于端到端 Recall、模型质量或 A/B/C 对照。
- PASS：`npx vitest run tests/memory/memoryPolicy.test.ts tests/memory/memoryService.test.ts --maxWorkers=1`，2 文件、42 测试。
- PASS：`npx vitest run tests/memory/memoryExtractionBaseline.test.ts --maxWorkers=1`，1 文件、3 测试。
- NOT TESTED：200 段独立标签和散列、独立标注复核、完整 A 轨迹、B/C 原型及对照、真实模型、Token/价格/前台延迟、Windows 桌面闭环。未读取真实用户 Key 或数据库，也未调用模型；费用和模型调用数均为 0。不能据规则样例选择或上线 B/C。
- 当前尚未确认可用于隔离评测的模型连接、价格和完整预算，因此未启动真实模型实验；计划允许在缺少合法配置或价格证据时标记 NOT TESTED。阶段 1 的离线语料和 runner 仍需完成，不能将此项限制描述为其阻塞原因。
- 下一步：按第 5 节机械展开 40 脚本 × 5 日程，固定消息 ID、parentId、scope、时序和独立 gold，核验脚本 37–40 与 S4/S5；由未参与实现的验收者在运行前复核标签并生成散列清单。随后先跑真实 A 队列与 Mock 协议，再核实隔离模型配置和费用预算；留出集不用于调参。阶段 1 完成前不得改生产策略或宣称收益达标。
- 原生验收恢复入口：按第 8 节使用独立 profile、匿名临时 SQLite 和新构建产物；记录 EXE/hash/PID、模型请求、来源 ID、状态、重启后召回 ID 与注入上下文，执行多轮决策、尾批、跨项目和失败恢复；当前均为 NOT TESTED。

### 后续离线进展

- 已生成 `docs/memory/evaluation/extraction-v1/` 的 200 条消息与日程草稿、原文 gold、散列和说明；生成器为 `scripts/memory-extraction-corpus.mjs`。奇偶脚本各 100 条，保留稳定消息 ID、父子关系、scope、时序与故障描述。未读取模型输出，留出集未运行。
- `gold.jsonl` 仍是计划原文，并非可评分的原子事实标签；初始库及事件尚未接入真实执行器，独立复核未完成，数据明确为 DRAFT，阶段 1 仍未完成。不要用该草稿冒充 A/B/C 评测结果。
- 开发集仅运行规则筛选轨迹，45 条用户消息通过；此数不能换算模型调用、Precision 或 Recall。新增 `tests/memory/memoryExtractionCorpus.test.ts` 检查数量、分组、parent、重启边界、跨项目和长文本。
- PASS：`npx vitest run tests/memory/memoryExtractionCorpus.test.ts tests/memory/memoryExtractionBaseline.test.ts --maxWorkers=1`，6 测试；`npx eslint scripts/memory-extraction-corpus.mjs tests/memory/memoryExtractionCorpus.test.ts tests/memory/memoryExtractionBaseline.test.ts`。
- 下一步：结构化所有 gold 和初始库，逐项核对脚本及 S4/S5 事件，提交独立复核；实现实际队列与 Mock 执行器并在冻结后运行。尚未调用真实模型，生产代码仍未修改。

### 本次续做：独立复核前草稿

- `gold-structured.jsonl` 已按固定脚本拆出事实、作用域、主来源、支持来源和预期状态，仍待独立复核；初始记忆仍为文字，禁止项和评分尚未完全机器化。草稿散列、复跑命令和限制见 `docs/memory/evaluation/extraction-v1/protocol.md`。
- 开发集 20 个 S1 脚本的 14 个草稿事实：规则接纳主来源 6，明确请求 1，自动规则拒绝 7。只说明入口规则与待复核标签的关系，不能当模型 Recall。此前曾检查脚本 07/09/10 的规则输出，10 是留出样例，必须向独立复核者披露；如依结果修订标签，按第 5 节升级版本并更换独立留出集。
- 真实 A 队列 + Node 内存 SQLite + NOOP Mock：40 个开发集 S1/S3 日程、18 次入队/请求、零写入；另测来源 metadata 变化阻止迟到写入。简化每轮回答成功后立即 drain，不覆盖实际调度、确认、预置库或故障，因此不是完整 A 基线、真实模型或桌面闭环。
- PASS：`npx vitest run tests/memory/memoryExtractionCorpus.test.ts tests/memory/memoryExtractionCorpusQueue.test.ts --maxWorkers=1`，6 项；`npx eslint scripts/memory-extraction-rule-analysis.mjs scripts/memory-extraction-gold.mjs tests/memory/memoryExtractionCorpusQueue.test.ts`。
- 未找到运行中的 Ollama、LM Studio 或 llama-server 进程；未读取用户 Key/配置，未启动网络或本地模型。真实模型可用性、价格、桌面隔离 profile 均未核实；模型调用和费用为 0。
- 下一步：等待未参与实现的验收者复核结构化 gold 及先前留出规则输出披露；与此同时可完善匿名初始库、故障调度与评分器。复核后冻结并记录散列，再运行完整 A Mock；确认隔离连接和预算后运行 pilot。不得在缺少正式质量与安全证据时实施或默认启用 B/C。
- 已补 200 条语义初始库草稿 `initial-states.jsonl`，包含计划中五种预置情况；生产 category/fact key 未猜测，尚不能直接初始化真实 SQLite。增加隔离 Mock：一次 503 后重试写入一次，重复 drain 不再调用；未验证实际退避计时。PASS：`npx vitest run tests/memory/memoryExtractionCorpus.test.ts tests/memory/memoryExtractionCorpusQueue.test.ts tests/memory/memoryExtractionBaseline.test.ts --maxWorkers=1`，11 项；相关新增文件 ESLint 通过。
- 增加基础一对一匹配计算 `scripts/memory-extraction-score.mjs`；PASS：`node --test scripts/memory-extraction-score.test.mjs`，3 项及对应 ESLint。该模块要求预先人工规范化，不评状态、安全、成本或延迟，尚不是完整评分器。

### Sol 独立复核后修订

- Sol 确认 200 条结构完整，但指出 07/08 的助手来源不必需、状态/旧记忆保护未明确、39/40 可能空通过。v1 留存，新增 `gold-structured-v2.jsonl`：07/08 的用户选项为必需、助手消息可选；补发现/确认前后状态、active Recall 分母及 17/18/21/22 旧记录不变、39/40 来源变更与迟到写入断言。细节和散列见评测协议。
- 由于原计划固定来源评分标准已修改，按原计划需要新的独立留出脚本；原留出集不再声称独立。v2 仍待独立复核，不得视为冻结或正式评分结论。
- 受控匿名 A 队列测试先等待请求到达并阻塞响应，再验证源删除/metadata-only 更新实际影响 1 行，释放可写入响应后无新增。原脚本 40 不满足 A 入队规则，故其零输出不是在途防护 PASS；受控样例也不能替代真实模型/桌面。
- PASS：`npx vitest run tests/memory/memoryExtractionCorpus.test.ts tests/memory/memoryExtractionCorpusQueue.test.ts tests/memory/memoryExtractionBaseline.test.ts --maxWorkers=1`，13 项；`node --test scripts/memory-extraction-score.test.mjs`，6 项；本次受影响脚本和测试 ESLint 通过。尚无真实模型调用。
- 下一步：设计全新留出脚本并独立复核 v2 标签与状态口径；完善真实故障日程、初始库映射和完整评分器。隔离模型、价格和桌面 profile 信息仍未收到。
- 已另拟 20 个新留出脚本并展开 100 条，位于 `docs/memory/evaluation/extraction-v2-holdout/`；尚未运行其规则或模型，也未独立复核。PASS：`npx vitest run tests/memory/memoryExtractionHoldoutV2.test.ts --maxWorkers=1`，3 项（含散列）；生成脚本和测试 ESLint 通过。已请求 Sol 复核 v2 及新留出集；冻结前仍只可完善与评测结果无关的基础设施。

### Sol 第二次复核后

- Sol 未批准冻结：发现阶段误计 proposal、重复来源组合被误罚、两个留出脚本是旧场景改写。已保留 v2，新增旧集 `gold-structured-v3.jsonl` 和候选留出集 `extraction-v3-holdout/`，分离提案与持久化发现，允许 EX-20 的另一条用户断言作为可选支持，替换指出的两个脚本；其余脚本独立性仍需逐项核验，不能声称该集已独立。
- PASS：`npx vitest run tests/memory/memoryExtractionCorpus.test.ts tests/memory/memoryExtractionHoldoutV3.test.ts --maxWorkers=1`，10 项；`node --test scripts/memory-extraction-score.test.mjs`，7 项；本次新增脚本、评分器和测试的 ESLint 通过。v3 全部为未复核草稿，未运行留出规则或模型。
- 下一步：请独立验收者复核 v3 状态、来源及全部候选留出脚本与旧集的语义独立性；发现更多重复时继续替换并重新计算散列。隔离模型/价格和桌面 profile 尚未确认；完整执行器、正式盲测及产品实现仍未完成。

### Sol 第三次复核后

- Sol 确认 v3 状态/来源口径通过；留出集只有 01、07、08、18 可保留候选，其余不满足新情节独立性或只适合安全回归。保留旧集，重新设计其余 16 项，生成 100 条 v4 留出草稿 `docs/memory/evaluation/extraction-v4-holdout/`；未运行规则或模型，仍需独立复核，不得声称已冻结。
- v4 两个故障候选分别测试删除第二个用户来源时第一条有效事实保留，以及 assistant 支持来源 metadata 变化。屏障与变更凭证要求见评测协议；是否足够独立、实际故障运行和产品防护均未验证。
- PASS：`npx vitest run tests/memory/memoryExtractionHoldoutV4.test.ts --maxWorkers=1`，4 项；生成器及最终测试文件 ESLint 通过。新增语料散列见协议。
- 下一步：独立复核 v4 全部情节及标签；评测基础设施仍欠初始库真实映射、完整 A 时序/故障执行器、正式评分集成。隔离模型连接和桌面 profile 未确认；原始任务未完成。

### Sol 第四次复核后

- Sol 认为 v4 多数情节成立；05 属旧例改写，02/10/17 标签和 19 请求绑定需修正。保留 v4，新增 `docs/memory/evaluation/extraction-v5-holdout/`；只替换 05，修正指定标签，06 敏感禁止范围和 08 否定范围一并明确。未对 v5 运行规则或模型，仍待独立复核。
- 02 按主来源分别允许直接 active/candidate 或上下文 candidate；10 允许显式请求前已存在来源正确的 M1 记录、确认时复用且不得重复；17 不再猜测新流水线用途。19 要求被阻塞请求实际包含 M3，响应原本能写入 M3 对应事实，并核查 M1 事实保留；20 要求 assistant M2 作为必要支持源。细节、散列和运行入口见评测协议。
- PASS：`npx vitest run tests/memory/memoryExtractionHoldoutV5.test.ts --maxWorkers=1`，5 项；`node --test scripts/memory-extraction-score.test.mjs`，9 项；受影响脚本及测试 ESLint 通过。评分器仅提供辅助函数，真实事件、快照、前台延迟及模型成本尚未接入。
- 下一步：独立复核 v5 的新 05、来源状态及故障绑定；完善实际 A 时序/故障执行器、初始库映射和评分集成。隔离模型连接、价格和桌面 profile 仍未确认，生产实现和正式验收均未完成。

### 用户要求实现者完成剩余审核

- 按用户要求自行复核，不再交接 Sol。将 v5 的 03/17 完整用户决定的先前上下文改为可选，生成 v6 留出集并记录哈希；其余标签及指标门槛保持不变。此为实现者自审，**独立复核 NOT TESTED**，不是独立质量证明。自审记录与数据限制见评测协议。
- PASS：`npx vitest run tests/memory/memoryExtractionHoldoutV6.test.ts --maxWorkers=1`，6 项及对应 ESLint。v6 留出没有运行规则/模型。
- PASS：`npx vitest run tests/memory/memoryExtractionScheduleMock.test.ts --maxWorkers=1`，使用开发集 100 日程、真实 A 队列、匿名内存 SQLite、虚拟时间与 NOOP Mock；46 次请求含 8 次模拟 503，66 日程无请求、0 已登记 pending。该模拟未覆盖实际启动恢复、完整持久链路、故障屏障和成本，不得当作正式 A 质量基线或恢复验收。
- 下一步：完成初始库映射和具备真实来源、故障、打分的执行器，再评估 B/C；确认隔离模型与价格后按预算试跑。没有可用的真实模型和隔离桌面时分别记录 NOT TESTED，保留原有 A，不以 Mock 证据上线替代策略。
- PASS：`npx vitest run tests/memory/memoryExtractionInitialState.test.ts --maxWorkers=1` 和该文件 ESLint；开发集初始记忆已通过匿名 SQLite 夹具映射验证。该映射使用合成 category/factKey，尚未接入时序或评分执行器，不能称为冲突场景评测通过。
- 本机 Ollama 可执行程序存在；临时启动本次进程、执行 `ollama list` 返回空模型列表后关闭该进程。未拉取模型、未读取用户凭据/数据库、未发模型请求；现有本地模型 pilot 因无已安装模型为 `NOT TESTED`，不能据此断定其他合法模型连接不可用。
- 自审修正评分器重复输出的来源归因与状态判定混淆；PASS：`node --test scripts/memory-extraction-score.test.mjs`，9 项及对应 ESLint。全部输出的来源真实性仍未完整实现，正式来源准确率不能使用该辅助函数直接宣称通过。

### 桌面隔离与执行器继续推进

- 用户允许在观墨配置测试 API。桌面配置与 SQLite 均使用应用配置目录；为避免访问正式数据，启动以 `com.guanmo.memory-eval-20261031` 为独立标识的开发实例。隔离配置文件位于临时目录，不读取或复制已有 Key；实际目录隔离、窗口与 API 配置需在启动后确认。
- 开发集初始记忆已接入 A 虚拟时序 NOOP 测试并核验前后不变；PASS：`npx vitest run tests/memory/memoryExtractionScheduleMock.test.ts --maxWorkers=1`，结果仍为 100 日程、46 次请求（含 8 次模拟 503）、66 日程无请求；对应 ESLint 通过。非空模型输出、真实调度和故障屏障仍未集成。
- Windows 隔离 Debug 已启动：`npx tauri dev --no-watch --config <临时独立标识配置>`；Rust Debug 构建成功，窗口 PID `31132`，设置显示 AI 未配置。已确认新标识对应的应用配置目录生成独立 `guanmo.db`，只读计数的初始会话、消息、记忆均为 0；未读取正式库或密钥。该结果仅为隔离环境就绪，不是桌面闭环或 Release 验收；正在等待用户在隔离窗口配置测试模型及提供价格。
- PASS：`npx vitest run tests/memory/memoryExtractionPersistenceMock.test.ts --maxWorkers=1` 和该文件 ESLint：在临时 SQLite 中保存匿名用户来源，真实 A 队列调用 Mock，核对 active 与 evidence 中来源/会话 ID；关闭并重开 SQLite 后确认不重复调用、按实际记忆 ID 召回并注入。此为 Node + Mock + 数据库重开，**不是自然桌面对话、真实模型或应用进程重启**。
- PASS：`npm run test:memory`，现有记忆策略快速检查通过。真实模型输入/输出 token 是否由当前后台路径暴露仍需实际核验；如不可取得必须记 unknown，不以估算冒充供应商用量或费用。
- 已新增当前进度报告 `docs/memory/evaluation/extraction-v1/report.md`，区分规则、虚拟时序、SQLite Mock 与真实桌面证据；A/B/C 模型质量、成本与完整桌面闭环均保留 NOT TESTED。
- 评分器新增按脚本聚合的发现阶段 micro/macro 计算，空分母为 null，负例不进入 Recall 分母；PASS：`node --test scripts/memory-extraction-score.test.mjs`，10 项及定向 ESLint。尚未连接真实模型输出或完整安全判定。
- 同一汇总现支持最终 active 口径，未确认 candidate 保留在 Recall 分母；PASS：评分器 11 项及定向 ESLint。尚无真实输出数据。
- 新增只接受匿名 ID 与安全分类的 B/C **调度 Mock**：检查四轮、两轮前缀、60 秒静默尾批、会话/作用域/epoch 分离及 gap/显式请求不作为自动模型输入。PASS：`node --test scripts/memory-extraction-window-mock.test.mjs`，4 项及定向 ESLint。该模型没有接入真实对话、模型、SQLite、Token、前台生成、重试或重启；不是 B/C 实现，也不能用于策略选择或成本结论。

### 首个真实桌面样例

- 隔离 Debug 窗口由用户配置官方 DeepSeek `deepseek-flash`，界面显示连接成功；未读取 Key。官方峰值价格为输入缓存未命中 $0.30/百万、输出 $1.20/百万 Token，按计划 600 万输入与 60 万输出的理论上限估算 $2.52（不含主回答及其他未知费用，实际账单和 usage 尚未知）。用户执行的连接测试次数未知，计入预算前须按保守方式处理；禁止把估算当实际费用。
- 在隔离窗口发送开发脚本 EX-01 的匿名用户句子，实际收到主回答；SQLite 只读核实真实 user 源 `user-1793445880170-qi9qz`、会话 `session-1793443006685-anqrxl3`；对应 v1 作业 `completed`、attempts=1。真实模型产生 active 记忆 `mem-auto-user-1793445880170-qi9qz-cb29a5fa95b32a2060388b2db65b840b510a3f1eddc283b8a2f693d70cf2ab26`，evidence 的 sourceId/sessionId 与用户消息一致。仅证明一条单轮样例在当前 Debug 运行中入库，非 A/B/C 质量、真实重启或召回 PASS。
- 用户指出现有 WebView2 CDP 脚本可访问桌面接口，后续优先复用现有隔离调试工具实施可复跑的请求/读取；自然对话入口和最终人工验收仍应保留 UI。必须先核实 CDP 连接到独立标识、隔离 SQLite 和本次进程，避免访问用户正式实例。
- 已正常关闭 PID 31132 并以同一隔离标识重启 Debug；新 PID `8120`，WebView 子进程及 CDP `app_config_dir` 均核对为隔离标识。数据库初始化完成后，经实际 `searchMemories` 返回 EX-01 原记忆 ID，并由 `buildMemoryContextWithSources` 生成相同来源 ID 的全局记忆上下文。首次在初始化完成前读取得到空数组，随后确认 `isDatabaseReady()` 为 true 才复查成功；不能将未就绪的空结果当作数据丢失或召回失败。
- 新空会话 `session-1793446112003-dcsw69f` 中，通过 `routingModelChat` 将上述上下文**手动组装**后发送真实模型，答“你的专业是计算机科学。”；usage 输入 60、输出 33 Token、服务墙钟约 1096ms。此操作没有通过自然对话入口自动构造 prompt，也没有保存该问答，故自动注入与真实新会话 UI 召回仍 `NOT TESTED`；不可把手动传参称为完整自然对话闭环。
- 经 CDP 在隔离 SQLite 中调用真实 `persistConversationSession`、`MemoryExtractionQueue` 和 `routingModelChat`：EX-03 源 `eval-ex03-1793446206309-u1` 入队并发出 1 次真实提取请求，输入 790、输出 174 Token、服务墙钟约 1409ms，写入 active `mem-auto-eval-ex03-1793446206309-u1-58373c3b1c6837219f28df9e3aa3cd44d49c2f532be5be5d9ba99321f5d1a8cc`，evidence 的用户及会话 ID 正确。此为底层直调、非完整 UI 调度；已有 EX-01 记忆，未按每案例全新库隔离，不能当正式独立质量指标。
- EX-07 三条匿名对话直接持久化，两个用户源 `eval-ex07-1793446215586-u1/u3` 均被真实 A 队列拒绝，提取模型调用 0 次；该多轮决定存在入口漏筛，但此结果不代表 B/C 可正确解析。上述两次已采集 usage 的真实调用共输入 850、输出 207 Token；EX-01 主回答/自动提取及用户连接测试的调用数和 usage 尚无法完整回收，故总调用、总费用和正式预算消耗仍为 unknown，不能宣称完整成本通过。
- 用户明确要求不使用 Computer Use 或抢鼠标，已通过隔离 CDP 后台恢复先前临时测试包装，不再控制鼠标。后台直接调用应用 `streamDirectChat`：重启后空会话内，真实模型发起 2 次请求，执行 1 次 `search_memory`，返回 EX-01 的实际记忆 ID；后续真实模型请求中检查到该记忆内容，回答“根据已有记录，你的专业是计算机科学。[S1]”。总输入 850、输出 154 Token，服务墙钟约 1971ms，单次每请求输出上限 160。此为后台 Direct 服务真实工具检索与注入，未经 `useAiChat` 自然入口、没有持久化该轮，不能冒充完整新会话 UI 闭环。累计已知真实 usage 为输入 1700、输出 361 Token；先前未知调用仍使总费用为 unknown。
- EX-07 连续上下文的**探索性提示词**直接请求配置模型一次，正文为空、usage 输入 220/输出 800，约 5097ms；没有写入记忆，不是 B 实现或正式策略评分。检查发现当前配置 provider=`custom`、model=`deepseek-flash` 时，`applyReasoningMode(...,'off')` 返回 false，没有发送关闭思考参数；[DeepSeek 官方文档](https://api-docs.deepseek.com/guides/thinking_mode/)说明思考默认开启且该模式忽略 temperature。故配置未满足冻结的 off/temperature 条件；输出为空与此有关仍是推断，不能证明这 800 Token 的内部构成。
- 为排查该变量，单独在内存创建 provider=`deepseek`、模型别名 `deepseek-v4-flash` 的一次诊断，未更改应用设置；先验证适配器将 `thinking.type` 设为 `disabled`。官方文档说明该别名当前路由到 `deepseek-flash` 同一模型版本。相同上下文输入 195/输出 53 Token、约 1055ms，返回 project、正确的最终用户和选项来源；内容仍包含“后续项目都这样”，有超出当前项目的表述风险，不能判作安全通过。此诊断与前次配置不同，不构成公平 A/B，未入库、未修改生产策略。
- 截至该诊断已知 usage 合计输入 2115、输出 1214 Token；首条自然对话及用户连接测试的请求数/用量仍 unknown，总费用不可确认。按计划先解决统一模型配置与 off 行为，正式 pilot 不得混用这两种配置，不追加无限重试。

### 后台窗口实验准备

- 新增 `scripts/memory-extraction-window-input.mjs` 离线原型：保留连续可见对话，拒绝跨会话/作用域和无 parent 的助手消息，敏感、拒绝、显式及引用转换内容转为 gap，不回退到 raw content；超长或预算不足返回 oversize，不截断冒充完整证据。PASS：`node --experimental-strip-types --test scripts/memory-extraction-window-input.test.mjs`，4 项；定向 ESLint 通过。**原型未接入生产，尚未实现超长拆分、任务持久化、多源写入原子校验或恢复，不能当 B/C 完成。**
- `scripts/memory-extraction-context-probe.mjs` 经 CDP 校验隔离标识，通过应用凭据绑定/Rust 代理调用同服务版本的 `deepseek-v4-flash` 兼容别名，明确设置 off、温度 0.1、输出上限 800、超时 20 秒；每次仅一个逻辑请求、provider 最多可能额外重试一次，不写记忆、只接受开发集 S3。使用固定提示词和输入 SHA-256，非正式 A/B runner。
- 真实 EX-09-S3：模型输出结论先行、primary `EX-09-S3-M3`、support `EX-09-S3-M1`，usage 输入 197/输出 46，约 895ms；EX-13-S3 输出 `[]`，输入 133/输出 1，约 712ms。仅两个样例、语料未逐例隔离真实持久状态且未入库，不能以此计算质量、错误率或选择策略。
- 截至这两次已知 usage 共输入 2445、输出 1261 Token；EX-01 自然回答/自动提取和用户连接测试仍有未知 usage，provider 参数降级重试的实际网络次数未统一计入；总费用、完整请求计数及正式预算验收仍为 unknown。测试未使用鼠标。
- 窗口原型增加来源 ID 基础校验：主来源必须是窗口内可见 user，支持源必须存在且不能使用晚于主来源的 assistant；仅证明来源身份、仍标记需要语义复核，不能证明助手建议未被错误归因。PASS：窗口原型 5 项测试及定向 ESLint。
- 固定提示词后台补测 EX-01-S3，返回专业事实和正确 user 源，输入 129/输出 33、约 825ms；EX-05-S3 返回 `[]`，输入 189/输出 1、约 516ms。二者均仅一次逻辑请求、不写库；来源检查仅通过 ID、仍需语义复核。`scripts/memory-extraction-context-probe.mjs` 现在记录解析状态、来源检查和输入散列；EX-01/05 与 EX-09/13 使用同一探索提示词，样本太少不能决策。已知 usage 更新为输入 2763、输出 1295 Token，未知的早期用量和可能重试仍未计入；完整费用 unknown。
- 新增仅显式启用的 A 开发集试跑器 `scripts/memory-extraction-pilot.test.ts` 及专用 Vitest 配置；每案例独立 Node 内存 SQLite，真实 A 队列，可选受限桌面代理，单次模型预留最多 2 个网络请求、800 输出 Token/请求并在首次模型/解析失败后停止。显式保存确认路径未实现；该混合执行器不等同真实桌面完整链路。
- PASS：`GUANMO_EVAL_PILOT_ENABLE=1`、`GUANMO_EVAL_PILOT_MODE=mock` 下运行专用 Vitest，8 个计划开发样例、NOOP Mock 和压缩时序，产物为临时匿名报告；EX-01/03 各有一次逻辑 Mock 请求，其他六例均无自动请求。此结果不是模型质量或真实时间数据。
- 真实 A 开发集试跑完成 8 个 S1 案例，逐例使用独立 Node 内存 SQLite、真实队列及隔离桌面模型代理，非完整桌面执行器：EX-01/03 各一次逻辑调用并写入来源正确的 active，EX-07/09 多轮事实和 EX-17 更新的用户源均被规则过滤；EX-13/23 无请求且没有新增记忆；EX-25 显式确认未实现，标为 NOT TESTED。两次调用实际 usage 合计输入 1274、输出 125，耗时分别 813/1004 ms；网络次数按最多 4 次预留，无法当作实际次数。队列稳定后提前结束，未实际等待完整 120 秒。报告在 `D:/Temp/guanmo-a-pilot-lU8iun/report.json`；此为小样本发现，不是正式 Recall 或完整对照。
- 增加 `scripts/memory-extraction-context-pilot.mjs`，仅显式启用、用同一固定提示词模拟 B/C 窗口并可经隔离代理访问模型；不写库、不实现确认、失败恢复和多源保护，不能代表完整 B/C。Mock 模式 PASS：8 个 B 和 10 个 C 模拟模型请求；提示词与语料散列入报告。真实运行前逐次校验独立目录、参数和网络次数上限，首次出错即停。
- 真实探索运行完成：B 为 8 次请求、输入 2599/输出 207 Token、单次 623–1317 ms；C 为 10 次、输入 3175/输出 230 Token、单次 634–1092 ms；共实际 18 次网络请求。B 的 EX-07/09/17 原始输出表达了 A 漏筛事实；C 的 EX-07 虽标 project，文本却加入“后续项目都这样”，超出来源，属于须拒绝的错误提案，未写库。C 两次静默尾批均返回空数组。显式确认 NOT TESTED；无生产队列、状态写入或前台并发，不能据此计算正式 Precision/Recall/错误记忆率、比较生产时效或宣布通过安全门槛。匿名原始记录保存于 `docs/memory/evaluation/extraction-v1/context-pilot-real.json`，A 保存于 `a-pilot-real.json`。
- 本轮无生产策略变更：真实试跑证明入口漏筛及实验输出的语义越界，但不能证明候选 B/C 已满足持久化、保护、恢复和质量门槛；保留 A 是当前回退状态，不是优化验收通过。下一步需要完成具备原子来源保护和可恢复执行的候选及完整评测，再做 Windows 自然新会话闭环；不能用本实验替代。
- 隔离 Debug 再次启动后，通过 CDP 在未挂载到屏幕的 React 容器中调用实际 `useAiChat.sendMessage`，不控制鼠标：新会话 `session-1793511833875-h9jrqi9` 问“我的专业是什么？”，答案为“你的专业是计算机科学。”；实际 SQLite 中 user 和 assistant 均已持久化，assistant metadata 的 memory source 为原 EX-01 记忆 `mem-auto-user-1793445880170-qi9qz-cb29a5fa95b32a2060388b2db65b840b510a3f1eddc283b8a2f693d70cf2ab26`。该入口使用真实应用 hook，非人工 UI 操作；尝试包装 Tauri invoke 以检查请求正文但未捕获任何请求，因而实际模型调用次数、该轮 usage 和请求上下文注入仍为 NOT TESTED，不能与此前 Direct 服务的请求观察合并冒充同一闭环。消息来源和答案是实际数据库结果。

### 多来源写入保护

- SQLite 的 `chat_messages` 是来源事实，`memories` 是写入目标；新增、候选更新和删除均在原有单条 SQL 语句中核验所有显式提供的来源快照，包括 ID、session、角色、parent、正文、metadata 和原始创建时间。显式快照不得为空、重复或跨会话，助手来源必须包含其用户 parent；旧调用仍兼容单来源 guard。快照只作为 SQL 参数，不额外持久化对话内容。影响文件：`src/services/database/persistence.ts`、`src/services/memory/memoryService.ts`、`src/services/memory/memoryExtractionQueue.ts`；与 Agent 路由、RAG 和召回逻辑无关。
- 现有 A 队列现在将原始用户来源 metadata 和 parent 一并传入最终 SQL guard，防止异步预检后、写入前仅 metadata 改变造成迟到写入。新增 `tests/memory/memorySourceSnapshots.test.ts` 覆盖各支持源内容、metadata、parent 和删除失效，插入/更新/删除及旧 guard 兼容，也模拟预检通过后、实际 SQL 前的 metadata 竞态。PASS：`npx vitest run tests/memory/memorySourceSnapshots.test.ts tests/memory/memoryExtractionPersistenceMock.test.ts tests/memory/memoryExtractionScheduleMock.test.ts --maxWorkers=1`（7 项，100 个虚拟日程）；定向 ESLint、`npm run typecheck` PASS。
- Windows Debug 隔离实例通过 `scripts/memory-source-guard-desktop.mjs`（需 `GUANMO_EVAL_SOURCE_GUARD=1` 与隔离 CDP 端口）执行实际 Tauri SQLite 插入/更新/删除：来源完整时插入成功，助手来源 metadata 更改后 3 种写入均拒绝且旧候选保持不变。此为原子 SQL 桥接测试，未调用模型，非完整桌面闭环。第一次直接 import 命中旧 Vite 模块缓存，错误地允许写入，明确记为旧模块测试失败；脚本使用独立模块 URL 加载新版本并校验后重测 PASS。所有数据均为隔离库匿名记录。
- 风险与后续：这些快照只验证来源未变，不能证明候选语义、项目作用域或助手建议归因；B/C 窗口、可恢复账本及多来源证据尚未接入。历史 A 真实样例属于安全修补前版本，正式 A 必须按冻结的原始 HEAD 运行；不得将此修补后队列冒充冻结 A 或把历史结果与新版本混为同一基线。当前桌面仅验证静态 SQL 屏障，模型返回屏障、重启、前台性能仍 NOT TESTED。
- 隔离 Windows Debug 的真实队列模型响应屏障 PASS：`scripts/memory-queue-barrier-desktop.mjs` 等待 Mock 模型请求实际启动，修改该用户来源的 metadata，再释放原本会写入的成功响应；1 次 Mock 调用、0 条记忆，v1 回执 `completed`。脚本检查隔离标识及队列为空，未访问网络；v1 将来源失效记为 completed 的既有语义未改变，不能视作计划中的 v2 `invalidated`。模型响应为 Mock，真实模型网络故障与多来源 C 队列仍 NOT TESTED。

### v2 原子登记接口契约

- 新增可选 Rust 命令 `persist_memory_intake_transaction`，请求为 `{ message: { id, sessionId, content, metadata, createdAt }, scopeKey, sourceFingerprint }`；仅接收一条 user（parent 固定 null），要求会话已存在。`sourceFingerprint` 为前端对 UTF-8 编码的 `JSON.stringify([content, metadata ?? null, createdAt])` 计算的 64 位小写 SHA-256；Rust 验证格式，worker 使用前必须重新计算核验，不能把调用方提供的 hash 当作授权。原探索版只包含正文与 metadata，因时间变化会影响事实时序而在正式接入前修订；隔离测试库的探索回执不属于正式数据。
- 返回 `true` 表示同一 SQLx 事务首次保存来源与 v2 回执，`false` 表示已有完全匹配的回执；冲突、数据库不可用或事务失败抛错并回滚。重复调用不得重置已有状态，已有来源不被覆盖，已有回执的来源被删后不得重建。回执包含来源 ID、会话、捕获的作用域、会话内单调顺序与 scope epoch、指纹和 pending 状态，不复制正文；settings 的 v1 键和旧聊天保存路径保持不变。
- 调用方必须在数据库 ready 后调用，并将本轮已捕获 scope 传入；命令和接口仅是候选策略基础设施，当前没有接入用户聊天或自动启用。尚需确认数据库维护态竞态、调用时机与首屏影响，再让 C 使用；B/C 恢复执行器未实现。
- 已实现后端事务、权限清单及前端桥接：`src-tauri/src/database_transactions.rs`、`src-tauri/src/lib.rs`、`src-tauri/permissions/main.toml`、`src/services/memory/memoryIntake.ts`。PASS：`cargo test --manifest-path src-tauri/Cargo.toml --lib memory_intake_ --jobs 1`（3 项，事务失败回滚、作用域 P→Q→P、重复及删改后重试）；`npx vitest run tests/memory/memoryIntake.test.ts tests/memory/memorySourceSnapshots.test.ts --maxWorkers=1`（7 项），定向 ESLint 和 `npm run typecheck` 通过。
- 首次 Windows Debug 调用失败：新命令未列入 Tauri `main.toml` 权限，返回 `Command not found`；此时事务没有运行。已添加单一新命令权限并重建隔离 Debug，桌面复测结果另记。当前 Rust 只核验调用方提供的指纹格式，恢复 worker 必须比对真实来源并利用最终 SQL 快照校验；两者尚未接入，禁止报告端到端完成。
- 隔离 Windows Debug 重建后，`scripts/memory-intake-desktop.mjs` PASS：真实 Tauri 命令写入三条匿名消息和回执，P→Q→P 的 sequence 为 1/2/3、epoch 为 0/1/2；重复登记返回 false 且保留 completed，删除第二条来源后重试被拒且未重建，回执不含正文。权限修复后的首次并行桌面尝试返回未识别的 `Uncaught (in promise)`，没有足够信息确定原因；增加阶段错误记录并独立重跑后通过，不将首次失败当作通过。重启恢复 worker、数据库维护态竞态以及并发 SQL 繁忙时的有界重试均 NOT TESTED。
- 新增 `src/services/memory/memoryIntakeSource.ts`：按来源 ID 和会话查询，重算包含原始创建时间的登记指纹；来源删除或正文/metadata/时间变化返回 invalidated，数据库不可用返回 blocked。敏感、拒绝、显式保存和转换内容返回无正文 gap；有标签却没有可见快照或 metadata 格式错误也不回退到附件正文。长消息返回 oversize，尚未完成计划要求的分段。普通消息不经价值关键词过滤；raw snapshot 仅供后续本地 SQL guard，不能作为模型输入。
- PASS：`npx vitest run tests/memory/memoryIntakeSource.test.ts tests/memory/memoryIntake.test.ts tests/memory/memorySourceSnapshots.test.ts --maxWorkers=1`（14 项）、定向 ESLint；Windows Debug 的 `scripts/memory-intake-desktop.mjs` 已实际验证三条回执对应 ready/invalidated/ready，第三条 metadata 变化后变为 invalidated。该读取器未接队列，不表示 B/C 可以提取、跨项目安全或满足恢复门槛。

### 窗口账本与租约基础

- 新增 `src/services/memory/memoryWindowLedger.ts`：按会话、捕获的作用域及 epoch 选择连续待处理回执；4 条触发 B/C，C 的不足一批仅在调用方确认前台空闲且最后活动超过 60 秒时领取，保留最多 2 条已处理前缀。持久槽保留固定来源和回执快照；通过单条 SQLite CAS 获取租约、有限重试（2 秒/4 秒、最多 3 次）、容量阻塞不扣次数、7 天失败；结算通过单条 SQL 同时推进回执。结算后、释放槽前中断时，下个 owner 可识别已终结回执而不重复处理。
- 记忆写入的可选 guard 新增窗口租约核验：在实际 INSERT/UPDATE/DELETE 的 SQL 中同时验证租约 owner 值、真实墙钟未过期及所有输入回执未变化。旧 A 不使用 v2 租约，单来源兼容路径保留。两个阶段之间仍可能中断；稳定记忆操作 ID、防删除复活和完整 worker 尚未实现，不得据此宣称 exactly-once。
- PASS：`npx vitest run tests/memory/memoryWindowLedger.test.ts tests/memory/memorySourceSnapshots.test.ts tests/memory/memoryExtractionPersistenceMock.test.ts --maxWorkers=1`（16 项）；覆盖项目/会话/epoch 隔离、空闲尾批、竞争、退避、容量、过期 owner、已结算恢复、回执篡改与来源租约写入保护。定向 ESLint 通过；首次 typecheck 因目标不支持 `Array.at`/`Object.hasOwn` 失败，已改为兼容写法并重新运行类型检查。
- Windows 隔离 Debug 的 `scripts/memory-window-ledger-desktop.mjs` PASS：4 条真实登记回执、两个 owner 竞争仅一个领取，模拟时间下按退避恢复，旧 owner 的记忆写入和回执结算被拒，新 owner 可写入并完成。测试无模型和网络，时间为模拟；不能用于真实时效或前台性能结论。下一步必须将来源读取、模型窗口、安全结果处理及账本接成可恢复的 B/C 执行器；全局前台空闲信号、启动恢复、超长安全分段及防删除复活仍 NOT TESTED。
- 补充固定前缀回执快照：窗口领取、最终记忆写入和回执结算均核验新来源及前缀回执未变化；前缀变更时不得把新来源标记完成。PASS：`npx vitest run tests/memory/memoryWindowLedger.test.ts tests/memory/memorySourceSnapshots.test.ts tests/memory/memoryExtractionPersistenceMock.test.ts --maxWorkers=1`（17 项）、定向 ESLint、隔离桌面租约脚本复跑。真实前台活动与 lease 检查的跨组件竞态仍未接入，不将模拟时钟视为时效验收。
- 新增 `src/services/memory/memoryWindowInput.ts`，读取已登记来源及按 `parent_id` 绑定的唯一助手答复，保留连续顺序；多答复歧义、敏感内容、文档/检索来源与缺少可见快照均作为 gap。每包对话 JSON 按 UTF-8 字节保守限制 4000；输入过长按 Unicode 完整字符无损拆段，标记前后续段，超 128 段明确返回 oversize；相邻包最多带两条标为 context-only 的前文。只有 `turns` 可送模型，原始来源快照仅供本地原子校验。前后均核验有效租约与登记回执；助手建议仍需模型结果语义校验，不能单凭来源 ID 入库。
- PASS：`npx vitest run tests/memory/memoryWindowInput.test.ts tests/memory/memoryIntakeSource.test.ts tests/memory/memoryWindowLedger.test.ts tests/memory/memorySourceSnapshots.test.ts --maxWorkers=1`（26 项），定向 ESLint；隔离 Windows Debug 脚本确认连续用户/助手/用户顺序、敏感 gap 和实际租约写入。此为 SQLite + 组包测试，没有模型调用；分段之间语义一致性、最终候选去重、超 128 段的终结策略及独立评测尚未实现。
- 新增 `memoryWindowCandidates.ts` 和 `memoryWindowModel.ts`：模型请求只序列化白名单 turn 字段，不发送本地来源快照或工作区 scope key；已有目录仅含同作用域的未锁自动记忆，敏感项过滤。完整请求按字节估算不超过 6000、最多 800 输出 Token、20 秒超时；后台调用前后核验租约，前台取消或租约失效丢弃响应。解析检查真实新用户主来源、支持源顺序与助手 parent、事实值字面出现、未决定、否定反转及项目范围扩大；通过的项仍强制标记 `requiresSemanticReview`，**不自动入库**。这些规则只排除部分明显错误，不证明语义正确；真实模型、分段去重和完整安全门槛均未通过。
- PASS：`npx vitest run tests/memory/memoryWindowModel.test.ts tests/memory/memoryWindowCandidates.test.ts tests/memory/memoryWindowInput.test.ts --maxWorkers=1`（15 项）与定向 ESLint；隔离 Windows Debug 的窗口脚本串联真实 SQLite 登记、领取、连续组包和 1 次 Mock 模型请求，返回带用户决定及助手支持源的提案，敏感文本未进入请求，且本测试没有把模型提案入库。真实调用次数与质量仍沿用先前探索数据，未新增真实模型费用。
- 增加可选的第二次模型逐项核对：只返回与候选一一对应的布尔结果，缺项、重复项或异常输出触发有限重试；同样遵守租约、取消和输入预算。**同一模型自查不是独立语义验收，即使返回 true 仍保留 `requiresSemanticReview`，不得据此直接上线写入。** 此设计可能增加调用与 Token，正式对照必须将两次调用及失败重试计入，未达成本门槛则不能采用。
- PASS：`npx vitest run tests/memory/memoryWindowModel.test.ts tests/memory/memoryWindowCandidates.test.ts tests/memory/memoryWindowInput.test.ts --maxWorkers=1`（17 项）；隔离 Windows Debug 使用 2 次 Mock 请求分别生成和核对提案，敏感内容没有进入请求。不存在真实模型调用；实际语义效果与成本 NOT TESTED。

### v2 幂等记忆写入接口契约

- 计划新增 `persist_memory_v2_transaction`，请求携带稳定 64 位操作哈希、结构化候选、v2 证据、用户及助手来源快照和已领取窗口的 `{key,value}`。Rust 在同一 SQLx 事务中核验有效租约、回执原值、全部来源的会话/角色/parent/内容/metadata/时间及冲突快照，再写入候选或直接支持的单来源 active 和不含正文的操作回执；重复操作返回已处理，即使用户已删除记忆也不得重建。多来源或分段事实必须 candidate，旧 active/手动/锁定记录不被自动覆盖。
- 返回值区分 `inserted`、`already_applied`、`duplicate`、`conflict`、`invalidated`、`lost_lease`；任何 SQL 错误整体回滚。稳定操作哈希由 scope、用户来源及支持来源、规范化主体/属性/值和动作生成，不依赖模型改写后的句子。旧 v1 写入和删除入口保持兼容，不改备份格式；该接口仅在候选策略显式启用和通过门槛后使用。
- 精确哈希不能识别所有同义改写或用户主动删除后不同来源产生的等价事实；现有语义去重与删除保护仍需联合评测和必要补强，不能提前宣称完全防复活。前端须先完成敏感内容、来源语义、scope 和模型验证；Rust 事务是最终原子保护，不把模型 confidence 当授权。

### v2 来源证据与冲突确认

- `src/services/memory/memoryEvidence.ts` 支持兼容 v1 的 v2 证据：有序用户/助手 ID、会话、parent、顺序、原始时间和可见文本 SHA-256；只保存主用户短摘录，不保存附件正文。引用必须属于当前窗口，助手必须有更早的用户 parent，主来源必须为新用户消息。替代快照与旧版共存；超过证据预算时拒绝写入而非截断证据。
- Rust 确认事务对 v2 校验结构并在替代时强制核对旧 active 的内容哈希和时间；未知结构化版本不能绕过替代校验。旧纯文本/v1、无替代关系的旧 JSON 保留兼容。记忆来源补查会核对 v2 原始可见文本哈希，只展示用户消息；原文被修改、metadata 无效或缺少可见快照时不回退读取附件。分段主来源暂不做整条原文补查，避免将截断片段冒充完整证据。
- PASS：`cargo test --manifest-path src-tauri/Cargo.toml --lib candidate_confirmation_ --jobs 1`（7 项）；`npx vitest run tests/memory/memoryEvidenceV2.test.ts tests/memory/memoryEvidenceRetrieval.test.ts tests/memory/memoryService.test.ts --maxWorkers=1`（41 项）、定向 ESLint。隔离 Windows Debug 的 `scripts/memory-window-evidence-desktop.mjs` 使用真实 Tauri SQLite 和确认命令，验证 3 个有序来源、旧事实变更后拒绝替代、旧事实未变时明确确认成功、结构不完整 v2 不得激活。样本为匿名数据，无模型调用；端到端实际提取与用户交互仍 NOT TESTED。

### Claude 新增调度器审查与隔离桌面验证

- 审查 Claude 新增的 `memoryWindowScheduler.ts` / `memoryWindowScheduler.test.ts`：模块此前未被聊天入口调用，不能报告为生产接入。首次定向运行 12 项有 4 项失败，`npm run typecheck` 有 4 个联合类型缩窄错误。修复为按 session/scope/epoch 分别排队、前台生成开始时中止后台请求、活动后重置 C 静默计时，并在租约失效、模型重试或原子写入失败时保留窗口重试，不把写入失败结算为完成。
- PASS：`npx vitest run tests/memory/memoryWindowScheduler.test.ts tests/memory/memoryWindowPersistence.test.ts tests/memory/memoryEvidenceV2.test.ts tests/memory/memoryEvidenceRetrieval.test.ts --maxWorkers=1`，22 项；`npm run typecheck`、对应 ESLint PASS。Rust `memory_v2_` 新增哈希验证后 PASS 6 项。
- Rust 写入现在重算并验证 operation SHA-256（不接受伪造 operation ID），并对未分段的可见来源重算 v2 textHash。`sha2` 已作为直接依赖声明（版本原已在锁文件传递依赖中）。来源哈希/operation identity 篡改拒绝由 Rust 定向测试覆盖。
- 内存清理后以 `CARGO_BUILD_JOBS=1`、`CARGO_PROFILE_DEV_DEBUG=0` 运行 `cargo build --manifest-path src-tauri/Cargo.toml --bin guanmo --jobs 1`，PASS（dev profile，unoptimized，5m06s；仅有既存 linker message warning）。再以隔离标识 `com.guanmo.memory-eval-20261031` 启动最新 Debug，验证 Rust operation SHA-256 和未分段 evidence textHash 改动已包含在桌面构建中。
- 最新隔离桌面二进制上 `scripts/memory-window-scheduler-desktop.mjs` PASS：4 个匿名 user 来源进入真实 SQLite B 窗口，2 次 Mock 模型调用，生成 candidate；显式确认后实际记忆 ID 可检索并注入上下文。`scripts/memory-window-persistence-desktop.mjs` PASS：首次写入 `inserted`、同操作重试及删除后的重试均为 `already_applied`、删除记录未复活、候选确认 active、真实召回与上下文注入均含目标 ID。结束后重启隔离实例，`scripts/memory-window-restart-recall-desktop.mjs` PASS：来源 ID/session/role、active 状态、召回 ID 和注入 ID 均保持一致。全程只用 Mock、未调用真实模型；因此不是自然聊天闭环或语义质量验收。重启时有页面加载超时回退提示，但桌面 Tauri SQLite/CDP 验证随即通过。
- 目前确认的剩余范围：调度器仍未接入 `useAiChat`，C 启动恢复只接受显式传入的一个 group，正式 v6 留出评测和真实自然聊天 B/C 闭环仍未完成。保留当前 A 路径，不因 Mock 通过而开启 B/C。隔离测试未操作或关闭真实用户实例。

### 已有真实 A/B/C 探索输出的同集事后评分

- 不增加 API 请求，利用已保存的真实 A 小样本和 B/C 探索原始输出，对 8 个相同开发脚本做事后复核。按 5 项非显式正例计发现：A 2/5 正确、0 错误（Precision 100%、Recall 40%）；B 5/5 正确、0 错误（100%、100%）；C 4/5 正确、1 个越项目范围的错误提案（80%、80%）。EX-13/23 两个负例均空输出；EX-25 显式确认流程不在该比较范围。B/C 的提案未持久化，只计 discovery，不计 active。
- 已知真实调用与用量：A 2 次、1274 输入/125 输出 Token；B 8 次、2599/207；C 10 次、3175/230。按缓存未命中标价对 7048 输入/562 输出 Token 粗算 $0.00279，不是账单；连接测试、部分早期调用和 provider 重试用量不全。整个试点真实请求累计无法确认，因此不追加 API 请求，避免超过 40 次预算上限。
- 这是实现者对已看过的开发集输出作的探索性事后评分，不是独立盲测、正式留出或语义质量认证；五个正例样本不足以决定生产策略，也无法推导错误记忆率、保护、恢复和前台延迟。具体计分口径及限制见 `docs/memory/evaluation/extraction-v1/report.md`。保留 A；不据此将 B/C 接入生产。

## 本轮执行收尾（2026-11-01）

### 完成情况

- 完成 B 批量 + C 闲时尾批的产品接线。`useAiChat` 在成功保存会话后，以来源 ID 从 SQLite 重新读取真实 user 行，再调用 B/C 调度；不再由逐条价值词规则提前丢弃一般消息。前台生成开始会中止后台提取，结束后重置闲时窗口。显式 `save_memory` 仍走 Agent 的用户确认卡，不进入自动记忆窗口。
- 完成应用首屏后的全局 pending 回执恢复。恢复只读取有限 SQLite 回执（最多 512 条，不读入队正文），按 session/scope/epoch 隔离；过量新回执被 Rust intake 事务拒绝，不提交来源或回执。B 四条成批，C 不足批量在 60 秒静默后尝试；有限退避、lease 和幂等写入沿用既有机制。
- B/C 选择仅以已存在的真实探索样本为依据：B 在同一小型开发集上较 C 有更高的事后 discovery Precision/Recall 且请求更少。采用 B 批阈值并保留 C 闲时尾批，候选仍须来源/模型核验且多源记录需用户确认。该数据不是冻结留出盲测，不能宣称正式质量门槛通过。
- 保护旧记忆、显式确认、来源删改、scope 隔离、前台取消、事务原子性和删除后不复活的既有实现与测试保留；未改 Agent 路由或 RAG。

### 本轮修改文件

- 产品：`src/hooks/useAiChat.ts`、`src/App.tsx`、`src/services/memory/memoryWindowScheduler.ts`、`src/services/memory/memoryWindowLedger.ts`、`src-tauri/src/database_transactions.rs`。
- 验证：`tests/memory/memoryWindowScheduler.test.ts`、`tests/memory/memoryWindowLedger.test.ts`、`scripts/memory-window-scheduler-desktop.mjs`、新增 `scripts/memory-window-recovery-desktop.mjs`。
- 报告：`docs/memory/evaluation/extraction-v1/report.md`。仓库中其余已有修改和未跟踪文件均按用户工作保留；未提交或执行 Git 清理。

### 实际运行结果

- PASS：`npx vitest run tests/memory/memoryWindowScheduler.test.ts tests/memory/memoryWindowLedger.test.ts tests/memory/memoryIntake.test.ts tests/memory/memoryWindowPersistence.test.ts tests/memory/memoryWindowInput.test.ts --maxWorkers=1`，5 个文件、42 tests。
- PASS：`npx vitest run tests/memory/memoryExtractionCorpus.test.ts tests/memory/memoryExtractionBaseline.test.ts tests/memory/memoryExtractionHoldoutV6.test.ts tests/memory/memoryExtractionScheduleMock.test.ts tests/memory/memoryExtractionInitialState.test.ts --maxWorkers=1`，5 个文件、18 tests；其中 NOOP 时序夹具运行 100 开发日程、46 次模拟请求（含 8 次模拟 503）、66 个无请求、0 条已登记 pending。此结果不计模型质量或恢复率。
- PASS：`npm run typecheck`；本次相关 TypeScript、桌面脚本和测试的定向 ESLint；`npm run test:smoke`（2 个文件、9 tests）；`node --check scripts/memory-window-scheduler-desktop.mjs` 与 `node --check scripts/memory-window-recovery-desktop.mjs`。
- PASS：Rust `cargo test --manifest-path src-tauri/Cargo.toml --lib memory_intake_ --jobs 1`（4 tests）、`cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`；Windows Debug 构建使用 `CARGO_BUILD_JOBS=1`、`CARGO_PROFILE_DEV_DEBUG=0` 和 `cargo build --manifest-path src-tauri/Cargo.toml --bin guanmo --jobs 1`。
- PASS：隔离标识 `com.guanmo.memory-eval-20261031` 的真实 Windows Debug + SQLite/CDP：4 个匿名持久 user 来源进入已接入调度器；Mock 提案及逐项核验各 1 次；候选确认后 evidence source ID、active memory ID、真实召回 ID 和上下文注入 ID 一致。另一桌面检查验证首次插入、相同操作重放、删除后重试不复活及回执不含正文。
- PASS：在相同隔离 SQLite 中先持久化一条拒绝记忆来源为 pending，关闭并重启 Windows Debug；启动恢复将其变为 `noop`，window 为 `finished`、attempts=1、没有 memory 写入。该来源按规则成为 gap，未调用真实模型。
- PASS：应用进程重启后，对先前真实 SQLite 中已确认记忆的 ID 执行真实 `searchMemories` 与上下文组装，来源行、session、user role、active 状态及相同 memory ID 注入均匹配。真实用户应用及其数据库未被访问；隔离窗口通过 CDP，无鼠标操控。
- 低成本规则分析实际执行：当前 A 规则在开发集 S1 中对 14 个 gold 正事实 primary，6 个自动准入、1 个显式路径、7 个自动拒绝（包含多轮/后续决定案例）。这是过滤可达性诊断，不是 Recall；标签仍为草稿口径。
- 本轮没有新增真实模型调用。此前真实模型 A/B/C 数值沿用报告的探索性同集事后评分；准确总请求数/费用仍 unknown，不据此宣称正式对照或预算通过。不得把 Mock 桌面数据与真实模型结果混合。

### 最终状态与阻塞项

- 工程接线与匿名隔离桌面 Mock 闭环：**完成**。
- 真实模型质量盲测、标签独立复核、实际服务商累计调用/费用核对、自然 UI 全链路的 B/C 实际模型运行和配对前台时延：**NOT TESTED / 阻塞**。已知请求数和早期重试不完整，不能证明仍在单次 pilot 的 40 网络请求预算内，因此本轮停止追加真实模型调用。留出 v6 保持自审草稿，不作为正式冻结评分集。
- 复现命令、差异、成本数据和剩余风险见 `docs/memory/evaluation/extraction-v1/report.md` 的“最终执行结果”。此状态覆盖本文早期历史段中“尚未接线/尚未恢复”的旧进度记录。
