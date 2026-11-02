# 记忆优化续接

更新时间：2026-10-29 11:43（北京时间）。任务进行中，长期 goal 工具返回 usageLimited，未完成；不将代码完成等同于交付验收。

## 恢复顺序

1. 工作区 `D:\React\guanmo-open`，核实 `git status --short` 和分支 `feature/agent-router-v2`。不要覆盖当前所有未提交修改。
2. 读取根 AGENTS.md、`docs/memory/AI_IMPLEMENTATION_PLAN.md` 和完整需求 `C:\Users\惜\.codex\attachments\a339d8fa-4170-4e93-9c55-6e289901931e\goal-objective.md`。根 `AI_IMPLEMENTATION_PLAN.md` 属于 MCP，禁止覆盖；记忆任务计划文件被既有 ignore 规则忽略，仅本机保留。
3. 不新建 goal 绕过限制，不自行提交/推送/打 tag/发布。不启用 Trellis、子 Agent 或独立模型 Reviewer；用户未授权这些工作流。

## 已落实与决策

- 用户已明确：非敏感稳定事实自动生效，冲突和敏感信息仍需确认。新自动事实须结构完整、原文直接支持、明确程度足够且无 active 冲突；敏感信息不自动提取，显式保存仍确认。
- 复用 memories/settings 与既有 IPC，无 schema 迁移/新依赖。SQLite 队列绑定真实 user 源/会话/scope，3 条一批，串行租约、20 秒请求上限、3 次尝试、幂等回执；响应后闲时处理，下次成功对话恢复。容量仅待确认候选 200，满时退避，不删用户记忆。
- sourceGuard + 乐观 SQL 防止源删除、手动修改、跨 scope 与迟到结果覆盖；Embedding 只条件写缓存列。新自动 active 并发冲突回落 candidate。手动/锁定/已确认事实不自动覆盖。
- Router 支持 no_tool + needsMemory，保留 Direct 与一次语义兜底；普通规则快路不额外串行调用模型。预检索空/失败区分，单轮复用；词法 + 缓存向量 + scope/时间排序，有界注入与必要时按 source ID 读取真实 user 记录。
- evidence v1 记录 source/session/recordedAt/excerpt；早期 occurredAt 兼容但只是记录时间，不能伪称事件日期。新替代候选带旧事实 id/contentHash/updatedAt 快照；Rust 确认同事务检查旧 active/scope/版本，变化则拒绝。hash 为 UTF16 FNV1a 版本校验，非授权凭据。
- `docs/agent-contracts/rag-memory.md`、`ai-selection.md` 已与用户新策略同步；提取提示词去掉“全部须确认”的旧冲突描述。

## 修改范围

本任务所有未提交源码涉及：memoryPolicy/Service/Evidence/ExtractionQueue；database persistence/memoryQuery、Web unsupported；useAiChat；Router/semantic/intent/executor/requestBuilder/tools 与相关类型；actionProposal/actionProposalCommand/aiScope；SettingsPage/settingsCommands；Rust database_transactions.rs；直接记忆/Router/提案测试、200 条评测脚本和 docs/memory。

`docs/MEMORY_TIMING_PLAN.md` 保留原规划并注明新策略与后续实现入口。Cargo.toml 曾被 Tauri CLI 改行尾，canonical diff 为空；只允许核实后恢复本次行尾，不覆盖语义修改。根 MCP 计划、MCP 兼容边界及真实用户库未改。

## 最新验证

- PASS：`npm run typecheck`（会话 64247 已终态 exit0）、`git diff --check`。
- PASS：`npx vitest run tests/memory/memoryService.test.ts tests/memory/memoryPolicy.test.ts tests/settings/memorySettings.test.tsx tests/agent/routerV2.execution.test.ts --maxWorkers=1`，4 文件/47 项。
- PASS：`cargo test --manifest-path src-tauri/Cargo.toml --lib database_transactions::tests::candidate_confirmation --jobs 1`，4 项/71 filtered，编译1分57秒；日志 `output/memory-native/rust-memory-tests.log`。含回滚、旧事实已替代、跨 scope、内容变更同时间戳及 JS/Rust UTF16 hash fixture。会话 93720 已完成，勿重复轮询。
- 之前联合轮次：106 项 PASS，但 execution beforeAll 超时 + settings worker 启动超时，整体 FAIL；47 项串行复验涵盖失败模块，不将前轮伪装全绿。
- 历史 Core Smoke 9/9、Web/desktop 构建、ESLint/查询/运行时 schema 均有较早 PASS；新增自动策略/Rust 快照后未重跑完整集成，不称最新产物验收。
- 纯规则200条固定150 tune/50 holdout；holdout Precision1/Recall0.82857/F1 0.90625，对照0.7857/0.3143/0.44898。剩6漏判未逐条针对调参。触发率随最后 semantic gate 又变动，需重跑脚本读取报告；不得引用旧4%当最新结论。
- 真实本地模型共12预算内调用，分类均3秒超时，仅warmup约2.49秒成功；无分类准确率、最终回答质量或应用TTFT证据。绿色评测脚本仅证明记录与预算，不代表模型通过。

## 明确下一步

1. 在允许继续后，检查提取已有目录总长度上限（现限制40行但单行可很长），只做直接有依据的有界修复与针对验证。
2. 复跑最新规则报告、受影响 Router/Chat/提案联测与 Core Smoke；复用上述结果，不跑无关全仓测试。
3. 稳定源码后重建隔离桌面 Debug 产物，核实 hash。旧 `output/memory-native/guanmo-memory-eval.exe`（BA4A...FBB5）不包含最新自动策略/Rust 快照，禁止用于最终验收。
4. 参考 `NATIVE_ACCEPTANCE.md`，只用测试 identifier/profile。独立 exe 通过精确绝对路径 Start-Process -WindowStyle Hidden 启动；通用 guanmo.exe 的 sky.launch_app 曾误解析为已安装 `D:\观墨\guanmo.exe`，未操作其数据，禁止复用该方式/窗口。native旧测试进程已退出，必须重新枚举窗口。
5. 隔离 profile `%APPDATA%\com.guanmo.app.memory-eval` 有匿名手动偏好1条与本地 Ollama 配置；未读 Key、未复制真实配置、未下载模型。用已安装本地小模型做预算受控的真实自动提取→active→跨会话召回、冲突确认、重启恢复/取消/删除闭环。
6. 继续200条隔离数据库/画像/历史集成与来源、重复、冲突质量；现200条只是规则识别，不能冒充检索/回答端到端。完成真实模型与桌面首token P50/P95、调用数/实际token（估算须标注），无法测就记 NOT TESTED。
7. 核对完整目标逐项收尾，再更新报告。HIGH 风险建议 L3，用户明确调用 ai-code-review 后才做模型 Review；可提示“使用 ai-code-review 审查本次记忆改动，复用已有门禁，重点并发写入、scope、确认版本与原生证据”。未完成不得 update_goal complete。

## 不能再走的路

- 不用后台整行 upsert 回写向量，不为容量自动删候选，不猜测旧项目提案scope，不把模型/助手建议当用户事实。
- 不用 Node SQLite/mocks/Web替代 Windows原生；不把CPU微秒测量当首token，不宣称CLI超时样本准确率通过；不以 Debug 单次启动宣称性能收益。
- 不读取真实用户数据库，不扫描全部旧聊天，不降低测试断言/提高超时掩盖回归，不无限尝试本地模型。

续接提示：按本文件恢复同一记忆任务，在确认额度允许后从“明确下一步”推进；先核实源码和当前状态，避免重做审计/覆写 MCP 交接。
