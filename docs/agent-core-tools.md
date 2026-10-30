# 普通聊天核心检索

## 当前实现

保留规则路由、一次有时限语义分类、记忆预检索和限定文件 RAG。Direct 请求可携带两个精简只读工具：`search_memory`、`search_knowledge`。未调用工具时只有一次主模型请求；调用后执行一批最多两个读取，再无工具续答。选区翻译等快速处理不附加 schema。

不提供 Direct 写入、联网、读取当前文档全文或 MCP，不自动升级 Agent。现有文件/记忆/成果写入仍走 Agent 和原确认链。

Agent 的非写入、非整篇文件总结、非限定选区/章节读取任务，也会在原候选之外加入经过同一资格检查的两个核心检索工具，避免落入 Agent 后反而失去只读检索机会。此行为不改变普通聊天核心检索开关的含义：该开关仍只控制 Direct。

“看看库里面有没有回溯内容”按范围＋查询动作进入知识库读取；“看看内容”不再因同一文件能力下的两个弱词进入 Agent。明确的 required 读取任务不能只返回一句行动说明就结束：未调用则最多自动补调一批，成功为空可正常回答，失败、拒绝或缺少工具则说明限制。语义候选没有 required 时不强制查询。

执行链：`useAiChat → streamDirectChat → streamChatResponse → executeTool → 无工具续答`。复用工具注册、资格、参数校验、取消、超时、结果裁剪和来源注册，没有新数据库或 Rust command。

## 配置与回滚

桌面设置 → AI 模型 → 对话参数 → **普通聊天核心检索**。

对应可选旧兼容字段 `ai.routing.coreToolsEnabled`，缺省 true；关闭恢复原 Direct payload。Agent、自动记忆预检索、限定文件 RAG 不受这个开关影响。配置结构和备份格式没有破坏性变化。

当前支持沿既有 OpenAI Chat Completions 适配层发送原生工具请求。协议层支持不等于每个模型支持。明确拒绝 tools 且尚无输出时最多无工具重试一次；降级缓存绑定 Provider 实例，切换连接/模型后新建实例重新判断，不探测、不执行文本 JSON 工具。

## 去重和权限

- 仅本轮缓存，不跨会话或工作区缓存结果。
- 同批同名、同 query、等价 TopK 共用 Promise，仅注入一份正文。
- 强预检索的同 query、足够 TopK、无限定分类结果可复用，成功为空也可复用。失败没有预取结果，不当作“没有记忆”。
- 轻检索与强检索、限定分类与无限定、标签范围与全库检索不互相冒充；细化查询可再次执行。
- 标签 RAG 已注入的完整片段，按 chunk ID＋content hash 去重；版本变化仍返回新片段。
- scope 由宿主捕获，不由模型产生；Direct 不写全局 Agent scope。会话/工作区变化和取消后不继续生成或写 UI。
- 原生调用和 tool 角色仅存在于请求副本，聊天持久化格式不变。上下文溢出恢复保留当前调用及结果，不重执行检索。

## 验证命令

```powershell
npx vitest run tests/agent/agentReadFallback.test.ts tests/agent/directChat.test.ts tests/agent/directChat.performance.test.ts tests/agent/routerV2.chat.test.tsx tests/agent/routerV2.execution.test.ts tests/agent/routerV2.test.ts tests/agent/aiChatFlowContext.test.ts tests/agent/contextOverflowRecovery.test.ts tests/agent/agentStreamPrerequisite.test.ts tests/agent/aiChatOrchestration.test.ts tests/agent/modelContextBudget.test.ts --maxWorkers=1
npm run typecheck
npm run test:smoke
npm run build:desktop
```

性能用例交错运行关闭/开启各 300 条匿名普通问答，另外各预热20条。只测本地编排开销、额外请求数和 schema 估算预算；不访问真实模型、文件或数据库，不代表真实 TTFT、误调用率或模型选择成功率。

## Windows 真实模型 A/B 验收

