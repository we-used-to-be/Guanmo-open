# Sol 独立审查与验收记录

日期：2026-11-02。分支：`feature/agent-router-v2`。结论：**FAIL**；真实模型部分 **BLOCKED**。本记录覆盖早期计划、report、NATIVE_ACCEPTANCE 中与当前状态冲突的进度表述，不改写历史证据。

## 范围与成功标准

- 接管时已有 11 个 tracked 文件修改及大量 memory 源码、测试、脚本和文档未跟踪；全部保留，未提交、推送、重置或批量删除。不是干净 HEAD 上的已提交实现。
- 按 `ai-code-review` 和项目 HIGH/L3 契约审查；知识图工具未提供，采用精确源码与 diff。另派只读独立 Reviewer；完成一次 Fix → Re-review，未无限修补。
- 验收要求：成功持久化来源可恢复；scope/session/epoch 隔离；前台让行不消耗失败次数；异常来源不吞掉有效来源；写入、回执、确认、删除和重放一致；正式模型质量、成本、延迟不得由 Mock 推断。
- Blast Radius：useAiChat 成功保存 → intake → window ledger → input/model → Rust 写入 → evidence/确认 → active-only 检索；App 首屏后恢复为间接入口。RAG 与 Agent 工具授权不应变化。

## 阶段二与阶段三

| 项目 | 状态 | 结论 |
|---|---|---|
| B 连续四轮、C 60 秒、作用域与接线 | 已实现 | 有定向测试及原生 Mock；不是正式策略选择通过 |
| 工程完整性 | FAIL | 下述 P1-1 尚未解决，不能称工程完成 |
| 独立代码/架构审查 | 已执行 | 初审 0 个确认 P0、3 个 HIGH-confidence P1；修复 2 个，剩余 1 个 |
| 定向回归及 Core Smoke | PASS | 命令和边界见下文 |
| 原生 SQLite/Mock 闭环 | PASS（限定范围） | 四轮 → candidate → 确认 active → 重启 → 检索/注入同 ID；非自然 UI/真实模型 |
| v6 正式独立评分 | NOT TESTED | 标签仍有问题，未冻结独立评测协议 |
| 真实模型盲测及自然 UI B/C/配对 TTFT | BLOCKED | 40 次 pilot 的实际剩余次数和累计费用不可核实 |

## 三项关键发现及处理

### P1-1 [HIGH] 保存后登记失败永久漏入队：未修复，阻塞

`useAiChat.ts` 的 `persistAndQueueMemory` 先 `saveCurrentSession()`，之后才调用 `schedulePersistedWindowExtraction`。Rust intake 达到 512 个 pending 时返回 `memory_intake_capacity`；scheduler 捕获后仅 warning 并返回。已保存的来源没有 intake，`listPendingMemoryWindowGroups` 只读已有回执，重启不会补到该来源。保存后、登记前退出也是同一缺口。A 调用已被替换，代码注释中的“A path still runs”不是实际兜底。

此外登记只在 Direct/Agent 成功且请求仍 current 时发生；失败、取消或切走会话后，后续保存进历史的 user 也不因此获得原始 scope 的 intake。故“所有正常持久对话均进入待处理范围”和“崩溃无漏登记”都不成立。512 上限没有删除已存在 pending，但会漏掉后来已保存、登记被拒的来源；不是聊天历史数据被删除。

现有 Rust 容量测试证明**该 Rust 事务内新建来源**会回滚，不能覆盖产品已先行提交来源的路径。必须把捕获 scope 的新 user 保存与登记真正接入同一 Rust 事务，并设计容量满的持久可恢复结果/背压；不能阻断聊天保存或用内存重试冒充崩溃恢复。该修复涉及聊天保存入口、API 契约及容量恢复，不是 scheduler 局部补丁。本轮停止该高风险扩展，保留明确 FAIL；下一步先补实际保存入口的容量/退出回归，再实现这个闭环。

已在新隔离 Windows 实际 SQLite 复现该边界：先单独保存匿名 source，再填充到总计512个pending，调用真实Rust intake返回 `memory_intake_capacity`；`sourceSaved=1,intakeCount=0,recoveryGroup=null`。复现脚本成功只证明缺陷触发，**不表示容量安全PASS**。脚本/输出在本机 `output/memory-native/sol-capacity.mjs`、`sol-capacity.json`，未删除或清空任何正式数据。

### P1-2 [HIGH] 前台抢占被当网络失败：已修复

原 scheduler 把模型 `deferred` 和已中止信号都转为 `retry`，第三次会使整窗来源 failed。新增 `foreground` 延后原因：使用旧格式可读的 retry 状态、保留租约 CAS、退还当前 attempt、60 秒后可重领。真实超时/模型错误仍走原来的有限失败重试。

