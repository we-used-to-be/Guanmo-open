# 提取评测语料草稿

状态：**DRAFT，未冻结，不可用于正式 A/B/C 质量判断**。

`cases.jsonl` 机械展开计划的 40 个脚本和 5 种日程；每条具有消息 ID、角色、时间、session、scope、parentId 及故障事件描述。`gold.jsonl` 保存计划原文，`gold-structured.jsonl` 初步拆分事实和来源，但初始库仍是自然语言、语义匹配规则与禁止项未完全机器化；这些标注尚未独立复核。日程与故障目前只是数据描述，不代表实际重启、重试或数据库操作。

- 开发集：奇数脚本，100 条；留出集：偶数脚本，100 条。每个脚本的五个日程不能当作独立语义样本。
- SHA-256：`cases.jsonl`：`278c4e775b8730ae1e035fca3f580124a60d753a87e4bfff4d228556395e8620`；`gold.jsonl`：`6f2d96bf6c042ae828042ae862dcebe6a0fc483fa166c33f6d3d343fa5f7236a`。
- `gold-structured.jsonl`：`5ea3a4c19dcbb37b11f09947eb86cc98f9e79fdf0d2ab6dc642dbc8a4a5f6a15`，由 `node scripts/memory-extraction-gold.mjs` 在目标文件不存在时生成；独立复核前不得作为正式评分标准。
- `initial-states.jsonl`：`3a08c9a342f0b7a709205c9cdea12a478ddb307507ad84ff5f4ae79653f03894`，由 `node scripts/memory-extraction-initial-states.mjs` 生成；只表达语义，不假定生产分类和结构化键，尚不能直接写入 SQLite。
- 计划第 5.2 节脚本文本 SHA-256：`8437f40fe7902efa8dc20c5bf13dc596f08441fbac4315838d22a7afe7c6aa5c`。只覆盖生成器截取的该节，不是整个计划文件。
- 生成：在不含该目录输出文件的隔离副本中运行 `node --experimental-strip-types scripts/memory-extraction-corpus.mjs`。为保护现有文件，生成器拒绝覆盖输出。
- 核验：`npx vitest run tests/memory/memoryExtractionCorpus.test.ts tests/memory/memoryExtractionBaseline.test.ts --maxWorkers=1`。

开发集规则轨迹只执行当前纯规则和长度/显式请求筛选，100 个日程内有 45 条用户消息通过；不代表真实队列成功、模型调用次数、Precision 或 Recall。`node --experimental-strip-types scripts/memory-extraction-rule-analysis.mjs` 对 20 个开发脚本的 S1 草稿事实逐项检查主来源：14 个事实中自动规则接纳 6、显式通道 1、自动规则拒绝 7；此为未复核标签与入口规则的对照，不是端到端 Recall，也不代表显式保存成功。定向样例 07/09/10 的规则输出在结构化标签完成前已被检查，其中 10 属于留出集；应向独立复核者披露，禁止利用其输出修改标签后仍声称盲法；如发生依输出修订，须按计划升级语料并使用全新留出集。

`npx vitest run tests/memory/memoryExtractionCorpusQueue.test.ts --maxWorkers=1`：实际 A 队列、Node 内存 SQLite 和永远返回空数组的 Mock；开发集 S1/S3 共 40 条，18 次入队、18 次 Mock 请求、零写入。测试简化为每个用户轮假定回答成功后立即 drain，不实现真实调度、明确记忆确认、预置库和故障日程；只能证明局部队列路径和 NOOP，不能用于质量、耗时或成本比较。另验证 metadata-only 来源变更后迟到结果不写入，以及模拟一次 503 后重试写入一次、再次 drain 不重复；重试测试直接调用 drain，没有验证定时器实际等待。未使用任何真实模型或真实用户数据。

后续需完善初始库及原子评分、核对事实和故障执行时点，并由未参与实现的验收者复核。任何修订应重算散列；独立留出集正式评测前不得用模型输出调整标签。完整 A runner、B/C 对照、模型与桌面验收均未完成。

