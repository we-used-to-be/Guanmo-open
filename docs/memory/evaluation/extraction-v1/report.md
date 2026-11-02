# 记忆提取评测进度报告

> **2026-11-02 独立复核：整体 FAIL，真实模型 BLOCKED。** 原始A/B/C调用与Token已复核，旧Precision/Recall仅为提案级事后探索，B/C未持久化输出不满足正式discovery定义；production又增加第二次模型核验，旧成本不代表当前流程。发现3个P1、修复2个、1个原子登记/容量遗漏仍阻塞。v6无正式输出、Gold未获准冻结。详见 [独立验收记录](../../FINAL_REVIEW_2026-11-02.md)。本段覆盖后文旧“工程完成”的验收含义，不删除历史轨迹。

状态：**进行中；不能据此选择或上线 B/C。** 以下均为匿名数据；已有部分真实供应商调用，完整费用、配对前台延迟及 Windows 桌面闭环尚未测量。

| 检查 | 已执行结果 | 边界 |
|---|---|---|
| 规则漏筛 | 开发集 20 个 S1 脚本的 14 个草稿事实，6 个主来源满足自动规则、1 个属显式请求、7 个主来源被拒 | 规则与草稿标签对照，非模型 Recall；不包含执行器、写入和实际召回 |
| A 调度 Mock | 开发集 100 日程，46 个模拟请求含 8 次模拟 503，66 日程无请求 | 真实队列、临时 SQLite、虚拟时钟、NOOP；不证明语义质量或真实延迟，S4 用户消息可能未登记 |
| A 状态与召回 Mock | 匿名来源进入真实队列，Mock 返回直接支持事实，生成 active；重开临时 SQLite 后按实际记忆 ID 召回和注入 | 不是应用进程重启、自然桌面对话或真实模型；未覆盖 B/C |
| 临时故障 Mock | 来源删除、仅 metadata 修改后释放预设成功响应，无迟到写入；一次模拟 503 后重试只写入一次 | Node/SQLite Mock；不等于 Windows 或多来源原子安全验收 |
| B/C 调度 Mock | 四轮触发、两轮前缀、C 静默尾批、scope/session/epoch 隔离及安全 gap 的 4 个定向测试通过 | 仅使用匿名 ID；没有模型、SQLite、Token、前台让行、重试或重启，不是可用策略或质量对照 |
| 连续窗口离线原型 | 5 项测试覆盖可见连续消息、安全 gap、作用域及 parent、超长不截断、窗口内真实 user 来源 ID | 未接入生产；来源 ID 合法仍需语义复核，长消息拆分、任务恢复与多源原子写入均未实现 |
| 基础测试 | `npm run test:memory`、相关 Vitest、评分器单测和定向 ESLint 通过 | 具体命令与次数见计划；不替代真实模型和桌面验收 |
| 隔离桌面 | Debug 自然对话 EX-01 经真实 DeepSeek 生成 active；重启后后台 Direct 服务真实调用 `search_memory` 返回相同 ID，后续真实模型请求包含该记忆并回答正确 | 后台直接调用 Direct 服务，未通过 `useAiChat` 发送或持久化新一轮；真实新会话 UI 闭环仍未完成 |
| 真实 A 底层样例 | EX-03 一次真实提取产生 active，来源 ID 正确；EX-07 两个用户源均被入队规则拒绝，提取调用 0 | 底层直接持久化与调度，共用已有 EX-01 记忆，不是每例独立库，也不是 B/C 对照或正式质量统计 |
| 连续上下文探索 | 原配置的一次 EX-07 请求返回空正文、输出 800 Token；同一服务版本的旧模型别名配合关闭思考后一次返回候选及来源 | 两次配置不同，不是公平 A/B；候选有跨项目表述风险且未入库。当前 custom 配置下 `reasoningMode=off` 未实际关闭思考，须先处理再冻结正式 pilot |
| 后台真实模型探测 | 固定提示词、同服务版本兼容别名：EX-01/09-S3 返回预期事实及来源；EX-05/13-S3 返回 `[]` | 每例一次逻辑请求、不写库；来源 ID 通过不等于语义通过，provider 可能参数降级重试；样本太少无法评定质量或安全 |
| A 开发集真实小样本 | 8 个 S1，独立 Node 内存 SQLite 和真实队列；EX-01/03 各一次真实模型调用并写入正确来源的 active，EX-07/09/17 漏筛；EX-13/23 无新增记忆 | EX-25 显式确认 NOT TESTED；真实使用隔离桌面模型代理但不是桌面闭环，提前结束未等待 120 秒，不是正式 A/B/C 对照。两次 usage 输入 1274、输出 125，服务耗时 813/1004 ms，实际网络重试次数未知 |
| B/C 真实窗口探索 | 8 个开发脚本：B 8 次、2599 输入/207 输出，623–1317 ms；C 10 次、3175 输入/230 输出，634–1092 ms。两者均返回 EX-07/09/17 的相关事实；C 的 EX-07 添加“后续项目都这样”，扩大了项目范围，必须拒绝 | 共 18 次实际网络请求，原始匿名结果见 `context-pilot-real.json`。只是提示词输出，未入库；显式确认、恢复、状态、真实前台并发均 NOT TESTED。来源 ID 和 scope 字段检查通过不能证明内容语义正确，不形成正式质量指标 |
| 重启后真实聊天入口 | CDP 后台调用隔离应用的实际 `useAiChat.sendMessage`，新会话问答已持久化；答案正确，assistant metadata 记录与 EX-01 相同的实际记忆 ID | 未经过人工 UI 操作；请求拦截未捕获报文，该轮模型调用数、usage 和请求上下文内容 NOT TESTED，不能和其他调用拼成同一次完整闭环 |
| 多来源原子写入屏障 | Node 临时 SQLite 覆盖来源内容/metadata/parent 修改和删除，以及预检后写入前的 metadata 竞态；隔离 Windows Debug 中实际 Tauri SQLite 验证来源 metadata 变更后插入/更新/删除均拒绝 | 未接入 B/C，多源语义正确性、B/C 模型响应屏障与重启仍 NOT TESTED；旧 Vite 缓存版本首次错误允许写入，新 URL 加载修改版本后 PASS。修补后 A 队列不是冻结 HEAD 的原始 A |
| 真实队列响应屏障 | Windows Debug 真实 A 队列 + Tauri SQLite；Mock 模型成功响应被阻塞，在 metadata 修改后释放，1 次调用、0 条记忆 | 模型为 Mock，未接入 B/C；v1 回执为 completed，非 v2 的 invalidated；不证明重启或真实网络恢复 |
| v2 原子登记基础 | Rust 定向测试通过：事务回滚、幂等、作用域 epoch、删改来源后重试；隔离 Windows Debug 的真实命令与 SQLite 复测通过，回执无正文且不重建已删除来源 | 尚未接入聊天或 B/C worker，维护态竞态、并发繁忙重试与重启消费 NOT TESTED。首次权限缺失导致调用被拒；修复权限后一次并行尝试未获得具体错误，再独立重跑通过 |
| v2 来源读取基础 | Node 测试覆盖登记指纹、会话绑定、来源删改、敏感/显式/引用 gap 及缺失可见快照；隔离桌面读取实际登记来源并检测删除与 metadata 变更通过 | 未接入模型或队列，超长分段和多轮上下文 NOT TESTED；来源快照仅供本地写入校验，不是语义安全证明 |
| v2 窗口账本与租约 | 临时 SQLite 覆盖分组、竞争、重试、失效回执、过期 owner 和中断恢复；隔离 Windows Debug 验证真实 SQLite 竞争及旧租约无法写入 | 使用模拟时间和无模型样例，未接正式聊天、模型或启动恢复；性能、持久化后的删除复活保护及跨项目语义仍 NOT TESTED |
| v2 连续窗口输入 | 临时 SQLite 验证 parent 关联、助手歧义、敏感和文档来源 gap、长消息无损续段和请求大小；隔离 Windows Debug 验证用户/助手/用户顺序与敏感内容隔离 | 尚未接入真实模型或评分，拆段后的语义连贯性、候选幂等和超限终结 NOT TESTED；字节预算不是实测 Token |
| v2 模型提案原型 | 定向测试验证请求预算、白名单字段、取消/超时、来源绑定、否定与部分作用域保护；隔离桌面组包后执行一次 Mock 模型调用，生成需复核提案 | 无生产入库，`requiresSemanticReview` 不能由 ID 校验替代；该提示词未经冻结，真实模型质量、错误率、成本和前台性能 NOT TESTED |
| 可选模型自查 | 测试一对一 verdict、缺失 verdict 失败及请求脱敏；隔离桌面使用 Mock 依次提出和核对 | 自查仍保留人工语义复核标记，不是独立证明；该方案增加第二次调用，真实安全收益与成本 NOT TESTED |
| v2 多来源证据与确认 | Rust 确认测试 7 项、来源和服务测试 41 项通过；隔离 Windows Debug 验证来源顺序、旧事实修改后拒绝、有效快照确认成功及畸形 v2 拒绝 | 没有真实模型提取或人工 UI；分段主来源的原文补查暂不支持 |
| Claude 新增 B/C 调度器 | 审查修复后 `memoryWindowScheduler` 定向集成测试通过；按组调度、前台取消与写入失败重试有测试 | 模块仍未连接 `useAiChat`；C 恢复只覆盖传入的一个组，非全局启动恢复；不代表产品启用 |
| v2 原子窗口写入 | Rust 6 项覆盖操作 ID 重算、来源 textHash 校验、事务回滚、租约/来源变化、删除后不复活；TS 22 项相关测试通过 | 两项 SHA 后端校验尚未在重建后的 Windows Debug 跑过；最新 app link 因 rustc 内存不足失败 |
| Windows B 窗口 Mock 闭环 | 最新 Debug 构建包含 Rust SHA operation/textHash 校验；4 个匿名来源进入隔离 SQLite，B scheduler 执行 2 次 Mock 调用并生成 candidate；显式确认后真实搜索返回目标 ID 并注入上下文；独立重启后来源、active 状态、召回 ID 和注入 ID 一致。持久化脚本另验证重试幂等及删除后不复活 | 非自然聊天入口、非真实模型；不证明语义质量、前台响应或生产接线。重启启动曾显示页面加载超时回退提示，随后 SQLite/CDP 验证通过 |
| Core Smoke | `npm run test:smoke` PASS，2 个测试文件、9 项通过 | Mock Tauri 宿主；不验证原生用户数据或真实模型，不替代上述隔离数据库验证 |

