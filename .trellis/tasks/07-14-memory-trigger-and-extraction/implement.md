# 执行计划

## 阶段 1：检索触发

- [x] 在 `memoryPolicy.ts` 收紧历史词匹配并增加惯例续接组合。
- [x] 在 `memory-policy-check.ts` 增加 strong/weak/none 回归用例。
- [x] 运行 `npm run test:memory`；失败则停留在阶段 1 修复。

## 阶段 2：归纳入库

- [x] 收紧提取 prompt，明确原子事实、80 字符和禁止项。
- [x] 抽取候选规范化、验证、身份比较、规范正文选择和合并决策为纯策略。
- [x] 调整 `memoryService.ts` 编排，实现候选复用、重复跳过、唯一 replacement 和 embedding 失效。
- [x] 扩展专项测试覆盖“该记/不该记/合并/冲突/作用域隔离”。
- [x] 运行 `npm run test:memory`。

## 全局验证

- [x] 运行 `npm run build`。
- [x] 检查 diff 仅包含任务文件及上述三个记忆相关实现/测试文件，不夹带现有脏改动。
- [x] 按 Trellis 质量检查完成最终审查；本轮不提交、不推送。