`scripts/memory-extraction-score.mjs` 为已人工规范化的事实计算一对一内容/作用域/来源匹配及按脚本聚合的 micro/macro；重复输出计 FP，错误来源计 FP+FN，零分母为 null。它提供阶段状态和旧记录快照比较的基础函数，但尚未连接执行器，也不具备语义归一、完整安全判定、成本或延迟统计，不能单独承担正式评分。`node --test scripts/memory-extraction-score.test.mjs` 验证基础计算，未以模型结果运行。

## Sol 复核修订草稿 v2

- 独立复核指出原计划及首版标签将 07/08 的助手回复列为必需来源过严。`gold-structured-v2.jsonl` 将最终用户消息列为主来源、第一条用户消息列为必需支持源、助手回复列为可选支持源；38 的助手回复仍为必需，因为它提供选项与具体数据库的对应关系。评分器接受可选来源，但仍拒绝未列出的来源。v1 文件原样保留。v2 SHA-256：`a430fb3c9826c54853476de856d577f4581ca7371c026c26ae11f2472d85f990`。
- 状态按三阶段记录：发现阶段只有持久化的 candidate/active 计事实发现；显式 proposal 单列、确认后持久化才计发现。确认前禁止冲突候选自动生效；显式请求的脚本确认仅在真实 proposal 出现后进行。最终 active Recall 的分母为该案例全部 gold 事实，分子为最终来源正确的 active；保守保留的 candidate 不算 active，但允许计发现。17/18/21/22 在确认前对旧记录完整快照做相等断言；此断言另记安全门槛，不以新候选抵消。
- 39/40 的在途验证必须先实际持久化来源、确认模型请求已启动并阻塞成功响应，随后执行删除或仅改 displayContent，检查受影响行数为 1 并回读证明变更（40 的原 content 未变），最后释放原本可写入的成功响应，等待任务终结并核查无新增/复活。请求没有启动、变更未实际生效、响应未释放或未等待终结均为 `NOT TESTED`/不适用，不能仅因零输出判通过。S4 另须记录重启前变更凭证及不发送新消息后的恢复结果。
- 现有 A 规则对脚本 40 返回 false，故其原始场景没有自动请求；A 的零输出不能证明在途防护。匿名可入队来源的两条 Mock 屏障测试通过，只证明 A 现有护栏在该受控路径下工作，不冒充脚本 40 或真实模型通过。
- 以上修订改变原计划已冻结的来源评分规范，保留 v1 记录，v2 仍是未复核草稿；正式盲测前需按照第 5 节启用全新独立留出脚本并由独立验收者复核，不能把原留出集继续称为独立。初始库到生产 category/key 的映射、完整调度和正式 scorer 仍待完成。
- 新留出草稿位于 `docs/memory/evaluation/extraction-v2-holdout/`，20 个新语义脚本 × 5 日程 = 100 条。`cases.jsonl` SHA-256：`efa5ca87d7079bf253bc7c8037b75e46320ebad1c1ef9af275189a87a8fae81b`；`gold.jsonl`：`4bbd449878877c98285fd7965e2748e235f55f940be5bc4ea1f28e081919bdc4`。由 `node scripts/memory-extraction-holdout-v2.mjs` 在空目录生成；结构检查 `npx vitest run tests/memory/memoryExtractionHoldoutV2.test.ts --maxWorkers=1`。未对其运行规则或模型；标签和初始状态尚未独立复核，正式评测前不能使用。

## Sol 第二次复核后的 v3 草稿