实际回归先失败再通过：连续四次前台让行仍 pending，随后可结算 completed；模型 deferred 使用 foreground 原因。未修改 Rust、数据库格式或 Gold。

### P1-3 [HIGH] 超长单来源吞掉同批正常来源：已修复

原 input 遇任一 oversize 整体返回，scheduler 将其他所有新来源直接 noop；超长项若是 prefix，则所有新来源均 noop。现在超长项作为 gap，ready 返回 `failedSourceIds`；只有相应新来源 failed，已处理 prefix 只提供 gap，正常新来源继续提取。三项回归覆盖混合批、超长 prefix 和逐来源结算，未放宽断言。

## A/B/C 与评测独立性

- A 的硬规则行为记录正确：enqueue、执行回读与来源/active 校验均有价值筛选。现有 S1 草稿 14 个正事实主来源是 6 自动准入、1 显式、7 拒绝；这不是 Recall。正式 A 应用冻结基线，不能把本分支增强来源屏障后的 A 偷换为原 HEAD。
- B 输入确实来自 ledger 顺序的连续 user，assistant 必须按 parent 关联；不是只拼关键词筛选消息。最多 4 个新轮、2 个已处理前缀；安全消息仍以 gap 隔断。字节/分段预算可能裁掉助手或早前缀，不能承诺任意长指代可恢复。
- 当前产品实际无条件采用 B 阈值＋C idle/recovery，显式 save_memory 仍由原 Agent 确认卡处理。它与计划“门槛不过保留 A”不同，现有小样本不足以证明该上线选择合理；本轮没有将其认定为最终获准方案，也未擅自清理 v2 数据或改回旧二进制。
- 独立重新阅读既有原始输出：A 的两条新增 active 有正确来源；B 的五个正例提案有对应用户/支持来源；C EX-07 把当前项目选择外推“后续项目都这样”，按既定 Gold 判错。B/C 这些输出未持久化，只能计**提案级探索**，不满足协议要求的 discovery（持久化 active/candidate），更不是最终 active Recall。
- 旧数值可复核为探索性：A 2/0/3、B 5/0/0、C 4/1/1（TP/FP/FN），仅 5 正例、2 负例，显式 EX-25 未验。它们不能替代错误记忆率、正式来源准确率或统计显著性。
- 两个真实结果文件 SHA-256：A `dc502fbe49d548d8c16bdb8059cd74fe713bd093cffe13991b00cf5385cf242a`；B/C `392ded476ccdb7f6682562f0ed6d304ea5c443d9701ef31e4abd24dc339f9d63`。
- B/C 探索使用只有 content/scope/source 的旧提示词和模拟窗口，没有当前 production 的结构字段、两次核验、写入、恢复、真实 UI 时序。因此它不能验证当前实现，也不能公平证明新版成本更低。
- v6 是 20 个语义脚本 × 5 日程，不是 100 个独立语义样本。散列匹配原记录；现有 real runner 固定使用开发集 8 个脚本，未找到 v6 的规则/模型运行结果。只能说明本次查到的证据中没有运行，不能证明完整历史从未泄露；实现者已看过全部标签，前几版也反复根据 review 调整来源，不能称严格独立盲测。
- 独立标签审查：H6-02 的 M1 变体可选 M3 是未来支持源，与 production 只允许主来源之前的支持矛盾；H6-20 `requiredWritableSource=M2` 指向 assistant，实际可写主来源应由 dependentPrimary=M3 绑定。冻结前需明确屏障语义。scorer 不会自动执行这些屏障，也不在 scoreCase 中统一执行 expectedStates；来源分数仍依赖语义归一和与 Gold 的匹配，不能独立量化全部错误输出的来源真实性。
- v6 原样保留，未改 Gold 或给未跑输出评分。正式盲测需在 P1 修复和实现/prompt 冻结后，由未参与实现者新建并封存独立语料与预注册标签；v6 降为已见的语义回归集。不要现在围绕 v6 调参后继续称盲测。

## API 预算审计与最小解除条件

