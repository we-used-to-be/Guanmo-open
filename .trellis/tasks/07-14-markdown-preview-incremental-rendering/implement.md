# Markdown 大文档预览增量渲染实施计划

## Phase 1：解析契约与回归测试

- 新增纯 Worker parser core，复刻现有 Markdown 插件链并输出稳定 HAST 块。
- 新增 Node 检查脚本，覆盖块稳定键、原文行号、GFM、公式、代码高亮、脚注、HTML 与链接安全。
- 验证：`npm run test:markdown-preview`、`npm run test:markdown-math`、`npm run build`。
- 回滚点：仅新增 parser/test 文件与依赖声明。

## Phase 2：Worker 调度与按块增量提交

- 新增共享 Worker、请求 ID 路由和错误回退。
- `MarkdownPreview` 增加大文档异步分支，复用现有 renderer，并以稳定键 memo 化块。
- 验证：快速连续请求只采用最新结果；编辑单块时未变块键和 memo 比较保持稳定；构建通过。
- 回滚点：移除大文档分支即可恢复同步渲染。

## Phase 3：近视口虚拟化与复杂块延迟挂载

- 为大文档块增加估高占位、IntersectionObserver 近视口挂载、ResizeObserver 实测高度缓存。
- 确保未挂载块 wrapper 仍提供行号锚点，目录跳转能触发目标块进入预加载区。
- 验证：自动化 DOM 检查确认远端块未初始生成；浏览器手测首屏、远端目录、滚动同步、Mermaid 与主题切换。
- 回滚点：关闭 lazy 条件仍保留 Worker 与增量块更新。

## Final Review

- 检查仅修改任务相关文件，不夹带现有 `Cargo.lock`、Sidebar、FullscreenFileDrawer 或 Trellis 初始化改动。
- 执行 `git diff --check`、新增专项检查、既有数学检查和生产构建。
- 对大文档生成样例记录 Worker 解析、首批挂载数量与更新后的稳定块复用情况；不把机器相关绝对耗时设为脆弱测试门槛。