## 已有真实 A/B/C 探索输出的同集事后评分

为了利用已花费的真实模型调用，本评分只重评既有 A 与 B/C 开发集原始输出，不追加 API 请求。由实现者按 Gold v3 逐项人工裁定；Gold 尚未独立复核，因此这是探索性发现，不是正式验收或留出集结果。

| 策略 | 计分范围 | TP / FP / FN | Precision / Recall | 调用与用量 | 延迟 |
|---|---|---:|---:|---|---|
| A 当前规则队列 | 5 项非显式正例（EX-01/03/07/09/17）；EX-25 显式确认路径另列 NOT TESTED | 2 / 0 / 3 | 100% / 40% | 2 次真实逻辑提取调用；1274 输入、125 输出 Token | 813 / 1004 ms |
| B 连续批量 | 同 5 项正例；EX-13/23 负例均为空输出 | 5 / 0 / 0 | 100% / 100% | 8 次真实模型请求；2599 输入、207 输出 Token | 623–1317 ms |
| C 连续批量＋即时处理 | 同上；EX-07 的跨项目外推按错误候选计 | 4 / 1 / 1 | 80% / 80% | 10 次真实模型请求；3175 输入、230 输出 Token | 634–1092 ms |

Precision/Recall 仅按 discovery 阶段计算；B/C 的输出是未持久化的模型提案，不计为 active 记忆。负例样本只有两项，错误记忆率、删除保护、失败恢复、冲突更新、前台延迟及显式请求路径均不能由此估计。已知 usage 合计 7048 输入、562 输出 Token；按报告所列 DeepSeek 缓存未命中标价估算约 $0.00279，不是供应商账单。此前连接测试、自动重试及部分早期请求用量/次数未知，不能确认整个 pilot 的准确累计值；不再追加真实请求以避免超过 40 次硬上限。