- A 文件：2 次**逻辑**调用、1274 输入/125 输出 Token，813/1004 ms；reservedNetworkCalls=4 是预留，不是实际网络次数。
- B：8 个 trace、2599/207 Token，623–1317 ms；C：10 个 trace、3175/230，634–1092 ms。B/C 文件合计明确记录 18 次 networkAttempts。合计已知 Token 7048/562；不能推算整个 pilot 的剩余调用。
- 已核查临时 pilot report：一份 real B/C、两份 mock B/C、一份有 usage 的 A 和一份无 usage 的 A；Mock 的 18 traces 不能混计真实请求。早期 context probe/连接测试/模型 provider 回退的累计值仍缺失。未发现可核验供应商账单或跨进程总请求账本；原生 ApiUsage 只在进程内累计且会随重启清零，不是费用记录。没有可用的供应商 billing 工具。
- 未主动执行任何 real runner 或供应商账单请求。第一轮启动旧评测 identifier 时复用了既有匿名评测库，已停止并排除出新空库结论；显式脚本使用 Mock，但该轮启动后台网络是否为零缺少完整记录，记为 **unknown**，不能声称本轮全进程真实调用数为 0。新 identifier 实例已核实无模型地址/凭据，全部模型输入由 Mock 接收。
- 预算部分结论 **BLOCKED**。解除条件：提供可核实的历史累计 actual attempts/费用；或另行明确授权**新的独立补测预算**，不要把未知旧余额当剩余 20 次。无需提供/打印 Key。
- 最小新预算方案（非正式全量）：新独立 4 个语义案例各 1 次 A/B/C，按每臂每例最多 1 次 extraction、B/C 阳性再最多 1 次 verifier，最多 20 次辅助网络调用；每例/每臂最多4个新轮，禁止健康检查和隐式 provider 回退另占未计预算。另预留最多8次真实前台回答与4次实际召回/续答，**总实际网络尝试硬上限32次**，所有错误/重试包含在内，到限即停。先按当日价格估算并确认金额上限；历史 $0.00279/$0.005172 只是估算，不作新授权。这个规模只解除 pilot 可用性，不满足正式100留出×3的验收；正式运行需重新估算与单独授权，并冻结 runner、标签及原始 usage/actual attempts 的持久账本。

## 性能、状态与残余风险

- 前台发送不会 await 后台提取；native C 单轮登记返回耗时只是单样例，不是 TTFT 或配对 P95。普通问答首 Token、真实前台重叠、长时间积压、连接/内存曲线和 Release 冷启动新旧对照均 **NOT TESTED**，没有性能收益结论。
- 普通安全对话虽不经价值词过滤，进入模型仍有代价：全阳性四轮窗口每100轮约25次提案＋25次核验；慢聊每轮间隔90秒时 C 可每轮调用。当前流程无法仅凭旧探索数据证明满足≤30辅助调用/100轮；这属于待测/明确成本门槛风险，不能称“无明显额外成本”。
- 数据源为 SQLite；窗口租约和回执使用 CAS、所有支持源的最终写入由单 Rust 事务校验、操作回执防同 operation 重放。没有保证所有语义同义改写或不同新来源都 exactly-once。
- completed 表示来源处理结算，不表示事实 active；noop 表示无提案/安全 gap，不表示用户确认；candidate 不注入召回。模型自查 true 仍不是独立语义证明。
- C 没有严格实现计划的持续交流最多5分钟兜底；其他组活动会重置所有组的尾批计时，跨会话频繁活动时历史尾批可能延后。配置变更后的唤醒、旧v1任务在无新v1触发下的消费、容量恢复、海量历史 settings 扫描与生命周期长期释放仍需定向验收。
- 显式 save_memory 代码路径未变；本轮 actionProposal 和 Rust 确认回归可证明局部授权/状态边界，真实自然 UI 下确认、拒绝、撤销及模型生成卡仍 NOT TESTED。

## 实际执行的 Machine Gate 与原生证据