- 第二次复核未通过：显式 proposal 被错误写入 discovery；重复断言合并来源会被误罚；新留出集至少两例只是旧场景改写。原有 v2 文件保留作为审计记录，不能正式使用。
- `gold-structured-v3.jsonl` 将 proposal 单列，发现只认可持久化的 candidate/active；显式请求确认前状态为 none，确认成功后预期 active。评分器 `scoreDiscovery` 会过滤 proposal。旧 EX-20 允许 U1 或 U3 作主来源，另一条可以是可选支持来源，不允许将主来源重复作为自身支持来源。
- `docs/memory/evaluation/extraction-v3-holdout/` 替换第二次复核指出的两个场景。该集的其他场景仍可能与旧脚本存在结构相似性，必须由独立验收者逐项核验，不能仅凭新 ID 或替换措辞宣称独立。原 v2 草稿保留，不用于正式评测。新集尚未运行规则或模型。
- SHA-256：旧集新版 gold `6c38ad9b7a6783d1006bd6b3f2a515c4569c61112297cb3ebdebf456f0032b92`；新留出 cases `10bc36ef5409928cab03bc5d6df210e4eb4096708e73461371a339cf9082d364`；新留出 gold `b1401ef158f8d8c5ba887a3d55e39ce9bce9f7e315ada8e0a8cae639fba52ff5`。生成命令分别为 `node scripts/memory-extraction-gold-v3.mjs` 和 `node scripts/memory-extraction-holdout-v3.mjs`；输出存在时拒绝覆盖。
- 测试：`npx vitest run tests/memory/memoryExtractionCorpus.test.ts tests/memory/memoryExtractionHoldoutV3.test.ts --maxWorkers=1`；`node --test scripts/memory-extraction-score.test.mjs`。这些只验证结构和评分单元逻辑，不等于评测或独立性验收。

## Sol 第三次复核后的 v4 留出草稿

- Sol 已确认 v3 的 proposal、状态和重复来源口径，留出集独立性未通过：只建议保留原 01、07、08、18，指出其他脚本与旧情节重复或属于安全回归变体。v3 数据保留，不用于独立盲测。
- `docs/memory/evaluation/extraction-v4-holdout/` 保留上述四个候选，其余 16 个情节重新设计。新集未运行规则或模型，仍须独立逐项复核其事实关系、对话依赖、作用域和状态后才能冻结；不因替换文本或新 ID 自动认定独立。
- H4-19 是两个独立用户事实，其中第二条来源被删除；除核查该来源的迟到结果不可写入，还必须确认第一条有效事实不被误删。H4-20 修改的是解释存储选项的 **assistant 支持来源**，不是用户主来源；须确保该支持来源确实进入请求、可构成结果的必要证据，并验证 metadata 实际变更后释放成功响应。无请求、无变更凭证或未覆盖支持来源均为 `NOT TESTED`。这两例需经独立复核确认是否构成独立情节，不替代既有固定安全回归。
- SHA-256：cases `898d4008b9850a0423ff46621bd5dcf7f6a45fcc42b4b323936ae209e7d3afbe`；gold `e7876ea931bc89c091478bda6d72e4bb3bb591ddd4296e4993ba6a856fb550a6`。空目录生成：`node scripts/memory-extraction-holdout-v4.mjs`；结构及散列检查：`npx vitest run tests/memory/memoryExtractionHoldoutV4.test.ts --maxWorkers=1`。测试仅证明结构，不证明独立性或产品行为。

## Sol 第四次复核后的 v5 留出草稿

- Sol 认为 v4 多数情节成立，但 05 是旧例改写；02、10、17 的标签及 19 的故障请求绑定需修正。v4 完整保留作回归与审计，不用于独立盲测。
- v5 的 05 改为对一次性进度做算术询问；06 的禁止范围限定在自动提取模型外发和记忆写入；08 的否定值明确保留“默认”；17 的新流水线属性使用中性描述，不推断其用途。
- 02 允许 M1 直接作为主来源、状态为 active 或 candidate；也允许 M3 为主来源、M1 为必需支持，后者只能是 candidate。评分器按来源组合检查对应状态。10 允许在显式请求前因 M1 已存在来源与作用域正确的 active/candidate；显式确认可复用它，但在最终结果中同一事实最多一条。若不存在预先正确记录，确认前不得有新记忆；proposal 仍不算持久化发现。`allowedBeforeConfirmation` 和 `correctRecordsWithinLimit` 是辅助检查，正式执行器必须在时间节点捕获实际快照并调用，单靠 gold 字段不能判通过。
- 19 的阻塞请求必须包含待删除的 M3，且释放的成功响应原本能够写入 **M3 对应事实**；变更 M3 并回读确认后释放响应，必须禁止其迟到写入，另核查 M1 有效事实最终仍可用。若阻塞的是只含 M1 的请求、响应不指向 M3 或任何屏障未成立，该项为 `NOT TESTED`。20 同样须证明请求包含 M2、结果依赖 M2、只改 metadata 且原 content 不变，并释放原本可写入的响应；其中 M2 是支持源，M3 是用户主来源。
- `docs/memory/evaluation/extraction-v5-holdout/` 为未复核草稿，不运行规则或模型。SHA-256：cases `ee16948e8bc6ef62595cea4324ea2239313dffe84763df2eed1c8cf8ed343d9b`；gold `39b4a5f04f2b4107f5266f9a5593838fc2f2e2c561d9a7c017132a9f749626f6`。空目录生成 `node scripts/memory-extraction-holdout-v5.mjs`；结构测试 `npx vitest run tests/memory/memoryExtractionHoldoutV5.test.ts --maxWorkers=1`；评分器单测 `node --test scripts/memory-extraction-score.test.mjs`。正式执行器、模型及实际屏障验收仍未完成。

