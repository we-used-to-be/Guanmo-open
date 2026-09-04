# Implementation Plan

1. 调整 `BASE_SYSTEM_PROMPT`：从普通问答规则中移除“简单解释”，新增 selection 解释深度规则。
2. 在 `scripts/agent-tool-parser-check.ts` 增加提示词与快速路由契约断言。
3. 运行 `npm run test:agent-parser`。
4. 运行 `npm run build` 与 `git diff --check`。
5. 审查最终 diff，确认未覆盖现有未提交修改。

## Risk and Rollback

- 风险：规则措辞过宽可能影响普通解释。通过限定“本轮 selection 内容”控制作用域。
- 回滚点：`systemPrompts.ts` 的两条风格规则和测试中的对应断言。