1. 使用同一新鲜 Windows 桌面产物、同一连接/模型、同一匿名测试库。关闭/开启核心检索分别为 A/C，交错执行，避免时段差异。初筛80条，通过后扩大至普通问答300条，其余各50条；不必对已淘汰方案继续消耗 API。
2. 场景：通用概念、隐含个人/项目历史、本地资料发现、带选区/文件的问题、连续任务、保存/替换/提醒。额外覆盖关闭数据库、禁用工具、取消、切换工作区、不支持工具的模型、空结果与索引降级。
3. 首字定义为提交到首个最终答案文本，排除占位及工具行动文字。分别统计无工具普通问答和检索分支的 P50/P95；冷索引、热索引分开，不混成一个延迟值。
4. 建议准入：普通问答 P50 增幅≤5%且≤100ms，P95≤10%且≤200ms；新增 schema＋策略估算≤600 tokens；隐含工具需求正确获取证据≥95%；普通问答误调用≤1%；合法调用成功率≥99%；越权执行、确定性重复查询/注入均为0。工具场景端到端 P95 较基线劣化≤10%。空结果不是调用失败，细化查询不是重复检索。
5. 在匿名测试库中核对底层查询次数、事实/片段版本和回答证据。不能把“调用过工具”直接计为识别成功，不能用 fixture 输出推断模型准确率。

启用“匿名路由诊断”后，可在开发调试控制台读取：

```js
const { getDirectChatMetrics } = await import('/src/services/agent/directChat.ts')
getDirectChatMetrics()
```

仅 DEV 调试服务器可使用以上模块 URL；生产产物不提供这个控制台导入入口。内存最多200项，不包含问题、路径或结果。`firstTextMs` 从提交计时，工具行动文字会在工具分支被排除；`modelRequests` 包含 Direct 的上下文重试和 tools 降级；`executedTools/reusedTools/failedTools/deniedTools` 及 `toolDurationMs` 用于定位执行情况。首字时间不是索引或工具执行时间。

`schemaEstimatedTokens` 是项目现有估算器值，不是供应商 tokenizer。`usage` 只在 Provider 返回时存在，不能把缺失当作0；当前流式适配未请求完整 usage，真实 token 验收应另取供应商 usage。Direct 统计不包含前置分类和 embedding 消耗，整轮成本须把这些一起计入。

## 验收边界

自动化使用匿名 fixture/mock 宿主。Windows 新鲜原生产物、真实模型工具兼容性、供应商实际 token、真实 TTFT/准确率与冷索引性能，未执行前一律为 **NOT TESTED**。本地编排快不证明供应商携带 schema 后同样快。

## 2026-10-30 本轮验证

| 检查 | 结果 |
| --- | --- |
| 上述定向测试＋两项设置兼容测试 | PASS，最终共186项（主体184项通过后，新增两项执行边界用例及其相关21项通过） |
| Core Smoke | PASS，9项；mock 宿主，不替代 Windows 原生验收 |
| TypeScript | PASS；最终 `build:desktop` 也包含类型检查 |
| 修改范围 ESLint | PASS，0 errors；现有文件10项既有 warning 未顺带清理 |
| 前端 HTTP 传输 `--frontend-only` | PASS；Rust API HTTP 为 NOT TESTED |
| 桌面前端构建及体积门禁 | PASS；entry 1,156,806 bytes，JS total 7,015,429 bytes，101 chunks |
| 最终源码本地编排 A/B | 各300项；关闭 P50/P95≈0.0023/0.0028ms，开启≈0.0178/0.0527ms；无额外请求、无检索。fixture schema＋策略估算359 tokens；真实注册 schema 另由聊天集成用例检查≤600估算tokens |
| Windows 新鲜原生产物、真实模型 A/B | NOT TESTED |

上下文恢复旧测试在 HEAD 原代码下同样有7项失败，原因是缺少 Router V2 所需宿主与授权目标夹具；本轮仅补齐该相关测试夹具，20项全部通过，未放宽生产权限。最终构建前一次进程曾在压缩阶段异常退出且无代码错误信息，单独重跑通过；未据此归因于源码或断言具体环境原因。

建议后续使用 L3 强模型调用 `ai-code-review`，聚焦本次 Direct 执行边界、取消、作用域、原生消息续答和去重，复用上述验证，不扩展到无关用户修改。本轮未提交、推送或创建发布。

## 知识库口语路由与缺失读取修复验证

- 状态文案已单独提交为 `27c22af`；本节记录后续路由与完成校验修复的验证结果。
- 最终定向回归：`agentReadFallback`、`routerV2.chat`、`directChat`、`routerV2.execution`、`agentStreamPrerequisite` 共70项通过；覆盖资格候选同步及实际检索工具的任务续接。此前路由矩阵、路由单测、上下文恢复等定向组合247项通过。
- TypeScript、修改范围 ESLint、`git diff --check` 通过。
- Core Smoke 首次运行8项通过、1项预览标题等待超时；单独复查 `CoreSmoke.test.tsx` 3项通过，超时未复现。未修改既有预览代码，也不将首轮命令记为通过。
- 新鲜 Windows 桌面产物、真实模型检索及延迟仍为 **NOT TESTED**。