| 命令/检查 | 结果 | 边界 |
|---|---|---|
| `npx vitest run tests/memory/memoryWindowScheduler.test.ts tests/memory/memoryWindowLedger.test.ts tests/memory/memoryWindowPersistence.test.ts tests/memory/memoryWindowInput.test.ts tests/memory/memoryWindowModel.test.ts tests/memory/memoryWindowCandidates.test.ts tests/memory/memoryIntake.test.ts tests/memory/memoryIntakeSource.test.ts tests/memory/memoryEvidenceV2.test.ts tests/memory/memoryEvidenceRetrieval.test.ts tests/memory/memorySourceSnapshots.test.ts tests/memory/memoryService.test.ts --maxWorkers=1` | PASS，12文件111项 | 修复前106项通过；新增回归先4项失败，修复后111通过 |
| `npx vitest run tests/memory/memoryExtractionCorpus.test.ts tests/memory/memoryExtractionBaseline.test.ts tests/memory/memoryExtractionHoldoutV6.test.ts tests/memory/memoryExtractionScheduleMock.test.ts tests/memory/memoryExtractionInitialState.test.ts tests/database/transactionBridge.test.ts --maxWorkers=1` | PASS，6文件22项 | 结构、NOOP、事务桥，不是模型评分 |
| `npx vitest run tests/agent/actionProposal.test.ts tests/memory/memoryExtractionPersistenceMock.test.ts --maxWorkers=1` | PASS，2文件13项 | 提案授权与SQLite Mock屏障 |
| `node --test scripts/memory-extraction-score.test.mjs scripts/memory-extraction-window-mock.test.mjs` | PASS，15项 | scorer/模拟调度 |
| `node --experimental-strip-types --test scripts/memory-extraction-window-input.test.mjs` | PASS，5项 | 离线连续窗口 |
| `node scripts/memory-extraction-rule-analysis.mjs` | PASS，正常执行 | 草稿14事实/6准入/1显式/7拒绝，不是Recall |
| `npm run typecheck` | PASS | 修复后执行 |
| 15个相关产品TS与3个修改测试的定向 `npx eslint` | PASS | 未跑全仓Lint；实际命令18个文件 |
| `npm run test:smoke` | PASS，2文件9项 | 修复前执行；本轮未改App，复用其入口证据，Mock宿主 |
| `cargo test --manifest-path src-tauri/Cargo.toml --lib database_transactions::tests::memory_ --jobs 1` | PASS，10项 | 匿名SQLx内存库；不是自然聊天接线 |
| `cargo test --manifest-path src-tauri/Cargo.toml --lib database_transactions::tests::candidate_confirmation_ --jobs 1` | PASS，7项 | 旧/v2证据、作用域、失败回滚、替代快照 |
| 独立identifier `tauri dev --no-watch --config ...` | PASS，Debug构建1m41s | 单线程、dev debug=0；既存linker warning；非发布构建 |
| 新profile四轮窗口、原子写入、删除重放、进程重启后检索/注入 | PASS，限定SQLite/Mock | 原生证据级别2，不是自然UI真实模型级别4 |
| 重启后pending→手动调用产品恢复API→noop | PASS，限定恢复 | 无配置时App不会自动发起恢复；不算App自动恢复通过 |
| C不足四轮的原生真实墙钟检查 | FAIL（验收脚本未通过，根因未定） | 首次来源超过240秒仍pending；第二次保留CDP75秒后新来源仍pending，Mock捕获的123ms调用实际可能来自旧pending恢复，不能计为本来源调用。document为visible且队列无运行项；有先前pending的干扰，尚不能把失败直接归因为某个实现缺陷，也不能宣称满足90秒门槛。两次输出分别保留，不用成功单测冲掉失败 |
| 真实模型正式评分/错误记忆率/来源准确率/自然UI完整链路 | NOT TESTED / 预算BLOCKED | 不填Mock数值 |
| 原生真实模型TTFT、长期资源/积压、Release冷启动对照 | NOT TESTED | 无性能收益/无退化结论 |
| `git diff --check` | PASS | 未提交；保留既有CRLF提示 |

原生EXE SHA-256 `54dbd001d8928033f5ae0b0dcebf8179f904fe20d2cc91d1e438333760353716`，identifier `com.guanmo.memory-eval-20261102-sol`。当前TS经Vite加载；没有将Debug数据当Release。完成后仅停止本轮创建的PID和Vite；用户已安装观墨进程未操作。512匿名pending fixture留在独立测试profile，不批量清理。

本轮正式可复查源码改动仅 `memoryWindowScheduler.ts`、`memoryWindowLedger.ts`、`memoryWindowInput.ts` 及三份同名定向测试；同步本报告、专项计划、extraction-v1/report与NATIVE_ACCEPTANCE。全部为接手时未跟踪文件中的精准追加，未覆盖其他Terre源码。命令、原生包装/夹具和JSON输出位于本机忽略目录 `output/memory-native/sol-*`。没有新Codex窗口或提交。

## 后续明确下一步

1. 先处理 P1-1：匿名实际会话保存入口复现512容量与保存/登记间退出；约定“用户持久化＋intake”的原子 API 及容量可恢复结果。不要先扩大模型测试或修 Gold 迎合当前输出。
2. 完成该跨层闭环并做 Windows 匿名库恢复、切会话/项目、取消/失败回归；另用干净单例及逐请求来源ID重新核实C原生计时，区分调度/计时环境/旧pending恢复。审查具体变更需另起一个受限 review 周期，不能把本次已用的一次复审无限延长。
3. 保持当前结果为 FAIL，按冻结门槛决定安全开关/回退方案；不清空旧记忆、账本、配置或降级到不能读取 v2 的旧二进制。
4. 预算明确且实现冻结后，再建独立盲集，接入持久状态/故障屏障/usage/费用 runner，执行公平 A/B/C 和自然 UI 原生真实闭环。正式计分不使用 Mock。