## 实现者自审后的 v6

- 用户要求由实现者完成剩余审核，不再交接。实现者核查 v5 与原脚本的事实关系、角色与作用域、故障条件及先前 Sol 意见；发现 03 的决定和 17 的完成事件已在最终用户消息完整表达，不应硬要求更早上下文或一律限制 candidate。v6 将两例的先前用户/助手消息设为可选支持，允许 active/candidate；其他 v5 定义保留。该审核**不是独立复核**，独立标签复核仍为 `NOT TESTED`，不得将自审写成独立评估通过。
- 按用户指定使用自审版本作为本地实验基准，固定哈希：`docs/memory/evaluation/extraction-v6-holdout/cases.jsonl` 为 `bd1e8a958c86df4bdfc05c655f2ab47f54e04b92693e7da90a736985568de22b`，`gold.jsonl` 为 `195f5dac9ebcf7e145b43f9eb3b99e5bd03476f0838dd12e156bf716f2d94d4d`。无规则或模型结果参与本轮修订；其他既定质量、安全和成本门槛不变。留出语义独立性与标签正确性的剩余风险须随报告披露。
- `npx vitest run tests/memory/memoryExtractionHoldoutV6.test.ts --maxWorkers=1`：6 项通过；`npx eslint scripts/memory-extraction-holdout-v6.mjs tests/memory/memoryExtractionHoldoutV6.test.ts` 通过。均仅检查结构及散列。
- `npx vitest run tests/memory/memoryExtractionScheduleMock.test.ts --maxWorkers=1`：开发集 100 日程，使用真实 A 队列、Node 内存 SQLite、虚拟时间及 NOOP Mock，46 次模拟模型请求（含 8 次首次模拟 503）、66 个日程无请求、运行结束有 0 条已登记的待处理任务。模拟成功回答后 500ms drain 和有限重试，S4 最后 user 持久化后停止，不发新消息；开发集预置状态已装入，NOOP 前后记录保持不变。**未实现真实会话保存事务、前台调度、启动恢复、真实墙钟、显式确认或 39/40 的屏障事件**；0 pending 不代表 S4 最后一条 user 已登记，不能用来计算质量、真实时延、成本或恢复率。自审留出集没有参与此 Mock。
- `npx vitest run tests/memory/memoryExtractionInitialState.test.ts --maxWorkers=1`：将开发集语义初始状态映射到临时 SQLite，并校验 status/locked 等字段。映射的 category、subject 和 factKey 是评测夹具约定，不是对真实用户库的假设；时序执行器仅测试 NOOP 保持旧记录，尚未与非空模型输出评分集成，也没有执行留出集初始状态。
- 自审修正评分器：重复输出仍各自计入来源归因分母，重复记录依旧算 FP；来源统计与状态有效性分别计算。PASS：`node --test scripts/memory-extraction-score.test.mjs`，9 项及评分器 ESLint。当前全部输出归因仍以能关联到 gold 事实为前提，无法独立判定内容错误结果的来源真实性，因此不是正式来源准确率实现。
- 补充脚本级发现与最终 active 的 micro/macro 汇总，单测增至 11 项通过；负例无 gold 时不进入 Recall 分母，未确认 candidate 保留在 active Recall 分母。此功能尚未连接实际模型结果。
