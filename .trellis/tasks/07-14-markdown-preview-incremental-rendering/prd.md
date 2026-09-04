# 优化 Markdown 大文档预览渲染

## Goal

降低超大 Markdown 文档在编辑更新和首次打开预览时的主线程长任务，确保包含大量代码块、KaTeX 公式或 Mermaid 图表时，编辑与滚动仍保持可响应。

## Background

- `src/components/editor/MarkdownPreview.tsx` 当前把整篇内容交给单个 `ReactMarkdown`，每次内容变化都会在主线程重新执行完整 remark/rehype 管线。
- `src/components/editor/EditorArea.tsx` 已负责预览挂载缓存、延迟内容提交、滚动同步与目录跳转；本任务复用这些机制，不重构五种编辑模式。
- Mermaid 当前在组件挂载后立即执行动态导入和渲染；大文档同时挂载多个图表时会进一步占用主线程。

## Requirements

- R1：仅对大文档启用异步优化路径；普通文档继续使用现有同步渲染路径，保持即时反馈和兼容性。
- R2：大文档的 Markdown 标准解析、GFM、数学公式转换和代码高亮必须在 Web Worker 中完成，主线程不得再同步解析整篇文档。
- R3：Worker 输出顶层语义块及稳定内容键；内容更新后，主线程只重新提交内容或行号发生变化的块，不重新构建未变化块。
- R4：大文档预览只挂载首屏和近视口块；远离视口的块保留估算/实测高度占位，进入预加载区后再生成 React 节点和复杂子组件。
- R5：Mermaid 只在所属块进入近视口并实际挂载后渲染；主题切换后已挂载图表仍正确更新。
- R6：保留标题目录跳转、编辑/预览滚动同步、任务列表勾选、图片预览、代码复制、脚注、原始 HTML 转义和链接协议过滤行为。
- R7：Worker 不可用或解析失败时自动回退到现有 `ReactMarkdown` 路径，不阻断预览。
- R8：不新增设置项，不改动预览外层缓存策略，不修改后端或 Tauri API。

## Acceptance Criteria

- [x] AC1：大文档内容交给 Worker 后，主线程组件不调用整篇 `ReactMarkdown`；解析结果按顶层 AST 块返回。
- [x] AC2：编辑一个不改变后续行号的段落时，至少一个前后相邻未变块保持相同稳定键，增量组件比较不会重新生成其 JSX。
- [x] AC3：远离视口的大文档块初始只渲染占位容器；首屏、近视口块和目录目标块可按需挂载。
- [x] AC4：代码块、GFM 表格/任务列表、行内与块级公式、Mermaid、脚注和重复标题的渲染检查通过。
- [x] AC5：标题点击、目录跳转和基于 `data-md-line` 的滚动锚点在优化路径中仍使用原文行号。
- [x] AC6：Worker 异常会显示同步回退结果，旧的异步响应不会覆盖更新后的文档。
- [x] AC7：`npm run test:markdown-preview`、`npm run test:markdown-math`、`npm run build` 与 `git diff --check` 全部通过。

## Out of Scope

- CodeMirror 编辑器虚拟化或增量语法树改造。
- 跨会话持久化 AST/块高度缓存。
- 修改预热频率统计、模式切换策略或增加性能设置 UI。
- 引入新的通用虚拟列表依赖。
