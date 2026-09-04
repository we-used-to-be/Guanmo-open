# Technical Design

## Boundary

只修改 `src/services/ai/systemPrompts.ts` 的回答风格规则，并在现有 `scripts/agent-tool-parser-check.ts` 中增加契约断言。

## Data Flow

编辑器命令 → selection tag + “请解释这段内容” → `classifySelectionRequest(...)=fast` → 普通流式回答 → `buildSystemMessages()`。

路由与消息数据均未发生回归，因此不新增回答模式、状态字段或跨层参数。修复点限定在最终生效的共享系统提示词：普通问答继续简洁；本轮 selection 解释按内容复杂度决定深度，不受一句话规则约束。

## Compatibility

- 保留可信回答、上下文安全、自定义偏好和编辑确认规则。
- “结合上下文解释”仍按现有 Agent 读取路径执行。
- 回滚只需撤销新增的 selection 解释风格规则及对应断言。
