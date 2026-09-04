# 实施计划

## 阶段 1：回答与来源 UI

- [x] 调整普通回答提示，保留研究/总结专用结构。
- [x] 删除无来源 UI 占位及无用属性/组件。
- [x] 运行相关静态检查、`npm run test:agent-parser`、`git diff --check`。

## 阶段 2：研究路由

- [x] 为无 tag 的明确主题研究增加意图规则。
- [x] 增加正反例回归：主题研究、普通知识问答、指定文件归纳、无 tag 改写。
- [x] 运行 `npm run test:agent-parser`、`git diff --check`。

## 阶段 3：RAG 调度

- [x] 区分手动保存与自动保存的索引延迟，保持按文件合并。
- [x] 增加或扩展索引调度回归检查。
- [x] 运行 `npm run test:rag-index`、`git diff --check`。

## 阶段 4：改写风格记忆

- [x] 增加个性化改写的轻量记忆意图，普通改写继续跳过。
- [x] 增加风格改写正反例测试。
- [x] 运行 `npm run test:memory`、`git diff --check`。

## 全局审查

- [x] 运行 `npm run test:agent-parser`。
- [x] 运行 `npm run test:memory`。
- [x] 运行 `npm run test:rag-index`。
- [x] 运行 `npm run build`；若 esbuild `write ENOMEM`，使用 `GOMAXPROCS=2` 重试。
- [x] 运行 `git diff --check`，核对任务 diff 与现有脏工作区边界。
- [x] 不提交、不推送，除非用户后续明确要求。

## 风险点

- 本地研究规则过宽会让普通问答误入 Agent；必须用正反例锁定。
- 风格信号与 transformation 排除顺序错误会让普通改写增加延迟。
- RAG 文件已有未提交调试改动，禁止整文件覆盖或顺手清理。