## 本轮可复跑机器验证

- PASS：`npx vitest run tests/memory/memoryWindowScheduler.test.ts tests/memory/memoryWindowPersistence.test.ts tests/memory/memoryEvidenceV2.test.ts tests/memory/memoryEvidenceRetrieval.test.ts --maxWorkers=1`（22 项）。
- PASS：`cargo test --manifest-path src-tauri/Cargo.toml --lib memory_v2_ --jobs 1`（6 项）；`cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`；`npm run typecheck`；针对新增/修改 TS、测试和 CDP 脚本的 ESLint。
- PASS：`npm run test:smoke`（2 文件、9 项）；`git diff --check`。
- PASS：内存清理后 `CARGO_BUILD_JOBS=1`、`CARGO_PROFILE_DEV_DEBUG=0` 的 `cargo build --manifest-path src-tauri/Cargo.toml --bin guanmo --jobs 1`；最新隔离 Debug 上运行 `scripts/memory-window-scheduler-desktop.mjs`、`scripts/memory-window-persistence-desktop.mjs`，再重启并运行 `scripts/memory-window-restart-recall-desktop.mjs`。这些桌面步骤均为匿名数据与 Mock 模型，未调用真实 API。

v6 留出语料由实现者自审，非独立复核；此前旧留出样例曾看过规则输出，详见 `protocol.md`。v6 留出未运行规则或模型。标签、评测实现与机器验收仍有风险。

