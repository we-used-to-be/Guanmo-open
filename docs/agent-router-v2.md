# Agent Router V2

## 范围与调用链

开发分支 `feature/agent-router-v2`，基线为用户确认的 `5407e7e`。不合入 main 的 MCP WIP、不改 Rust、SQLite schema、文件写入或确认卡授权语义。

`useAiChat → prepareConversationRouting → makeRoutingDecision（一次规则评分）→ semanticRoutingTriggers → [仅不确定时 resolveSemanticRouting] → qualifyCandidates → 既有记忆预检索/Direct 或 Agent → executeTool 再校验 → 既有工具与原生边界`。

规则层负责选择，资格层只过滤。模型返回的类别直接映射到候选工具，不返回规则竞争；`required=[]`，主模型可选择不调用。语义分类不创造记忆写入或编辑授权。Direct 的明确问答没有新增 await、模型请求、MCP 连接或工具初始化。

## 初始策略

配置位于 `ai.routing`，缺失字段由 `resolveRouterConfig` 兼容读取，不清空旧配置或保存新的密钥。

| 配置 | 默认值 | 用途 |
|---|---|---|
| enabled | true | 仅对不确定请求启用分类；设置可关闭 |
| model | 空 | 复用对话模型，也可指定同一 API 下的快速模型 |
| timeoutMs | 1200 | 100–3000ms；超时撤销请求并回退 |
| conflictMinScore | 2 | 参与类别竞争的最低已有规则分数 |
| conflictMargin | 1 | 两类分差不超过该值且有竞争/检索线索 |
| maxCategories | 3 | 结构化结果的类别数量上限 |
| maxQueryChars | 600 | 仅发送本轮问题前 600 字符 |
| maxOutputTokens | 160 | 分类输出预算 |
| diagnostics | false | 内存中匿名诊断，最多 200 条 |

触发线索包括：接近的检索类别分数配合“还是/或者”等竞争关系或检索线索；“出处/核实/靠谱吗”等隐含查证；没有当前标签及已有对话上下文时的“那份/之前那套”等指代或历史依赖。通用定义/解释、明确工具、明确回忆、选区翻译、手动选择和续接优先旁路。不因得分低或单个普通弱词触发。存在已有对话时保守跳过隐含记忆判断，允许漏召回以优先保障速度。

分类结果为 `{intent: 'tools' | 'no_tool', toolCategories, needsMemory, confidence}`。拒绝未知类别、超量/重复类别、非 JSON 与字段类型错误；置信度只校验结构，不作为选择资格或权限依据。一次调用同时处理工具与记忆判断，不循环、不自动重试。模型复用现有 `externalApiFetch` 凭据绑定和 Origin 授权，不读取/发送密钥。

## 资格与状态

`toolEligibility.ts` 提供 `available/needs_input/blocked`；`toolEligibilityContext.ts` 从当前 scope、标签、打开的文档、桌面/数据库状态和搜索开关取得实时值。需要输入的工具不注入可执行 Schema，主模型收到补充目标提示；不可用或无权限的工具收到限制提示。工具注册可提供同步 `isAvailable` 与 `enabled`，不会在资格校验时等待网络。

执行器发送 Schema 前与每次执行前重复使用同一资格逻辑，读取缓存命中也先检查资格；后续仍保留原有参数白名单、selection 范围、路径检查、显式记忆写入意图和确认卡机制。`save_memory` 不能由语义模型自行授权。没有候选时不注入全量工具说明。

记忆继续调用现有 `searchMemories`，按当前工作区限定项目作用域，已有系统继续过滤 active/已替代记录；没有新存储。明确回忆走原规则，隐含需求共用一次语义判断。

MCP 本次只有与 main 命名空间一致的元数据资格接口：连接已就绪、目录仍有效、启用且用户本轮已选中才可用。没有引入 Client/Server、Schema 或执行器。真实接入须在后续合并中验证，此处不能视为 MCP 验收。

## 诊断与验证

`getRoutingMetrics/getRoutingSummary` 返回匿名耗时、触发原因、候选数量、触发率和回退次数，仅限当前运行。`summarizeRoutingEvaluation` 对提供的匿名标注计算误选/漏选；未运行真实模型标注集，不报告准确率提升。

改造前定向基线：路由矩阵、请求准备、聊天编排、记忆策略共 167 项通过。新增测试覆盖 Direct、明确工具、模糊选择、no_tool、一次记忆判断、超时/异常/取消/迟到、资格不足、连接失效接口与执行前授权撤回；保留原执行预算和必需上下文回归。

最终定向验证：12 个测试文件、242 项测试 PASS；Core Smoke 2 个文件、9 项 PASS；TypeScript PASS；修改范围 ESLint 0 错误、7 条预先存在的警告；`git diff --check` PASS。Smoke 只代表 mock IPC 下的入口渲染与切换，不替代原生桌面验收。

复验入口：

```powershell
npx vitest run tests/agent/routerV2.test.ts tests/agent/routerV2.chat.test.tsx tests/agent/routerV2.execution.test.ts tests/agent/routerV2.model.test.ts tests/agent/routerV2.performance.test.ts --maxWorkers=1
npm run typecheck
npm run test:smoke
```

Direct CPU 对照使用同机 5,000 次匿名请求：改造前规则中位数 0.0185ms、P90 0.0207ms；改造后规则加 V2 配置/不确定性门控中位数 0.0192ms、P90 0.0224ms。绝对差约 0.0007/0.0017ms；此微基准不代表真实模型首 Token 或原生端到端延迟，也不据此宣称性能提升。基准原始结果在本地忽略目录 `output/router-v2/`。

真实 Windows 桌面、供应商/本地模型分类准确率及首 Token 延迟：NOT TESTED。MCP Client/Server 集成：按用户确认延后，NOT TESTED。发布、全量 E2E、全量测试、Rust 编译与安装包构建均不在本次定向验证范围内。

## 继续验收

使用匿名文档与独立测试配置，在 Windows 桌面验证：普通问答、明确工具、隐含查证、历史依赖、无目标改写、禁用搜索、取消后立即发送新问题。与同机旧产物交替比较真实首 Token；不使用个人对话/真实凭据构造测试，不以模拟答案代替真实分类效果。

本次涉及异步路由与权限过滤，建议 L3 模型验收：`使用 ai-code-review Skill 执行本次模型 Review；以当前 diff 为起点，检查 Direct 快路径、取消与迟到结果、资格校验及已有授权边界，复用已完成的定向测试和 Smoke，不进行全仓扫描。`