尚缺：自然聊天入口接线、全局待处理窗口启动恢复、真实 B/C 正式留出评测及语义复核、当前预算内可确认的真实模型余量、准确 Token/费用、配对前台时延和真实模型故障恢复。最新 SHA 后端校验已构建并通过隔离桌面 SQLite 闭环，但自然聊天和真实模型仍未测。当前没有可用的正式收益或成本数据，保持现有 A；禁止用 Mock 或合成结果替代模型质量。

真实测试上限沿用计划：pilot 最多 40 次辅助请求；总上限 1800 次、600 万输入 Token、60 万输出 Token、20 美元或本地计算墙钟 3 小时，任一达到即停。已记录 usage 的调用共 9811 输入、1857 输出 Token；EX-01 主回答及自动提取、用户连接测试的 usage 不明，总费用 unknown。DeepSeek 官方公布 `deepseek-flash` 峰值缓存未命中输入 $0.30/百万、输出 $1.20/百万 Token；按已知 usage 估算上限约 $0.005172，**不代表总花费**。价格来源：[DeepSeek Models & Pricing](https://api-docs.deepseek.com/quick_start/pricing/)。未掌握实际计费或供应商用量时标为 unknown，不能通过费用验收；不得记录 API Key。

## 复跑与尚需的桌面验收

在仓库根目录执行 `node --test scripts/memory-extraction-score.test.mjs scripts/memory-extraction-window-mock.test.mjs` 和 `node --experimental-strip-types --test scripts/memory-extraction-window-input.test.mjs`；它们不访问真实模型或用户数据库。A 的隔离 Mock 试跑在 PowerShell 设置 `$env:GUANMO_EVAL_PILOT_ENABLE='1'; $env:GUANMO_EVAL_PILOT_MODE='mock'` 后运行 `npx vitest run --config scripts/memory-extraction-pilot.vitest.config.ts --maxWorkers=1`。B/C 探索 Mock 使用同样环境变量后运行 `node --experimental-strip-types scripts/memory-extraction-context-pilot.mjs`。Mock 结果不能作为模型质量证据。

已新增隔离桌面复跑命令（全部 Mock，无网络；需要先启动隔离 Debug 并开放 CDP 19283）：

```powershell
$env:GUANMO_EVAL_CDP_PORT='19283'; $env:GUANMO_EVAL_SOURCE_GUARD='1'; node scripts/memory-window-scheduler-desktop.mjs
$env:GUANMO_EVAL_MEMORY_ID='<上一步输出的 memoryId>'; node scripts/memory-window-restart-recall-desktop.mjs
$env:GUANMO_EVAL_CDP_PORT='19283'; $env:GUANMO_EVAL_SOURCE_GUARD='1'; node scripts/memory-window-persistence-desktop.mjs
```

完整 Windows 验收仍需自然聊天入口接线后在全新隔离库验证多轮决定、隐含偏好、不足一批、跨项目隔离、冲突、删改屏障与故障恢复，再重启并通过新会话自然提问核对真实模型调用、来源/记忆/召回 ID 和实际 prompt 注入；需同时有已知 API usage/费用预算和配对前台延迟。当前这些项目均为 `NOT TESTED`，上述 Mock 命令不能替代正式桌面验收。

## 最终执行结果（2026-11-01）

本节覆盖前文形成期间的旧进度状态；历史记录保留审计轨迹。

### 实现与机器验证

- 已将后台窗口流程接入自然聊天成功持久化后的路径：保存会话后按真实 SQLite source ID 读取 user 行，再登记 intake、捕获 session/scope/epoch 并调度。正常消息不会因单条价值关键词未命中而在入口直接丢弃；敏感、拒绝、显式记忆请求及不安全来源仍按 gap/原有确认路径处理。Agent `save_memory` 的用户确认卡未改。
- 已加入启动恢复：首屏及 AI 配置准备完成后，从 SQLite 有界回执扫描 pending 组；按 session/scope/epoch 进行 B 四条批量和 C 60 秒静默尾批。前台模型生成会让出后台槽。Rust intake 对超过 512 条未完成回执拒绝提交，不把待处理列表无限扩张。来源回读、租约、有限退避、原子幂等写入、用户删除后不复活保护复用现有实现。
- PASS：定向 memory Vitest 42 tests；语料/基线/v6 结构/NOOP 调度/初始状态 Vitest 18 tests；`npm run typecheck`；定向 ESLint；`npm run test:smoke`（9 tests）；两条桌面 Node 脚本 `node --check`；Rust `memory_intake_` 4 tests、Rust fmt；单线程低 debug 信息 Windows Debug 构建。命令见计划文件“本轮执行收尾”。
- PASS，真实隔离 Windows Debug + CDP + 应用 SQLite（Mock 模型、无网络）：4 个真实持久 user 来源进入调度器；模型提案和逐项核验各调用 Mock 一次；确认 candidate 后，SQL 中 evidence 的源 ID、active 记忆 ID、`searchMemories` 返回 ID 与上下文注入 ID 一致。
- PASS，真实隔离 Windows Debug + SQLite：原子写入为 `inserted`，重放及删除后重放均为 `already_applied`；删除记录仍不存在，操作回执不含源正文，用户确认后状态为 active。
- PASS，真实隔离应用进程重启：对已确认记忆重新读取同一 source/session/role/evidence ID，检索及上下文注入均返回同一 memory ID。
- PASS，真实隔离应用启动恢复：重启前把一条拒绝记忆的匿名来源持久化为 pending；重启后回执变为 `noop`、window 为 `finished`、attempts=1、无记忆写入。该用例走 gap 路径，没有发真实模型请求。自然聊天代码所用的 API 调度本身已由 CDP 调用验证；人工 UI 发送及完整真实模型新会话链路没有被本用例覆盖。
- PASS，低成本过滤可达性分析：开发集 S1 中 14 个 gold 正事实 primary 里，A 逐条自动规则准入 6、显式路径 1、自动过滤 7。该计数只展示入口规则会拒绝哪些 gold primary；它不是整案例召回率或语义准确率。对应执行：`node scripts/memory-extraction-rule-analysis.mjs`。

### A/B/C 数据与决策

- 唯一真实模型 A/B/C 指标仍是前文“已有真实 A/B/C 探索输出的同集事后评分”：同一小型已查看开发集的 5 个非显式正例，A 为 2 TP/0 FP/3 FN（P 100%、R 40%）；B 为 5/0/0（P 100%、R 100%）；C 为 4/1/1（P 80%、R 80%，错误项为项目范围外推）。B 使用 8 次请求、2599 输入/207 输出 Token；C 10 次、3175/230；A 两次逻辑提取、1274/125。只有两个负例，故不能代表错误记忆率。人工事后评分已看过样本、Gold 未独立复核，不是盲测或正式验收。
- 工程采用 B 的四条批次触发，辅以 C 的 60 秒 idle tail flush，避免低频会话无限等到下一批。显式 `save_memory` 继续由 Agent 生成待用户确认的 action card，不依赖自动提取窗口。C 的探索假阳性仍说明来源/语义范围需要保守核验和候选确认。
- v6 有 100 条新留出日程，基于实现者自审；它的结构与散列测试通过，但没有在 v6 上运行 A/B/C 规则或真实模型，也没有独立语义标签复核。因此所有留出集质量指标、错误记忆率和安全门槛均为 `NOT TESTED`。不得把结构测试或 100 条 NOOP Mock 调度结果当模型对照结果。
- 本轮新增真实模型请求为 0。此前连接测试、早期调用和 provider 重试的总调用数/账单仍 unknown；虽有先前记录的 token 与标价估算，实际累计费用与 pilot 40 请求余量不可证。为守住调用预算，不再发真实 API 请求。没有声称成本验收通过。

### 风险与限制

- `useAiChat` 已接线，但本次桌面全链路以持久化匿名来源直接调用同一产品 scheduler 并使用 Mock 模型；没有在自然 UI 流程中调用真实 B/C 模型。因此自然对话触发、提取模型准确性、回复耗时与前台延迟影响仍 `NOT TESTED`。
- 应用重启实际验证覆盖了已确认记忆召回和一条 gap 的 pending 启动恢复；含真实模型响应被阻塞、来源删改后释放迟到响应的 B/C 桌面竞态没有本轮真实模型验证。原子 Rust/SQLite 屏障由定向 Rust/TS/Mock 测试覆盖，不能等同真实网络响应时序。
- v6 Gold 和留出独立性为实现者自审，不是 Sol/第三方独立复核；按用户“由你完成剩余审核、不用交接”的指示继续自审和实现，但正式盲测标准中的独立复核仍明确 `NOT TESTED`。
- 本机隔离 Debug 窗口已关闭；测试使用 `com.guanmo.memory-eval-20261031` 临时应用标识与独立 `guanmo.db`。未操作真实用户应用、SQLite、Key 或鼠标。未提交修改。

### 最终状态与复跑入口

工程实现及隔离桌面 Mock 闭环为 **完成**；原任务的正式模型/成本/自然 UI 接受门槛为 **阻塞（NOT TESTED）**，不能整体报告全部验收完成。后续只在可核对的真实请求余量与费用预算、以及独立 Gold 复核可提供时继续正式评测；当前不再进行功能开发。

隔离桌面复跑需先启动同一隔离 Debug 配置并开放 CDP 19283。调度器、写入及重启召回：

```powershell
$env:GUANMO_EVAL_CDP_PORT='19283'; $env:GUANMO_EVAL_SOURCE_GUARD='1'; node scripts/memory-window-scheduler-desktop.mjs
$env:GUANMO_EVAL_MEMORY_ID='<scheduler 输出的 memoryId>'; node scripts/memory-window-restart-recall-desktop.mjs
$env:GUANMO_EVAL_CDP_PORT='19283'; $env:GUANMO_EVAL_SOURCE_GUARD='1'; node scripts/memory-window-persistence-desktop.mjs
```

真实启动恢复可复跑：先执行 seed，再完整关闭并重开隔离 Debug，然后执行 assert。两个步骤只写独立测试库；来源为拒绝记忆内容，不应产生模型调用。

```powershell
$env:GUANMO_EVAL_CDP_PORT='19283'; $env:GUANMO_EVAL_SOURCE_GUARD='1'; $env:GUANMO_EVAL_RECOVERY_ACTION='seed'; node scripts/memory-window-recovery-desktop.mjs
$env:GUANMO_EVAL_RECOVERY_ACTION='assert'; $env:GUANMO_EVAL_RECOVERY_SOURCE_ID='<seed 输出的 sourceId>'; node scripts/memory-window-recovery-desktop.mjs
```

定向机器门：`npx vitest run tests/memory/memoryWindowScheduler.test.ts tests/memory/memoryWindowLedger.test.ts tests/memory/memoryIntake.test.ts tests/memory/memoryWindowPersistence.test.ts tests/memory/memoryWindowInput.test.ts --maxWorkers=1`；`npm run typecheck`；`npm run test:smoke`；`cargo test --manifest-path src-tauri/Cargo.toml --lib memory_intake_ --jobs 1`。
